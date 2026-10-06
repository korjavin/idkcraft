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
// under(y): the default column (g0z.15 quarry worlds).
function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), chest = [], timeOfDay = 6000, under = (y) => (y <= 63 ? 'dirt' : 'air') } = {}) {
  const calls = { goals: [], withdraw: [], dig: [], opens: [] }
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : under(Math.floor(p.y))
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
      add(items, b.name === 'stone' ? 'cobblestone' : b.name, 1)
    },
    pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
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
    fetch(bot, ctx) // the only off-site stone is gone: the quarry takes over (g0z.15)
    assert.equal(ctx.stepStatus, undefined)
    assert.ok(ctx.castleFetch.target.quarry)
    assert.equal(fetch.onSite(ctx.castle, ctx.castleFetch.target, 2), false, 'the trench is off the site')
  })

  it('no stone reachable -> failed + hold: the arbiter moves on, then retries after the bound', async () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 63 ? 'water' : 'air') }) // a lake: no quarry side either
    const ctx = { castle: castleState() }
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
    const asks = () => bot.chats.filter((m) => /no stone/.test(m))
    assert.equal(asks().length, 1, 'one line to the owner')
    assert.match(asks()[0], /no stone near the castle at 100 200.*cobblestone into a chest/)
    assert.notEqual((await goal.decide(bot, ctx)).action, 'castlefetch', 'held: no churn')
    ctx.stepStatus = 'done'
    assert.notEqual((await goal.decide(bot, ctx)).action, 'castlefetch', 'still held')
    ctx.stepFail.castlefetch.at -= goal.CASTLEFETCH_RETRY_MS + 1
    ctx.stepStatus = 'running' // whatever took over is still running, text unchanged
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch', 'bounded: an owner restock gets looked at')
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
    assert.equal(asks().length, 1, 'the retry never repeats the line')
  })

  it('a moving facts text never releases the fetch hold before the bound (g0z.12 rig churn)', async () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 63 ? 'water' : 'air') })
    const ctx = { castle: castleState() }
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
    fetch(bot, ctx)
    await goal.decide(bot, ctx)
    ctx.stepFail.castlefetch.text = 'known=none flipped' // text-keyed hold no longer matches
    ctx.stepStatus = 'done'
    assert.notEqual((await goal.decide(bot, ctx)).action, 'castlefetch')
    assert.equal(goal.MENU.castlefetch.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
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

describe('castlefetch give-ups and guards (g0z.4 revmux 01)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
  })

  it('a running fetch keeps the castle step off the model menu too', () => {
    const items = [...TOOLS(), { name: 'cobblestone', count: 16 + 20 }]
    const bot = makeBot({ items })
    const running = { castle: castleState(), step: 'castlefetch', stepStatus: 'running' }
    const facts = goal.goalFacts(bot, running)
    assert.equal(facts.castle, 'stone-batch')
    assert.equal(goal.MENU.castle.feasible(facts, bot, running), false)
    assert.equal(goal.MENU.castlefetch.feasible(facts, bot, running), true)
    assert.equal(goal.MENU.castle.feasible(facts, bot, { castle: castleState() }), true, 'no fetch running: the castle lays')
  })

  it('a craft failure with a full log load fails (holds) instead of chopping into an instant done', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'door', left: 1 }; return 'door-none' }
    fetch.deps.craftItem = () => ({ done: false, line: 'need a crafting table' })
    let chopped = 0
    fetch.deps.gather = () => { chopped++ }
    const bot = makeBot({ items: [{ name: 'oak_log', count: 14 }] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.equal(chopped, 0)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-craft-door')
  })

  // Buried / deep stone is never an exposed-stone target: the trench (g0z.15)
  // is the only way down.
  const quarrying = (ctx) => ctx.stepStatus === undefined && ctx.castleFetch.target && ctx.castleFetch.target.quarry === true

  it('buried stone is never a target (no shaft digging)', () => {
    const set = new Map([[`${SITE.x - 8},${SITE.y - 2},${SITE.z - 8}`, 'stone']]) // dirt all around
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.ok(quarrying(ctx))
  })

  it('an exposed cave wall far below the feet is never a target (revmux 02)', () => {
    const set = new Map([[`${SITE.x - 8},${SITE.y - 10},${SITE.z - 8}`, 'stone'], [`${SITE.x - 7},${SITE.y - 10},${SITE.z - 8}`, 'cave_air']])
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.ok(quarrying(ctx))
  })

  it('the stone window is anchored on the site, not the feet: a bot down in its pit never picks deeper (revmux 03)', () => {
    const deep = `${SITE.x - 8},${SITE.y - 4},${SITE.z - 8}`
    const set = new Map([[deep, 'stone'], [`${SITE.x - 8},${SITE.y - 3},${SITE.z - 8}`, 'air']])
    const bot = makeBot({ items: TOOLS(), set, at: pos(SITE.x - 6.5, SITE.y - 3, SITE.z - 7.5) }) // standing 3 down
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.ok(quarrying(ctx))
  })

  it('the dig re-checks the stance rules at dig time: a submerged target is skipped, not dug', async () => {
    const tx = SITE.x - 5
    const tz = SITE.z - 5
    const set = new Map([[`${tx},${SITE.y},${tz}`, 'stone'], [`${tx},${SITE.y + 1},${tz}`, 'water']])
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: castleState(), castleFetch: { kind: 'stone', chestDone: true, skips: 0, noGain: 0, skip: new Set(), target: { x: tx, y: SITE.y, z: tz, k: `${tx},${SITE.y},${tz}`, waits: 0 } } }
    fetch(bot, ctx)
    await settle()
    assert.equal(bot.calls.dig.length, 0)
    assert.ok(ctx.castleFetch.skip.has(`${tx},${SITE.y},${tz}`))
  })

  it('a stone the walk never closes in on is skipped; three skips fail unreachable', () => {
    const set = new Map()
    for (let i = 0; i < 3; i++) set.set(`${SITE.x - 10 - i * 2},${SITE.y},${SITE.z - 10}`, 'stone')
    const bot = makeBot({ items: TOOLS(), set }) // never moves
    const ctx = { castle: castleState() }
    for (let i = 0; i < 200 && ctx.stepStatus == null; i++) fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-unreachable')
    assert.equal(bot.calls.dig.length, 0)
  })

  it('digs that never grow the cobble count fail dig-stall', async () => {
    const tx = SITE.x - 5
    const tz = SITE.z - 5
    const set = new Map([[`${tx},${SITE.y},${tz}`, 'stone']])
    const bot = makeBot({ items: TOOLS(), set })
    bot.dig = async (b) => { bot.calls.dig.push(b.position) } // ghost dig: block stays, no drop
    const ctx = { castle: castleState() }
    for (let i = 0; i < 20 && ctx.stepStatus == null; i++) { fetch(bot, ctx); await settle(); await settle() }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-dig-stall')
    assert.equal(bot.calls.dig.length, 5)
  })

  it('a chest the walk never reaches falls through to the next source', () => {
    const set = new Map([[`${SITE.x + 10},${SITE.y},${SITE.z + 10}`, 'chest'], [`${SITE.x - 5},${SITE.y},${SITE.z - 5}`, 'stone']])
    const bot = makeBot({ items: TOOLS(), set, chest: [{ name: 'cobblestone', count: 64 }] })
    const ctx = { castle: castleState() }
    for (let i = 0; i < 40 && !(ctx.castleFetch && ctx.castleFetch.chestDone); i++) fetch(bot, ctx)
    assert.ok(ctx.castleFetch.chestDone)
    assert.equal(bot.calls.opens.length, 0)
  })
})

