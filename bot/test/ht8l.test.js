'use strict'

// idkcraft-ht8l: banked logs in the home chest (or the castle site chest)
// are drawn before any tree is chopped; an empty or unreachable chest is
// tried once per need, then the chop runs as before.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const fetch = require('../src/behaviours/castlefetch')
const castleMod = require('../src/behaviours/castle')
const { NEED_LOGS } = require('../src/budget')

const IDS = { oak_log: 17, chest: 2, stone: 1 }
const settle = () => new Promise((r) => setImmediate(r))

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

// One tree far off at (30,64,0); `chests`: "x,y,z" -> stacks.
function makeBot({ items = [], chests = {}, at = pos(0, 64, 0) } = {}) {
  const blocksByName = {}
  for (const [n, id] of Object.entries(IDS)) blocksByName[n] = { id }
  const tree = { '30,64,0': 'oak_log', '30,65,0': 'oak_log', '30,66,0': 'oak_leaves', '31,65,0': 'oak_leaves' }
  const calls = { goals: [], opens: [], dig: 0 }
  const bot = {
    calls,
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    registry: { blocksByName, itemsByName: { oak_log: {}, oak_planks: {} } },
    time: { timeOfDay: 6000, day: 1 },
    players: {},
    chat() {},
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = chests[k] ? 'chest' : tree[k] || (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: ({ matching }) => {
      const want = new Set(Array.isArray(matching) ? matching : [matching])
      return want.has(IDS.oak_log) ? [pos(30, 64, 0)] : [] // no chest on the castle site
    },
    openChest: async (block) => {
      const k = `${block.position.x},${block.position.y},${block.position.z}`
      calls.opens.push(k)
      const stacks = chests[k]
      return {
        containerItems: () => stacks.filter((s) => s.count > 0).map((s) => ({ ...s, type: s.name, metadata: null })),
        withdraw: async (type, meta, n) => {
          stacks.find((s) => s.name === type).count -= n
          const it = items.find((i) => i.name === type)
          if (it) it.count += n
          else items.push({ name: type, count: n })
        },
        close() {},
      }
    },
    canDigBlock: () => true,
    dig: async () => { calls.dig++ },
    equip: async () => {},
    pathfinder: { goal: null, isMoving: () => false, setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g }, stop() {}, setMovements() {}, movements: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}
const logs = (bot) => bot.inventory.items().filter((i) => i.name === 'oak_log').reduce((a, i) => a + i.count, 0)
const treeGoal = (bot) => bot.calls.goals.some((g) => g && g.x === 30)
// Built home + open castle: the castle wood keep holds a full load.
const castleCtx = (chest, extra = {}) => ({
  lastGoalKey: '',
  home: { site: pos(-10, 64, -10), built: true, chest },
  castle: { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {}, parked: false },
  ...extra,
})

describe('gather draws banked logs first (ht8l)', () => {
  it('home chest with logs in reach: withdraws a load, no tree walk, done', async () => {
    const chests = { '1,64,1': [{ name: 'oak_log', count: 40 }] }
    const bot = makeBot({ chests })
    const ctx = castleCtx(pos(1, 64, 1))
    gather(bot, ctx)
    await settle(); await settle()
    assert.deepEqual(bot.calls.opens, ['1,64,1'])
    assert.equal(logs(bot), NEED_LOGS)
    gather(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(treeGoal(bot), false, 'never walked to the tree')
    assert.equal(bot.calls.dig, 0)
  })

  it('empty chest: one try, then the chop as today; no second open', async () => {
    const chests = { '1,64,1': [] }
    const bot = makeBot({ chests })
    const ctx = castleCtx(pos(1, 64, 1))
    gather(bot, ctx)
    await settle(); await settle()
    assert.equal(bot.calls.opens.length, 1)
    gather(bot, ctx)
    gather(bot, ctx)
    assert.ok(treeGoal(bot), 'walks to the tree')
    assert.equal(bot.calls.opens.length, 1, 'the dry chest is not reopened')
    ctx.gather = null // a fresh need inside the dry window
    gather(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens.length, 1)
  })

  it('unreachable chest: the stalled walk marks it dry and the chop starts', () => {
    const bot = makeBot({ chests: { '20,64,20': [{ name: 'oak_log', count: 40 }] } })
    const ctx = castleCtx(pos(20, 64, 20))
    for (let i = 0; i < 40 && !treeGoal(bot); i++) gather(bot, ctx)
    assert.ok(treeGoal(bot))
    assert.equal(bot.calls.opens.length, 0)
    assert.ok(ctx.chestLogsDry['20,64,20'])
  })

  it('a chest past the task radius is never walked to (far castle, home 200 off)', async () => {
    const bot = makeBot({ chests: { '200,64,0': [{ name: 'oak_log', count: 40 }] } })
    const ctx = castleCtx(pos(200, 64, 0))
    gather(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens.length, 0)
    assert.ok(treeGoal(bot), 'chops on the first tick')
  })

  it('a short draw is one try per attempt, even past the dry window', async () => {
    const chests = { '1,64,1': [{ name: 'oak_log', count: 3 }] }
    const bot = makeBot({ chests })
    const ctx = castleCtx(pos(1, 64, 1))
    gather(bot, ctx)
    await settle(); await settle()
    ctx.chestLogsDry = {} // the window lapsed mid-chop
    chests['1,64,1'][0].count = 40
    gather(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens.length, 1)
  })

  it('built home, no castle: never draws (stockpile would bank the logs straight back)', async () => {
    const bot = makeBot({ chests: { '1,64,1': [{ name: 'oak_log', count: 40 }] } })
    const ctx = castleCtx(pos(1, 64, 1), { castle: null })
    gather(bot, ctx)
    await settle()
    assert.equal(bot.calls.opens.length, 0)
    assert.ok(treeGoal(bot))
  })

  it('the castle site chest counts too (unbuilt home, far castle)', async () => {
    const chests = { '2,64,0': [{ name: 'oak_log', count: 5 }] }
    const bot = makeBot({ chests })
    const ctx = castleCtx(null, { home: { site: pos(-500, 64, 0), built: false } })
    ctx.castle.siteChest = pos(2, 64, 0)
    gather(bot, ctx)
    await settle(); await settle()
    assert.equal(logs(bot), 5, 'a short draw takes what there is')
    gather(bot, ctx)
    assert.ok(treeGoal(bot), 'short: the chop tops the load up')
  })
})

describe('castle wood need draws the home chest before chopping (ht8l)', () => {
  const realFact = castleMod.menuFact
  const realCraft = fetch.deps.craftItem
  afterEach(() => { castleMod.menuFact = realFact; fetch.deps.craftItem = realCraft })

  it('planks-none, no castle chest, logs in the home chest: withdraw, no chop', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'planks', left: 64 }; return 'planks-none' }
    fetch.deps.craftItem = () => ({ done: false, line: 'need logs' })
    const chests = { '1,64,1': [{ name: 'oak_log', count: 40 }] }
    const bot = makeBot({ chests })
    const ctx = castleCtx(pos(1, 64, 1))
    fetch(bot, ctx)
    await settle(); await settle()
    assert.deepEqual(bot.calls.opens, ['1,64,1'])
    assert.equal(logs(bot), NEED_LOGS)
    fetch(bot, ctx) // the load is in: the leg ends, the next one crafts
    assert.equal(treeGoal(bot), false)
    assert.equal(bot.calls.dig, 0)
  })
})
