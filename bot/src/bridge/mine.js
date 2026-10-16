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
  // Rig evidence (neuc.53 instrumented runs): a 64-target composite never
  // completes a calc under rig load — every second reissues the goal and
  // blacklists the closest instance, 60 s of motionless spam. Twelve
  // nearest keeps calcs ms-scale, so paths follow or fail fast.
  ['mineMaxOreLocationsCount', '12'],
  // A mine digs by definition: a no-dig walk lease (gocastle/gohome set
  // canDig false) would leave MineProcess targetless on its first tick
  // and the leg would read noPath (round-1 core-3). The mirror below keeps
  // the adapter's diff honest so the next lease restores its own value.
  ['allowBreak', 'true'],
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

// Cancel the live mine from the adapter's goal latch (_stopPath, _setGoal:
// a new goal supersedes the mine). Sends #stop and rejects with
// mine-stopped; the behaviour gen guards drop the stale settle. True when
// a live mine was cancelled.
function cancelMine(bot, err) {
  const st = bot && bot._mine
  if (!st || st.settled) return false
  try {
    if (bot.transport && typeof bot.transport.call === 'function') {
      bot.transport.call('baritone.cmd', { command: '#stop' }).catch(() => { /* stop best-effort */ })
    }
  } catch (_) { /* stop best-effort */ }
  settle(bot, st, err instanceof Error ? err : new Error('mine-stopped'))
  return true
}

function installMine(bot) {
  bot._mine = null
  bot.cancelMine = (err) => cancelMine(bot, err)

  bot.mine = (names, count, opts = {}) => {
    if (!Array.isArray(names) || names.length === 0) return Promise.reject(new Error('mine: want non-empty names'))
    const need = Math.floor(count)
    if (!(need > 0)) return Promise.reject(new Error('mine: want positive count'))
    // One mine at a time; behaviours guard with their in-flight flags, so
    // a second call shares the live run instead of forking the process.
    if (bot._mine) return bot._mine.promise
    const radius = opts && typeof opts.radius === 'number' ? opts.radius : 12
    const forbid = opts && typeof opts.forbid === 'function' ? opts.forbid : null
    const guard = opts && opts.guard && typeof opts.guard === 'object' ? opts.guard : null
    const stallMs = opts && typeof opts.stallMs === 'number' ? opts.stallMs : MINE_STALL_MS
    const tickMs = opts && typeof opts.tickMs === 'number' ? opts.tickMs : MINE_TICK_MS

    const st = {
      promise: null, id: null, target: null, have: 0, gainAt: Date.now(),
      start: null, armed: true, watch: null, resolve: null, reject: null,
    }
    st.promise = new Promise((resolve, reject) => { st.resolve = resolve; st.reject = reject })
    bot._mine = st
    void run(bot, st, names, need, { radius, forbid, guard, stallMs, tickMs })
    return st.promise
  }
}

function settle(bot, st, err, have) {
  if (st.settled) return
  st.settled = true
  if (st.watch) clearInterval(st.watch)
  st.watch = null
  if (bot._mine === st) bot._mine = null
  // Lift the goal marker (round-3 core-1): only when it is still ours — a
  // superseding goal or stop already replaced it.
  try {
    if (bot.pathfinder && bot.pathfinder.goal && bot.pathfinder.goal.mine === true) bot.pathfinder.goal = null
  } catch (_) { /* marker best-effort */ }
  if (err) st.reject(err)
  else st.resolve({ have })
}

async function run(bot, st, names, need, { radius, forbid, guard, stallMs, tickMs }) {
  // A cancel between the awaits below (fight preemption, owner stop)
  // settles st through cancelMine; every leg checks it, so a dead run
  // sends nothing more (round-2 core-3).
  const dead = () => st.settled || bot._mine !== st
  try {
    for (const [k, v] of MINE_SETTINGS) {
      try { await bot.transport.call('baritone.cmd', { command: `#set ${k} ${v}` }) } catch (_) { /* settings best-effort */ }
      if (dead()) return
    }
    // Mirror the allowBreak pin into the adapter's diff: the next lease
    // push must see the live value, or a canDig lease would read synced
    // while Baritone still breaks (round-1 core-3).
    try { if (bot._settings) bot._settings.allowBreak = 'true' } catch (_) { /* mirror best-effort */ }
    // The mine walks itself: clear the live walk first, superseding the
    // latch silently like a follow re-issue (_maybeReissueFollow) — the
    // stopped event for the old goal drops. The mine then parks a marker
    // as pathfinder.goal (round-3 core-1/core-3): stopOnce/clearGoal and
    // the body owner-switch cleanup gate on the goal, not on isMoving, so
    // the marker — not a moving latch — is what lets a stop reach the
    // mine. isMoving stays false while mining (the mine has its own 60 s
    // stall; the stuck machine must not count it).
    try { await bot.transport.call('baritone.cmd', { command: '#stop' }) } catch (_) { /* stop best-effort */ }
    if (dead()) return
    bot._boundSeq = bot._cmdSeq
    bot._goalId = null
    bot._pathing = false
    bot._follow = null
    try { if (bot.pathfinder) bot.pathfinder.goal = { mine: true } } catch (_) { /* marker best-effort */ }
    st.start = posOf(bot)
    // The forbid leash trips on entry: a mine that starts inside (the
    // body fetching on the castle site) arms once it leaves.
    try { st.armed = !forbid || !forbid(st.start) } catch (_) { st.armed = true }
    const params = { blocks: names.map(stripMcPrefix), count: need, radius }
    if (guard) params.guard = guard
    const r = await bot.transport.call('baritone.mine', params)
    if (!r || r.id == null || typeof r.target !== 'number') throw new Error(`mine: bad baritone.mine reply ${JSON.stringify(r)}`)
    // A goal that superseded us while the verb was in flight already
    // settled through cancelMine, whose #stop follows the verb on the
    // wire — send nothing more (round-3 core-4: an extra #stop here would
    // cancel the fresh #goto that superseded us), never arm the watch.
    if (dead()) return
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
    // A guarded cell broke: reject even at target — the leg must end
    // loudly (the hold parks it) instead of succeeding over the damage.
    if (params.status === 'guard') {
      settle(bot, st, new Error('mine-leash'))
      return true
    }
    const have = typeof params.have === 'number' ? params.have : st.have
    if (st.target != null && have >= st.target) settle(bot, st, null, have)
    else settle(bot, st, new Error('mine-noPath'))
  }
  return true
}

module.exports = { installMine, handleMineEvent, cancelMine, countHave, acceptedNames, MINE_STALL_MS, MINE_TICK_MS }
