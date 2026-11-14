'use strict'

// Prod v2 castle stuck on planks: "can't make spruce_planks: need 1
// spruce_log (have 0)" while the pack held stripped logs (facts logs=few).
// The registry recipe names only <wood>_log; the game takes the whole tag.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const craftany = require('../src/behaviours/craftany')

const ITEMS = { spruce_log: 1, spruce_planks: 2, stripped_spruce_log: 3, oak_log: 4, oak_planks: 5, oak_wood: 6 }
const byId = {}
for (const [n, i] of Object.entries(ITEMS)) byId[i] = n
const R = (log, planks) => ({ delta: [{ id: ITEMS[log], count: -1 }, { id: ITEMS[planks], count: 4 }], ingredients: [{ id: ITEMS[log], count: -1 }], inShape: null, result: { count: 4 }, requiresTable: false })
const TABLE = { spruce_planks: [R('spruce_log', 'spruce_planks')], oak_planks: [R('oak_log', 'oak_planks')] }

function mockBot(items) {
  const itemsByName = {}
  for (const [n, i] of Object.entries(ITEMS)) itemsByName[n] = { id: i }
  return { entity: { position: { x: 0, y: 64, z: 0 } }, registry: { itemsByName, blocksByName: {} }, inventory: { items: () => items }, recipesAll: (id) => TABLE[byId[id]] || [] }
}

describe('planks craft from stripped logs / wood blocks', () => {
  it('a stripped log funds its wood planks with the stripped id in the grid', () => {
    const p = craftany.planCraft(mockBot([{ name: 'stripped_spruce_log', count: 2 }]), {}, ['oak_planks', 'spruce_planks'], 4)
    assert.equal(p.ok, true)
    assert.equal(p.target, 'spruce_planks')
    assert.equal(p.recipe.ingredients[0].id, ITEMS.stripped_spruce_log)
    assert.equal(p.recipe.delta[0].id, ITEMS.stripped_spruce_log)
    assert.equal(TABLE.spruce_planks[0].delta[0].id, ITEMS.spruce_log) // registry recipe untouched
  })
  it('a wood block funds its planks', () => {
    const p = craftany.planCraft(mockBot([{ name: 'oak_wood', count: 1 }]), {}, ['spruce_planks', 'oak_planks'], 4)
    assert.equal(p.ok, true)
    assert.equal(p.target, 'oak_planks')
  })
  it('no wood at all still refuses', () => {
    assert.equal(craftany.planCraft(mockBot([]), {}, ['spruce_planks'], 4).ok, false)
  })
})
