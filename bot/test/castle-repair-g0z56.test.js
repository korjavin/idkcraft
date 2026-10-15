'use strict'

// idkcraft-g0z.56: 'castle repair' — damage report by kind on a complete
// castle, un-park + relay; the arbiter keeps the relay ahead of the house
// while cells are missing; the castlefetch wood shortfall is named.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const goal = require('../src/goal')
const castlefetch = require('../src/behaviours/castlefetch')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

// A complete v2 castle laid in the world, moat dug.
function completeSet() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    if (blueprint.isPlaceTarget(c.kind)) set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    else if (c.kind === 'dig') set.set(`${c.x},${c.y},${c.z}`, 'air')
  }
  return set
}

// The acceptance's 20 cells: a fence row (12), the door + 4 wall cells, 3 torches.
function knockOut(set) {
  const cells = blueprint.absPlan(SITE, 0, 2).cells
  const fence = cells.filter((c) => c.kind === 'fence').slice(0, 12)
  const door = cells.filter((c) => c.kind === 'door')
  const stone = cells.filter((c) => c.kind === 'stone' && c.y === SITE.y + 1).slice(0, 4)
  const torch = cells.filter((c) => c.kind === 'torch').slice(0, 3)
  const out = [...fence, ...door, ...stone, ...torch]
  for (const c of out) set.set(`${c.x},${c.y},${c.z}`, 'air')
  return out
}

function makeBot({ items = [], set = completeSet(), timeOfDay = 6000 } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(SITE.x - 4, 64, SITE.z - 4) },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false, ...extra }
}

describe('castle repair (g0z.56)', () => {
  it("'castle' and 'castle repair' report the 20 knocked-out cells by kind; repair un-parks", () => {
    const set = completeSet()
    assert.equal(knockOut(set).length, 20)
    const bot = makeBot({ set })
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.castle = castleState({ parked: true })
    handleChat(bot, ticker, 'Steve', 'castle')
    const line = bot.chats.pop()
    assert.match(line, /^castle at 100 64 200: \d+%, 20 cells missing \(fence 12, stone 4, torch 3, door 1\); now: parked — say castle go; blocked 0/)
    assert.ok(line.length <= 256)
    let worked = 0
    const work = ticker.work
    ticker.work = () => { worked++; return work() }
    handleChat(bot, ticker, 'Steve', 'castle repair')
    assert.equal(bot.chats.pop(), 'castle: 20 cells missing (fence 12, stone 4, torch 3, door 1); repairing — drop logs or planks in the castle chest to speed it up')
    assert.equal(ctx.castle.parked, false)
    assert.equal(worked, 1)
  })

  it("'castle repair' on an intact castle says so and changes nothing", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.castle = castleState({ parked: true })
    const before = JSON.stringify(ctx.castle)
    let worked = 0
    ticker.work = () => { worked++ }
    handleChat(bot, ticker, 'Steve', 'castle repair')
    assert.equal(bot.chats.pop(), 'castle at 100 64 200 is intact — nothing to repair')
    assert.equal(JSON.stringify(ctx.castle), before)
    assert.equal(worked, 0)
    // The plain reply keeps the per-kind laid counts on an intact castle.
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.match(bot.chats.pop(), /^castle at 100 64 200: 100% \(stone /)
  })

  it("'castle repair' on an unfinished castle or with no castle changes nothing", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'castle repair')
    assert.equal(bot.chats.pop(), 'no castle yet — say build castle')
    bot._tickerCtx.castle = castleState({ phase: 'body', parked: true })
    handleChat(bot, ticker, 'Steve', 'castle repair')
    assert.equal(bot.chats.pop(), 'the castle is not finished yet — say castle go to resume')
    assert.equal(bot._tickerCtx.castle.parked, true)
  })

  it('names the wood shortfall when the last fetch found no trees', () => {
    const set = completeSet()
    knockOut(set)
    const bot = makeBot({ set })
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.castle = castleState({ status: 'no wood within 64 — drop logs in the castle chest' })
    handleChat(bot, ticker, 'Steve', 'castle repair')
    assert.match(bot.chats.pop(), /; repairing — drop logs or planks in the castle chest to speed it up; no wood within 64 — drop logs in the castle chest$/)
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.match(bot.chats.pop(), /now: no wood within 64 — drop logs in the castle chest; blocked 0/)
  })

  it('castlefetch: a woodless fence leg names the gap and the no-trees shortfall', () => {
    const set = completeSet()
    for (const c of blueprint.absPlan(SITE, 0, 2).cells.filter((x) => x.kind === 'fence').slice(0, 12)) set.set(`${c.x},${c.y},${c.z}`, 'air')
    const bot = makeBot({ set, items: [{ name: 'stone_pickaxe', count: 1 }] })
    bot.registry = { itemsByName: { oak_fence: {}, warped_fence: {}, oak_planks: {}, warped_planks: {} } }
    const ctx = { castle: castleState() }
    const d = castlefetch.deps
    const saved = { craftItem: d.craftItem, gather: d.gather }
    const logs = []
    const log = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      d.craftItem = () => ({ done: false, line: "can't make warped_fence: need 4 warped_planks (have 0)" })
      d.gather = (b, c) => { c.stepStatus = 'failed:no-trees' }
      castlefetch(bot, ctx, null, {})
    } finally {
      Object.assign(d, saved)
      console.log = log
    }
    assert.ok(logs.includes("castlefetch fence: craft failed: can't craft fence: no planks or logs"), logs.join('\n'))
    assert.equal(ctx.castle.status, 'no wood within 64 — drop logs in the castle chest')
    assert.ok(logs.includes('castlefetch fence: no wood within 64 — drop logs in the castle chest'))
  })

  it('the arbiter keeps the relay ahead of the house while cells are missing', async () => {
    // Walls knocked out, cobble on hand: the castle step lays them.
    const set = completeSet()
    knockOut(set)
    const home = { site: pos(SITE.x - 40, 64, SITE.z), built: false, v: 2 }
    const planks = { name: 'oak_planks', count: 64 }
    const cobble = { name: 'cobblestone', count: 64 }
    const pick = { name: 'stone_pickaxe', count: 1 }
    const sword = { name: 'stone_sword', count: 1 }
    const withStone = makeBot({ set, items: [cobble, planks, pick, sword] })
    const r1 = await goal.decide(withStone, { castle: castleState(), home })
    assert.equal(r1.action, 'castle')
    // Only wood cells left (fence, door), planks on hand: the fetch crafts them.
    const cells = blueprint.absPlan(SITE, 0, 2).cells
    for (const c of cells) if (c.kind === 'stone' || c.kind === 'torch') set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    const woodOnly = makeBot({ set, items: [planks, pick, sword] })
    const ctx = { castle: castleState(), home }
    const f = goal.goalFacts(woodOnly, ctx)
    assert.match(f.castle, /^(fence|door)-none$/)
    assert.ok(castlefetch.demand(woodOnly, ctx).short > 0)
    const r2 = await goal.decide(woodOnly, ctx)
    assert.equal(r2.action, 'castlefetch')
  })
})
