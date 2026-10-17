// idkcraft-neuc.54: bot.buildCells over baritone.build (Baritone BuilderProcess).
//
// bot.buildCells(name, origin, cells, {forbid}) -> Promise<{placed, missing}>.
// cells = [{dx,dy,dz,block}] offsets from origin {x,y,z} with plain block
// names ('oak_planks'). The mod owns approach, scaffolding and re-lay; the
// adapter only tracks progress/end through baritone.event {kind:'build'}:
// {kind:'build', name, placed, missing, active, paused, reason?} (secondly
// while live, final active:false when the builder idles — done, out of
// world, or #stop).
//
// End semantics, mirroring today's place flow:
// - paused (idkcraft-pnxy): Baritone pauses the build and says why; the mod
//   relays it as paused:true + reason. missing:<id> resolves starved at
//   once (Baritone's verdict, whatever the node mirror reads — the mismatch
//   is logged with both counts); any other reason rejects build-stall at
//   once. No 90 s wait for either.
// - material exhausted with no pause seen: the watchdog below resolves
//   {placed, missing} instead of hanging, and the FSM goes to craft/gather
//   as today (build's no-planks, castle's failed:no-<kind>).
// - stall: no placed growth for STALL_MS with wanted material on hand
//   rejects 'build-stall' (a wedged builder must fail loud, never idle).
// Missing is re-read from the sync world at watch time, so substitutes the
// mod accepted (any *_planks for a planks cell) read placed here too.
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const STALL_MS = 90000 // no placed growth with material on hand -> build-stall
const WATCH_MS = 5000 // missing/material re-check cadence
const MAX_CELLS = 4096

function suffixClass(name) {
  if (typeof name !== 'string') return null
  if (name.endsWith('_planks')) return '_planks'
  if (name.endsWith('_fence')) return '_fence'
  if (name.endsWith('_log')) return '_log'
  return null
}

// Same-block rule: exact, or the mod's wood-variant acceptance (any
// same-class variant for a schematic cell). Callers may pass their own
// (castle stone: any quarry variant for a stone cell) as opts.isSame.
function defaultSame(want, have) {
  if (want === have) return true
  const cls = suffixClass(want)
  return !!(cls && typeof have === 'string' && have.endsWith(cls))
}

// The mod accepts substitutes for a schematic cell; the material check
// must too, or a birch-held oak-planks build reads starved forever.
function onHand(bot, want, isSame = defaultSame) {
  try {
    const items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    for (const it of items) {
      if (!it || typeof it.name !== 'string' || !(it.count > 0)) continue
      if (isSame(want, it.name)) return true
    }
  } catch (_) { /* no inventory: nothing on hand */ }
  return false
}

