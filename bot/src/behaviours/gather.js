'use strict'

const { goals } = require('mineflayer-pathfinder')
const recover = require('./recover')
const resources = require('../resources')
const { startFarSearch, stepFarSearch } = require('./scout')
const { NEED_LOGS } = require('../goal')
const { countItems } = require('../perception')

// gather: chop the nearest trees until NEED_LOGS logs are on hand. One
// function, same shape as lead.js/roam.js; registered in BEHAVIOURS under
// 'gather' so the goal arbiter can pick it. Reports via ctx.stepStatus.
// No mineflayer-collectblock: GoalNear walks the bot next to the log and
// bot.dig does the rest. NOT GoalBreakBlock: in the pinned pathfinder 2.4.5
// its isEnd() calls the inner goal without the node and builds it with the
// bot as the world, so the first executor tick throws and kills the process
// (reproduced); GoalNear range 2 stops inside dig reach with pure math.
// Upper logs: the executor pillars on its own — movements.scafoldingBlocks
// already defaults to the kit dirt/cobblestone, the only kit use allowed.
// Foliage is never a target (matching is *_log only).
// ponytail: if the pathfinder ever starts chewing through its own future
// house, gate the blueprint blocks via movements.blocksCantBreak (bead .4).
const FIND_RADIUS = 48
const FIND_COUNT = 64
const STALL_TICKS = 10 // no-displacement walk ticks before a tree is skipped
const UNREACHABLE_FAILS = 3 // consecutive skips before failed:unreachable
const MOVE_TOLERANCE = 0.5
const PLACE_ERROR_STALLS = 3 // consecutive place_error resets with no displacement count as a stall
const PROGRESS_INTERVAL_MS = 10_000 // same cadence as lead.js progress lines

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`
}

function dist(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function logNames(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  return Object.keys(byName).filter((n) => n.endsWith('_log'))
}

function logIds(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!name.endsWith('_log')) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

// Drop a dead goal like stopOnce, but without stop(): its latch would
// swallow the next setGoal issued on the same tick.
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

// Commit a walk target: shared init for the sync-48 hit, a resource-memory
// point and a far-search hit. far marks a fallback origin: if it reads back
// as gone, the point joins skip so the next fallback takes another, not it.
function commitTarget(g, bp, p, name, far) {
  g.pos = p
  g.name = name || 'log'
  g.far = !!far
  g.lastFound = [p]
  g.phase = 'walk'
  g.stalls = 0
  g.issuedKey = null // fresh search, fresh budget (see walk re-issue below)
  g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
}

// Progress is horizontal displacement or a new standing level. Tower jumps
// pump y in place (64<->65.2 with x,z fixed): jumping is standing still.
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

function failFinal(bot, ctx, g, logs, final) {
  g.final = final
  g.atLogs = logs
  ctx.stepStatus = g.final
  say(bot, g.final === 'failed:no-trees' ? 'no trees within 48 blocks' : 'cannot reach the trees')
  clearGoal(bot, ctx)
}

function gather(bot, ctx, target, state) {
  const logs = countItems(bot, (n) => n.endsWith('_log'))
  if (!ctx.gather) ctx.gather = { pos: null, name: 'log', phase: 'walk', skip: new Set(), streak: 0, final: null, atLogs: -1, lastProgressAt: Date.now() }
  const g = ctx.gather
  // A finished attempt stays finished until the world changes (log count):
  // decide() re-picks the step with status 'running', so re-assert here
  // instead of rescanning and re-chatting every tick.
  if (g.final) {
    if (g.atLogs !== logs && ctx.recoverLatch && ctx.recoverLatch.by === 'gather') ctx.recoverLatch = null
    if (g.atLogs === logs) {
      ctx.stepStatus = g.final
      clearGoal(bot, ctx) // no-op once null (acceptance: no setGoal past final)
      return
    }
    g.final = null
    g.skip.clear()
    g.streak = 0
  }
  if (logs >= NEED_LOGS) {
    g.final = 'done'
    g.atLogs = logs
    ctx.stepStatus = 'done'
    say(bot, `got ${NEED_LOGS} logs`)
    clearGoal(bot, ctx)
    return
  }
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  if (!g.pos) {
    // A running staged search resolves before any new sync scan: the 48
    // below stays empty while the 96/160 shells stream in across ticks.
    if (g.phase === 'searchfar') {
      const r = stepFarSearch(bot, g.search)
      if (!r.done) return
      g.search = null
      const hit = r.result && r.result !== 'unknown' ? r.result : null
      if (hit && hit.position && !g.skip.has(keyOf(hit.position))) {
        commitTarget(g, bp, hit.position, hit.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else {
        failFinal(bot, ctx, g, logs, 'failed:no-trees')
      }
      return
    }
    let found = []
    try {
      found = bot.findBlocks({ matching: logIds(bot), maxDistance: FIND_RADIUS, count: FIND_COUNT }) || []
    } catch (_) { found = [] }
    const open = found.filter((p) => !g.skip.has(keyOf(p)))
    if (open.length > 0) {
      let best = open[0]
      for (const p of open) {
        if (dist(p, bp) < dist(best, bp)) best = p
      }
      let name = 'log'
      try {
        const b = bot.blockAt && bot.blockAt(best)
        name = (b && b.name) || 'log'
      } catch (_) { /* name best-effort */ }
      commitTarget(g, bp, best, name, false)
      g.lastFound = open
    } else {
      // atl.5: the sync 48 is empty — next tree from resource memory
      // (atl.1) or the amb staged far search, before any final.
      const names = logNames(bot)
      const mem = names.length > 0 ? resources.nearest(ctx, bp, names) : null
      if (mem && !g.skip.has(keyOf(mem))) {
        commitTarget(g, bp, { x: mem.x, y: mem.y, z: mem.z }, mem.name, true)
        say(bot, `going for ${g.name}, ${Math.round(dist(g.pos, bp))} blocks away`)
      } else {
        let search = null
        try { search = startFarSearch(bot, 'logs') } catch (_) { search = null }
        if (search && search !== 'unknown') {
          g.search = search
          g.phase = 'searchfar'
          return
        }
        failFinal(bot, ctx, g, logs, found.length === 0 ? 'failed:no-trees' : 'failed:unreachable')
        return
      }
    }
  }
  if (logs > 0 && g.skip.size > 0 && logs !== g.seenLogs) {
    // Drops landed: the world changed, old skips may be stale.
    g.skip.clear()
    g.streak = 0
    if (ctx.recoverLatch && ctx.recoverLatch.by === 'gather') ctx.recoverLatch = null
  }
  g.seenLogs = logs
  // Progress line only when the count grew (68p): repeating 'chopping
  // 6/14' every 10 s with no new log reads as a hang.
  if (logs > 0 && logs !== g.progressLogs && Date.now() - (g.lastProgressAt || 0) >= PROGRESS_INTERVAL_MS) {
    g.lastProgressAt = Date.now()
    g.progressLogs = logs
    say(bot, `chopping ${g.name} ${logs}/${NEED_LOGS}`)
  }
  if (g.phase === 'walk') {
    const key = `gather:${g.pos.x},${g.pos.y},${g.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(g.pos.x, g.pos.y, g.pos.z, 2), false)
      const prevKey = ctx.lastGoalKey
      ctx.lastGoalKey = key
      if (key !== g.issuedKey || prevKey === '' || prevKey === 'idle') {
        // Another trunk (or an explicit fresh start): fresh stall budget.
        // The SAME trunk retaken after a fight/bring tick stole the body
        // (68p) only re-issues the stolen goal above — stalls, placeErrors
        // and lastPos survive, and the walk continues below this same tick.
        g.issuedKey = key
        g.stalls = 0
        ctx.placeErrors = 0
        g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
        return
      }
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(g.pos) } catch (_) { block = null }
    if (!block || !block.name || !block.name.endsWith('_log')) {
      // A stale memory/far point joins skip: without this the next fallback
      // re-takes the same gone point instead of moving on to the final.
      if (g.far && g.pos) g.skip.add(keyOf(g.pos))
      g.pos = null // chopped by someone else (reads back as air): search again
      g.far = false
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) {
        g.phase = 'dig'
        g.block = block
      }
    }
    if (g.phase === 'walk') {
      // Stall by displacement, not isMoving (follow.js wedge lesson: a
      // wedged executor keeps reporting moving while the body stands still).
      const grounded = !bot.entity || bot.entity.onGround !== false
      if (progressed(bp, g.lastPos, grounded)) {
        g.stalls = 0
        ctx.placeErrors = 0
        g.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++g.stalls >= STALL_TICKS || (ctx.placeErrors || 0) >= PLACE_ERROR_STALLS) {
        // One strike per trunk, not per log: a stalled trunk's mates would
        // each burn 10 ticks and a strike, failing the step with reachable
        // trees nearby. Skip the whole column at once.
        for (const q of g.lastFound || []) {
          if (q.x === g.pos.x && q.z === g.pos.z) g.skip.add(keyOf(q))
        }
        g.skip.add(keyOf(g.pos))
        g.streak = (g.streak || 0) + 1
        g.pos = null
        if (g.streak >= UNREACHABLE_FAILS) {
          g.final = 'failed:unreachable'
          g.atLogs = logs
          ctx.stepStatus = g.final
          say(bot, 'cannot reach the trees')
          clearGoal(bot, ctx)
          // Detector (ef3): the menu gets one shot before the arbiter moves
          // on. Transition only — re-asserts of the same final stay quiet.
          recover.setStuck(ctx, 'gather', g.lastFound && g.lastFound[0] ? { x: g.lastFound[0].x, y: g.lastFound[0].y, z: g.lastFound[0].z } : null, 'gather')
        }
      }
      return
    }
  }
  if (g.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (mutation:
    // digging every tick breaks the executor and the count).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      g.skip.add(keyOf(g.pos))
      g.pos = null
      return
    }
    ctx.digInFlight = true
    const block = g.block
    const run = async () => {
      try { await bot.dig(block) } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      g.phase = 'pickup'
    }
    void run()
    return
  }
  if (g.phase === 'pickup') {
    const key = `gather-pickup:${g.pos.x},${g.pos.y},${g.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(g.pos.x, g.pos.y, g.pos.z), false)
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the drop is picked up by proximity
    // and the inventory count is the truth — move to the next tree.
    g.pos = null
    g.phase = 'walk'
  }
}

module.exports = gather
