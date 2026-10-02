'use strict'

// idkcraft-g0z.4: castle materials — the castlefetch arbiter step and its
// sources (castle chest -> craft -> dig stone / chop logs).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const BLOCK_IDS = { stone: 1, chest: 2 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function add(items, name, n) {
  const it = items.find((i) => i.name === name)
  if (it) it.count += n
  else items.push({ name, count: n })
}

function count(items, name) {
  return items.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
}

// set: "x,y,z" -> block name; below y 64 reads dirt. chest: stacks in the
// one chest (any chest block opens it).
function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), chest = [], timeOfDay = 6000 } = {}) {
  const calls = { goals: [], withdraw: [], dig: [], opens: [] }
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
  }
  const bot = {
    username: 'IdkBot',
    calls,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { stone: { id: BLOCK_IDS.stone }, chest: { id: BLOCK_IDS.chest } },
      itemsByName: { oak_planks: {}, birch_planks: {}, oak_log: {}, oak_fence: {}, birch_fence: {}, nether_brick_fence: {}, oak_door: {}, iron_door: {}, torch: {}, cobblestone: {}, stick: {} },
    },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: ({ matching }) => {
      const want = Object.keys(BLOCK_IDS).find((n) => BLOCK_IDS[n] === matching)
      const out = []
      for (const [k, n] of set) {
        if (n !== want) continue
        const [x, y, z] = k.split(',').map(Number)
        out.push(pos(x, y, z))
      }
      return out
    },
    openChest: async (block) => {
      calls.opens.push(block.position)
      return {
        containerItems: () => chest.map((s) => ({ ...s, type: s.name, metadata: null })),
        withdraw: async (type, meta, n) => {
          calls.withdraw.push([type, n])
          const s = chest.find((c) => c.name === type)
          s.count -= n
          add(items, type, n)
        },
        close() {},
      }
    },
    equip: async () => {},
    dig: async (b) => {
      calls.dig.push(b.position)
      set.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air')
      add(items, 'cobblestone', 1)
    },
    pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: blueprint.BLUEPRINT_VERSION, phase: 'body', blocked: {}, parked: false, ...extra }
}

const TOOLS = () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }] // scaffold kit: equip is content
const settle = () => new Promise((r) => setImmediate(r))

describe('castlefetch arbiter step (g0z.4)', () => {
  it('sits right before the castle step', () => {
    const o = goal.STEP_ORDER
    assert.equal(o.indexOf('castlefetch') + 1, o.indexOf('castle'))
    assert.ok(goal.STEP_CRITERIA.castlefetch)
  })

  it('stone-none by day with a pickaxe -> castlefetch; never at night', async () => {
    const items = TOOLS()
    const ctx = { castle: castleState() }
    assert.equal(goal.goalFacts(makeBot({ items }), ctx).castle, 'stone-none')
    assert.equal((await goal.decide(makeBot({ items }), ctx)).action, 'castlefetch')
    const night = await goal.decide(makeBot({ items, timeOfDay: 18000 }), { castle: castleState() })
    assert.notEqual(night.action, 'castlefetch')
  })

  it('a running fetch keeps going to its stack target past the castle batch line', async () => {
    const items = [...TOOLS(), { name: 'cobblestone', count: 16 + 20 }] // 20 usable: a castle batch
    const bot = makeBot({ items })
    const fresh = { castle: castleState() }
    assert.equal(goal.goalFacts(bot, fresh).castle, 'stone-batch')
    assert.equal((await goal.decide(bot, fresh)).action, 'castle', 'fresh pick lays the batch on hand')
    const running = { castle: castleState(), step: 'castlefetch', stepStatus: 'running', goalText: 'stale' }
    assert.equal((await goal.decide(bot, running)).action, 'castlefetch', 'the fetch finishes its 64')
    items[3].count = 16 + 64
    running.stepStatus = 'done' // the behaviour's own done at the target
    assert.equal((await goal.decide(bot, running)).action, 'castle', 'target met: back to laying')
  })

  it('no pickaxe: stone fetch yields so equip rearms first', async () => {
    const items = [{ name: 'cobblestone', count: 16 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }]
    const ctx = { castle: castleState() }
    const r = await goal.decide(makeBot({ items }), ctx)
    assert.equal(r.action, 'equip')
    assert.match(goal.stepWhy('castlefetch', goal.goalFacts(makeBot({ items }), ctx), null, ctx, ''), /no pickaxe/)
  })
})

