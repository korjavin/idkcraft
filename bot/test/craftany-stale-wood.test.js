'use strict'

// Prod 2026-11-15 bot3: "castlefetch planks: craft failed: can't make
// spruce_planks: need 1 spruce_log (have 0)" while birch logs were held — a
// run planned on spruce outlived the spruce. Any wood variant must do.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const reg = require('prismarine-registry')('26.1.2')
const { Recipe } = require('prismarine-recipe')(reg)
const craftItem = require('../src/behaviours/craftany')
const castlefetch = require('../src/behaviours/castlefetch')

function mkBot(inv) {
  return {
    registry: reg,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) },
    recipesAll: (id, m, t) => Recipe.find(id, m).filter((r) => !r.requiresTable || t),
  }
}

function staleRun(ctx, names) {
  const plan = craftItem.planCraft(mkBot({ spruce_log: 1 }), ctx, names, 4)
  assert.equal(plan.target, 'spruce_planks')
  ctx.craftany = { key: `${names.join(',')}x4`, plan, have0: 0, finalNeed: 4, table: null, tableTries: 0, tableP: false, walkTicks: 0, lastDist: null }
}

it('a planks run planned on spruce re-plans on birch once the spruce is gone', () => {
  const ctx = {}
  const names = castlefetch.craftNames(mkBot({}), 'planks')
  staleRun(ctx, names)
  const bot = mkBot({ birch_log: 5 })
  assert.equal(craftItem(bot, ctx, names, 4), 'running')
  assert.equal(ctx.craftany, null)
  assert.equal(craftItem.planCraft(bot, ctx, names, 4).target, 'birch_planks')
})

it('no wood at all still fails with the gap line', () => {
  const ctx = {}
  const names = castlefetch.craftNames(mkBot({}), 'planks')
  staleRun(ctx, names)
  const r = craftItem(mkBot({}), ctx, names, 4)
  assert.match(r.line, /^can't make spruce_planks/)
})
