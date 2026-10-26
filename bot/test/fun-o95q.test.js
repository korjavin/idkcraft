'use strict'

// Idle whimsy (idkcraft-o95q): funny, illogical, rare — a useless gift, a
// tiny stonehenge-like ring, or an LLM-improvised gag. Pins: idle-only
// gating (no trigger under order/castle/night/fight/cooldown), bounds
// (block cap, cheap-mats-only, keep-last, no tool output), pinned chat
// lines, and the LLM-offer validator (accept tiny joke / reject
// castle, sword, lava, oversize).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fun = require('../src/behaviours/fun')
const goal = require('../src/goal')
const { STEP_ORDER } = require('../src/plan-consts')

const OLD_KEY = process.env.ANTHROPIC_API_KEY

function botWith(items, extra = {}) {
  const inv = items.map((i) => ({ type: 1, ...i }))
  const bot = {
    inv,
    chats: [],
    tossed: [],
    placed: [],
    tossedCounts: [],
    inventory: { items: () => inv },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 } },
    entities: {},
    players: {},
    blockAt: (p) => {
      const y = Math.floor(p.y)
      if (y <= 63) return { name: 'dirt', position: { x: Math.floor(p.x), y, z: Math.floor(p.z) } }
      return { name: 'air', position: { x: Math.floor(p.x), y, z: Math.floor(p.z) } }
    },
    toss: async (type, meta, count) => {
      const stack = inv.find((i) => i.type === type)
      botWith.last.tossed.push(stack && stack.name)
      botWith.last.tossedCounts.push(count)
      const idx = inv.indexOf(stack)
      if (stack && count >= stack.count) inv.splice(idx, 1)
      else if (stack) stack.count -= count
    },
    equip: async () => {},
    placeBlock: async () => {},
    chat: (line) => { botWith.last.chats.push(line) },
    ...extra,
  }
  return bot
}
botWith.last = null

function fakeBot(items, extra) {
  const b = botWith(items, extra)
  botWith.last = b
  return b
}

const facts = (over = {}) => ({ time: 'day', castle: 'none', player: 'none', home: 'built', ...over })
const dirt8 = [{ name: 'dirt', count: 8 }]
const junkPair = [{ name: 'rotten_flesh', count: 2 }]

describe('fun gating (o95q idle-only)', () => {
  it('fires on an idle day with junk or cheap mats', () => {
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt8), {}), true)
    assert.equal(goal.MENU.fun.feasible(facts({ player: 'seen' }), fakeBot(junkPair), {}), true)
  })
  it('never triggers under order, castle, night, fight, or cooldown', () => {
    const b = () => fakeBot(dirt8)
    assert.equal(goal.MENU.fun.feasible(facts({ time: 'night' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts({ time: 'dusk' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts({ castle: 'stone-batch' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts({ castle: 'blocked' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { bring: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { lead: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { comehome: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { flat: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { taskPlanStep: 'craft' }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { llmOrder: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { llmAsk: {} }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { paused: true }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { funNext: Date.now() + 60000 }), false)
    const hostile = b()
    hostile.entities = { 7: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
    hostile.entity.position.distanceTo = () => 3
    assert.equal(goal.MENU.fun.feasible(facts(), hostile, {}), false)
  })
  it('stays infeasible with an empty pack or nothing jokeable', () => {
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([]), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([{ name: 'dirt', count: 1 }]), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([{ name: 'diamond_sword', count: 3 }]), {}), false)
  })
  it('ranks just above rest and loses to every work step', () => {
    assert.equal(STEP_ORDER.indexOf('fun'), STEP_ORDER.indexOf('rest') - 1)
    assert.equal(goal.goalFsm(facts(), ['rest', 'fun']), 'fun')
    assert.equal(goal.goalFsm(facts(), ['gather', 'fun', 'rest']), 'gather')
  })
})

describe('fun bounds (o95q cheap-only, keep-last, caps)', () => {
  it('never spends the last of anything', () => {
    assert.equal(fun.giftPick(fakeBot([{ name: 'dirt', count: 1 }])), null)
    assert.equal(fun.giftPick(fakeBot([{ name: 'dirt', count: 2 }])), 'dirt')
    assert.equal(fun.follyMats(fakeBot([{ name: 'dirt', count: 7 }])), null)
    assert.equal(fun.follyMats(fakeBot([{ name: 'dirt', count: 8 }])), 'dirt')
  })
  it('never outputs tools, weapons, or non-cheap mats', () => {
    const rich = fakeBot([
      { name: 'diamond_sword', count: 5 },
      { name: 'iron_pickaxe', count: 5 },
      { name: 'oak_log', count: 64 },
      { name: 'torch', count: 64 },
    ])
    assert.equal(fun.giftPick(rich), null)
    assert.equal(fun.follyMats(rich), null)
  })
  it('cooldown spans 30-60 min from the act start', () => {
    const ctx = {}
    fun.stampFun(ctx, 1000, () => 0)
    assert.equal(ctx.funNext, 1000 + fun.FUN_MIN_MS)
    fun.stampFun(ctx, 1000, () => 0.99999)
    assert.ok(ctx.funNext >= 1000 + fun.FUN_MIN_MS)
    assert.ok(ctx.funNext <= 1000 + fun.FUN_MIN_MS + fun.FUN_JITTER_MS)
  })
})

describe('fun chat lines (o95q unmistakable joke)', () => {
  it('pins one line per act', () => {
    assert.equal(fun.CHAT_GIFT, "a gift for you. you're welcome.")
    assert.equal(new Set([fun.CHAT_GIFT, fun.CHAT_FOLLY, fun.CHAT_IMPROV]).size, 3)
  })
  it('gift act tosses exactly one junk item and chats the gift line', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const here = { x: 2, y: 64, z: 0 }
      const b = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: here } } },
      })
      const ctx = {}
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, ['rotten_flesh'])
      assert.deepEqual(b.tossedCounts, [1], 'one item, the last stays')
      assert.deepEqual(b.inv, [{ type: 1, name: 'rotten_flesh', count: 1 }])
      assert.ok(b.chats.includes(fun.CHAT_GIFT), `chats=${JSON.stringify(b.chats)}`)
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a preempted act writes nothing into the replacement step', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const step = require('../src/step')
      const here2 = { x: 2, y: 64, z: 0 }
      const b = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: here2 } } },
      })
      const origToss = b.toss
      b.toss = async (...a) => {
        step.nextStepGen(b._ctx) // an order lands mid-toss: the step is gone
        return origToss(...a)
      }
      const ctx = {}
      b._ctx = ctx
      await fun.run(b, ctx) // gift is the only act: no dice involved
      assert.equal(ctx.stepStatus, undefined, 'no completion leaks into the new step')
      assert.deepEqual(b.chats, [], 'no joke line after preemption')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('the folly ring keeps off the flat square (cx/cz/r shape)', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt8)
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } }, flatEnd: { cx: 0, cz: 0, r: 8, outcome: 'done' } }
      assert.equal(fun.findFollySpot(b, ctx), null, 'the whole ring sits inside the square')
      await fun.run(b, ctx)
      assert.equal(ctx.stepStatus, 'failed:fun-no-ground')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('folly act places at most 7 cheap blocks and chats the folly line', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt8)
      const placed = []
      b.placeBlock = async (ref) => { placed.push([ref.position.x, ref.position.y, ref.position.z]) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      // No player, no key: folly is the only available act, no dice involved.
      assert.deepEqual(fun.availActs(b, { player: 'none' }, ctx), ['folly'])
      await fun.run(b, ctx, null, {})
      assert.ok(placed.length >= 1 && placed.length <= fun.MAX_PLACE, `placed=${placed.length}`)
      assert.deepEqual(new Set(placed.map((p) => p.join(','))).size, placed.length, 'no double-place')
      assert.ok(b.chats.includes(fun.CHAT_FOLLY), `chats=${JSON.stringify(b.chats)}`)
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(typeof ctx.funNext === 'number' && ctx.funNext > Date.now(), 'cooldown stamped at act start')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
})

