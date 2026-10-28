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
const consts = require('../src/plan-consts')
const { STEP_ORDER } = consts
// Explicit registration (o95q R1.5): goal.js stays untouched — the step
// joins the menu through registerInto, in prod called by src/index.js.
fun.registerInto(goal, consts)

const OLD_KEY = process.env.ANTHROPIC_API_KEY

function botWith(items, extra = {}) {
  const inv = items.map((i) => ({ type: 1, ...i }))
  const bot = {
    inv,
    chats: [],
    tossed: [],
    placed: [],
    tossedCounts: [],
    looked: [],
    walkGoals: [],
    inventory: { items: () => inv },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 } },
    entities: {},
    players: {},
    lookAt: async (p) => { botWith.last.looked.push([p.x, p.y, p.z]) },
    pathfinder: { goal: null, setGoal(g) { botWith.last.walkGoals.push(g ? (g.constructor && g.constructor.name) || 'goal' : null) } },
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

const facts = (over = {}) => ({
  time: 'day', castle: 'none', player: 'none', home: 'built', known: 'none',
  haul: 'none', surplus: 'no', pinned: 'none', beds: 'both', gear: 'done',
  sword: 1, pickaxe: 1, logs: 0, unlit: 0, torches: 0, rearm: false,
  maxPlanks: 0, table: 0, door: 0, scaffold: 16,
  chest: 'yes', chestTodo: 'none', gearHandover: 'none',
  coal: 0, charcoal: 0, sticks: 0,
  ...over,
})
const dirt8 = [{ name: 'dirt', count: 8 }]
const dirt20 = [{ name: 'dirt', count: 20 }]
const junkPair = [{ name: 'rotten_flesh', count: 2 }]

function nearSteve(items = junkPair, extra = {}) {
  const withScaffold = [...items, { name: 'dirt', count: 16 }]
  return fakeBot(withScaffold, {
    players: { Steve: { username: 'Steve', entity: { position: { x: 2, y: 64, z: 0 } } } },
    ...extra,
  })
}

function idleCtx(over = {}) {
  return { step: 'rest', funIdleSince: Date.now() - fun.FUN_IDLE_MS - 60000, ...over }
}

