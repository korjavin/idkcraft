'use strict'

// Prod 2026-11-15 bot3: "can't make chest: need 8 oak_planks (have 2)" with
// other wood held. Planks are one #planks tag in the game: every castle
// fetch kind the default wood funds must be funded by any wood variant and
// by a mixed planks pack, with or without a standing table. Real registry.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reg = require('prismarine-registry')('26.1.2')
const { Recipe } = require('prismarine-recipe')(reg)
const craftany = require('../src/behaviours/craftany')
const castlefetch = require('../src/behaviours/castlefetch')

function mkBot(inv) {
  return {
    registry: reg,
    inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) },
    recipesAll: (id, m, t) => Recipe.find(id, m).filter((r) => !r.requiresTable || t),
  }
}
const plan = (inv, kind) => craftany.planCraft(mkBot(inv), {}, castlefetch.craftNames(mkBot(inv), kind), 1)

// The recipe (after mixPlanks) consumes only what the pack holds.
function covered(inv, recipe, target) {
  const out = craftany.poolsPlanks(mkBot(inv), target) ? craftany.mixPlanks(mkBot(inv), recipe, inv) : recipe
  for (const d of out.delta) {
    if (d.count >= 0) continue
    const n = reg.items[d.id].name
    if (n === 'stick' || n.endsWith('_planks') && !(n in inv)) continue // sticks/planks come from the layer op
    if ((inv[n] || 0) < -d.count) return `${n} short`
  }
  return null
}

const OAK = { oak_log: 16, crafting_table: 1 }
const kinds = Object.keys(castlefetch.FETCH).filter((k) => castlefetch.craftNames(mkBot(OAK), k).length > 0 && plan(OAK, k).ok)

describe('craftany wood family (any wood, any planks mix)', () => {
  it('finds wood-funded castle kinds', () => assert.ok(kinds.includes('chest') && kinds.includes('planks')))
  for (const k of kinds) {
    for (const wood of ['birch', 'spruce', 'dark_oak']) {
      it(`${k} from ${wood} logs`, () => assert.ok(plan({ [`${wood}_log`]: 16, crafting_table: 1 }, k).ok, plan({ [`${wood}_log`]: 16, crafting_table: 1 }, k).line))
    }
    it(`${k} from mixed planks, no table`, () => {
      const inv = { oak_planks: 2, birch_planks: 9, spruce_planks: 7, jungle_planks: 6 }
      const p = plan(inv, k)
      if (k === 'planks') return // planks from planks is not a craft
      assert.ok(p.ok, p.line)
      assert.equal(covered(inv, p.recipe, p.target), null)
      if (p.tableRecipe) assert.equal(covered(inv, p.tableRecipe, 'crafting_table'), null)
    })
  }
  it('chest: 2 oak + 6 birch planks with a table', () => {
    const inv = { oak_planks: 2, birch_planks: 6, crafting_table: 1 }
    const p = plan(inv, 'chest')
    assert.ok(p.ok, p.line)
    const r = craftany.mixPlanks(mkBot(inv), p.recipe, inv)
    const used = Object.fromEntries(r.delta.filter((d) => d.count < 0).map((d) => [reg.items[d.id].name, -d.count]))
    assert.deepEqual(used, { birch_planks: 6, oak_planks: 2 })
  })
  it('table from 2 oak + 2 spruce planks', () => {
    const inv = { oak_planks: 2, spruce_planks: 2 }
    const p = craftany.planCraft(mkBot(inv), {}, ['crafting_table'], 1)
    assert.ok(p.ok, p.line)
    assert.equal(covered(inv, p.recipe, 'crafting_table'), null)
  })
  it('door/fence keep one variant (the game has no mixed door)', () => {
    assert.equal(craftany.poolsPlanks(mkBot({}), 'birch_door'), false)
    assert.equal(craftany.poolsPlanks(mkBot({}), 'dark_oak_fence_gate'), false)
    assert.equal(craftany.poolsPlanks(mkBot({}), 'chest'), true)
    assert.equal(plan({ oak_planks: 3, birch_planks: 3, crafting_table: 1 }, 'door').ok, false)
  })
  it('birch door + table from 6 birch + 4 oak planks', () => assert.ok(plan({ birch_planks: 6, oak_planks: 4 }, 'door').ok))
  it('honest gap when the pool is short', () => {
    const p = plan({ oak_planks: 2, birch_planks: 3, crafting_table: 1 }, 'chest')
    assert.equal(p.ok, false)
    assert.match(p.line, /need 8 \w+_planks \(have 5\)/)
  })
})
