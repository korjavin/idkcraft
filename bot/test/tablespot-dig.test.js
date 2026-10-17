'use strict'

// idkcraft-gfgx: a body encased in stone (castlefetch shaft) failed
// tableFor no-table-ref with a table in the pack; it now digs a neighbour
// free and places there. A liquid above the only cell keeps the old refusal.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tableFor } = require('../src/behaviours/tablespot')

function world(extra = {}) {
  const cells = new Map(Object.entries(extra))
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const blockAt = (p) => {
    const k = key(p)
    // body column (0,64..65,0) is air, everything else stone
    const name = cells.has(k) ? cells.get(k) : (p.x === 0 && p.z === 0 && p.y >= 64 && p.y <= 65 ? 'air' : 'stone')
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
  }
  return { cells, key, blockAt }
}

function bot(w) {
  const calls = { dig: [], place: [] }
  return {
    calls,
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    inventory: { items: () => [{ name: 'crafting_table', count: 1 }] },
    blockAt: w.blockAt,
    equip: async () => {},
    dig: async (b) => { calls.dig.push(b.position); w.cells.set(w.key(b.position), 'air') },
    placeBlock: async (ref, face) => {
      calls.place.push(ref.position)
      w.cells.set(w.key({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }), 'crafting_table')
    },
  }
}

describe('gfgx tableFor digs a cell free when encased', () => {
  it('encased body digs a neighbour and places the table there', async () => {
    const w = world()
    const b = bot(w)
    const r = await tableFor(b, {})
    assert.deepEqual(b.calls.dig, [{ x: 1, y: 64, z: 0 }])
    assert.deepEqual(b.calls.place, [{ x: 1, y: 63, z: 0 }])
    assert.equal(r.block.name, 'crafting_table')
  })

  it('castle-protected neighbours are never dug: no-table-ref', async () => {
    const b = bot(world())
    const ctx = { castle: { site: { x: -3, y: 60, z: -3 }, rot: 0, blueprintVersion: 2 } }
    await assert.rejects(tableFor(b, ctx), /no-table-ref/)
    assert.equal(b.calls.dig.length, 0)
  })

  it('a failed dig skips that cell; the next pick digs another neighbour', async () => {
    const w = world()
    const b = bot(w)
    const okDig = b.dig
    b.dig = async () => { throw new Error('Digging aborted') }
    const ctx = {}
    await assert.rejects(tableFor(b, ctx), /table-dig: Digging aborted/)
    assert.ok(ctx.equipTableSkip.has('1,64,0'))
    b.dig = okDig
    await tableFor(b, ctx)
    assert.deepEqual(b.calls.dig, [{ x: -1, y: 64, z: 0 }])
  })

  it('a refused placement on a dug cell digs a fresh neighbour next, not the refused one', async () => {
    const w = world()
    const b = bot(w)
    const okPlace = b.placeBlock
    b.placeBlock = async () => { throw new Error('refused') }
    const ctx = {}
    await assert.rejects(tableFor(b, ctx), /refused/)
    b.placeBlock = okPlace
    await tableFor(b, ctx)
    assert.deepEqual(b.calls.dig, [{ x: 1, y: 64, z: 0 }, { x: -1, y: 64, z: 0 }])
    assert.deepEqual(b.calls.place, [{ x: -1, y: 63, z: 0 }])
  })

  it('water above every neighbour keeps no-table-ref', async () => {
    const extra = {}
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) extra[`${dx},65,${dz}`] = 'water'
    const b = bot(world(extra))
    await assert.rejects(tableFor(b, {}), /no-table-ref/)
    assert.equal(b.calls.dig.length, 0)
  })
})
