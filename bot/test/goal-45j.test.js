'use strict'

// Bundle idkcraft-45j / 8cx / ck3 (prod session 2026-10-01):
// 45j — a home site in unloaded chunks (respawn ~145 blocks away) read every
//   cell as undone, the table cell gated build off, and the bot never walked
//   back; build now batches on planks there and walks to the site.
// 8cx — a 7-log remainder of a second wood held gather feasible forever at
//   136+ planks; gather finishes a load only while planks are short, and
//   craft converts every wood in one step.
// ck3 — night with low health kept building at the site (two deaths).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
const craft = require('../src/behaviours/craft')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

const SITE = { x: 79, y: 63, z: -288 }
const KIT = [{ name: 'acacia_planks', count: 136 }, { name: 'oak_door', count: 1 },
  { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }]

function siteHome() {
  return { site: { ...SITE }, v: 2, built: false, table: { x: SITE.x + 5, y: SITE.y, z: SITE.z + 1 } }
}

function workBot({ items = KIT, blockAt = () => null, timeOfDay = 6000, health = 20, at = pos(-48, 65, -208), moving = false } = {}) {
  const goals = []
  return {
    chats: [],
    goals,
    health,
    food: 20,
    entity: { position: at },
    spawnPoint: pos(-48, 65, -208),
    time: { timeOfDay },
    inventory: { items: () => items },
    blockAt,
    pathfinder: { isMoving: () => moving, setGoal: (g) => { goals.push(g) } },
    chat(m) { this.chats.push(String(m)) },
  }
}

// Loaded site: the table stands, every other cell is open air.
function loadedSite({ table = true } = {}) {
  const t = { x: SITE.x + 5, y: SITE.y, z: SITE.z + 1 }
  return (p) => {
    const name = table && p.x === t.x && p.y === t.y && p.z === t.z ? 'crafting_table'
      : p.y < SITE.y ? 'dirt' : 'air'
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: p }
  }
}

describe('45j build stays on the menu while the site is unloaded', () => {
  it('unloaded site, planks 136, table 0, door 1 -> build feasible and decided', async () => {
    const bot = workBot()
    const ctx = { home: siteHome(), buildSkip: [] }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(facts.planks, 136)
    assert.equal(facts.table, 0)
    assert.equal(facts.door, 1)
    assert.equal(goal.MENU.build.feasible(facts, bot, ctx), true)
    const ctx2 = { step: '', stepStatus: null, goalText: null, home: siteHome(), buildSkip: [] }
    const r = await goal.decide(bot, ctx2)
    assert.equal(r.action, 'build')
  })

  it('unloaded site still needs a plank batch', () => {
    const bot = workBot({ items: [{ name: 'oak_planks', count: 10 }] })
    const ctx = { home: siteHome(), buildSkip: [] }
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), false)
    assert.match(goal.stepWhy('build', goal.goalFacts(bot, ctx), bot, ctx, ''), /need 16 planks/)
  })

  it('loaded site keeps the old gates', () => {
    // Table never placed + no table item: the next cell gates build off.
    const bare = workBot({ blockAt: loadedSite({ table: false }) })
    const ctx = { home: siteHome(), buildSkip: [] }
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(bare, ctx), bare, ctx), false)
    // Table standing: the next cells are planks/fill, build runs.
    const set = workBot({ blockAt: loadedSite() })
    assert.equal(goal.MENU.build.feasible(goal.goalFacts(set, ctx), set, ctx), true)
  })

  it('the build step walks toward the unloaded site, then fails a dead walk', () => {
    const bot = workBot()
    const ctx = { home: siteHome(), step: 'build', stepStatus: 'running', buildSkip: [] }
    build(bot, ctx, null, null)
    assert.equal(bot.goals.length, 1, 'one walk goal')
    assert.equal(ctx.stepStatus, 'running', 'no no-planks failure for the unknown cell')
    assert.deepEqual(ctx.buildSkip, [], 'nothing skipped')
    for (let i = 0; i < build.CELL_TICK_BUDGET + 1 && ctx.stepStatus === 'running'; i++) build(bot, ctx, null, null)
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-site')
    assert.deepEqual(ctx.buildSkip, [], 'a dead walk skips no cell')
  })

  it('a walk that keeps moving never fails', () => {
    const at = pos(-48, 65, -208)
    const bot = workBot({ at, moving: true })
    const ctx = { home: siteHome(), step: 'build', stepStatus: 'running', buildSkip: [] }
    for (let i = 0; i < build.CELL_TICK_BUDGET * 2; i++) {
      at.x += 2
      build(bot, ctx, null, null)
    }
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.goals.length, 1, 'a moving walk is not re-issued')
  })
})

