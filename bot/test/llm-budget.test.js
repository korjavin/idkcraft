'use strict'

// LLM guardrails (idkcraft-vf8e.5): llmCall() counts the response usage
// into prom counters and a sliding-hour LLM_TOKENS_PER_HOUR budget; the
// N+1th call inside the window is skipped (outcome budget, no fetch) and the
// stall-point planner falls back to the deterministic park. Fake fetch only;
// the prom registry is the real one (bot/src/metrics.js).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { llmPlanner, llmTokensPerHour, resetLlmBudget, LLM_MODEL } = require('../src/brain')
const metrics = require('../src/metrics')
const taskMod = require('../src/task')
const { createTicker } = require('../src/index')

const CRITERIA = { castlefetch: 'stone is near: fetch it', gather: 'logs are few: chop', park: 'nothing helps: park' }
const REQ = { state: { goal: 'build castle' }, instructions: 'Pick the next step', criteria: CRITERIA }

// Messages API response shape, per https://docs.claude.com/en/api/messages
// (content[] text blocks; usage.input_tokens / usage.output_tokens).
function messagesFetch(counter) {
  return async () => {
    counter.n++
    return {
      ok: true,
      json: async () => ({
        id: 'msg_x', type: 'message', role: 'assistant', model: LLM_MODEL,
        content: [{ type: 'text', text: '{"choice":"gather","reason":"r"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 600, output_tokens: 30 },
      }),
    }
  }
}

async function metric(name, labels) {
  const text = await metrics.client.register.metrics()
  const m = text.match(new RegExp(`${name}\\{${labels}\\} ([0-9.e+]+)`))
  return m ? Number(m[1]) : 0
}

let saved
let lines
let origLog
beforeEach(() => {
  saved = { cap: process.env.LLM_TOKENS_PER_HOUR, wd: process.env.GOAL_WATCHDOG_MS }
  resetLlmBudget()
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
})
afterEach(() => {
  console.log = origLog
  resetLlmBudget()
  for (const [k, v] of [['LLM_TOKENS_PER_HOUR', saved.cap], ['GOAL_WATCHDOG_MS', saved.wd]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('llm budget (vf8e.5)', () => {
  it('cap parsing: default 200000, 0 = unlimited, junk = default', () => {
    assert.equal(llmTokensPerHour({}), 200000)
    assert.equal(llmTokensPerHour({ LLM_TOKENS_PER_HOUR: '' }), 200000)
    assert.equal(llmTokensPerHour({ LLM_TOKENS_PER_HOUR: '0' }), 0)
    assert.equal(llmTokensPerHour({ LLM_TOKENS_PER_HOUR: '5000' }), 5000)
    assert.equal(llmTokensPerHour({ LLM_TOKENS_PER_HOUR: 'lots' }), 200000)
  })

  it('usage counted; the N+1th call in the window is skipped with outcome budget, logged once', async () => {
    process.env.LLM_TOKENS_PER_HOUR = '1260' // two 630-token calls fit
    const c = { n: 0 }
    const p = llmPlanner('k', messagesFetch(c))
    const tin = await metric('idkcraft_bot_llm_tokens_total', 'dir="in",use="planner"')
    const tout = await metric('idkcraft_bot_llm_tokens_total', 'dir="out",use="planner"')
    const ok = await metric('idkcraft_bot_llm_calls_total', 'use="planner",outcome="ok"')
    const budget = await metric('idkcraft_bot_llm_calls_total', 'use="planner",outcome="budget"')
    assert.equal((await p.plan(REQ)).step, 'gather')
    assert.equal((await p.plan(REQ)).step, 'gather')
    await assert.rejects(p.plan(REQ), /llm budget exhausted/)
    await assert.rejects(p.plan(REQ), /llm budget exhausted/)
    assert.equal(c.n, 2, 'skipped calls never reach fetch')
    assert.equal(await metric('idkcraft_bot_llm_tokens_total', 'dir="in",use="planner"'), tin + 1200)
    assert.equal(await metric('idkcraft_bot_llm_tokens_total', 'dir="out",use="planner"'), tout + 60)
    assert.equal(await metric('idkcraft_bot_llm_calls_total', 'use="planner",outcome="ok"'), ok + 2)
    assert.equal(await metric('idkcraft_bot_llm_calls_total', 'use="planner",outcome="budget"'), budget + 2)
    const logs = lines.filter((l) => l.startsWith('llm budget exhausted until '))
    assert.equal(logs.length, 1, JSON.stringify(lines))
    assert.match(logs[0], /until \d\d:\d\d \(1260\/1260 tokens\/h\)/)
  })

  it('a timed-out call (no usage) still charges the window an estimate', async () => {
    process.env.LLM_TOKENS_PER_HOUR = '1'
    let n = 0
    const hanging = (url, opts) => { n++; return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))) }
    const p = llmPlanner('k', hanging, 20)
    await assert.rejects(p.plan(REQ), (err) => err && err.name === 'TimeoutError')
    await assert.rejects(p.plan(REQ), /llm budget exhausted/)
    assert.equal(n, 1)
  })

  it('0 = unlimited', async () => {
    process.env.LLM_TOKENS_PER_HOUR = '0'
    const c = { n: 0 }
    const p = llmPlanner('k', messagesFetch(c))
    for (let i = 0; i < 5; i++) assert.equal((await p.plan(REQ)).step, 'gather')
    assert.equal(c.n, 5)
  })

  it('over budget the stall-point planner parks deterministically (why=error)', async () => {
    process.env.LLM_TOKENS_PER_HOUR = '1'
    process.env.GOAL_WATCHDOG_MS = '0' // the legacy L2 plan/park path (task-plan.test.js)
    const c = { n: 0 }
    const p = llmPlanner('k', messagesFetch(c))
    await p.plan(REQ) // spends the hour
    const pos = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) })
    const bot = {
      username: 'IdkBot', chats: [], chat(m) { this.chats.push(String(m)) },
      entity: { position: pos(100, 64, 200), onGround: true, isInWater: false },
      inventory: { items: () => [{ name: 'cobblestone', count: 20 }] },
      time: { timeOfDay: 6000, day: 1 }, health: 20, food: 20, oxygenLevel: 20,
      spawnPoint: pos(0, 64, 0), players: {}, entities: {}, blockAt: () => null,
      pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
      clearControlStates() {},
    }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setCastle({ site: { x: 100, y: 64, z: 200 }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 8, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.castleWord = { kind: 'stone', left: 80 }
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'running'
    ctx.stepPick = { step: 'castlefetch', at: Date.now() - 5000, source: 'goal-fsm', why: 'fetch stone' }
    // This castle menu has one option, which answers without a call; widen it
    // so the paid path (and the budget check) actually runs.
    ctx.brain = { plan: (req) => p.plan({ ...req, criteria: { ...req.criteria, forage: 'x' } }) }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    for (let s = 0; s < 270; s++) { t += 10000; taskMod.taskTick(bot, ctx, t) } // 45 min -> L2
    assert.ok(ctx.task.castle.planPending, 'plan fired at L2')
    await new Promise((r) => setImmediate(r))
    taskMod.taskTick(bot, ctx, t + 10000)
    assert.equal(c.n, 1, 'no paid call over budget')
    assert.equal(ctx.castle.parked, true)
    assert.ok(lines.some((l) => /^task plan kind=castle .*answer=park why=error$/.test(l)), JSON.stringify(lines.filter((l) => l.startsWith('task plan'))))
  })
})
