'use strict'

// idkcraft-0dbg: the attic enchanting table was planned but never built —
// the only fund list was the finished item, chest-only, never crafted.
// Now: finished table else its vanilla mats from the chest (normal legs),
// crafted at a table; an honest status names the missing mats.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const castlefetch = require('../src/behaviours/castlefetch')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const DECOR_LAID = { pane: 'glass_pane', banner: 'white_wall_banner', gate: 'oak_fence_gate', bookshelf: 'bookshelf', enchanting_table: 'enchanting_table', blast_furnace: 'blast_furnace', fence: 'oak_fence' }
function painted(skipTable) {
  const cells = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) {
    cells.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) {
    if (skipTable && c.kind === 'enchanting_table') continue // the missing attic table
    if (DECOR_LAID[c.kind]) cells.set(`${c.x},${c.y},${c.z}`, DECOR_LAID[c.kind])
  }
  return cells
}
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
function worldBot(cells, items = []) {
  return {
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const items = (list) => list.map(([name, count]) => ({ name, count }))

describe('0dbg enchanting table', () => {
  it('funds the finished table first, then obsidian, book, diamonds', () => {
    const lists = castlefetch.chestNames({}, 'enchanting_table')
    assert.deepEqual(lists, [['enchanting_table'], ['obsidian'], ['book'], ['diamond']])
  })
  it('crafts one table from the pack (vanilla 4+2+1)', () => {
    assert.deepEqual(castlefetch.craftNames({}, 'enchanting_table'), ['enchanting_table'])
    assert.equal(castlefetch.TABLE_OBSIDIAN, 4)
    assert.equal(castlefetch.TABLE_DIAMOND, 2)
    assert.equal(castlefetch.TABLE_BOOK, 1)
  })
  it('tableShort names exactly the missing mats, null when funded', () => {
    const bot = (inv) => ({ inventory: { items: () => items(inv) } })
    assert.equal(castlefetch.tableShort(bot([])), '4 obsidian, 2 diamonds, 1 book')
    assert.equal(castlefetch.tableShort(bot([['obsidian', 4]])), '2 diamonds, 1 book')
    assert.equal(castlefetch.tableShort(bot([['obsidian', 2], ['diamond', 1]])), '2 obsidian, 1 diamond, 1 book')
    assert.equal(castlefetch.tableShort(bot([['obsidian', 4], ['diamond', 2], ['book', 1]])), null)
    assert.equal(castlefetch.tableShort(bot([['obsidian', 9], ['diamond', 5], ['book', 3]])), null, 'surplus reads funded')
  })
  it("a table-less complete castle words 'enchanting_table-none' and demands it", () => {
    const now = Date.now()
    const bot = worldBot(painted(true))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, visitedAt: now } }
    assert.equal(castle.menuFact(bot, ctx, now), 'enchanting_table-none')
    const d = castlefetch.demand(bot, ctx)
    assert.ok(d, 'a demand exists')
    assert.equal(d.kind, 'enchanting_table')
    assert.ok(d.short > 0, 'short of one table')
  })
  it('a laid table words done (no phantom demand)', () => {
    const now = Date.now()
    const bot = worldBot(painted(false))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, visitedAt: now } }
    assert.equal(castle.menuFact(bot, ctx, now), 'done')
  })
})
