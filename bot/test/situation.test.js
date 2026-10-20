'use strict'

// LLM situation context (idkcraft-qxql.9): situationText pins its section
// headers over a fake ctx (castle order + 2 holds + order ring) and yields
// all-'unknown' without throwing on a null-everything ctx. planOrder's user
// prompt carries the situation instead of the old state+inventory text.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { situationText, inventoryText, pushOrderLog } = require('../src/situation')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

function mockBot(items = []) {
  return {
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: {}, itemsByName: {} },
    players: { P: { username: 'P', entity: { position: pos(1, 64, 0) } } },
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false },
    inventory: { items: () => items },
    chat() {},
  }
}

describe('situation text', () => {
  it('pins every section header over a castle order with holds and an order ring', () => {
    const bot = mockBot([{ name: 'torch', count: 8 }])
    const now = Date.now()
    const ctx = {
      castle: { site: { x: 10, y: 64, z: 10 }, rot: 0, phase: 'body', progress: { done: 621, total: 2048 } },
      castleWord: { kind: 'stone', left: 16 },
      home: { site: { x: 0, y: 64, z: 0 }, built: false },
      stepFail: {
        castlefetch: { status: 'failed:no-path', text: 'x', at: now - 5 * 60000, kinds: { stone: now - 2 * 60000 } },
        gather: { status: 'failed:no-trees', text: 'y', at: now - 12 * 60000 },
      },
      orderLog: [
        { line: 'come home', at: now - 9 * 60000 },
        { line: 'bring me torch 8', at: now - 3 * 60000 },
      ],
    }
    const text = situationText(bot, ctx)
    for (const h of ['castle:', 'home:', 'chests:', 'inventory:', 'holds:', 'owner:', 'world:']) {
      assert.match(text, new RegExp(`^${h}`, 'm'), `missing section ${h}`)
    }
    assert.match(text, /621\/2048/)
    assert.match(text, /stone/)
    assert.match(text, /castlefetch failed:no-path 5m ago/)
    assert.match(text, /stone@2m/)
    assert.match(text, /gather failed:no-trees 12m ago/)
    assert.match(text, /bring me torch 8 \(3m ago\)/)
    assert.match(text, /torch 8/)
    assert.match(text, /time=day/)
    assert.ok(text.split('\n').length <= 40, 'prompt stays short')
  })

  it('a null-everything ctx yields all-unknown without throwing', () => {
    const text = situationText(null, null)
    assert.doesNotThrow(() => situationText({}, {}))
    for (const h of ['castle:', 'home:', 'chests:', 'inventory:', 'holds:', 'owner:', 'world:']) {
      assert.match(text, new RegExp(`^${h}`, 'm'), `missing section ${h}`)
    }
    assert.match(text, /no castle order|unknown/)
  })

  it('the order ring caps at 5 and ignores junk', () => {
    const ctx = {}
    for (let i = 0; i < 8; i++) pushOrderLog(ctx, `order ${i}`)
    assert.equal(ctx.orderLog.length, 5)
    assert.equal(ctx.orderLog[0].line, 'order 3')
    assert.equal(ctx.orderLog[4].line, 'order 7')
    assert.doesNotThrow(() => pushOrderLog(null, 'x'))
    assert.doesNotThrow(() => pushOrderLog(ctx, null))
    assert.doesNotThrow(() => pushOrderLog(ctx, ''))
  })

  it('inventoryText mirrors the old llm-orders shape', () => {
    assert.equal(inventoryText(mockBot([{ name: 'torch', count: 8 }])), 'torch 8')
    assert.equal(inventoryText(mockBot()), 'empty')
    assert.equal(inventoryText(null), 'unknown')
  })
})

describe('situation wiring', () => {
  let savedOn
  let savedKey
  let origFetch
  let origLog
  beforeEach(() => {
    savedOn = process.env.BOT_LLM_ORDERS
    savedKey = process.env.ANTHROPIC_API_KEY
    process.env.BOT_LLM_ORDERS = '1'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    origFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"plan":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    })
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    console.log = origLog
    const { resetLlmBudget } = require('../src/brain')
    resetLlmBudget()
    for (const [k, v] of [['BOT_LLM_ORDERS', savedOn], ['ANTHROPIC_API_KEY', savedKey]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('planOrder sends the situation, not the old state+inventory text', async () => {
    const llmOrders = require('../src/llm-orders')
    const bot = mockBot()
    const ctx = { castle: { site: { x: 1, y: 64, z: 1 }, progress: { done: 3, total: 10 }, phase: 'body' } }
    let body = null
    await llmOrders.planOrder(bot, ctx, 'hello', async (url, init) => {
      body = JSON.parse(init.body)
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: '{"plan":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      }
    })
    const content = body.messages[0].content
    assert.match(content, /^Order from the player: "hello"/m)
    assert.match(content, /^Situation:/m)
    assert.match(content, /^castle:/m)
    assert.doesNotMatch(content, /^Bot state:/m)
    assert.doesNotMatch(content, /^Inventory:/m)
  })

  it('planState carries the situation next to facts', () => {
    const task = require('../src/task')
    const bot = mockBot()
    const ctx = {}
    const out = task.planState(bot, ctx, 'house', 0, 1, { fails: [], stallMs: 0 })
    assert.equal(typeof out.situation, 'string')
    assert.match(out.situation, /^castle:/m)
    assert.equal(typeof out.facts, 'string')
  })
})
