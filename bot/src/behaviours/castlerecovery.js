'use strict'

// Cell-local hard cases use the existing planner seam. Only observed,
// immutable candidates execute; a model answer never supplies coordinates.
// Episodes and cooldowns are transient, leaving castle memory compatible.
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const blueprint = require('../castle')
const build = require('./build')
const flat = require('./flat')
const tools = require('./toolprep')
const { denyReason, isInteractRef } = require('./util')
const { stepGen } = require('../step')

const MAX_CALLS = 3
const MAX_ACTIONS = 3
const EPISODE_MS = 60000
const WAIT_MS = 10000
const BACKOFF_MS = 600000
const MAX_EPISODES = 2
const AIR = new Set(['air', 'cave_air', 'void_air'])
const WHY = new Set(['build-miss', 'no-ref', 'unreachable', 'cell-budget', 'cell-hard-cap'])
const sessions = new WeakMap()
const key = (p) => `${p.x},${p.y},${p.z}`
function block(bot, p) { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)) } catch (_) { return null } }
function name(bot, p) { const b = block(bot, p); return b && b.name }
function position(bot) { return bot.entity && bot.entity.position }
function distance(bot, p) { const b = position(bot); return b ? Math.hypot(b.x - p.x - 0.5, b.y + 1.6 - p.y - 0.5, b.z - p.z - 0.5) : Infinity }
function state(ctx, st) {
  let s = sessions.get(ctx)
  if (!s || s.castle !== st) { s = { castle: st, cooldown: new Map(), until: 0, episode: null }; sessions.set(ctx, s) }
  return s
}
function enabled(ctx) { return process.env.BOT_BODY === 'baritone' && ctx.brain && typeof ctx.brain.plan === 'function' }
function eligible(bot, ctx, st, cells, now, hooks) {
  if (!enabled(ctx) || st.phase === 'prep' || st.toolPrep) return null
  const s = state(ctx, st)
  if (s.episode) return s.episode.cell
  if (s.until > now) return null
  return cells.find((c) => {
    const e = st.blocked && st.blocked[hooks.bkey(st, c.idx)]
    return e && e.retired && (e.until || 0) <= now && (e.recoveries || 0) < MAX_EPISODES && WHY.has(e.why) && blueprint.isPlaceTarget(c.kind) &&
      (s.cooldown.get(c.idx) || 0) <= now && name(bot, c) != null &&
      !hooks.done(bot, c) && hooks.findItem(bot, c.kind, ctx) && distance(bot, c) < 16
  }) || null
}

// qxql.27: the control() terms a menu can check before the castle step
// exists (no step/gen/goal yet); the first false one is named, else null.
function blocker(bot, ctx) {
  if (!ctx.work) return 'no-work'
  if (ctx.paused) return 'paused'
  if (ctx.lead) return 'lead'
  if (ctx.bring) return 'bring'
  if (ctx.inShelter) return 'shelter'
  if (ctx.breath) return 'breath'
  if (ctx.stuck) return 'stuck'
  if (ctx.body && ctx.body.owner !== 'work') return `owner-${ctx.body.owner}`
  if (ctx.lastDecision && ['fight', 'follow'].includes(ctx.lastDecision.action)) return ctx.lastDecision.action
  return null
}
// The menu's word: an eligible cell the castle step would actually start.
function startable(bot, ctx, st, cells, now, hooks) {
  const c = eligible(bot, ctx, st, cells, now, hooks)
  if (!c) return null
  const why = blocker(bot, ctx)
  if (why) {
    const s = state(ctx, st)
    if (s.saidBlocker !== `${c.idx}:${why}`) { s.saidBlocker = `${c.idx}:${why}`; console.log(`castle recovery target=${key(c)} not startable: ${why}`) }
    return null
  }
  return c
}