describe('castle v2 materials: frame logs and the chest (g0z.12)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
  })
  const LAID = { stone: 'cobblestone', planks: 'oak_planks', torch: 'torch', frame: 'oak_log', chest: 'chest' }
  // A v2 world laid up to (not including) the first cell of `kind`.
  function upTo(kind) {
    const set = new Map()
    for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
      if (c.kind === kind) break
      if (LAID[c.kind]) set.set(`${c.x},${c.y},${c.z}`, LAID[c.kind])
    }
    return set
  }

  it('the frame batch is one gather load (gather stops at NEED_LOGS)', () => {
    assert.equal(castleMod.batchOf('frame'), goal.NEED_LOGS)
    assert.equal(fetch.FETCH.frame, goal.NEED_LOGS)
    assert.equal(castleMod.batchOf('stone'), castleMod.BATCH)
  })

  it('frame-none -> castlefetch chops logs; a full load reads frame-batch and the castle lays it (never crafted to planks)', async () => {
    const set = upTo('frame')
    const items = TOOLS()
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    assert.equal(goal.goalFacts(makeBot({ items, set }), ctx).castle, 'frame-none')
    assert.equal((await goal.decide(makeBot({ items, set }), ctx)).action, 'castlefetch')
    let chopped = 0
    fetch.deps.gather = (bot, c) => { chopped++; c.stepStatus = 'running' }
    fetch.deps.craftItem = () => { throw new Error('frame is never crafted') }
    fetch(makeBot({ items, set }), ctx)
    assert.equal(chopped, 1)
    items.push({ name: 'oak_log', count: goal.NEED_LOGS }) // gather's 'done' load
    const bot = makeBot({ items, set })
    const full = { castle: castleState({ blueprintVersion: 2 }) }
    const facts = goal.goalFacts(bot, full)
    assert.equal(facts.castle, 'frame-batch')
    assert.equal(goal.MENU.craft.feasible(facts, bot, full), false, 'the craft step leaves frame logs alone')
    assert.equal((await goal.decide(bot, full)).action, 'castle')
    assert.equal(castleMod.findItem(bot, 'frame').name, 'oak_log')
  })

  it('frame from the castle chest: logs withdraw one per beam', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'frame', left: 70 }; return 'frame-none' }
    const set = new Map([[`${SITE.x},${SITE.y},${SITE.z}`, 'chest']])
    const items = []
    const bot = makeBot({ items, set, chest: [{ name: 'oak_log', count: 64 }], at: pos(SITE.x + 1.5, 64, SITE.z - 0.5) })
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(count(items, 'oak_log'), goal.NEED_LOGS)
  })

  it('chest-none: crafts one chest; with nothing to craft from it chops logs', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'chest', left: 1 }; return 'chest-none' }
    const asked = []
    fetch.deps.craftItem = (bot, ctx, names, n) => { asked.push([names, n]); return 'running' }
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    fetch(makeBot({ items: [{ name: 'oak_planks', count: 8 }] }), ctx)
    assert.deepEqual(asked, [[['chest'], 1]])
    fetch.deps.craftItem = () => ({ done: false, line: 'need 8 planks' })
    let chopped = 0
    fetch.deps.gather = (bot, c) => { chopped++; c.stepStatus = 'running' }
    const bare = { castle: castleState({ blueprintVersion: 2 }) }
    fetch(makeBot({ items: [] }), bare)
    assert.equal(chopped, 1)
    fetch.deps.gather = () => { chopped++ }
    const full = { castle: castleState({ blueprintVersion: 2 }) }
    fetch(makeBot({ items: [{ name: 'oak_log', count: goal.NEED_LOGS }] }), full)
    assert.equal(full.stepStatus, 'failed:castlefetch-craft-chest', 'a full load that cannot craft holds, not chops')
  })

  it('chest on hand reads chest-batch (a 1-cell remainder)', () => {
    const set = upTo('chest')
    const bot = makeBot({ items: [{ name: 'chest', count: 1 }], set })
    assert.equal(goal.goalFacts(bot, { castle: castleState({ blueprintVersion: 2 }) }).castle, 'chest-batch')
  })
})