describe('castlefetch sources (g0z.4)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
  })

  it('missing stone: withdraws cobble from the castle chest (explicit position, home chest untouched)', async () => {
    const set = new Map([[`${SITE.x},${SITE.y},${SITE.z}`, 'chest']])
    const items = TOOLS()
    const chest = [{ name: 'cobblestone', count: 128 }]
    const bot = makeBot({ items, set, chest, at: pos(SITE.x + 1.5, 64, SITE.z - 0.5) })
    const homeChest = pos(0, 64, 0)
    const ctx = { castle: castleState(), home: { site: pos(-10, 64, -10), chest: homeChest } }
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(bot.calls.opens.length, 1)
    assert.equal(bot.calls.opens[0].x, SITE.x)
    assert.equal(ctx.home.chest, homeChest)
    assert.equal(count(items, 'cobblestone'), 64 + 16, 'stack target plus the scaffold reserve in one withdraw')
    assert.equal(bot.calls.dig.length, 0)
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done', 'target met ends the leg')
  })

  it('empty castle chest -> digs stone off the site, never on it', async () => {
    const set = new Map([
      [`${SITE.x},${SITE.y},${SITE.z}`, 'chest'],
      [`${SITE.x + 3},${SITE.y - 1},${SITE.z + 3}`, 'stone'], // castle ground: never
      [`${SITE.x - 5},${SITE.y},${SITE.z - 5}`, 'stone'],
    ])
    const items = TOOLS()
    const bot = makeBot({ items, set, chest: [], at: pos(SITE.x - 4, 64, SITE.z - 4) })
    const ctx = { castle: castleState() }
    // Chest leg: walk to it first.
    bot.entity.position = pos(SITE.x + 1.5, 64, SITE.z - 0.5)
    fetch(bot, ctx)
    await settle(); await settle()
    assert.ok(ctx.castleFetch.chestDone)
    bot.entity.position = pos(SITE.x - 4, 64, SITE.z - 4)
    fetch(bot, ctx) // picks the target (in pickup reach) and digs
    await settle(); await settle()
    assert.deepEqual(bot.calls.dig.map((p) => [p.x, p.y, p.z]), [[SITE.x - 5, SITE.y, SITE.z - 5]])
    assert.equal(count(items, 'cobblestone'), 1)
    fetch(bot, ctx) // the only off-site stone is gone: nothing reachable
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
  })

  it('no stone reachable -> failed + hold: the arbiter moves on, then retries after the bound', async () => {
    const items = TOOLS()
    const bot = makeBot({ items })
    const ctx = { castle: castleState() }
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
    assert.notEqual((await goal.decide(bot, ctx)).action, 'castlefetch', 'held: no churn')
    ctx.stepStatus = 'done'
    assert.notEqual((await goal.decide(bot, ctx)).action, 'castlefetch', 'still held')
    ctx.stepFail.castlefetch.at -= goal.CASTLEFETCH_RETRY_MS + 1
    ctx.stepStatus = 'running' // whatever took over is still running, text unchanged
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch', 'bounded: an owner restock gets looked at')
  })

  it('missing fence: crafts it from planks + sticks', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const asked = []
    fetch.deps.craftItem = (bot, ctx, names, n) => { asked.push([names, n]); return 'running' }
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }, { name: 'stick', count: 4 }] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.equal(asked.length, 1)
    assert.deepEqual(asked[0][0], ['birch_fence', 'oak_fence'], 'birch first, no nether brick')
    assert.equal(asked[0][1], 3)
    assert.notEqual(ctx.stepStatus, 'failed:castlefetch-no-fence')
  })

  it('missing planks with nothing to craft: chops logs through gather', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'planks', left: 20 }; return 'planks-none' }
    fetch.deps.craftItem = () => ({ done: false, line: 'need 1 log' })
    let chopped = 0
    fetch.deps.gather = (bot, ctx) => { chopped++; ctx.stepStatus = 'running' }
    const bot = makeBot({ items: [] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    fetch(bot, ctx)
    assert.equal(chopped, 2)
  })

  it('torch without coal above the reserve fails instead of spinning', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'torch', left: 5 }; return 'torch-none' }
    let crafted = 0
    fetch.deps.craftItem = () => { crafted++; return 'running' }
    const bot = makeBot({ items: [{ name: 'coal', count: 4 }, { name: 'stick', count: 4 }] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.equal(crafted, 0, 'coal at the smelting floor is never torched')
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-torch')
  })

  it('pick breaks mid-batch: leg ends, equip rearms with the reserved cobble + sticks, then the fetch resumes', async () => {
    const set = new Map([[`${SITE.x - 5},${SITE.y},${SITE.z - 5}`, 'stone'], [`${SITE.x - 6},${SITE.y},${SITE.z - 5}`, 'stone']])
    const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'cobblestone', count: 16 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }]
    const bot = makeBot({ items, set })
    const ctx = { castle: castleState() }
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
    items.splice(0, 1) // the pickaxe breaks
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal((await goal.decide(bot, ctx)).action, 'equip', 'rearm first')
    assert.ok(count(items, 'cobblestone') >= 3 && count(items, 'stick') >= 2, 'tool inputs retained')
    items.unshift({ name: 'stone_pickaxe', count: 1 }) // equip landed it
    ctx.stepStatus = 'done'
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch', 'back to the stone')
  })

  it('the castle lays birch planks first when it has them', () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 20 }, { name: 'birch_planks', count: 20 }] })
    assert.equal(castleMod.findItem(bot, 'planks').name, 'birch_planks')
    assert.equal(castleMod.findItem(makeBot({ items: [{ name: 'oak_planks', count: 20 }] }), 'planks').name, 'oak_planks')
  })
})