function control(bot, ctx, ep) {
  return ctx.castle === ep.castle && stepGen(ctx) === ep.gen && ctx.work === ep.work &&
    ctx.work && ctx.step === 'castle' && !ctx.paused && !ctx.lead && !ctx.bring &&
    !ctx.inShelter && !ctx.breath && !ctx.stuck &&
    (!ctx.body || ctx.body.owner === 'work') &&
    !(ctx.lastDecision && ['fight', 'follow'].includes(ctx.lastDecision.action)) &&
    (!bot.pathfinder.goal || bot.pathfinder.goal === ep.goal)
}
function say(ep, action, outcome) {
  console.log(`castle recovery target=${key(ep.cell)} action=${action} outcome=${outcome} calls=${ep.calls} attempts=${ep.actions}`)
}
function end(s, ep, now, outcome) {
  if (s.episode !== ep) return
  // Only a real planner invocation spends the lifetime episode budget.
  // Paid calls stay charged even when a later fight/timeout preempts them.
  if (ep.calls === 0) ep.entry.recoveries = Math.max(0, ep.entry.recoveries - 1)
  ep.cancelled = true
  s.cooldown.set(ep.cell.idx, now + BACKOFF_MS)
  s.until = now + 30000 // many old holes must not create one model call per tick
  s.episode = null
  say(ep, 'episode', outcome)
}
function signature(bot, p) {
  const b = block(bot, p)
  return b ? `${b.name}:${b.stateId == null ? '' : b.stateId}` : 'unloaded'
}
function stamp(bot, points) { return points.map((p) => [Object.freeze({ x: p.x, y: p.y, z: p.z }), signature(bot, p)]) }
function unchanged(bot, stamps) { return stamps.every(([p, v]) => signature(bot, p) === v) }
function safeDig(bot, ctx, p) {
  const b = block(bot, p)
  // Strict shared default-deny preserves owner builds and containers;
  // unlike normal footprint clearing, recovery never opts into castleClear.
  return b && !AIR.has(b.name) && distance(bot, p) <= flat.REACH_DIG &&
    !flat.threatenedSelf(bot, p.x, p.y, p.z) && !flat.threatenedByPlayer(bot, p.x, p.y, p.z) && !denyReason(bot, b, ctx)
}
function standable(bot, p, at) {
  const feet = block(bot, p), head = block(bot, { ...p, y: p.y + 1 }), floor = block(bot, { ...p, y: p.y - 1 })
  return feet && head && floor && AIR.has(feet.name) && AIR.has(head.name) &&
    floor.boundingBox === 'block' && !flat.isLiquidName(floor.name) &&
    !blueprint.isPlaceTarget((at.get(key(p)) || {}).kind) &&
    !blueprint.isPlaceTarget((at.get(key({ ...p, y: p.y + 1 })) || {}).kind) &&
    !flat.cellOccupiedByPlayer(bot, p.x, p.y, p.z)
}
function menu(bot, ctx, ep, hooks) {
  const c = ep.cell, st = ep.castle
  const { at } = blueprint.absPlan(st.site, st.rot, st.blueprintVersion)
  const out = []
  const add = (id, type, p, text, extra = {}) => {
    const points = [c, p]
    if (extra.ref) points.push(extra.ref.ref.position)
    if (type === 'stance') points.push({ ...p, y: p.y + 1 }, { ...p, y: p.y - 1 })
    const action = Object.freeze({ id, type, p: Object.freeze({ x: p.x, y: p.y, z: p.z }), text, stamps: stamp(bot, points), ...extra })
    // A failed identical action only becomes eligible after its observed
    // world facts change. Prior outcomes are carried into the next prompt.
    const sig = JSON.stringify(action.stamps)
    if (!ep.recent.some((a) => a.id === id && a.signature === sig && a.outcome !== 'enabled' && a.outcome !== 'correct')) out.push(action)
  }
  if (safeDig(bot, ctx, c)) add('clear_target', 'clear', c, `Clear observed ${name(bot, c)} at ${key(c)} with a harvesting tool, then verify it changed.`)
  const under = { x: c.x, y: c.y - 1, z: c.z }
  const filler = hooks.fillItem(bot, ctx)
  const ref = AIR.has(name(bot, under)) ? build.findRef(bot, new Vec3(under.x, under.y, under.z)) : null
  // Off-plan supports only: never fill blueprint air, moat, doors or
  // another construction. They remain owned scaffold for normal sweeping.
  if (AIR.has(name(bot, c)) && !at.has(key(under)) && !blueprint.inCastleApron(ctx, under) &&
      filler && ref && distance(bot, under) <= build.PLACE_REACH &&
      !flat.cellOccupiedSelf(bot, under.x, under.y, under.z) && !flat.cellOccupiedByPlayer(bot, under.x, under.y, under.z)) {
    add('support_below', 'support', under, `Place owned ${filler.name} support below the missing cell at ${key(under)}, verify support, then retry builder.`, { ref, itemName: filler.name })
  }
  const stances = []
  for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
    const p = { x: c.x + dx, y: c.y, z: c.z + dz }
    const b = position(bot)
    if (!b || Math.hypot(b.x - p.x - 0.5, b.y - p.y, b.z - p.z - 0.5) < 0.75 || !standable(bot, p, at)) continue
    stances.push(p)
    if (!['stone', 'planks', 'frame'].includes(c.kind)) continue
    add(`stance_${stances.length}`, 'stance', p, `Repath to observed dry stance ${key(p)} and try placing the target cube from there; only observed target correctness counts as an effect.`)
    if (stances.length >= 2) break
  }
  const retryRef = build.findRef(bot, new Vec3(c.x, c.y, c.z))
  if (['stone', 'planks', 'frame'].includes(c.kind) && AIR.has(name(bot, c)) && retryRef && distance(bot, c) <= build.PLACE_REACH &&
      !flat.cellOccupiedSelf(bot, c.x, c.y, c.z) && !flat.cellOccupiedByPlayer(bot, c.x, c.y, c.z)) {
    add('retry_cell', 'retry', c, 'Retry direct placement only into this currently open supported cell; success requires the expected block in the world.', { ref: retryRef })
  }
  out.push(Object.freeze({ id: 'defer', type: 'defer', text: 'No useful safe action now; keep the hole honest and back off.' }))
  return { actions: out, stances }
}
function prompt(bot, ctx, ep, choices, hooks) {
  const c = ep.cell
  const voxels = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    voxels.push({ ...p, block: name(bot, p) || 'unloaded' })
  }
  const item = hooks.findItem(bot, c.kind, ctx)
  return {
    state: { goal: 'finish the castle; enable this missing blueprint cell',
      target: { x: c.x, y: c.y, z: c.z, kind: c.kind, expected: item && item.name, occupant: name(bot, c) },
      progress: ep.castle.progress || null, reason: (ep.castle.blocked[hooks.bkey(ep.castle, c.idx)] || {}).why,
      body: position(bot), voxels, stances: choices.stances,
      inventory: (bot.inventory.items() || []).map((it) => ({ name: it.name, count: it.count })),
      recent: ep.recent.map(({ id, outcome }) => ({ action: id, outcome })) },
    instructions: 'Diagnose the target-centered obstacle. Choose ONE exact offered option ID; prefer a safe action with an observed useful effect. Prior unchanged attempts must not repeat. Never invent commands or coordinates.',
    criteria: Object.fromEntries(choices.actions.map((a) => [a.id, a.text])),
  }
}

