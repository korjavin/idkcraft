'use strict'
// idkcraft-8hpy.2: a goal stall goes to the chooser (JEV, keyless stub,
// LLM at most once per episode), never to an idle park before the cap.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const taskMod = require('../src/task')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}
function makeBot(items) {
  return {
    username: 'IdkBot', chats: [], chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(2, 64, 2), onGround: true, isInWater: false },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20, oxygenLevel: 20,
    spawnPoint: pos(0, 64, 0), players: {}, entities: {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
  }
}
// House with few planks; a remembered chest full of planks.
function houseCtx(bot) {
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
  ticker.work()
  const ctx = bot._tickerCtx
  ctx.chests = [{ x: 6, y: 64, z: 6, contents: { oak_planks: 128 }, at: Date.now() }]
  return ctx
}
const flush = () => new Promise((r) => setImmediate(r))
// Tick until the watchdog fired, flush its answer, consume it.
async function decideRound(bot, ctx, t) {
  let guard = 0
  const wd = () => ctx.task && ctx.task.house && ctx.task.house.wd
  while (!(wd() && wd().pending) && guard++ < 60) { t += 10000; taskMod.taskTick(bot, ctx, t) }
  assert.ok(wd() && wd().pending, `round fired\n${lines.join('\n')}`)
  await flush()
  t += 10000
  taskMod.taskTick(bot, ctx, t)
  return t
}
// Tick the window out flat.
function runOut(bot, ctx, t) {
  let guard = 0
  while (ctx.goal && ctx.goal.commit && guard++ < 40) { t += 10000; taskMod.taskTick(bot, ctx, t) }
  return t
}

let lines = []
let origLog = null
const ENV = ['STALL_DECIDE', 'LLM_ESCALATION', 'GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'GOAL_WATCHDOG_MAX_ROUNDS']
let saved = {}
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  saved = {}
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  console.log = origLog
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})
const decides = () => lines.filter((l) => l.startsWith('stall decide'))