function blockNameAt(bot, x, y, z) {
  try {
    const b = bot.blockAt(new bot.Vec3(x, y, z))
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

// Missing cells re-read from the sync world (unreadable reads missing, like
// the behaviours' done tests). A standing substitute counts as placed.
function missingCells(bot, origin, cells, isSame = defaultSame) {
  const out = []
  for (const c of cells) {
    const cur = blockNameAt(bot, origin.x + c.dx, origin.y + c.dy, origin.z + c.dz)
    if (cur == null || !isSame(c.block, cur)) out.push(c)
  }
  return out
}

function installBuild(bot) {
  bot._build = null

  bot.buildCells = (name, origin, cells, opts = {}) => {
    if (bot._build) return Promise.reject(new Error('build-busy'))
    if (typeof name !== 'string' || !name) return Promise.reject(new Error('build: bad name'))
    if (!origin || !Number.isInteger(origin.x) || !Number.isInteger(origin.y) || !Number.isInteger(origin.z)) {
      return Promise.reject(new Error('build: bad origin'))
    }
    if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS) {
      return Promise.reject(new Error('build: cells must hold 1..4096'))
    }
    for (const c of cells) {
      if (!c || !Number.isInteger(c.dx) || !Number.isInteger(c.dy) || !Number.isInteger(c.dz) ||
        typeof c.block !== 'string' || !c.block) {
        return Promise.reject(new Error('build: bad cell'))
      }
    }
    const forbid = Array.isArray(opts.forbid) ? opts.forbid.filter((n) => typeof n === 'string' && n) : []
    const isSame = typeof opts.isSame === 'function' ? opts.isSame : defaultSame
    return new Promise((resolve, reject) => {
      // Unique wire name per call (core-2): names are constant per
      // behaviour ('house', 'castle@x,z'), and the mod ends a replaced
      // build with the OLD name's final — without this the new call would
      // settle at once on the old final with missing=cells.length.
      const wire = `${name}#${(bot._buildSeq = (bot._buildSeq | 0) + 1)}`
      const st = {
        name,
        wire,
        origin: { x: origin.x, y: origin.y, z: origin.z },
        cells: cells.map((c) => ({ dx: c.dx, dy: c.dy, dz: c.dz, block: c.block })),
        isSame,
        placed: 0,
        missing: cells.length,
        grownAt: Date.now(),
        resolve,
        reject,
        settled: false,
        timer: null,
      }
      const settle = (fn, val) => {
        if (st.settled) return
        st.settled = true
        if (st.timer) clearInterval(st.timer)
        if (bot._build === st) bot._build = null
        fn(val)
      }
      st.settle = settle
      bot._build = st
      const onEnd = () => settle(reject, new Error('build: bridge closed'))
      if (bot.transport && typeof bot.transport.once === 'function') {
        bot.transport.once('close', onEnd)
        const origSettle = settle
        st.settle = (fn, val) => {
          try { bot.transport.removeListener('close', onEnd) } catch (_) { /* already gone */ }
          origSettle(fn, val)
        }
      }
      // Test seam: bot._buildTiming = { stallMs, watchMs } shortens the
      // watchdog (bridge-build.test.js); prod always uses the constants.
      const timing = bot._buildTiming || {}
      st.stallMs = timing.stallMs || STALL_MS
      // Referenced, not unref'd: a pending buildCells promise owns the
      // loop until it settles (an unref'd watchdog let the file's loop
      // drain with the promise still pending).
      st.timer = setInterval(() => watch(bot, st), timing.watchMs || WATCH_MS)
      bot.transport.call('baritone.build', {
        name: wire,
        origin: st.origin,
        cells: st.cells,
        ...(forbid.length > 0 ? { forbid } : {}),
      }).then(
        (r) => {
          if (st.settled) return
          if (r && typeof r.missing === 'number') st.missing = r.missing
          if (r && typeof r.cells === 'number' && typeof r.missing === 'number') {
            st.placed = Math.max(0, r.cells - r.missing)
            st.grownAt = Date.now()
          }
        },
        (e) => st.settle(st.reject, e instanceof Error ? e : new Error(`build: ${e}`)),
      )
    })
  }
}

// #stop cancels the builder like any other process (the mod's tick reports
// the idle as the build's final event); stopBuild is that spelling for
// callers that hold no pathfinder goal to stop. A #stop we send while our
// own build is live preempts it (round-3 core-2): the final then rejects
// 'build-preempted' — neither a strike nor a step failure — instead of
// settling as a starved resolve that would fail the step for material the
// pack holds.
function installBuildStop(bot) {
  bot.stopBuild = () => {
    if (bot._build) bot._build.preempted = true
    return bot.transport.call('baritone.cmd', { command: '#stop' })
      .then((r) => ({ stopped: true, id: r && r.id != null ? r.id : null }))
  }
}

// The mod's build notifications only (kind:'build'); true when consumed.
// A foreign name (a replaced build's late final) still consumes: the
// adapter settles a build on its own final only.
function handleBuildEvent(bot, method, params) {
  if (method !== 'baritone.event' || !params || params.kind !== 'build') return false
  const st = bot._build
  if (!st) return true
  if (params.name != null && params.name !== st.wire) return true
  if (typeof params.placed === 'number' && params.placed > st.placed) {
    st.placed = params.placed
    st.grownAt = Date.now()
  }
  if (typeof params.missing === 'number') st.missing = params.missing
  if (params.paused === true && params.active !== false && !st.preempted) {
    paused(bot, st, typeof params.reason === 'string' ? params.reason : 'unable')
    return true
  }
  if (params.active === false) {
    if (st.preempted) st.settle(st.reject, new Error('build-preempted'))
    else st.settle(st.resolve, { placed: st.placed, missing: st.missing })
  }
  return true
}

// Re-read missing from the world into st; null when unreadable.
function refresh(bot, st) {
  let missing = null
  try {
    missing = missingCells(bot, st.origin, st.cells, st.isSame)
  } catch (_) {
    missing = null
  }
  if (missing) {
    st.missing = missing.length
    st.placed = st.cells.length - missing.length
  }
  return missing
}

// Stall-site line (r185): absolute coords the world still shows unplaced,
// capped so one wedge cannot flood the log; then reject build-stall.
function stall(st, missing, tail) {
  try {
    const show = (missing || st.cells).slice(0, 10)
      .map((c) => `${st.origin.x + c.dx},${st.origin.y + c.dy},${st.origin.z + c.dz}:${c.block}`)
      .join(' ')
    console.log(`build-stall ${st.name}: ${st.missing} cells unplaced e.g. ${show} ${tail}`)
  } catch (_) { /* stall-site line best-effort */ }
  st.settle(st.reject, new Error('build-stall'))
}

function release(bot) {
  try {
    if (bot.transport && typeof bot.transport.call === 'function') {
      bot.transport.call('baritone.cmd', { command: '#stop' }).catch(() => { /* release best-effort */ })
    }
  } catch (_) { /* release best-effort */ }
}

function countExact(items, name, lo, hi) {
  let n = 0
  for (const it of items || []) {
    if (!it || typeof it.slot !== 'number' || it.slot < lo || it.slot > hi) continue
    if (String(it.name).replace(/^minecraft:/, '') === name) n += it.count | 0
  }
  return n
}

// Baritone paused the build (idkcraft-pnxy): its verdict settles at once.
// missing:<ids> -> starved resolve (the FSM re-batches/fetches) unless the
// mirror still holds one of them (then build-stall ... mismatch), plus one
// line per id: node = this mirror's exact count (slots 9-44),
// mod = the live inventory.get count over the same slots Baritone reads
// (offhand 45 shown apart: approxPlaceable never looks there). Anything
// else (unable: nothing reachable) -> build-stall with the stall-site line.
function paused(bot, st, reason) {
  const missing = refresh(bot, st)
  if (reason.startsWith('missing:')) {
    const ids = reason.slice('missing:'.length).split(',').filter(Boolean)
    let node = {}
    try {
      const items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
      for (const id of ids) node[id] = countExact(items, id, 9, 44)
    } catch (_) { node = {} }
    // Mirror disagrees (it still holds a block Baritone calls missing — H1):
    // a starved resolve would re-batch the same phantom names every ~2 s
    // and strike-retire live cells (review core-1), so it keeps the
    // watchdog's on-hand verdict, build-stall, minus the 90 s wait: it
    // still strikes, but once per step failure + hold, as on master.
    // ponytail: H1 itself (the mirror/Baritone disagreement) is unfixed
    // until a rig shows mod=0 with node>0 on this line.
    if (ids.some((id) => node[id] > 0)) stall(st, missing, `paused=yes reason=${reason} mismatch`)
    else st.settle(st.resolve, { placed: st.placed, missing: st.missing })
    const say = (slots) => {
      for (const id of ids) {
        const mod = slots ? countExact(slots, id, 9, 44) : '?'
        const off = slots ? countExact(slots, id, 45, 45) : 0
        console.log(`build paused ${st.name} reason=missing:${id} node=${node[id] != null ? node[id] : '?'} mod=${mod}${off ? ` offhand=${off}` : ''}`)
      }
    }
    try {
      Promise.resolve(bot.transport.call('inventory.get', {}))
        .then((inv) => say(inv && Array.isArray(inv.slots) ? inv.slots : null), () => say(null))
    } catch (_) { say(null) }
  } else {
    stall(st, missing, `paused=yes reason=${reason}`)
  }
  release(bot)
}

// No placed growth for STALL_MS: wanted material on hand means the builder
// is wedged (reject); without it the build is starved (resolve missing so
// the FSM fetches). Missing re-reads from the world, never from the last
// event alone.
function watch(bot, st) {
  if (st.settled || Date.now() - st.grownAt < (st.stallMs || STALL_MS)) return
  const missing = refresh(bot, st)
  // Starvation is EXACT-name (round-2 core-5): the builder can only place
  // what it holds — a valid substitute counts a standing cell as done
  // (missingCells), but laying the next one needs the named item itself.
  // A cobblestone cell with only deepslate on hand starves (fetch more),
  // it is not a wedged builder.
  const kinds = new Set((missing || st.cells).map((c) => c.block))
  let starved = true
  for (const want of kinds) {
    if (onHand(bot, want, (w, h) => w === h)) {
      starved = false
      break
    }
  }
  // Settle first, then stop the builder: the watchdog's verdict owns the
  // promise, and a still-running (paused or wedged) builder must never
  // survive untracked (core-2) — the late final finds no live build.
  if (starved) st.settle(st.resolve, { placed: st.placed, missing: st.missing })
  else stall(st, missing, 'paused=no')
  release(bot)
}

module.exports = { installBuild, installBuildStop, handleBuildEvent, missingCells, onHand, defaultSame, STALL_MS, WATCH_MS }