function effect(bot, ep, a, hooks) {
  if (hooks.done(bot, ep.cell)) return 'correct'
  if (a.type === 'clear' && AIR.has(name(bot, a.p))) return 'enabled'
  if (a.type === 'support' && name(bot, a.p) === a.itemName) return 'enabled'
  return 'unchanged'
}
function record(bot, ctx, s, ep, a, hooks) {
  if (!control(bot, ctx, ep) || ep.cancelled) return
  const outcome = effect(bot, ep, a, hooks)
  ep.recent.push({ id: a.id, signature: JSON.stringify(a.stamps), outcome })
  say(ep, a.id, outcome)
  ep.pending = false
  if (outcome === 'enabled' || outcome === 'correct') {
    if (a.type === 'support') hooks.own(ctx, a.p, a.itemName)
    hooks.resume(ctx, ep.castle, ep.cell, outcome)
    end(s, ep, Date.now(), outcome)
  }
}

async function act(bot, ctx, s, ep, a, hooks, afterWalk = false) {
  const live = () => !ep.cancelled && control(bot, ctx, ep) && unchanged(bot, a.stamps)
  try {
    if (!live()) return
    // bridge/build.js stopBuild explicitly cancels BuilderProcess even
    // when no pathfinder goal exists. Clear our old path before local work.
    if (typeof bot.stopBuild === 'function') await bot.stopBuild()
    if (!live()) return
    bot.pathfinder.setGoal(null)
    ep.goal = null
    if (!live()) return
    if (a.type === 'clear') {
      const b = block(bot, a.p)
      if (!safeDig(bot, ctx, a.p)) return
      const req = tools.requirement(b)
      const tool = req ? tools.carried(bot, { ...req, harvestTools: b.harvestTools }) : bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(b)
      if (req && !req.hand && !tool) return
      if (b.harvestTools && !(tool && b.harvestTools[tool.type])) return
      if (tool) await bot.equip(tool, 'hand')
      if (!live() || !safeDig(bot, ctx, a.p)) return
      await bot.dig(block(bot, a.p))
    } else if (a.type === 'support') {
      const item = hooks.fillItem(bot, ctx)
      const ref = build.findRef(bot, new Vec3(a.p.x, a.p.y, a.p.z))
      if (!item || item.name !== a.itemName || !ref || isInteractRef(ref.ref.name)) return
      await bot.equip(item, 'hand')
      if (!live() || distance(bot, a.p) > build.PLACE_REACH || flat.cellOccupiedSelf(bot, a.p.x, a.p.y, a.p.z) || flat.cellOccupiedByPlayer(bot, a.p.x, a.p.y, a.p.z)) return
      await bot.placeBlock(ref.ref, ref.face)
    } else if (a.type === 'stance' && !afterWalk) {
      ep.goal = new goals.GoalBlock(a.p.x, a.p.y, a.p.z)
      bot.pathfinder.setGoal(ep.goal)
      ep.walk = a
      return
    } else if (a.type === 'retry' || a.type === 'stance') {
      const item = hooks.findItem(bot, ep.cell.kind, ctx)
      const p = ep.cell
      const ref = build.findRef(bot, new Vec3(p.x, p.y, p.z))
      if (!item || !ref || !live() || !AIR.has(name(bot, p))) return
      const reference = signature(bot, ref.ref.position)
      await bot.equip(item, 'hand')
      if (!live() || signature(bot, ref.ref.position) !== reference || distance(bot, p) > build.PLACE_REACH || flat.cellOccupiedSelf(bot, p.x, p.y, p.z) || flat.cellOccupiedByPlayer(bot, p.x, p.y, p.z)) return
      await bot.placeBlock(ref.ref, ref.face)
    }
  } catch (err) {
    if (err && err.message === 'build-preempted' && control(bot, ctx, ep)) end(s, ep, Date.now(), 'preempted')
    // Other RPC failures still get the same honest world-effect read.
  }
  finally {
    if (!ep.walk && control(bot, ctx, ep) && !ep.cancelled) record(bot, ctx, s, ep, a, hooks)
  }
}

