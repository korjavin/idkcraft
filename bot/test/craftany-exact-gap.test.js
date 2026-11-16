'use strict'
// prod 2026-11-16 bot3: "need 24 any planks (have 23), 12 stick (have 11)" x28/h —
// the gap left out the planks the sticks op eats, so filling it never made the
// recipe craftable. The gap now names the whole wood tree in one pass: filling
// it exactly (n) plans ok, one short (n-1) does not.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const { planCraft } = require('../src/behaviours/craftany')

const NAMES = ['oak_log', 'birch_log', 'oak_planks', 'birch_planks', 'stick', 'crafting_table', 'oak_fence', 'birch_fence', 'oak_door', 'chest']
const ID = Object.fromEntries(NAMES.map((n, i) => [n, i + 1]))
const R = (product, takes, count, table) => ({ delta: [...takes.map(([n, c]) => ({ id: ID[n], count: -c })), { id: ID[product], count }], result: { count }, requiresTable: table, product })
const TABLE = {
  oak_planks: [R('oak_planks', [['oak_log', 1]], 4, false)],
  birch_planks: [R('birch_planks', [['birch_log', 1]], 4, false)],
  stick: [R('stick', [['oak_planks', 2]], 4, false)],
  crafting_table: [R('crafting_table', [['oak_planks', 4]], 1, false)],
  oak_fence: [R('oak_fence', [['oak_planks', 4], ['stick', 2]], 3, true)],
  birch_fence: [R('birch_fence', [['birch_planks', 4], ['stick', 2]], 3, true)],
  oak_door: [R('oak_door', [['oak_planks', 6]], 3, true)],
  chest: [R('chest', [['oak_planks', 8]], 1, true)],
}
const byId = Object.fromEntries(NAMES.map((n) => [ID[n], n]))
function bot(pack) {
  const items = Object.entries(pack).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }))
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: {}, itemsByName: Object.fromEntries(NAMES.map((n) => [n, { id: ID[n] }])) },
    inventory: { items: () => items },
    recipesAll: (id) => TABLE[byId[id]] || [],
    blockAt: () => null,
    findBlocks: () => [],
    pathfinder: { setGoal() {} },
  }
}

const CASES = [
  // [names, count, base pack]: wood-named (fence, door) and any-planks (chest) kinds
  [['oak_fence'], 18, { crafting_table: 1 }],
  [['oak_fence'], 3, { crafting_table: 1, stick: 1 }],
  [['oak_fence'], 6, { crafting_table: 1, stick: 3, birch_planks: 1 }],
  [['oak_fence', 'birch_fence'], 9, { crafting_table: 1 }],
  [['oak_door'], 6, { crafting_table: 1, birch_planks: 5 }],
  [['chest'], 2, { crafting_table: 1, birch_planks: 3 }],
]

for (const [names, count, base] of CASES) {
  it(`${names.join('|')} x${count}: filling the named gap plans ok (n), one short does not (n-1)`, () => {
    const p0 = planCraft(bot(base), {}, names, count)
    assert.equal(p0.ok, false, 'the base pack is short')
    const g = p0.missing[0]
    const full = { ...base, [g.name]: (base[g.name] || 0) + g.need - g.have }
    assert.equal(planCraft(bot(full), {}, names, count).ok, true, `n: ${p0.line}`)
    const short = { ...full, [g.name]: full[g.name] - 1 }
    assert.equal(planCraft(bot(short), {}, names, count).ok, false, `n-1: ${p0.line}`)
  })
}

it('the prod line: 23 planks + 11 sticks for 18 fences names 24 + the sticks op', () => {
  const p = planCraft(bot({ crafting_table: 1, oak_planks: 23, stick: 11 }), {}, ['oak_fence'], 18)
  assert.equal(p.ok, false)
  assert.deepEqual(p.missing[0], { name: 'oak_planks', need: 26, have: 23 })
})