describe('castlefetch at the site: walk, quarry, prep word, infill run (g0z.15)', () => {
  it('a far body walks to the site and digs the exposed stone there (prod: instant no-stone)', async () => {
    const site = { x: 100, y: 80, z: 200 }
    const sx = site.x - 5
    const sz = site.z - 5
    const set = new Map([[`${sx},80,${sz}`, 'stone']])
    const bot = makeBot({ items: TOOLS(), set, at: pos(site.x - 40, 64, site.z) })
    const ctx = { castle: castleState({ site }) }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, undefined, 'no instant failure')
    assert.equal(bot.calls.dig.length, 0)
    const g = bot.calls.goals[bot.calls.goals.length - 1]
    assert.ok(g && Math.hypot(g.x - (site.x + 5), g.z - (site.z + 5)) < 1, 'walks to the site')
    bot.entity.position = pos(sx + 1.5, 80, sz + 0.5)
    fetch(bot, ctx) // arrival: the castle chest is looked up first
    fetch(bot, ctx)
    await settle(); await settle()
    assert.deepEqual(bot.calls.dig.map((p) => [p.x, p.y, p.z]), [[sx, 80, sz]])
  })

  it('stone under 3 dirt: a trench beside the site, staircase down, one chat line, batch met', async () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 60 ? 'stone' : y <= 63 ? 'dirt' : 'air') })
    const ctx = { castle: castleState() }
    for (let i = 0; i < 2000 && ctx.stepStatus == null; i++) {
      fetch(bot, ctx)
      const t = ctx.castleFetch && ctx.castleFetch.target
      if (t) bot.entity.position = pos(t.x + 0.5, t.y + 1, t.z + 0.5) // the walk lands next to it
      await settle(); await settle()
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(count(items, 'cobblestone') >= 64 + 16)
    assert.equal(bot.chats.length, 1)
    const digs = bot.calls.dig
    assert.ok(digs.every((p) => !fetch.onSite(ctx.castle, p, 2)), 'never the castle or its margin')
    assert.ok(digs.every((p) => p.y >= SITE.y - 6), 'never deeper than the trench floor')
    assert.deepEqual([digs[0].x, digs[0].y, digs[0].z], [SITE.x - 4, SITE.y - 1, SITE.z + 2], 'side 0, column 0, the sod first')
    // A staircase: each column's floor is at most one below the previous.
    const floor = new Map()
    for (const p of digs) floor.set(p.x, Math.min(floor.has(p.x) ? floor.get(p.x) : Infinity, p.y))
    const xs = [...floor.keys()].sort((a, b) => b - a)
    for (let i = 1; i < xs.length; i++) assert.ok(floor.get(xs[i - 1]) - floor.get(xs[i]) <= 1)
  })

  it('revmux 01: a trench stance block is never an exposed-stone target; a dead side lives one leg only', () => {
    const under = (y) => (y <= 62 ? 'stone' : y <= 63 ? 'dirt' : 'air') // one sod over stone
    const set = new Map([[`${SITE.x - 4},63,${SITE.z + 2}`, 'air'], [`${SITE.x - 4},63,${SITE.z + 3}`, 'air'], [`${SITE.x - 4},62,${SITE.z + 2}`, 'stone']]) // column 0 dug, its stance floor exposed (findBlocks sees set only)
    const bot = makeBot({ items: TOOLS(), set, under })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    const t = ctx.castleFetch.target
    assert.ok(t.quarry, 'the exposed column-0 floor stone is the trench, not a pick')
    assert.deepEqual([t.x, t.y, t.z], [SITE.x - 5, 63, SITE.z + 2], 'column 1 next')
    // Side 0 under water this leg: the next leg looks again.
    set.set(`${SITE.x - 5},64,${SITE.z + 2}`, 'water')
    ctx.castleFetch.target = null
    fetch(bot, ctx)
    assert.ok(ctx.castleFetch.target.x > SITE.x, 'side 0 dead this leg')
    set.delete(`${SITE.x - 5},64,${SITE.z + 2}`)
    ctx.castleFetch = null
    fetch(bot, ctx)
    assert.equal(ctx.castleFetch.target.x, SITE.x - 5, 'a new leg retries side 0')
  })

  it('trench dirt is dug bare-handed, stone with the pickaxe (rig: the pick wore out on sod)', async () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 62 ? 'stone' : y <= 63 ? 'dirt' : 'air') })
    const held = []
    bot.equip = async (it) => { bot.heldItem = it; held.push('equip') }
    bot.unequip = async () => { bot.heldItem = null; held.push('unequip') }
    const realDig = bot.dig
    const dug = []
    bot.dig = async (b) => { dug.push([b.name, bot.heldItem ? bot.heldItem.name : 'hand']); await realDig(b) }
    const ctx = { castle: castleState() }
    for (let i = 0; i < 12; i++) {
      fetch(bot, ctx)
      const t = ctx.castleFetch && ctx.castleFetch.target
      if (t) bot.entity.position = pos(t.x + 0.5, t.y + 1, t.z + 0.5)
      await settle(); await settle()
    }
    assert.ok(dug.some(([n]) => n === 'stone') && dug.some(([n]) => n === 'dirt'))
    for (const [n, h] of dug) assert.equal(h, n === 'stone' ? 'stone_pickaxe' : 'hand', `${n} with ${h}`)
  })

  it('revmux 01: a path block in the trench is stepped around, the side lives', () => {
    const set = new Map([[`${SITE.x - 4},63,${SITE.z + 2}`, 'dirt_path']])
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    const t = ctx.castleFetch.target
    assert.deepEqual([t.x, t.y, t.z], [SITE.x - 4, 63, SITE.z + 3])
  })

  it('revmux 01: trench stone that never reaches the pack fails dig-stall', async () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 63 ? 'stone' : 'air') })
    const realDig = bot.dig
    bot.dig = async (b) => { await realDig(b); const c = items.find((i) => i.name === 'cobblestone'); if (c) c.count = 0 } // drops lost
    const ctx = { castle: castleState() }
    for (let i = 0; i < 500 && ctx.stepStatus == null; i++) {
      fetch(bot, ctx)
      const t = ctx.castleFetch && ctx.castleFetch.target
      if (t) bot.entity.position = pos(t.x + 0.5, t.y + 1, t.z + 0.5)
      await settle(); await settle()
    }
    assert.equal(ctx.stepStatus, 'failed:castlefetch-dig-stall')
    assert.ok(bot.calls.dig.length <= 30)
  })

  it('a far leg looks for the castle chest again once at the site (revmux 01/02)', async () => {
    const set = new Map()
    const chest = [{ name: 'cobblestone', count: 10 }] // short of the target: the leg goes on
    const items = TOOLS()
    const bot = makeBot({ items, set, chest, at: pos(SITE.x - 60, 64, SITE.z) })
    bot.findBlocks = ({ matching }) => (matching === BLOCK_IDS.chest && Math.abs(bot.entity.position.x - SITE.x) < 20 ? [pos(SITE.x, SITE.y, SITE.z)] : [])
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    fetch(bot, ctx)
    assert.ok(ctx.castleFetch.chestDone, 'no chest seen from afar')
    set.set(`${SITE.x},${SITE.y},${SITE.z}`, 'chest')
    bot.entity.position = pos(SITE.x + 1.5, 64, SITE.z - 0.5)
    fetch(bot, ctx) // arrival: re-arm the chest source
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(bot.calls.opens.length, 1)
    assert.equal(count(items, 'cobblestone'), 10)
    // Out past DIG_RADIUS and back in the same leg: no second chest trip.
    bot.entity.position = pos(SITE.x - 60, 64, SITE.z)
    fetch(bot, ctx); fetch(bot, ctx)
    bot.entity.position = pos(SITE.x + 1.5, 64, SITE.z - 0.5)
    fetch(bot, ctx); fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(bot.calls.opens.length, 1, 'the chest re-look is once per leg')
  })

  it('a quarrying leg past DIG_RADIUS keeps digging, never walks back to the site (revmux 02)', async () => {
    const bot = makeBot({ items: TOOLS(), at: pos(SITE.x - 4, 64, SITE.z + 2) })
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    fetch(bot, ctx)
    assert.ok(ctx.castleFetch.target.quarry)
    await settle(); await settle()
    const far = { x: SITE.x - 40, y: 58, z: SITE.z + 2 }
    ctx.castleFetch.target = null
    bot.entity.position = pos(far.x + 0.5, far.y, far.z + 0.5)
    const goalsBefore = bot.calls.goals.length
    fetch(bot, ctx)
    assert.ok(ctx.castleFetch.target && ctx.castleFetch.target.quarry, 'picks the next trench cell')
    assert.ok(bot.calls.goals.slice(goalsBefore).every((g) => !(g.x === SITE.x + 15 && g.z === SITE.z + 13)), 'no walk back to the site centre')
  })

  it('the trench never digs the house apron: that side is skipped', () => {
    const items = TOOLS()
    const bot = makeBot({ items, under: (y) => (y <= 60 ? 'stone' : y <= 63 ? 'dirt' : 'air') })
    // A house right where side 0 starts.
    const ctx = { castle: castleState(), home: { site: pos(SITE.x - 8, 64, SITE.z), interior: { min: pos(SITE.x - 10, 64, SITE.z), max: pos(SITE.x - 7, 67, SITE.z + 4) } } }
    fetch(bot, ctx)
    const t = ctx.castleFetch.target
    assert.ok(t && t.quarry)
    assert.ok(t.x > SITE.x, `side 0 skipped, got ${t.x} ${t.z}`)
  })

  it('prep with nothing to prep reads the body word: stone-none, castlefetch on the menu', async () => {
    const items = TOOLS()
    const bot = makeBot({ items })
    const ctx = { castle: castleState({ phase: 'prep' }) }
    assert.equal(castleMod.menuFact(bot, ctx), 'stone-none')
    assert.equal((await goal.decide(bot, ctx)).action, 'castlefetch')
  })

  it('planks fetch stops at the next Fachwerk beam: held frame logs are not crafted away', () => {
    const { cells } = blueprint.absPlan(SITE, 0, 2)
    const i = cells.findIndex((c, j) => c.kind === 'planks' && j > 0 && cells[j - 1].kind === 'frame' && cells[j + 4].kind === 'frame')
    assert.ok(i > 0)
    const set = new Map()
    const LAID = { stone: 'cobblestone', planks: 'oak_planks', torch: 'torch', frame: 'oak_log' }
    for (const c of cells.slice(0, i)) if (LAID[c.kind]) set.set(`${c.x},${c.y},${c.z}`, LAID[c.kind])
    const bot = makeBot({ items: [{ name: 'oak_log', count: 10 }], set })
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    const d = fetch.demand(bot, ctx)
    assert.equal(d.kind, 'planks')
    assert.equal(ctx.castleWord.left, 4)
    assert.equal(d.short, 4 + castleMod.reserveOf('planks'), 'one infill run, not a 32 stack')
  })
})

