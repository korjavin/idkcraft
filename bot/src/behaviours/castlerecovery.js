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
const { voxelSlice, LEGEND } = require('../stall-state')

const MAX_CALLS = 3
const MAX_ACTIONS = 3
const EPISODE_MS = 60000
const WAIT_MS = 10000
const BACKOFF_MS = 600000
const MAX_EPISODES = 2
const AIR = new Set(['air', 'cave_air', 'void_air'])
// qxql.32: 'unloaded' too — a cell retired on cache gaps re-enters via the planner once its column reads (eligible needs name != null).
const WHY = new Set(['build-miss', 'no-ref', 'unloaded', 'unreachable', 'cell-budget', 'cell-hard-cap'])
const sessions = new WeakMap()
const key = (p) => `${p.x},${p.y},${p.z}`
function block(bot, p) { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)) } catch (_) { return null } }
function name(bot, p) { const b = block(bot, p); return b && b.name }
function position(bot) { return bot.entity && bot.entity.position }
function distance(bot, p) { const b = position(bot); return b ? Math.hypot(b.x - p.x - 0.5, b.y + 1.6 - p.y - 0.5, b.z - p.z - 0.5) : Infinity }
// An 8hx3 cell episode is running (unstick must not take the tick from it).
function busy(ctx) { const s = sessions.get(ctx); return !!(s && s.episode) }
function state(ctx, st) {
  let s = sessions.get(ctx)
  if (!s || s.castle !== st) { s = { castle: st, cooldown: new Map(), until: 0, episode: null }; sessions.set(ctx, s) }
  return s
}
// No escalation model (no key) keeps the old menu.
function escalation(ctx) { return /^(1|true|yes)$/i.test(String(process.env.CASTLE_LLM_ESCALATION || '')) && !!escalator(ctx) }
// 8hx3: the escalation planner; tests (or another brain) set ctx.brain.escalate.
function escalator(ctx) { return (ctx.brain && ctx.brain.escalate) || (process.env.ANTHROPIC_API_KEY ? llmEscalate : null) }
function enabled(ctx) {
  if (process.env.BOT_BODY !== 'baritone' || !ctx.brain) return false
  return escalation(ctx) || typeof ctx.brain.plan === 'function'
}
function eligible(bot, ctx, st, cells, now, hooks) {
  if (!enabled(ctx) || st.phase === 'prep' || st.toolPrep) return null
  const s = state(ctx, st)
  if (s.episode) return s.episode.cell
  if (s.until > now) return null
  return cells.find((c) => {
    const e = st.blocked && st.blocked[hooks.bkey(st, c.idx)]
    if (!e || !e.retired || !blueprint.isPlaceTarget(c.kind)) return false
    const why = (e.until || 0) > now ? 'until' : (e.recoveries || 0) >= MAX_EPISODES ? 'recoveries' : !WHY.has(e.why) ? `why-${e.why}`
      : (s.cooldown.get(c.idx) || 0) > now ? 'cooldown' : name(bot, c) == null ? 'unloaded' : hooks.done(bot, c) ? 'done'
        : !hooks.findItem(bot, c.kind, ctx) ? 'no-item' : distance(bot, c) >= 16 ? 'far' : null
    noteSkip(s, c, why)
    return !why
  }) || null
}
// A retired cell recovery skips logs its first failing term once per change
// (2026-11-11: 4 torch holes held torches yet never got an episode).
function noteSkip(s, c, why) {
  s.skips = s.skips || new Map()
  if (s.skips.get(c.idx) === why) return
  s.skips.set(c.idx, why)
  if (why) console.log(`castle recovery skip ${c.kind} ${key(c)} why=${why}`)
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
  // Only fight takes the body from work: a stub 'follow' (any player in range)
  // runs the work tick anyway, so it blocked every recovery while someone was online.
  if (ctx.lastDecision && ctx.lastDecision.action === 'fight') return 'fight'
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
    !(ctx.lastDecision && ctx.lastDecision.action === 'fight') &&
    (!bot.pathfinder.goal || bot.pathfinder.goal === ep.goal)
}
function say(ep, action, outcome) {
  console.log(`castle recovery target=${key(ep.cell)} action=${action} outcome=${outcome} calls=${ep.calls} attempts=${ep.actions}`)
}
function end(s, ep, now, outcome) {
  if (s.episode !== ep) return
  if (ep.esc && ep.plan) console.log(`escalation target=${key(ep.cell)} kind=${ep.cell.kind} call=${ep.calls} plan=${ep.plan} outcome=${outcome}`)
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
const KEEP = /chest|barrel|shulker|furnace|smoker|hopper|dispenser|dropper|brewing|_bed$/
function safeDig(bot, ctx, p, escape = false) {
  const b = block(bot, p)
  // Strict shared default-deny preserves owner builds and containers;
  // unlike normal footprint clearing, recovery never opts into castleClear.
  return b && !AIR.has(b.name) && distance(bot, p) <= flat.REACH_DIG &&
    !flat.threatenedSelf(bot, p.x, p.y, p.z) && !flat.threatenedByPlayer(bot, p.x, p.y, p.z) && (!denyReason(bot, b, ctx) || (escape && denyReason(bot, b, ctx) === 'protected'))
}
// qxql.29: off-plan cells are free to stand in; isPlaceTarget(undefined) is
// true, so the old check refused every stance outside the blueprint.
function planned(at, p) { const c = at.get(key(p)); return !!c && blueprint.isPlaceTarget(c.kind) }
function standable(bot, p, at) {
  const feet = block(bot, p), head = block(bot, { ...p, y: p.y + 1 }), floor = block(bot, { ...p, y: p.y - 1 })
  return feet && head && floor && AIR.has(feet.name) && AIR.has(head.name) &&
    floor.boundingBox === 'block' && !flat.isLiquidName(floor.name) &&
    !planned(at, p) && !planned(at, { ...p, y: p.y + 1 }) &&
    !flat.cellOccupiedByPlayer(bot, p.x, p.y, p.z)
}
// qxql.29: torch too (a wall or floor ref gives wall_torch/torch, both match).
// Stairs (2026-11-11 prod: 5 of 14 last holes) place faced via the builder.
const PLACE_KINDS = ['stone', 'planks', 'frame', 'torch', 'stairs']
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
  // qxql.29: stances are any observed dry spot within place reach of the
  // cell (nearest first, at most 2), not only +-2 on the cell's own row —
  // a wall cell high up had none, so a bot out of reach got only 'defer'.
  const stances = []
  const reach = (p) => Math.hypot(p.x - c.x, p.y + 1.6 - c.y - 0.5, p.z - c.z)
  const near = []
  for (let dy = -3; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    if ((dx || dz || dy > 0 || dy < -1) && reach(p) <= build.PLACE_REACH) near.push(p)
  }
  near.sort((p, q) => reach(p) - reach(q))
  for (const p of near) {
    const b = position(bot)
    if (!b || Math.hypot(b.x - p.x - 0.5, b.y - p.y, b.z - p.z - 0.5) < 0.75 || !standable(bot, p, at)) continue
    stances.push(p)
    if (!PLACE_KINDS.includes(c.kind)) continue
    add(`stance_${stances.length}`, 'stance', p, `Repath to observed dry stance ${key(p)} and try placing the target cube from there; only observed target correctness counts as an effect.`)
    if (stances.length >= 2) break
  }
  const retryRef = build.findRef(bot, new Vec3(c.x, c.y, c.z), c.kind === 'stairs' ? { excludeTop: true } : undefined) // the act's own ref rule
  if (PLACE_KINDS.includes(c.kind) && AIR.has(name(bot, c)) && retryRef && distance(bot, c) <= build.PLACE_REACH &&
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
      const stairs = p.kind === 'stairs'
      if (stairs && !(p.face && hooks.placeStairs)) return
      const ref = build.findRef(bot, new Vec3(p.x, p.y, p.z), stairs ? { excludeTop: true } : undefined)
      if (!item || !ref || !live() || !AIR.has(name(bot, p))) return
      const reference = signature(bot, ref.ref.position)
      await bot.equip(item, 'hand')
      if (!live() || signature(bot, ref.ref.position) !== reference || distance(bot, p) > build.PLACE_REACH || flat.cellOccupiedSelf(bot, p.x, p.y, p.z) || flat.cellOccupiedByPlayer(bot, p.x, p.y, p.z)) return
      if (stairs) await hooks.placeStairs(bot, ref, p)
      else await bot.placeBlock(ref.ref, ref.face)
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
  if (ep && (!control(bot, ctx, ep) || now - ep.started >= (escalation(ctx) ? ESC_EPISODE_MS : EPISODE_MS) || (ep.pending && now - ep.waitAt >= WAIT_MS))) {
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
      calls: 0, actions: 0, recent: [], history: [], pending: false, goal: bot.pathfinder.goal || null }
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
  if (escalation(ctx)) return escTick(bot, ctx, s, ep, now, hooks)
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

// --- 8hx3: generic LLM escalation over safe primitives (CASTLE_LLM_ESCALATION=1).
// The model writes a short plan of walk_to/dig/place/wait/ask_owner; safety
// lives in each primitive (refusals go back to the model as outcomes), and
// every result is read from the world, never from a resolved RPC.
const ESC_EPISODE_MS = 240000
const ESC_MAX_STEPS = 4
const ESC_RANGE = 6 // primitives stay near the target cell
const ESC_TIMEOUT_MS = 9000 // under WAIT_MS: a hung call ends as timeout, not a late plan
const ESC_SYSTEM = 'You unstick a Minecraft bot that failed to place one castle block. Answer with JSON only: ' +
  '{"plan":[{"op":"walk_to","x":0,"y":0,"z":0},{"op":"dig","x":0,"y":0,"z":0},{"op":"place","item":"name","x":0,"y":0,"z":0},{"op":"wait","s":3},{"op":"ask_owner","text":"..."}]} ' +
  `with at most ${ESC_MAX_STEPS} steps. Coordinates are block coordinates; walk_to targets the feet cell. ` +
  'Unsafe steps (owner/protected blocks, containers, other castle cells, lava, out of reach) are refused and reported back.'
const ints = (o) => ['x', 'y', 'z'].every((k) => Number.isInteger(o[k]))
function primText(o) {
  if (o.op === 'place') return `place(${o.item},${key(o)})`
  if (o.op === 'wait') return `wait(${o.s})`
  if (o.op === 'ask_owner') return 'ask_owner'
  return `${o.op}(${key(o)})`
}
function parsePlan(ans) {
  const list = ans && Array.isArray(ans.plan) ? ans.plan : []
  return list.slice(0, ESC_MAX_STEPS).filter((o) => o && (
    ((o.op === 'walk_to' || o.op === 'dig') && ints(o)) || (o.op === 'place' && ints(o) && typeof o.item === 'string') ||
    o.op === 'wait' || (o.op === 'ask_owner' && typeof o.text === 'string'))).map((o) => Object.freeze({ ...o }))
}
function observe(bot, ctx, ep, hooks) {
  const c = ep.cell
  const target = []
  for (let dy = 1; dy >= -1; dy--) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) target.push(name(bot, { x: c.x + dx, y: c.y + dy, z: c.z + dz }) || 'unloaded')
  const item = hooks.findItem(bot, c.kind, ctx)
  const b = position(bot)
  return {
    target: { x: c.x, y: c.y, z: c.z, kind: c.kind, item: item && item.name, occupant: name(bot, c), why: (ep.castle.blocked[hooks.bkey(ep.castle, c.idx)] || {}).why },
    target_grid: 'blocks x-1..x+1 per row, rows z-1..z+1, layers y+1..y-1: ' + target.join(' '),
    bot: b && { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) },
    bot_grid: voxelSlice(bot, ctx), legend: LEGEND,
    inventory: (bot.inventory.items() || []).map((it) => `${it.name}x${it.count}`),
    history: ep.history.slice(-12),
  }
}
async function llmEscalate(obs, system = ESC_SYSTEM) {
  const brain = require('../brain')
  const model = process.env.LLM_MODEL || brain.LLM_MODEL
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ESC_TIMEOUT_MS)
  try {
    const data = await brain.llmCall({ use: 'escalation', apiKey: process.env.ANTHROPIC_API_KEY, signal: ac.signal,
      body: { model, ...brain.llmModelConfig(model, 400), system, messages: [{ role: 'user', content: JSON.stringify(obs) }] } })
    const t = ((data && data.content) || []).find((x) => x && x.type === 'text')
    const out = (t && t.text) || ''
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } finally { clearTimeout(timer) }
}
// One primitive -> a result word; 'walking' finishes in escTick.
async function primitive(bot, ctx, ep, o, hooks) {
  const c = ep.cell
  // u04q: a generic stuck episode (ep.generic) brings its own live() and no castle target
  const live = () => !ep.cancelled && (ep.live ? ep.live() : control(bot, ctx, ep))
  if (o.op === 'wait') { ep.waitUntil = Date.now() + Math.min(10, Math.max(1, Number(o.s) || 1)) * 1000; return 'waited' }
  if (o.op === 'ask_owner') { try { bot.chat(`${ep.generic ? 'stuck' : 'castle'} ${key(c)}: ${String(o.text).slice(0, 120)}`) } catch (_) { /* chat best-effort */ } return 'asked' }
  if (Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y), Math.abs(o.z - c.z)) > ESC_RANGE) return 'refused:too-far-from-target'
  const { at } = ep.castle && ep.castle.site ? blueprint.absPlan(ep.castle.site, ep.castle.rot, ep.castle.blueprintVersion) : { at: new Map() }
  const isTarget = !ep.generic && key(o) === key(c)
  // Owner 2026-11-09: no guard on the bot's own castle for a stuck episode —
  // whatever it breaks, the castle step re-lays (repair instead of protection).
  // Containers stay refused: their contents would spill.
  const pc = at.get(key(o))
  const own = ep.generic && (pc || blueprint.inCastleApron(ctx, o))
  const escape = own && !(pc && (pc.kind === 'chest' || pc.kind === 'blast_furnace'))
  if (!isTarget && pc && o.op !== 'walk_to' && !escape) return 'refused:castle-cell'
  if (typeof bot.stopBuild === 'function') await bot.stopBuild()
  if (!live()) return 'preempted'
  bot.pathfinder.setGoal(null)
  ep.goal = null
  if (o.op === 'walk_to') {
    if (!standable(bot, o, ep.generic ? new Map() : at)) return 'refused:not-standable'
    ep.goal = new goals.GoalBlock(o.x, o.y, o.z)
    bot.pathfinder.setGoal(ep.goal)
    ep.walk = o
    return 'walking'
  }
  const b = block(bot, o)
  if (!b) return 'refused:unloaded'
  if (o.op === 'dig') {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (/lava/.test(name(bot, { x: o.x + dx, y: o.y + dy, z: o.z + dz }) || '')) return 'refused:lava'
    }
    if (AIR.has(b.name)) return 'refused:already-air'
    if (isTarget && hooks.done(bot, c)) return 'refused:already-correct'
    // escape: the castle's own build protection yields; trap/gravity/water rules still refuse
    // Owner 2026-11-09: a stuck episode ignores build protection everywhere
    // (default-deny refused plain mountain rock); only containers and beds stay.
    const loose = escape || (ep.generic && !KEEP.test(b.name))
    const deny = denyReason(bot, b, ctx)
    if (deny && !(loose && deny === 'protected')) return 'refused:protected'
    if (!safeDig(bot, ctx, o, loose)) return 'refused:out-of-reach-or-occupied'
    const req = tools.requirement(b)
    const tool = req ? tools.carried(bot, { ...req, harvestTools: b.harvestTools }) : bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(b)
    if ((req && !req.hand && !tool) || (b.harvestTools && !(tool && b.harvestTools[tool.type]))) return 'refused:no-tool'
    if (tool) await bot.equip(tool, 'hand')
    if (!live() || !safeDig(bot, ctx, o, loose)) return 'preempted'
    await bot.dig(block(bot, o))
    return AIR.has(name(bot, o)) ? 'dug' : 'unchanged'
  }
  // place
  if (!AIR.has(b.name) && !flat.isLiquidName(b.name)) return 'refused:occupied'
  const item = isTarget ? hooks.findItem(bot, c.kind, ctx) : (bot.inventory.items() || []).find((it) => it.name === o.item)
  if (!item) return 'refused:no-item'
  if (!isTarget && !escape && blueprint.inCastleApron(ctx, o)) return 'refused:castle-apron'
  const ref = build.findRef(bot, new Vec3(o.x, o.y, o.z))
  if (!ref) return 'refused:no-ref'
  if (distance(bot, o) > build.PLACE_REACH) return 'refused:out-of-reach'
  if (flat.cellOccupiedSelf(bot, o.x, o.y, o.z) || flat.cellOccupiedByPlayer(bot, o.x, o.y, o.z)) return 'refused:occupied-by-entity'
  await bot.equip(item, 'hand')
  if (!live()) return 'preempted'
  await bot.placeBlock(ref.ref, ref.face)
  if (isTarget) return hooks.done(bot, c) ? 'placed' : 'unchanged'
  if (name(bot, o) !== item.name) return 'unchanged'
  hooks.own(ctx, o, item.name)
  return 'placed'
}
function note(ep, o, result) {
  ep.history.push(`${primText(o)} -> ${result}`)
  console.log(`escalation primitive=${primText(o)} result=${result}`)
}
function escTick(bot, ctx, s, ep, now, hooks) {
  ep.esc = true
  if (ep.waitUntil > now) return true
  if (ep.walk) {
    if (bot.pathfinder.isMoving()) return true
    const w = ep.walk, b = position(bot)
    ep.walk = null
    note(ep, w, b && Math.hypot(b.x - w.x - 0.5, b.y - w.y, b.z - w.z - 0.5) < 0.75 ? 'arrived' : 'not-arrived')
    return true
  }
  if (ep.pending) return true
  if (hooks.done(bot, ep.cell)) { hooks.resume(ctx, ep.castle, ep.cell, 'correct'); end(s, ep, now, 'correct'); return true }
  if (ep.queue && ep.queue.length) {
    const o = ep.queue.shift()
    ep.actions++
    ep.pending = true; ep.waitAt = now
    primitive(bot, ctx, ep, o, hooks).then((r) => r, (err) => (err && err.message === 'build-preempted' ? 'preempted' : 'error')).then((r) => {
      if (ep.cancelled || !control(bot, ctx, ep)) return
      ep.pending = false
      if (r !== 'walking') note(ep, o, r)
      if (o.op === 'ask_owner') end(s, ep, Date.now(), 'asked-owner')
    })
    return true
  }
  if (ep.plan) console.log(`escalation target=${key(ep.cell)} kind=${ep.cell.kind} call=${ep.calls} plan=${ep.plan} outcome=unfinished`)
  if (ep.calls >= MAX_CALLS) {
    try { bot.chat(`castle ${key(ep.cell)}: stuck on this ${ep.cell.kind} after ${ep.calls} tries, please help`) } catch (_) { /* chat best-effort */ }
    ep.plan = null
    end(s, ep, now, 'ask-owner')
    return true
  }
  const ask = escalator(ctx)
  const obs = observe(bot, ctx, ep, hooks)
  ep.plan = null
  ep.pending = true; ep.waitAt = now
  Promise.resolve().then(() => {
    if (!control(bot, ctx, ep) || ep.cancelled) return null
    ep.calls++
    return ask(obs)
  }).then((ans) => {
    if (!control(bot, ctx, ep) || ep.cancelled) return
    ep.pending = false
    ep.queue = parsePlan(ans)
    ep.plan = `[${ep.queue.map(primText).join(' ')}]`
    if (!ep.queue.length) end(s, ep, Date.now(), 'empty-plan')
  }, () => { if (control(bot, ctx, ep) && !ep.cancelled) end(s, ep, Date.now(), 'planner-unavailable') })
  return true
}

module.exports = { primitive, parsePlan, primText, llmEscalate, escalator, ESC_RANGE, startable, ESC_MAX_STEPS, blocker, eligible, tick, menu, MAX_CALLS, MAX_EPISODES, busy }