describe('stall chooser (8hpy.2)', () => {
  it('keyless stub picks a productive step (not park/rest) and marks a failed choice', async () => {
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    ctx.brain = { name: 'stub' } // no plan(): before 8hpy.2 this never decided
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await decideRound(bot, ctx, t)
    const d1 = decides()
    assert.equal(d1.length, 1, lines.join('\n'))
    assert.match(d1[0], /^stall decide goal=house round=1 by=stub choice=\S+ conf=1\.00 why=.* options=\[/)
    const first = ctx.goal.commit.optionId
    assert.ok(!/^(park|rest|ask-owner)$/.test(first), `productive pick: ${first}`)
    assert.ok(!/park/.test(d1[0].split('options=')[1]), 'park is not offered')
    t = runOut(bot, ctx, t)
    assert.ok(lines.some((l) => l.startsWith(`stall outcome goal=house choice=${first} progress=`)), lines.join('\n'))
    t = await decideRound(bot, ctx, t)
    // Only gather is offered here (explore waits for gather to fail): the
    // bot keeps working it rather than parking. With an alternative, the
    // flat choice ranks last:
    assert.ok(ctx.goal && ctx.goal.commit, 'round 2 commits work again')
    const hist = ctx.task.house.wd.history
    assert.equal(hist[0].choice, first)
    assert.equal(hist[0].outcome, 'flat')
    const alt = taskMod.fallbackRank('house', [{ id: first, step: first }, { id: 'explore', step: 'explore' }], hist, null, new Set())
    assert.equal(alt.id, 'explore', 'failed choice marked, the next pick changes')
    assert.equal(ctx.home.taskPark || null, null, 'no park before the cap')
  })

  it('JEV low confidence -> one LLM plan per episode, replayed without further calls', async () => {
    process.env.LLM_ESCALATION = '1'
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    let jev = 0
    let llm = 0
    ctx.brain = {
      plan: async (req) => { jev++; return { step: Object.keys(req.criteria)[0], confidence: 0.1, source: 'jev' } },
      stallPlan: async (req) => { llm++; const ks = Object.keys(req.criteria); return { steps: [ks[ks.length - 1], ks[0]], reason: 'try both' } },
    }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await decideRound(bot, ctx, t) // JEV undecided -> LLM fired
    t = await decideRound(bot, ctx, t) // LLM answer consumed
    assert.equal(llm, 1)
    assert.ok(decides().some((l) => / by=llm /.test(l)), lines.join('\n'))
    t = runOut(bot, ctx, t)
    const jevBefore = jev
    t = await decideRound(bot, ctx, t) // queued step replays, no call
    assert.equal(llm, 1)
    assert.equal(jev, jevBefore, 'replay asks nobody')
    assert.ok(ctx.goal.commit, 'replayed step committed')
    t = runOut(bot, ctx, t)
    for (let i = 0; i < 3; i++) { t = await decideRound(bot, ctx, t); t = runOut(bot, ctx, t) }
    assert.equal(llm, 1, 'LLM at most once per stall episode')
    assert.ok(jev > jevBefore, 'JEV asked again once the plan ran out')
  })

  it('sources are separate options; a picked chest source runs directly as a self bring', async () => {
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    // The real chest rung needs a world (pickChest); record the rung asked for.
    const asked = []
    ctx.ordersTicker = { setBring: (a) => { asked.push(a); ctx.bring = { kind: 'item', name: a.name }; return 'checking chests' } }
    let offered = null
    ctx.brain = { plan: async (req) => { offered = req; return { step: Object.keys(req.criteria).find((k) => k.startsWith('fetch:')), confidence: 0.9, source: 'jev' } } }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await decideRound(bot, ctx, t)
    const id = Object.keys(offered.criteria).find((k) => k.startsWith('fetch:'))
    assert.equal(id, 'fetch:oak_planks@chest(6m,128)', Object.keys(offered.criteria).join(' '))
    assert.match(offered.state.context.res.join('\n'), /res wood pack=0 near=32 far=0/)
    assert.ok(lines.some((l) => l.startsWith('stall source resolver=chest item=oak_planks')), lines.join('\n'))
    assert.deepEqual(asked, [{ name: 'oak_planks', want: 115, by: 'self', chestFirst: true, craftFirst: false }], 'the picked rung only, no resolver order')
    assert.ok(ctx.bring && ctx.bring.self, 'self bring started')
    assert.equal(ctx.goal.commit.optionId, id)
  })

  it('JEV may pick escalate_llm: the one stallPlan call answers', async () => {
    process.env.LLM_ESCALATION = '1'
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    let llm = 0
    ctx.brain = {
      plan: async (req) => ({ step: 'escalate_llm', confidence: 0.9, source: 'jev' }),
      stallPlan: async (req) => { llm++; assert.ok(!('escalate_llm' in req.criteria)); return { steps: [Object.keys(req.criteria)[0]], reason: 'x' } },
    }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    t = await decideRound(bot, ctx, t)
    t = await decideRound(bot, ctx, t)
    assert.equal(llm, 1)
    assert.ok(decides().some((l) => / by=llm /.test(l)), lines.join('\n'))
  })

  it('a 3-round loop is named and escalate_llm leads; ignored, the next round escalates by itself', async () => {
    process.env.LLM_ESCALATION = '1'
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    ctx.ordersTicker = null // no source options: the plain table loops
    let llm = 0
    const reqs = []
    ctx.brain = {
      plan: async (req) => { reqs.push(req); return { step: Object.keys(req.criteria).find((k) => k !== 'escalate_llm'), confidence: 0.9, source: 'jev' } },
      stallPlan: async () => { llm++; return { steps: [], reason: 'x' } },
    }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    for (let i = 0; i < 3; i++) { t = await decideRound(bot, ctx, t); t = runOut(bot, ctx, t) }
    assert.equal(llm, 0)
    t = await decideRound(bot, ctx, t)
    const last = reqs[reqs.length - 1]
    assert.match(last.state.loop, / x3$/)
    assert.equal(Object.keys(last.criteria)[0], 'escalate_llm')
    assert.match(last.criteria.escalate_llm, /^RECOMMENDED, loop=/)
    t = runOut(bot, ctx, t)
    let guard = 0
    while (llm === 0 && guard++ < 60) { t += 10000; taskMod.taskTick(bot, ctx, t); await flush() }
    assert.equal(llm, 1, lines.join('\n'))
    assert.ok(lines.some((l) => /^stall escalate goal=house by=auto loop=/.test(l)))
  })

  it('loopOf: same x3, A/B x4, progress breaks it', () => {
    const { loopOf } = require('../src/plan-context')
    const h = (cs, out = 'flat') => cs.map((choice) => ({ choice, outcome: out }))
    assert.equal(loopOf(h(['a', 'a', 'a'])), 'a x3')
    assert.equal(loopOf(h(['a', 'b', 'a', 'b'])), 'a<->b x4')
    assert.equal(loopOf(h(['a', 'b', 'a'])), null)
    assert.equal(loopOf([...h(['a', 'a']), { choice: 'a', outcome: 'progress' }]), null)
  })

  it('STALL_DECIDE=0 keeps the old keyless no-op', async () => {
    process.env.STALL_DECIDE = '0'
    const bot = makeBot([{ name: 'oak_planks', count: 3 }])
    const ctx = houseCtx(bot)
    ctx.brain = { name: 'stub' }
    let t = 1000000000000
    for (let i = 0; i < 20; i++) { t += 10000; taskMod.taskTick(bot, ctx, t) }
    await flush()
    assert.equal(decides().length, 0)
  })

  it('makeBrain: a JEV key keeps plan() on JEV and adds the LLM stallPlan; the plan is filtered to offered ids', async () => {
    const brain = require('../src/brain')
    const b = brain.makeBrain({ TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' })
    assert.equal(brain.plannerName(b), 'jev')
    assert.equal(typeof b.stallPlan, 'function')
    assert.equal(typeof brain.makeBrain({ TYPESAFE_API_KEY: 'k' }).stallPlan, 'undefined')
    const fetchFn = async () => ({ ok: true, json: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{"plan":["gather","bogus","build"],"reason":"wood first"}' }] }) })
    const p = await brain.llmStallPlanner('a', fetchFn)({ state: {}, instructions: '', criteria: { gather: 'x', build: 'y' } })
    assert.deepEqual(p, { steps: ['gather', 'build'], reason: 'wood first' })
  })
})
