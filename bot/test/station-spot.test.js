'use strict'

// Station class (any crafted/smelted item): prod v2 glazing failed
// 'table place n/3 failed: no-table-ref', 'smelt-glass-no-spot' and
// 'furnace-unreachable' while standing in a pit/tunnel at a castle, and
// placed a new furnace per smelt. One shared spot finder (tablespot.stationSpot)
// serves the table and the furnace; an unreachable furnace is relocated;
// a furnace standing nearby is reused.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tableFor } = require('../src/behaviours/tablespot')
const furnace = require('../src/behaviours/furnace')

function world(solid) {
  const cells = new Map()
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const blockAt = (p) => {
    const k = key(p)
    const name = cells.has(k) ? cells.get(k) : (solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? 'stone' : 'air')
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
  }
  return { cells, key, blockAt }
}
const pit = (x, y, z) => y <= 64 || !(x === 0 && z === 0) // 1x1 shaft at 0,0 above y=64

function bot(w, item, extra = {}) {
  const calls = { dug: [], placed: [] }
  return {
    calls,
    entity: { position: { x: 0.5, y: 65, z: 0.5 } },
    inventory: { items: () => [{ name: item, count: 1 }] },
    blockAt: w.blockAt,
    equip: async () => {},
    dig: async (b) => { calls.dug.push(b.position); w.cells.set(w.key(b.position), 'air') },
    placeBlock: async (ref, face) => {
      const at = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
      calls.placed.push(at)
      w.cells.set(w.key(at), item)
    },
    pathfinder: { setGoal: () => {} },
    ...extra,
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('station spot (no-table-ref / no-spot class)', () => {
  it('a table in a pit: digs a feet-level neighbour and places there (was no-table-ref)', async () => {
    const b = bot(world(pit), 'crafting_table')
    const r = await tableFor(b, {})
    assert.equal(b.calls.dug.length, 1)
    assert.equal(r.block.name, 'crafting_table')
    assert.deepEqual(b.calls.placed, [b.calls.dug[0]])
  })

  it('only a diagonal cell is open: the table goes there, nothing dug', async () => {
    const b = bot(world((x, y, z) => y <= 64 || !((x === 0 && z === 0) || (x === 1 && z === 1))), 'crafting_table')
    const r = await tableFor(b, {})
    assert.deepEqual(b.calls.dug, [])
    assert.deepEqual({ ...r.pos }, { x: 1, y: 65, z: 1 })
  })

  it('a furnace in a pit: digs a spot and places (was smelt-*-no-spot)', async () => {
    const b = bot(world(pit), 'furnace')
    const ctx = { home: {} }
    furnace(b, ctx)
    await settle(); await settle()
    assert.equal(ctx.stepStatus, undefined)
    assert.equal(b.calls.dug.length, 1)
    assert.deepEqual({ ...ctx.home.furnace }, b.calls.placed[0])
  })

  it('a furnace standing nearby is reused; an unreachable one is skipped for the day', () => {
    const w = world((x, y) => y <= 64)
    w.cells.set('5,65,0', 'furnace')
    const b = bot(w, 'furnace', {
      registry: { blocksByName: { furnace: { id: 61 } } },
      findBlocks: () => [{ x: 5, y: 65, z: 0 }],
    })
    const ctx = { home: {} }
    assert.deepEqual({ ...furnace.furnaceReady(b, ctx) }, { x: 5, y: 65, z: 0 })
    delete ctx.home.furnace
    ctx.furnaceFar = { day: 0, keys: new Set(['5,65,0']) }
    assert.equal(furnace.furnaceReady(b, ctx), null)
  })
})
