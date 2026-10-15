// idkcraft-neuc.53: bot.mine(names, count, {radius, forbid}) for the
// Baritone body — one MineProcess (#mine) instead of a hand-rolled
// per-tick dig loop.
//
// bot.mine(names, count, opts) -> Promise<{have}> resolving when the pack
// holds target (have-at-call + count), rejecting with Error('mine-noPath'
// | 'mine-stall' | 'mine-leash'). Stall = no inventory gain for 60 s while
// the process is live (one constant, not the 10 s goal STALL_MS); leash =
// the body farther than radius from the start position, or inside the
// caller forbid(pos) — a leash that trips on ENTRY (armed once the body
// leaves it), so a mine that starts inside never fails at once —
// either sends #stop and rejects. Baritone has no per-process region, so
// both guards live here; block protection rides the existing #set avoid
// lists from Movements.
//
// On v1 bot.mine is undefined (no mineflayer implementation — callers
// branch on typeof bot.mine === 'function').
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const MINE_STALL_MS = 60000 // no-gain budget while the process is live
const MINE_TICK_MS = 1000 // leash/stall watch cadence
// Pushed with the verb through the existing #set path (Baritone 1.18.0
// Settings.java defaults; pinned because #set persists to the client
// settings.txt across calls).
const MINE_SETTINGS = [
  ['mineScanDroppedItems', 'true'],
  ['legitMine', 'false'],
  ['mineGoalUpdateInterval', '5'],
]
// Drops counted toward a block name (mirrors Mine.java): a mine for
// stone is done when the cobblestone lands, grass when the dirt does.
const DROPS = { grass_block: 'dirt', stone: 'cobblestone' }

function stripMcPrefix(s) {
  return typeof s === 'string' ? s.replace(/^minecraft:/, '') : s
}

function acceptedNames(names) {
  const out = new Set()
  for (const raw of names || []) {
    const n = stripMcPrefix(raw)
    if (!n || out.has(n)) continue
    out.add(n)
    if (DROPS[n] && !out.has(DROPS[n])) out.add(DROPS[n])
  }
  return out
}

function countHave(bot, names) {
  const want = acceptedNames(names)
  let n = 0
  try {
    for (const it of (bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []) {
      if (it && typeof it.name === 'string' && want.has(it.name)) n += typeof it.count === 'number' ? it.count : 1
    }
  } catch (_) { /* inventory not ready: count 0 */ }
  return n
}

function posOf(bot) {
  const p = bot && bot.entity && bot.entity.position
  return p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'
    ? { x: p.x, y: p.y, z: p.z } : null
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function installMine(bot) {
  bot._mine = null

  bot.mine = (names, count, opts = {}) => {
    if (!Array.isArray(names) || names.length === 0) return Promise.reject(new Error('mine: want non-empty names'))
    const need = Math.floor(count)
    if (!(need > 0)) return Promise.reject(new Error('mine: want positive count'))
    // One mine at a time; behaviours guard with their in-flight flags, so
    // a second call shares the live run instead of forking the process.
    if (bot._mine) return bot._mine.promise
    const radius = opts && typeof opts.radius === 'number' ? opts.radius : 12
    const forbid = opts && typeof opts.forbid === 'function' ? opts.forbid : null
    const stallMs = opts && typeof opts.stallMs === 'number' ? opts.stallMs : MINE_STALL_MS
    const tickMs = opts && typeof opts.tickMs === 'number' ? opts.tickMs : MINE_TICK_MS

    const st = {
      promise: null, id: null, target: null, have: 0, gainAt: Date.now(),
      start: null, armed: true, watch: null, resolve: null, reject: null,
    }
    st.promise = new Promise((resolve, reject) => { st.resolve = resolve; st.reject = reject })
    bot._mine = st
    void run(bot, st, names, need, { radius, forbid, stallMs, tickMs })
    return st.promise
  }
}

function settle(bot, st, err, have) {
  if (st.settled) return
  st.settled = true
  if (st.watch) clearInterval(st.watch)
  st.watch = null
  if (bot._mine === st) bot._mine = null
  if (err) st.reject(err)
  else st.resolve({ have })
}

async function run(bot, st, names, need, { radius, forbid, stallMs, tickMs }) {
  try {
    for (const [k, v] of MINE_SETTINGS) {
      try { await bot.transport.call('baritone.cmd', { command: `#set ${k} ${v}` }) } catch (_) { /* settings best-effort */ }
    }
    // The mine walks itself: clear the live walk first (its late verdict
    // drops — the goal latch is replaced below, like a follow re-issue).
    try { await bot.transport.call('baritone.cmd', { command: '#stop' }) } catch (_) { /* stop best-effort */ }
    st.start = posOf(bot)
    // The forbid leash trips on entry: a mine that starts inside (the
    // body fetching on the castle site) arms once it leaves.
    try { st.armed = !forbid || !forbid(st.start) } catch (_) { st.armed = true }
    const r = await bot.transport.call('baritone.mine', { blocks: names.map(stripMcPrefix), count: need, radius })
    if (!r || r.id == null || typeof r.target !== 'number') throw new Error(`mine: bad baritone.mine reply ${JSON.stringify(r)}`)
    st.id = r.id
    st.target = r.target
    st.have = typeof r.have === 'number' ? r.have : countHave(bot, names)
    st.gainAt = Date.now()
    st.watch = setInterval(() => watch(bot, st, names, { radius, forbid, stallMs }), tickMs)
    if (typeof st.watch.unref === 'function') st.watch.unref()
  } catch (err) {
    settle(bot, st, err instanceof Error ? err : new Error(String(err)))
  }
}

// Leash + stall watch: a trip stops the process and rejects; the mod's
// end event for the stopped mine lands stale and drops (id cleared).
function watch(bot, st, names, { radius, forbid, stallMs }) {
  if (bot._mine !== st || st.settled || st.id == null) return
  const now = posOf(bot)
  if (now && st.start && dist3(now, st.start) > radius) {
    stopAndReject(bot, st, new Error('mine-leash'))
    return
  }
  if (forbid && now) {
    let inside = false
    try { inside = !!forbid(now) } catch (_) { inside = false }
    if (!st.armed && !inside) st.armed = true
    else if (st.armed && inside) {
      stopAndReject(bot, st, new Error('mine-leash'))
      return
    }
  }
  if (Date.now() - st.gainAt > stallMs) {
    stopAndReject(bot, st, new Error('mine-stall'))
  }
}

function stopAndReject(bot, st, err) {
  try {
    if (bot.transport && typeof bot.transport.call === 'function') {
      bot.transport.call('baritone.cmd', { command: '#stop' }).catch(() => { /* stop best-effort */ })
    }
  } catch (_) { /* stop best-effort */ }
  settle(bot, st, err)
}

// Mod mine notifications. A foreign id (a superseded mine, a stop echo)
// drops; a live end resolves below target as noPath, at/above as done.
function handleMineEvent(bot, method, params) {
  if (method !== 'baritone.event' || !params || params.kind !== 'mine') return false
  const st = bot._mine
  if (!st || st.settled || params.id == null || params.id !== st.id) return true
  if (typeof params.have === 'number' && params.have > st.have) {
    st.have = params.have
    st.gainAt = Date.now()
  }
  if (params.active === false) {
    const have = typeof params.have === 'number' ? params.have : st.have
    if (st.target != null && have >= st.target) settle(bot, st, null, have)
    else settle(bot, st, new Error('mine-noPath'))
  }
  return true
}

module.exports = { installMine, handleMineEvent, countHave, acceptedNames, MINE_STALL_MS, MINE_TICK_MS }