describe('fun LLM-offer validator (o95q allowlist)', () => {
  const counts = () => new Map([['dirt', 10], ['rotten_flesh', 3], ['cobblestone', 8]])
  it('accepts a tiny joke: one gift or a small cheap ring', () => {
    assert.deepEqual(fun.validateFunOffer({ kind: 'gift', item: 'rotten_flesh' }, counts()).act, 'gift')
    const v = fun.validateFunOffer({ kind: 'build', block: 'dirt', count: 7 }, counts())
    assert.deepEqual([v.act, v.count], ['build', 7])
  })
  it('rejects a castle, a sword, lava, and oversize counts', () => {
    assert.equal(fun.validateFunOffer({ kind: 'castle' }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'gift', item: 'diamond_sword' }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'gift', item: 'torch' }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'build', block: 'lava', count: 1 }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'build', block: 'tnt', count: 1 }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'build', block: 'oak_planks', count: 2 }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'build', block: 'dirt', count: 8 }, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'craft', item: 'stick', count: 4 }, counts()).ok, false)
    assert.equal(fun.validateFunOffer(null, counts()).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'none' }, counts()).ok, false)
  })
  it('rejects spending the last one the pack holds', () => {
    assert.equal(fun.validateFunOffer({ kind: 'gift', item: 'dirt' }, new Map([['dirt', 1]])).ok, false)
    assert.equal(fun.validateFunOffer({ kind: 'build', block: 'dirt', count: 7 }, new Map([['dirt', 7]])).ok, false)
  })
  it('an invalid model offer skips honestly: done, nothing tossed or placed', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const realRandom = Math.random
    Math.random = () => 0.75 // avail [folly, improv]: index 1 = improv
    const brain = require('../src/brain')
    const orig = brain.llmCall
    brain.llmCall = async () => ({
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: '{"kind":"gift","item":"diamond_sword"}' }],
    })
    try {
      const b = fakeBot(dirt8)
      const placed = []
      b.placeBlock = async (ref) => { placed.push(ref) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx, null, {})
      assert.equal(ctx.stepStatus, 'done')
      assert.deepEqual(b.tossed, [])
      assert.deepEqual(placed, [])
    } finally {
      brain.llmCall = orig
      Math.random = realRandom
      if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = OLD_KEY
    }
  })
  it('a valid model gift executes with the improv line', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const realRandom = Math.random
    Math.random = () => 0.75
    const brain = require('../src/brain')
    const orig = brain.llmCall
    brain.llmCall = async () => ({
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: '{"kind":"gift","item":"dirt"}' }],
    })
    try {
      const b = fakeBot(dirt8)
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx, null, {})
      assert.equal(ctx.stepStatus, 'done')
      assert.deepEqual(b.tossed, ['dirt'])
      assert.ok(b.chats.includes(fun.CHAT_IMPROV), `chats=${JSON.stringify(b.chats)}`)
    } finally {
      brain.llmCall = orig
      Math.random = realRandom
      if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = OLD_KEY
    }
  })
  it('pack summary fed to the model is capped', () => {
    const many = []
    for (let i = 0; i < 40; i++) many.push({ name: `item_${i}`, count: 64 })
    const s = fun.packSummary(fakeBot(many))
    assert.ok(s.length <= 300, `len=${s.length}`)
    assert.ok(s.includes('item_0 x64'))
  })
})