describe('fun gating (o95q idle-only)', () => {
  it('fires on an idle day with junk or cheap mats after a sustained idle stretch', () => {
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), idleCtx()), true)
    assert.equal(goal.MENU.fun.feasible(facts(), nearSteve(), idleCtx()), true)
  })
  it('a fresh or busy body waits: no history, no joke', () => {
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), { step: 'rest' }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), { step: 'gather', funIdleSince: Date.now() - fun.FUN_IDLE_MS - 60000 }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), idleCtx({ step: 'gather' })), false)
    // An idle stretch accrues: rest then explore keeps the clock.
    const ctx = idleCtx({ step: 'explore' })
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), ctx), true)
    // ...and so does sheltering through the night (R4.1): only productive
    // work restarts the clock, so idle credit survives dawn.
    const night = idleCtx({ step: 'shelter' })
    assert.equal(goal.MENU.fun.feasible(facts({ time: 'day' }), fakeBot(dirt20), night), true)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), idleCtx({ step: 'gohome' })), false)
  })
  it('stays out while useful work is available (home, finds, castle)', () => {
    const b = () => fakeBot(dirt8)
    assert.equal(goal.MENU.fun.feasible(facts({ home: 'site' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts({ home: 'none' }), b(), {}), false)
    assert.equal(goal.MENU.fun.feasible({ ...facts(), known: 'near' }, b(), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts({ castle: 'stone-batch' }), b(), {}), false)
  })
  it('never triggers under order, castle, night, fight, or cooldown', () => {
    // idleCtx everywhere: only the named gate may bite, never the idle clock.
    const b = () => fakeBot(dirt20)
    assert.equal(goal.MENU.fun.feasible(facts({ time: 'night' }), b(), idleCtx()), false)
    assert.equal(goal.MENU.fun.feasible(facts({ time: 'dusk' }), b(), idleCtx()), false)
    assert.equal(goal.MENU.fun.feasible(facts({ castle: 'blocked' }), b(), idleCtx()), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { bring: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { lead: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { comehome: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { flat: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { taskPlanStep: 'craft', ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { llmOrder: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { llmAsk: {}, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { paused: true, ...idleCtx() }), false)
    assert.equal(goal.MENU.fun.feasible(facts(), b(), { ...idleCtx(), funNext: Date.now() + 60000 }), false)
    const hostile = b()
    hostile.entities = { 7: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
    hostile.entity.position.distanceTo = () => 3
    assert.equal(goal.MENU.fun.feasible(facts(), hostile, idleCtx()), false)
    // Productive work during cooldown still resets the idle credit.
    const worked = b()
    const t0 = Date.now()
    const wctx = { step: 'gather', funIdleSince: t0 - fun.FUN_IDLE_MS - 60000, funNext: t0 + 3600000 }
    assert.equal(goal.MENU.fun.feasible(facts(), worked, wctx), false)
    assert.ok(wctx.funIdleSince >= t0, 'credit restamped despite the cooldown')
  })
  it('stays infeasible with an empty pack or nothing jokeable', () => {
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([]), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([{ name: 'dirt', count: 1 }]), {}), false)
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot([{ name: 'diamond_sword', count: 3 }]), {}), false)
  })
  it('ranks just above explore and above rest, below every work step', () => {
    assert.equal(STEP_ORDER.indexOf('fun'), STEP_ORDER.indexOf('explore') - 1)
    assert.equal(STEP_ORDER.indexOf('fun'), STEP_ORDER.indexOf('rest') - 2)
    assert.equal(goal.goalFsm(facts(), ['rest', 'fun']), 'fun')
    assert.equal(goal.goalFsm(facts(), ['explore', 'fun', 'rest']), 'fun')
    assert.equal(goal.goalFsm(facts(), ['gather', 'fun', 'rest']), 'gather')
  })
  it('precise idle: joke fires only when nothing productive is available', () => {
    const idle = () => fakeBot([{ name: 'dirt', count: 20 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }])
    assert.equal(goal.MENU.fun.feasible(facts(), idle(), idleCtx()), true)
    // Every productive alternative vetoes, even with mats on hand —
    // each checked against an already-idle body so only that gate bites.
    // u02t: beds owed-but-runnable rides along so the menu is never
    // blocked here — the vetoes below bite while work can run; the
    // blocked-menu release is covered in fun-blocked-u02t.test.js.
    for (const over of [
      { home: 'site' }, { home: 'none' }, { known: 'near' },
      { haul: 'waiting' }, { surplus: 'yes' }, { pinned: 'craft' },
      { gear: 'ready' }, { gear: 'want' },
      { sword: 0 }, { pickaxe: 0 }, { rearm: true }, { logs: 14 },
      { scaffold: 0 },
      { table: 0, maxPlanks: 4, tableOwed: true },
      { door: 0, tablePlaced: true, maxPlanks: 6 },
    ]) assert.equal(goal.MENU.fun.feasible(facts({ beds: 'none', ...over }), idle(), idleCtx()), false, JSON.stringify(over))
  })
  it('owed beds no longer veto the joke (u19u classifier demotion)', () => {
    const idle = () => fakeBot([{ name: 'dirt', count: 20 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }])
    // Beds owed is a classifier criterion now, not a menu veto: the joke
    // stays feasible with beds owed (prod decides by FSM rank until a tick
    // ask is wired). All other idle pins are unchanged.
    assert.equal(goal.MENU.fun.feasible(facts({ beds: 'none' }), idle(), idleCtx()), true)
    assert.equal(goal.MENU.fun.feasible(facts({ beds: 'one' }), idle(), idleCtx()), true)
    assert.ok(String(goal.STEP_CRITERIA.fun).includes('beds owed'), 'criterion names the owed work')
  })
  it('a lightable yard and bankable goods belong to light/stockpile (R5.1 mirrors)', () => {
    // A yard only counts when the bot has a home site (light itself needs
    // one) — so these run with the site pinned next to the body.
    const yard = () => idleCtx({ home: { site: { x: 0, y: 64, z: 0 } } })
    const b = () => fakeBot(dirt20)
    // Torches on hand with dark yard: light fires, not fun.
    assert.equal(goal.MENU.fun.feasible(facts({ unlit: 3, torches: 2 }), b(), yard()), false)
    // The R5 repro verbatim: craftable charcoal fuel plus sticks.
    assert.equal(goal.MENU.fun.feasible(
      facts({ unlit: 1, torches: 0, coal: 1, charcoal: 1, sticks: 1 }), b(), yard()), false)
    // ...but a dark yard with no fuel and no wood is nobody's work:
    // light cannot fire, so the joke may.
    assert.equal(goal.MENU.fun.feasible(facts({ unlit: 2, torches: 0 }), b(), yard()), true)
    // Stockpile's complement: a chest to adopt/place, bankable surplus,
    // or finished goods awaiting handover all veto the joke.
    assert.equal(goal.MENU.fun.feasible(facts({ chest: 'no', chestTodo: 'place' }), b(), idleCtx()), false)
    assert.equal(goal.MENU.fun.feasible(facts({ gearHandover: 'waiting' }), b(), idleCtx()), false)
    assert.equal(goal.MENU.fun.feasible(facts({ surplus: 'yes' }), b(), idleCtx()), false)
    // ...while a standing chest with nothing to bank is no veto.
    assert.equal(goal.MENU.fun.feasible(facts({ chest: 'yes', chestTodo: 'none' }), b(), idleCtx()), true)
  })
  it('a wooden pick plus stone chain belongs to equip, not whimsy', () => {
    const wood = fakeBot([{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }, { name: 'dirt', count: 16 }])
    assert.equal(fun.upgradeDue(wood), true)
    // u02t: beds owed-but-runnable keeps the menu unblocked, so the
    // upgrade veto bites while work can run (blocked-menu release is
    // covered in fun-blocked-u02t.test.js).
    assert.equal(goal.MENU.fun.feasible(facts({ pickaxe: 1, sword: 1, beds: 'none' }), wood, idleCtx()), false)
    const stone = fakeBot([{ name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 8 }])
    assert.equal(fun.upgradeDue(stone), false)
  })
  it('FSM mode picks the joke over rest and a nothing-new explore', () => {
    // The R2#1 repro shape, through real goalFacts: built home, no
    // castle/order/find, full kit, stacked scaffold, cheap mats —
    // explore starves no more.
    const b = fakeBot([
      { name: 'dirt', count: 20 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 },
    ])
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true },
      step: 'explore', funIdleSince: Date.now() - fun.FUN_IDLE_MS - 60000,
    }
    const f = goal.goalFacts(b, ctx)
    assert.equal(f.home, 'built')
    assert.equal(goal.MENU.fun.feasible(f, b, ctx), true, `why-not=${goal.stepWhy('fun', f, b, ctx, '')}`)
    const idleNames = ['explore', 'fun', 'rest'].filter((n) => goal.MENU[n].feasible(f, b, ctx))
    assert.equal(goal.goalFsm(f, idleNames), 'fun')
    // ...but a scaffold refill keeps equip in the menu and on top (R4.3:
    // equip is not hidden from the comparison).
    const short = fakeBot([
      { name: 'dirt', count: 10 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 },
    ])
    const f2 = goal.goalFacts(short, ctx)
    assert.equal(goal.MENU.equip.feasible(f2, short, ctx), true, 'equip wants blocks')
    assert.equal(goal.MENU.fun.feasible(f2, short, ctx), false, 'the joke yields to the refill')
    const names2 = Object.keys(goal.MENU).filter((n) => goal.MENU[n].feasible(f2, short, ctx))
    assert.ok(names2.includes('equip'), `menu=${names2.join(',')}`)
    assert.equal(goal.goalFsm(f2, names2), 'equip')
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
    const realRandom = Math.random
    Math.random = () => 0 // avail [gift, folly]: index 0 = gift
    try {
      const b = nearSteve()
      const ctx = {}
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, ['rotten_flesh'])
      assert.deepEqual(b.tossedCounts, [1], 'one item, the last stays')
      assert.deepEqual(b.inv, [{ type: 1, name: 'rotten_flesh', count: 1 }, { type: 1, name: 'dirt', count: 16 }])
      assert.ok(b.looked.length >= 1, 'faces the recipient before tossing')
      assert.ok(Math.abs(b.looked[0][0] - 2) < 1 && Math.abs(b.looked[0][2] - 0) < 1, `looked=${JSON.stringify(b.looked)}`)
      assert.ok(b.chats.includes(fun.CHAT_GIFT), `chats=${JSON.stringify(b.chats)}`)
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      Math.random = realRandom
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
  it('the folly ring keeps off a parked flat episode too, not just flatEnd', () => {
    const b = fakeBot(dirt8)
    const ctx = { home: { site: { x: 100, y: 64, z: 100 } }, flat: { cx: 0, cz: 0, r: 8, parked: true } }
    assert.equal(fun.findFollySpot(b, ctx), null, 'the parked square is protected like flatEnd')
  })
  it('the folly ring keeps off the house footprint on every cell', () => {
    const b = fakeBot(dirt8)
    b.entity.position.x = 6
    b.entity.position.z = 5
    const ctx = {
      home: {
        site: { x: 0, y: 64, z: 0 },
        interior: { min: { x: 0, y: 64, z: 0 }, max: { x: 8, y: 70, z: 8 } },
      },
    }
    assert.equal(fun.findFollySpot(b, ctx), null, 'no ring cell may sit on the house')
  })
  it('the folly ring keeps off the castle footprint and yard', () => {
    const castle = require('../src/castle')
    const b = fakeBot(dirt8)
    b.entity.position.x = 20
    b.entity.position.z = 20
    const ctx = {
      home: { site: { x: 100, y: 64, z: 100 } },
      castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: castle.BLUEPRINT_VERSION, phase: 'complete' },
    }
    assert.equal(fun.findFollySpot(b, ctx), null, 'every candidate cell sits in the footprint')
  })
  it('an unseen or distant player gets no blind toss: delivery defers', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      // Online but unseen (no entity): the only pack is junk, so no act
      // runs — the joke backs off instead of tossing at its own feet.
      const far = fakeBot(junkPair, { players: { Steve: { username: 'Steve' } } })
      assert.deepEqual(fun.availActs(far, {}), [])
      const ctxFar = {}
      await fun.run(far, ctxFar)
      assert.equal(ctxFar.stepStatus, 'failed:fun-no-mats')
      assert.deepEqual(far.tossed, [])
      // Visible but 100 blocks out: same deferral.
      const away = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: { x: 100, y: 64, z: 100 } } } },
      })
      assert.deepEqual(fun.availActs(away, {}), [])
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('an unreachable recipient holds the gift: no blind toss', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      // Steve at 7 blocks: offered, but the fake body never walks there.
      const here7 = { x: 7, y: 64, z: 0 }
      const b = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: here7 } } },
      })
      const ctx = { funApproachMs: 300 }
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, [], 'nothing leaves the pack')
      assert.equal(ctx.stepStatus, 'failed:fun-no-recipient')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a recipient who logs out mid-approach keeps the gift', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(junkPair)
      let reads = 0
      const steve = { username: 'Steve', entity: { position: { x: 7, y: 64, z: 0 } } }
      Object.defineProperty(b, 'players', { get: () => (++reads <= 2 ? { Steve: steve } : {}) })
      const ctx = { funApproachMs: 2000 }
      await fun.run(b, ctx) // offered, then gone before handover
      assert.deepEqual(b.tossed, [])
      assert.equal(ctx.stepStatus, 'failed:fun-no-recipient')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('combat during equip holds fire: threat checked after equip', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt8)
      const placed = []
      b.equip = async () => {
        b.entities = { 9: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
        b.entity.position.distanceTo = () => 3
      }
      b.placeBlock = async (ref) => { placed.push(ref) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx) // folly is the only act: no dice involved
      assert.deepEqual(placed, [], 'a zombie arriving mid-equip stops the ring')
      assert.equal(ctx.stepStatus, 'failed:fun-threat')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a recipient lost after facing holds the toss: rechecked, not thrown', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const realRandom = Math.random
    Math.random = () => 0 // avail [gift, folly]: index 0 = gift
    try {
      const b = nearSteve()
      const origLook = b.lookAt
      b.lookAt = async (p) => {
        await origLook(p)
        delete b.players.Steve // walks out between facing and the toss
      }
      const ctx = {}
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, [], 'the toss is rechecked after the facing await')
      assert.equal(ctx.stepStatus, 'failed:fun-no-recipient')
    } finally {
      Math.random = realRandom
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a recipient drifting past toss range holds the toss (R5.3)', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const realRandom = Math.random
    Math.random = () => 0 // avail [gift, folly]: index 0 = gift
    try {
      const pos = { x: 2, y: 64, z: 0 }
      const b = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: pos } } },
      })
      const origLook = b.lookAt
      b.lookAt = async (p) => {
        await origLook(p)
        pos.x = 7 // backs away during the facing await: seen, but past handover range
      }
      const ctx = {}
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, [], 'past toss range is not a handover')
      assert.equal(ctx.stepStatus, 'failed:fun-no-recipient')
    } finally {
      Math.random = realRandom
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a stack dropping to its last item keeps the gift (R5.5)', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const realRandom = Math.random
    Math.random = () => 0 // avail [gift, folly]: index 0 = gift
    try {
      const b = nearSteve()
      const origLook = b.lookAt
      b.lookAt = async (p) => {
        await origLook(p)
        b.inv.find((i) => i && i.name === 'rotten_flesh').count = 1 // eaten/spent mid-approach
      }
      const ctx = {}
      await fun.run(b, ctx)
      assert.deepEqual(b.tossed, [], 'the last item is survival stock, never the joke')
      assert.deepEqual(b.chats, [], 'no proud line for a joke that did not land')
      assert.equal(ctx.stepStatus, 'done', 'an honest skip, not a failure')
    } finally {
      Math.random = realRandom
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a body stepping into a cell mid-equip skips that cell (R5.4)', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt8)
      let calls = 0
      const placed = []
      const origEquip = b.equip
      b.equip = async (...a) => {
        calls++
        // Second cell is (3,64,1) — ring order off centre (2,64,0); the
        // bot's own feet take the centre cell, so 6 are offered. A body
        // steps into exactly that cell during its equip await: past the
        // loop-start check, caught only by the post-equip recheck.
        if (calls === 2) b.entities = { 9: { position: { x: 3.5, y: 64, z: 1.5 }, isValid: true } }
        return origEquip(...a)
      }
      b.placeBlock = async (ref) => { placed.push(ref) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx) // folly is the only act: no dice involved
      assert.equal(placed.length, 5, `one cell skipped, the ring lands: ${placed.length}`)
      assert.equal(ctx.stepStatus, 'done')
      assert.ok(b.chats.includes(fun.CHAT_FOLLY), `chats=${JSON.stringify(b.chats)}`)
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a preempted walk keeps the replacement movement goal', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const step = require('../src/step')
    try {
      // Steve at 7: the act walks first, so there is a window to preempt.
      const b = fakeBot(junkPair, {
        players: { Steve: { username: 'Steve', entity: { position: { x: 7, y: 64, z: 0 } } } },
      })
      const replacement = { kind: 'replacement-follow' }
      b.pathfinder.goal = null
      b.pathfinder.setGoal = (g) => {
        b.pathfinder.goal = g
        b.walkGoals.push('set')
        step.nextStepGen(b._ctx) // an order lands as the walk starts...
        b.pathfinder.goal = replacement // ...and the new step takes the body
      }
      const ctx = { funApproachMs: 2000 }
      b._ctx = ctx
      await fun.run(b, ctx)
      assert.equal(b.pathfinder.goal, replacement, 'cleanup does not null a goal it did not set')
      assert.equal(ctx.stepStatus, undefined)
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a stop ordered mid-equip places nothing', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const step = require('../src/step')
      const b = fakeBot(dirt8)
      const placed = []
      b.equip = async () => {
        step.nextStepGen(b._ctx) // stop lands while the hand fills
      }
      b.placeBlock = async (ref) => { placed.push(ref) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      b._ctx = ctx
      await fun.run(b, ctx) // folly is the only act: no dice involved
      assert.deepEqual(placed, [])
      assert.equal(ctx.stepStatus, undefined, 'no completion leaks into the replacement step')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('combat cancels the joke: threat after the model answer aborts', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const realRandom = Math.random
    Math.random = () => 0.999 // avail [folly, improv]: last = improv
    const brain = require('../src/brain')
    const orig = brain.llmCall
    brain.llmCall = async () => ({
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: '{"kind":"build","block":"dirt","count":7}' }],
    })
    try {
      const b = fakeBot(dirt8)
      const placed = []
      b.placeBlock = async (ref) => { placed.push(ref) }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      b.entities = { 9: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
      b.entity.position.distanceTo = () => 3
      await fun.run(b, ctx)
      assert.equal(ctx.stepStatus, 'failed:fun-threat')
      assert.deepEqual(placed, [], 'the ring never starts under combat')
      assert.deepEqual(b.chats, [])
    } finally {
      brain.llmCall = orig
      Math.random = realRandom
      if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = OLD_KEY
    }
  })
  it('a body wandering into the ring skips that cell, the joke continues', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt20)
      const placed = []
      b.placeBlock = async (ref) => {
        placed.push([ref.position.x, ref.position.y, ref.position.z])
        // A cow wanders onto the next ring cell after the first placement.
        b.entities = { 3: { type: 'animal', name: 'cow', position: { x: 3, y: 64, z: 1 }, isValid: true } }
      }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx)
      // (3,1) is skipped outright; (2,0) falls inside the same fat collision
      // box and is skipped too — the other four land and the joke completes.
      assert.equal(placed.length, 4, `placed=${JSON.stringify(placed)}`)
      assert.ok(!placed.some(([x, y, z]) => x === 3 && z === 1), 'the occupied cell is skipped')
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      if (hadKey !== undefined) process.env.ANTHROPIC_API_KEY = hadKey
    }
  })
  it('a hostile walking up mid-ring stops the placements', async () => {
    const hadKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const b = fakeBot(dirt8)
      const placed = []
      b.placeBlock = async (ref) => {
        placed.push(ref)
        b.entities = { 9: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
        b.entity.position.distanceTo = () => 3
      }
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx) // folly is the only act: no dice involved
      assert.equal(placed.length, 1, 'one block lands before the threat reads')
      assert.equal(ctx.stepStatus, 'failed:fun-threat')
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
      // No recipient, no key: folly is the only available act, no dice involved.
      assert.deepEqual(fun.availActs(b, ctx), ['folly'])
      await fun.run(b, ctx, null, {})
      assert.ok(placed.length >= 1 && placed.length <= fun.MAX_PLACE, `placed=${placed.length}`)
      assert.deepEqual(new Set(placed.map((p) => p.join(','))).size, placed.length, 'no double-place')
      assert.ok(placed.every(([x, y, z]) => !(x === 0 && (y === 64 || y === 65) && z === 0)), 'never into the bot’s own cell')
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
      // avail [gift, folly, improv], r=0.75 -> improv; the gift executes
      // because Steve is in sight.
      const b = nearSteve(dirt8)
      const ctx = { home: { site: { x: 100, y: 64, z: 100 } } }
      await fun.run(b, ctx)
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

describe('fun running-step cooldown (codex R6 P2)', () => {
  it('a running joke stays feasible under its own cooldown; a new run does not', () => {
    // run() stamps funNext at pick time: without the running-step
    // exemption the next goal-text move forces a re-pick the joke can
    // never win (abandoned act, burned 30-60 min cooldown).
    const stamped = idleCtx({ step: 'fun', funNext: Date.now() + 30 * 60 * 1000 })
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), stamped), true)
    const next = idleCtx({ step: 'rest', funNext: Date.now() + 30 * 60 * 1000 })
    assert.equal(goal.MENU.fun.feasible(facts(), fakeBot(dirt20), next), false)
  })
})
