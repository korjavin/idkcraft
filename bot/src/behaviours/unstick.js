'use strict'

// idkcraft-u04q: the 8hx3 escalation for any v2 step that cannot path to its
// goal (noPath streak, ctx.stuck, or a step ending failed:unreachable).
// Primitives, safety checks, plan parsing and the planner call are the
// castlerecovery ones; this file only finds the episode and owns the tick.
const esc = require('./castlerecovery')
const { stepGen } = require('../step')
const { voxelSlice, LEGEND } = require('../stall-state')

const MAX_CALLS = esc.MAX_CALLS
const NOPATH_TICKS = 10
const COOLDOWN_MS = 300000
const EPISODE_MS = 180000
const WAIT_MS = 10000
const BOXED_MS = 120000
const SYSTEM = 'You unstick a Minecraft bot whose pathfinder cannot reach its goal. Answer with JSON only: ' +
  '{"plan":[{"op":"walk_to","x":0,"y":0,"z":0},{"op":"dig","x":0,"y":0,"z":0},{"op":"place","item":"name","x":0,"y":0,"z":0},{"op":"wait","s":3},{"op":"ask_owner","text":"..."}]} ' +
  `with at most ${esc.ESC_MAX_STEPS} steps, all within ${esc.ESC_RANGE} blocks of the bot. Typical fixes: dig through a 1-2 block wall, ` +
  'place a block to step up or bridge a gap, walk to an intermediate spot. Coordinates are block coordinates; walk_to targets the feet cell. ' +
  'Unsafe steps (owner/protected blocks, containers, lava, out of reach) are refused and reported back. ' +
  'Blocks are not protected: dig or place through any wall, floor or rock to get out (the bot\'s castle repairs itself later); only containers and beds are refused.'
const NOOP = Object.freeze({ done: () => false, findItem: () => null, own: () => {} })
const sessions = new WeakMap()
const key = (p) => `${p.x},${p.y},${p.z}`
const floor = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