function tick(bot, ctx, st, cells, now, hooks) {
  const s = state(ctx, st)
  let ep = s.episode
  if (ep && (!control(bot, ctx, ep) || now - ep.started >= EPISODE_MS || (ep.pending && now - ep.waitAt >= WAIT_MS))) {
    // Cancel only our state: a new body's goal must never be cleared by
    // a stale episode or its late asynchronous completion.
    const owned = control(bot, ctx, ep)
    if (owned && ep.actions) {
      try { if (typeof bot.stopBuild === 'function') Promise.resolve(bot.stopBuild()).catch(() => {}) } catch (_) { /* stop best-effort */ }
      try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (_) { /* stop best-effort */ }
      if (ep.goal && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
    }
    end(s, ep, now, owned ? 'timeout' : 'preempted')
    return false
  }
  if (!ep) {
    const c = eligible(bot, ctx, st, cells, now, hooks)
    if (!c) return false
    ep = { castle: st, cell: Object.freeze({ ...c }), work: ctx.work, gen: stepGen(ctx), started: now,
      calls: 0, actions: 0, recent: [], pending: false, goal: bot.pathfinder.goal || null }
    if (!control(bot, ctx, ep)) {
      const why = blocker(bot, ctx) || (ctx.step !== 'castle' ? `step-${ctx.step}` : 'goal-or-gen')
      if (s.saidBlocker !== `${c.idx}:${why}`) { s.saidBlocker = `${c.idx}:${why}`; console.log(`castle recovery target=${key(c)} not started: ${why}`) }
      return false
    }
    const entry = st.blocked[hooks.bkey(st, c.idx)]
    entry.recoveries = (entry.recoveries || 0) + 1
    ep.entry = entry
    s.episode = ep
  }
  st.status = `diagnosing obstacle at ${key(ep.cell)}`
  if (ep.walk) {
    if (!bot.pathfinder.isMoving()) {
      const a = ep.walk, b = position(bot)
      ep.walk = null
      if (b && Math.hypot(b.x - a.p.x - 0.5, b.y - a.p.y, b.z - a.p.z - 0.5) < 0.75) {
        ep.waitAt = now
        act(bot, ctx, s, ep, a, hooks, true)
      } else record(bot, ctx, s, ep, a, hooks)
    }
    return true
  }
  if (ep.pending) return true
  if (ep.answer) {
    const a = ep.choices.find((o) => o.id === ep.answer.step)
    if (!a || a.type === 'defer') { end(s, ep, now, a ? 'deferred' : 'invalid'); return true }
    if (!unchanged(bot, a.stamps)) { ep.answer = null; ep.recent.push({ id: a.id, signature: JSON.stringify(a.stamps), outcome: 'world-changed' }); return true }
    if (a.type === 'clear') {
      const b = block(bot, a.p), req = tools.requirement(b)
      if (req && !tools.carried(bot, { ...req, harvestTools: b.harvestTools }) &&
          (!req.hand || !((st.toolPrepBackoff || {})[req.kind] > now))) {
        // A missing tool is a prerequisite, not geometry work. End this
        // episode before toolprep takes the tick (its own budget applies).
        end(s, ep, now, 'preparing-tool')
        s.cooldown.set(ep.cell.idx, now + 30000)
        tools.ready(bot, ctx, st, b)
        return true
      }
    }
    ep.answer = null
    ep.actions++
    ep.pending = true; ep.waitAt = now
    act(bot, ctx, s, ep, a, hooks)
    return true
  }
  if (!hooks.findItem(bot, ep.cell.kind, ctx) || name(bot, ep.cell) == null || hooks.done(bot, ep.cell)) { end(s, ep, now, 'unavailable-or-correct'); return false }
  if (ep.calls >= MAX_CALLS || ep.actions >= MAX_ACTIONS) { end(s, ep, now, 'exhausted'); return true }
  const choices = menu(bot, ctx, ep, hooks)
  if (choices.actions.length === 1) { end(s, ep, now, 'no-safe-action'); return true }
  ep.choices = choices.actions
  ep.pending = true; ep.waitAt = now
  const req = prompt(bot, ctx, ep, choices, hooks)
  Promise.resolve().then(() => {
    if (!control(bot, ctx, ep) || ep.cancelled) return null
    ep.calls++
    return ctx.brain.plan(req)
  }).then(
    (answer) => { if (control(bot, ctx, ep) && !ep.cancelled) { ep.pending = false; ep.answer = answer && typeof answer.step === 'string' ? { step: answer.step } : { step: '' } } },
    () => { if (control(bot, ctx, ep) && !ep.cancelled) end(s, ep, Date.now(), 'planner-unavailable') },
  )
  return true
}

module.exports = { startable, blocker, eligible, tick, MAX_CALLS, MAX_EPISODES }
