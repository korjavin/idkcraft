'use strict'

// idkcraft-unm6: a null tableFor resolve ("walking in") must not spend one of
// craftany's TABLE_TRIES; only a reject does. tableFor is stubbed through the
// require cache BEFORE craftany loads (it destructures the export). The stub
// mirrors tablespot.tableFor: Promise<{block,pos}|null>, rejects on no table.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const tablespot = require('../src/behaviours/tablespot')

let calls = 0
let mode = 'null'
tablespot.tableFor = () => {
  calls++
  return mode === 'null' ? Promise.resolve(null) : Promise.reject(new Error('table-unreachable'))
}
const craftany = require('../src/behaviours/craftany')

const tick = () => new Promise((r) => setImmediate(r))

function bot() {
  const itemsByName = { stone_axe: { id: 1 }, crafting_table: { id: 2 }, cobblestone: { id: 3 }, stick: { id: 4 } }
  const recipe = { delta: [{ id: 3, count: -3 }, { id: 4, count: -2 }, { id: 1, count: 1 }], result: { count: 1 }, requiresTable: true }
  return {
    username: 'B',
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    registry: { blocksByName: {}, itemsByName },
    inventory: { items: () => [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }, { name: 'crafting_table', count: 1 }] },
    recipesAll: () => [recipe],
    recipesFor: () => [recipe],
    blockAt: () => null,
    findBlocks: () => [],
    pathfinder: { setGoal() {}, isMoving: () => false },
  }
}

describe('craftany table tries (unm6)', () => {
  it('walking-in nulls never exhaust TABLE_TRIES; rejects still do', async () => {
    const b = bot()
    const ctx = {}
    for (let i = 0; i < 8; i++) {
      assert.equal(craftany(b, ctx, ['stone_axe'], 1), 'running', `tick ${i} still walking`)
      await tick()
    }
    assert.equal(calls, 8, 'tableFor asked every tick')
    mode = 'reject'
    let res = 'running'
    for (let i = 0; i < 6 && res === 'running'; i++) {
      res = craftany(b, ctx, ['stone_axe'], 1)
      await tick()
    }
    assert.deepEqual(res, { done: false, line: 'need a crafting table' })
  })
})
