'use strict'

// idkcraft-szr1: prod castle wood livelock — v1 castlefetch fence looped
// "can't make warped_fence" (castle stuck 1971/2048), v2 "need warped_stem"
// with 2189 protected oak_log (1263/2048 flat). craftany's full-tie refusal
// kept the later registry variant and the nether woods sort last, so an
// uncoverable pack named an unobtainable nether gap; the fence leg also
// ignored chest planks (finished + logs only), so a chest of banked planks
// never refilled a treeless world.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const craftany = require('../src/behaviours/craftany')
const castlefetch = require('../src/behaviours/castlefetch')

// Registry with the nether woods (prod order): candidates sort birch-first,
// then A-Z, so warped/crimson are last — the full-tie winners before the fix.
const WOODS = ['oak', 'birch', 'spruce', 'warped', 'crimson']
const ITEMS = {}
let nextId = 1
for (const w of WOODS) {
  for (const s of (w === 'warped' || w === 'crimson') ? ['stem', 'planks', 'fence'] : ['log', 'planks', 'fence']) ITEMS[`${w}_${s}`] = nextId++
}
ITEMS.stick = nextId++
ITEMS.crafting_table = nextId++
const byId = {}
for (const [n, i] of Object.entries(ITEMS)) byId[i] = n

function R(product, takes, resCount, reqTable) {
  const delta = takes.map(([n, c]) => ({ id: ITEMS[n], count: -c }))
  delta.push({ id: ITEMS[product], count: resCount })
  return { delta, result: { count: resCount }, requiresTable: !!reqTable, product }
}

const TABLE = {}
for (const w of WOODS) {
  const raw = (w === 'warped' || w === 'crimson') ? `${w}_stem` : `${w}_log`
  TABLE[`${w}_planks`] = [R(`${w}_planks`, [[raw, 1]], 4, false)]
  TABLE[`${w}_fence`] = [R(`${w}_fence`, [[`${w}_planks`, 4], ['stick', 2]], 3, true)]
}
TABLE.crafting_table = [
  R('crafting_table', [['oak_planks', 4]], 1, false),
  R('crafting_table', [['birch_planks', 4]], 1, false),
]

function mockBot(items) {
  const itemsByName = {}
  for (const [n, i] of Object.entries(ITEMS)) itemsByName[n] = { id: i }
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: {}, itemsByName },
    inventory: { items: () => items },
    recipesAll: (id) => (TABLE[byId[id]] || []),
    blockAt: () => null,
    findBlocks: () => [],
    pathfinder: { setGoal() {} },
  }
}

function plankNames() {
  return ['birch_planks', 'crimson_planks', 'oak_planks', 'spruce_planks', 'warped_planks']
}

function fenceNames() {
  return ['birch_fence', 'crimson_fence', 'oak_fence', 'spruce_fence', 'warped_fence']
}

describe('craftany refusal names the fetchable gap (szr1)', () => {
  it('v2 prod pack (few planks, no logs): names an overworld log, never a stem', () => {
    const r = craftany(mockBot([{ name: 'oak_planks', count: 5 }]), {}, plankNames(), 4)
    assert.equal(r.done, false)
    assert.ok(!/(warped|crimson)/.test(r.line), `nether gap unobtainable: ${r.line}`)
    assert.match(r.line, /_log \(have 0\)/, `gather-suppliable gap: ${r.line}`)
  })

  it('v1 prod pack (1 log + 1 planks, no table): names an overworld fence gap', () => {
    const r = craftany(mockBot([{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 1 }]), {}, fenceNames(), 3)
    assert.equal(r.done, false)
    assert.ok(!/(warped|crimson)/.test(r.line), `nether gap unobtainable: ${r.line}`)
    assert.match(r.line, /_fence: need 4 \w+_planks/, `real gap: ${r.line}`)
  })

  it('a genuinely closest variant still wins (tie-break never overrules)', () => {
    const r = craftany(mockBot([{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 3 }]), {}, fenceNames(), 3)
    assert.equal(r.done, false)
    assert.match(r.line, /can't make oak_fence/, `closest fund wins: ${r.line}`)
  })
})