describe('8cx gather does not chop past a covered budget', () => {
  it('planks 136, logs 7 of one wood, home=site -> gather not feasible', () => {
    const F = goal.MENU.gather.feasible
    const facts = { time: 'day', home: 'site', planks: 136, logs: 7, table: 0, door: 1 }
    assert.equal(F(facts, null, { home: siteHome() }), false)
    // Short on loose planks: the started load still finishes (old rule).
    assert.equal(F({ ...facts, planks: 100 }, null, { home: siteHome() }), true)
  })

  it('craft converts every wood in one step: 7 acacia + 7 oak -> logs 0', async () => {
    const items = [{ name: 'acacia_log', count: 7 }, { name: 'oak_log', count: 7 }]
    const ids = { acacia_planks: 1, oak_planks: 2 }
    const bot = {
      chats: [],
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { acacia_planks: { id: 1 }, oak_planks: { id: 2 } } },
      inventory: { items: () => items.filter((i) => i.count > 0) },
      recipesFor: (id) => [{ result: { name: Object.keys(ids).find((n) => ids[n] === id), count: 4 } }],
      craft: async (recipe) => {
        const wood = recipe.result.name.replace('_planks', '')
        items.find((i) => i.name === `${wood}_log`).count--
        items.push({ name: recipe.result.name, count: 4 })
      },
      blockAt: () => null,
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      chat(m) { this.chats.push(String(m)) },
    }
    const ctx = { stepStatus: 'running', home: null }
    craft(bot, ctx, null, {})
    const t0 = Date.now()
    while (ctx.craftInFlight && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 10))
    assert.equal(ctx.craftInFlight, false)
    const logs = items.filter((i) => i.name.endsWith('_log')).reduce((n, i) => n + i.count, 0)
    assert.equal(logs, 0)
    assert.equal(bot.chats.length, 2, bot.chats.join(' | '))
  })
})

describe('ck3 hurt at night keeps off outdoor work', () => {
  it('night, health low, hostiles near, home=site, planks enough -> no build', async () => {
    const bot = workBot({ timeOfDay: 18000, health: 2.3, blockAt: loadedSite(), at: pos(SITE.x + 3, SITE.y, SITE.z - 3) })
    bot.entities = { 1: { name: 'zombie', type: 'hostile', position: pos(SITE.x + 4, SITE.y, SITE.z - 4) } }
    const ctx = { home: siteHome(), buildSkip: [] }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(facts.time, 'night')
    assert.equal(goal.MENU.build.feasible(facts, bot, ctx), false)
    assert.equal(goal.MENU.gather.feasible({ ...facts, planks: 0, logs: 0 }, bot, ctx), false)
    assert.match(goal.stepWhy('build', facts, bot, ctx, ''), /hurt at night/)
    const r = await goal.decide(bot, { step: 'build', stepStatus: 'running', goalText: 'stale', home: siteHome(), buildSkip: [] })
    assert.notEqual(r.action, 'build')
    // Same scene by day, or at full health: build is back.
    assert.equal(goal.MENU.build.feasible({ ...facts, time: 'day' }, bot, ctx), true)
    assert.equal(goal.MENU.build.feasible({ ...facts, health: 20 }, bot, ctx), true)
  })
})