describe('castlefetch while the castle is blocked (g0z.23)', () => {
  const LAID = { stone: 'cobblestone', planks: 'oak_planks', torch: 'torch', door: 'oak_door' }
  // Everything laid but one gated stone cell: the word is blocked, the kind
  // and remainder stay visible for the fetch.
  function blockedWorld() {
    const { cells } = blueprint.absPlan(SITE, 0, 1)
    const stuck = cells.find((c) => c.kind === 'stone' && c.dy === 1)
    const set = new Map()
    for (const c of cells) {
      if (c === stuck) continue
      if (LAID[c.kind]) set.set(`${c.x},${c.y},${c.z}`, LAID[c.kind])
      else set.set(`${c.x},${c.y},${c.z}`, 'air')
    }
    const ctx = { castle: castleState({ blocked: { [`1:${stuck.idx}`]: { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' } } }) }
    return { cells, stuck, set, ctx }
  }

  it('a gated stone cell reads blocked with its kind, and the fetch quarries it', () => {
    const { set, ctx } = blockedWorld()
    const bot = makeBot({ items: TOOLS(), set })
    assert.equal(goal.goalFacts(bot, ctx).castle, 'blocked')
    assert.deepEqual(ctx.castleWord, { word: 'blocked', kind: 'stone', left: 1 })
    const d = fetch.demand(bot, ctx)
    assert.equal(d.kind, 'stone')
    assert.equal(d.word, 'blocked')
    assert.ok(d.short > 0, `short: ${d.short}`)
  })

  it('a full batch parks the fetch (the behaviour ends done, the gate closes)', () => {
    const { set, ctx } = blockedWorld()
    const items = [...TOOLS(), { name: 'cobblestone', count: 1 + castleMod.reserveOf('stone') }]
    const bot = makeBot({ items, set })
    assert.equal(goal.goalFacts(bot, ctx).castle, 'blocked')
    assert.equal(fetch.demand(bot, ctx).short, 0)
    assert.equal(goal.MENU.castlefetch.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('stone fetch while blocked needs a pickaxe and daylight', () => {
    assert.ok(goal.STEP_CRITERIA.castlefetch.includes('blocked'), 'the model menu names the blocked fetch')
    const { set, ctx } = blockedWorld()
    const day = makeBot({ items: TOOLS(), set })
    assert.equal(goal.MENU.castlefetch.feasible(goal.goalFacts(day, ctx), day, ctx), true)
    const bare = makeBot({ items: [{ name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }], set })
    const bareCtx = { castle: castleState({ blocked: ctx.castle.blocked }) }
    const bareFacts = goal.goalFacts(bare, bareCtx)
    assert.equal(bareFacts.castle, 'blocked')
    assert.equal(goal.MENU.castlefetch.feasible(bareFacts, bare, bareCtx), false)
    assert.equal(goal.stepWhy('castlefetch', bareFacts, bare, bareCtx, ''), 'castlefetch: no pickaxe')
    const night = makeBot({ items: TOOLS(), set, timeOfDay: 18000 })
    const nightCtx = { castle: castleState({ blocked: ctx.castle.blocked }) }
    assert.equal(goal.MENU.castlefetch.feasible(goal.goalFacts(night, nightCtx), night, nightCtx), false)
  })

  it('follow-up: blocked planks demand counts the infill run, not the whole remainder', () => {
    // v2: a blocked planks cell P, an unlaid beam F past it (gated) and one
    // undone planks cell Q past the beam (gated, higher): left is the run
    // (1), not all undone planks (2). Laid beams never stop a run (material
    // branch), so F stays unlaid.
    const { cells } = blueprint.absPlan(SITE, 0, 2)
    const order = cells.map((c) => c.idx).sort((a, b) => castleMod.rank(cells[a]) - castleMod.rank(cells[b]) || a - b)
    let pick = null
    for (const idx of order) {
      const P = cells[idx]
      if (P.kind !== 'planks') continue
      const oi = order.indexOf(idx)
      let beam = -1
      for (let i = oi + 1; i < order.length; i++) {
        if (cells[order[i]].kind === 'frame') { beam = i; break }
      }
      if (beam < 0) continue
      const F = cells[order[beam]]
      if (F.dy <= P.dy) continue
      const Q = order.slice(beam + 1).map((j) => cells[j]).find((c) => c.kind === 'planks' && c.dy > P.dy)
      if (Q) { pick = { P, F, Q }; break }
    }
    assert.ok(pick, 'a planks run with a higher beam and higher post-beam planks')
    const { P, F, Q } = pick
    const LAID2 = { stone: 'cobblestone', planks: 'oak_planks', torch: 'torch', door: 'oak_door', frame: 'oak_log', fence: 'oak_fence', chest: 'chest' }
    const set = new Map()
    for (const c of cells) {
      if (c === P || c === F || c === Q) continue
      set.set(`${c.x},${c.y},${c.z}`, LAID2[c.kind] || 'air')
    }
    const ctx = { castle: castleState({ blueprintVersion: 2, blocked: { [`2:${P.idx}`]: { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' } } }) }
    const bot = makeBot({ items: TOOLS(), set })
    assert.equal(goal.goalFacts(bot, ctx).castle, 'blocked')
    assert.deepEqual(ctx.castleWord, { word: 'blocked', kind: 'planks', left: 1 })
    const d = fetch.demand(bot, ctx)
    assert.equal(d.kind, 'planks')
    assert.equal(d.short, 1 + castleMod.reserveOf('planks'))
  })

  it('round 2 core-1: the flip chats through decide, which drops castle for the fetch', async () => {
    // Prod shape: castle() never runs on the blocked tick — decide() sees
    // the flipped word first and re-picks. The line must come from the flip.
    const { stuck, set, ctx } = blockedWorld()
    const bot = makeBot({ items: TOOLS(), set })
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    ctx.goalText = 'stale'
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'castlefetch')
    const stuckLines = () => bot.chats.filter((m) => m.startsWith('castle: stuck at'))
    assert.equal(stuckLines().length, 1, `chats: ${JSON.stringify(bot.chats)}`)
    assert.match(stuckLines()[0], new RegExp(`^castle: stuck at ${stuck.x} ${stuck.y} ${stuck.z} on dig-refused, retry in \\d+s$`))
    assert.match(ctx.castle.status, new RegExp(`^blocked at ${stuck.x} ${stuck.y} ${stuck.z} \\(stone: dig-refused\\), retry in \\d+s$`))
    await goal.decide(bot, ctx)
    assert.equal(stuckLines().length, 1, 'the standing block stays silent')
  })
})