function on(ctx) {
  return process.env.BOT_BODY === 'baritone' && /^(1|true|yes)$/i.test(String(process.env.LLM_ESCALATION || '')) && !!esc.escalator(ctx)
}
function state(ctx) {
  let s = sessions.get(ctx)
  if (!s) { s = { cooldown: new Map(), nopath: 0, goal: null, episode: null }; sessions.set(ctx, s) }
  return s
}
function goalPos(g) {
  return g && [g.x, g.y, g.z].every(Number.isFinite) ? floor(g) : null
}
// fight/stop/shelter/breath/lead/follow (work off) preempt, like castlerecovery control().
function live(bot, ctx, ep) {
  return !ep.cancelled && ctx.work === ep.work && ctx.work && stepGen(ctx) === ep.gen && !ctx.paused && !ctx.lead &&
    !ctx.inShelter && !ctx.breath && !(ctx.lastDecision && ctx.lastDecision.action === 'fight') &&
    (!bot.pathfinder.goal || bot.pathfinder.goal === ep.goal)
}
function end(bot, ctx, s, ep, outcome) {
  if (s.episode !== ep) return
  ep.cancelled = true
  s.episode = null
  s.nopath = 0
  s.cooldown.set(key(ep.target), Date.now() + COOLDOWN_MS)
  if (ep.goal && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
  // reached: the step keeps going; an unreachable verdict is lifted so the step re-paths.
  if (outcome === 'reached' && ep.trigger === 'unreachable' && ctx.stepStatus === 'failed:unreachable') ctx.stepStatus = 'running'
  console.log(`escalation target=${key(ep.target)} step=${ep.step} trigger=${ep.trigger} call=${ep.calls} plan=${ep.plan || '[]'} outcome=${outcome}`)
}
function trigger(bot, ctx, s) {
  if (ctx.stepStatus === 'failed:unreachable') return 'unreachable'
  if (ctx.stuck) return 'stuck'
  if (s.nopath >= NOPATH_TICKS) return 'nopath'
  return null
}
function observe(bot, ctx, ep) {
  return {
    goal: `reach the ${ep.step} step target`, trigger: ep.trigger,
    target: ep.target, bot: floor(bot.entity.position),
    bot_grid: voxelSlice(bot, ctx), legend: LEGEND,
    inventory: (bot.inventory.items() || []).map((it) => `${it.name}x${it.count}`),
    history: ep.history.slice(-12),
  }
}
function note(ep, o, r) {
  ep.history.push(`${esc.primText(o)} -> ${r}`)
  console.log(`escalation primitive=${esc.primText(o)} result=${r}`)
}

// true = the episode owns this tick (the caller skips recover/brain dispatch).
// fight = the caller's urgent-fight verdict for this tick.
function tick(bot, ctx, fight = false) {
  if (!on(ctx) || !bot.entity || !bot.pathfinder) return false
  const s = state(ctx), now = Date.now()
  let ep = s.episode
  if (ep) {
    if (fight || !live(bot, ctx, ep) || now - ep.started >= EPISODE_MS || (ep.pending && now - ep.waitAt >= WAIT_MS)) {
      const owned = !fight && live(bot, ctx, ep)
      if (owned) { try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (_) { /* best-effort */ } }
      end(bot, ctx, s, ep, owned ? 'timeout' : 'preempted')
      return false
    }
    return run(bot, ctx, s, ep, now)
  }
  if (fight) return false
  const g = goalPos(bot.pathfinder.goal)
  if (g) s.goal = { pos: g, gen: stepGen(ctx) }
  s.nopath = g && ctx.lastPathStatus === 'noPath' ? s.nopath + 1 : 0
  const why = trigger(bot, ctx, s)
  const target = g || (s.goal && s.goal.gen === stepGen(ctx) ? s.goal.pos : null)
  // Castle cells have their own 8hx3 episode; the castle step escalates here
  // only when the bot itself has not moved a block for BOXED_MS (prod
  // 2026-11-09: boxed in on the wall top, every cell noPath, 35+ min).
  const p = bot.entity.position
  if (!s.moved || Math.hypot(p.x - s.moved.x, p.y - s.moved.y, p.z - s.moved.z) >= 1) s.moved = { x: p.x, y: p.y, z: p.z, at: now }
  const boxed = now - s.moved.at >= BOXED_MS
  if (!why || !target || !ctx.work || !ctx.step || (ctx.step === 'castle' && !boxed) || esc.busy(ctx) || ctx.paused || ctx.inShelter || ctx.breath || ctx.lead) return false
  if ((s.cooldown.get(key(target)) || 0) > now) return false
  ep = { generic: true, trigger: why, target, step: ctx.step, cell: floor(bot.entity.position), castle: ctx.castle || null,
    work: ctx.work, gen: stepGen(ctx), started: now, calls: 0, actions: 0, history: [], pending: false, goal: null }
  ep.live = () => live(bot, ctx, ep)
  s.episode = ep
  bot.pathfinder.setGoal(null)
  console.log(`escalation target=${key(target)} step=${ep.step} trigger=${why} outcome=started`)
  return run(bot, ctx, s, ep, now)
}

function run(bot, ctx, s, ep, now) {
  if (ep.waitUntil > now || ep.pending) return true
  if (ep.walk) {
    if (bot.pathfinder.isMoving()) return true
    const w = ep.walk, b = bot.entity.position
    ep.walk = null
    note(ep, w, Math.hypot(b.x - w.x - 0.5, b.y - w.y, b.z - w.z - 0.5) < 0.75 ? 'arrived' : 'not-arrived')
    if (ep.goal && bot.pathfinder.goal === ep.goal) bot.pathfinder.setGoal(null)
    ep.goal = null
  }
  const b = bot.entity.position, t = ep.target
  if (Math.hypot(b.x - t.x - 0.5, b.y - t.y, b.z - t.z - 0.5) < 2) { end(bot, ctx, s, ep, 'reached'); return false }
  if (ep.queue && ep.queue.length) {
    const o = ep.queue.shift()
    ep.actions++
    ep.pending = true; ep.waitAt = now
    esc.primitive(bot, ctx, ep, o, NOOP).then((r) => r, (err) => (err && err.message === 'build-preempted' ? 'preempted' : 'error')).then((r) => {
      if (ep.cancelled) return
      ep.pending = false
      if (r !== 'walking') note(ep, o, r)
      if (o.op === 'ask_owner') end(bot, ctx, s, ep, 'asked-owner')
    })
    return true
  }
  if (ep.calls >= MAX_CALLS) {
    try { bot.chat(`stuck ${key(t)}: cannot reach it for ${ep.step} after ${ep.calls} tries, please help`) } catch (_) { /* chat best-effort */ }
    end(bot, ctx, s, ep, 'ask-owner')
    return false
  }
  if (ep.plan) console.log(`escalation target=${key(t)} step=${ep.step} trigger=${ep.trigger} call=${ep.calls} plan=${ep.plan} outcome=unfinished`)
  const ask = (ctx.brain && ctx.brain.escalate) || ((obs) => esc.llmEscalate(obs, SYSTEM))
  const obs = observe(bot, ctx, ep)
  ep.plan = null
  ep.pending = true; ep.waitAt = now
  ep.calls++
  Promise.resolve().then(() => ask(obs)).then((ans) => {
    if (ep.cancelled) return
    ep.pending = false
    ep.queue = esc.parsePlan(ans)
    ep.plan = `[${ep.queue.map(esc.primText).join(' ')}]`
    if (!ep.queue.length) end(bot, ctx, s, ep, 'empty-plan')
  }, () => { if (!ep.cancelled) end(bot, ctx, s, ep, 'planner-unavailable') })
  return true
}

module.exports = { tick, MAX_CALLS, NOPATH_TICKS, COOLDOWN_MS }
