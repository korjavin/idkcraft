// idkcraft-neuc.54: bot.buildCells over baritone.build (Baritone BuilderProcess).
//
// bot.buildCells(name, origin, cells, {forbid}) -> Promise<{placed, missing}>.
// cells = [{dx,dy,dz,block}] offsets from origin {x,y,z} with plain block
// names ('oak_planks'). The mod owns approach, scaffolding and re-lay; the
// adapter only tracks progress/end through baritone.event {kind:'build'}:
// {kind:'build', name, placed, missing, active} (secondly while live, final
// active:false when the builder idles — done, out of world, or #stop).
//
// End semantics, mirroring today's place flow:
// - material exhausted: Baritone pauses the build when it holds none of the
//   next block, so no placed growth ever comes. The watchdog below resolves
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

// The mod accepts any same-class wood for a schematic cell; the material
// check must too, or a birch-held oak-planks build reads starved forever.
function onHand(bot, want) {
  try {
    const items = (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    const cls = suffixClass(want)
    for (const it of items) {
      if (!it || typeof it.name !== 'string' || !(it.count > 0)) continue
      if (it.name === want) return true
      if (cls && it.name.endsWith(cls)) return true
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
function missingCells(bot, origin, cells) {
  const out = []
  for (const c of cells) {
    const cur = blockNameAt(bot, origin.x + c.dx, origin.y + c.dy, origin.z + c.dz)
    if (cur == null) { out.push(c); continue }
    if (cur === c.block) continue
    const cls = suffixClass(c.block)
    if (!(cls && cur.endsWith(cls))) out.push(c)
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
    return new Promise((resolve, reject) => {
      const st = {
        name,
        origin: { x: origin.x, y: origin.y, z: origin.z },
        cells: cells.map((c) => ({ dx: c.dx, dy: c.dy, dz: c.dz, block: c.block })),
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
      st.timer = setInterval(() => watch(bot, st), timing.watchMs || WATCH_MS)
      if (typeof st.timer.unref === 'function') st.timer.unref()
      bot.transport.call('baritone.build', {
        name,
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
// callers that hold no pathfinder goal to stop.
function installBuildStop(bot) {
  bot.stopBuild = () => bot.transport.call('baritone.cmd', { command: '#stop' })
    .then((r) => ({ stopped: true, id: r && r.id != null ? r.id : null }))
}

// The mod's build notifications only (kind:'build'); true when consumed.
// A foreign name (a replaced build's late final) still consumes: the
// adapter settles a build on its own final only.
function handleBuildEvent(bot, method, params) {
  if (method !== 'baritone.event' || !params || params.kind !== 'build') return false
  const st = bot._build
  if (!st) return true
  if (params.name != null && params.name !== st.name) return true
  if (typeof params.placed === 'number' && params.placed > st.placed) {
    st.placed = params.placed
    st.grownAt = Date.now()
  }
  if (typeof params.missing === 'number') st.missing = params.missing
  if (params.active === false) st.settle(st.resolve, { placed: st.placed, missing: st.missing })
  return true
}

// No placed growth for STALL_MS: wanted material on hand means the builder
// is wedged (reject); without it the build is starved (resolve missing so
// the FSM fetches). Missing re-reads from the world, never from the last
// event alone.
function watch(bot, st) {
  if (st.settled || Date.now() - st.grownAt < (st.stallMs || STALL_MS)) return
  let missing = null
  try {
    missing = missingCells(bot, st.origin, st.cells)
  } catch (_) {
    missing = null
  }
  if (missing) {
    st.missing = missing.length
    st.placed = st.cells.length - missing.length
  }
  const kinds = new Set((missing || st.cells).map((c) => c.block))
  for (const want of kinds) {
    if (onHand(bot, want)) {
      st.settle(st.reject, new Error('build-stall'))
      return
    }
  }
  st.settle(st.resolve, { placed: st.placed, missing: st.missing })
}

module.exports = { installBuild, installBuildStop, handleBuildEvent, missingCells, onHand, STALL_MS, WATCH_MS }
