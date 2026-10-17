'use strict'

// idkcraft-gfgx: the castle builder stood on a 1-wide wall top (lay rig plan
// world dump: every neighbour open air with no floor) and tableFor failed
// no-table-ref 6/6 with the table in the pack. It now places the table
// beside the block under its feet, against that block's side, and never
// into a castle plan cell.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { tableFor } = require('../src/behaviours/tablespot')

// A one-block pillar (0,y<=77,0) under a body at (0,78,0); open air elsewhere.
function world() {
  const cells = new Map()
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const blockAt = (p) => {
    const k = key(p)
    const name = cells.has(k) ? cells.get(k) : (Math.floor(p.x) === 0 && Math.floor(p.z) === 0 && p.y <= 77 ? 'cobblestone' : 'air')
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
  }
  return { cells, key, blockAt }
}

// Each stub mirrors the real API:
// - bot.blockAt(pos) -> Block | null: mineflayer lib/plugins/blocks.js.
//   The fake keeps only { name, boundingBox ('block' | 'empty'), position }
//   (prismarine-block). It never returns null, because every chunk is loaded.
// - bot.placeBlock(referenceBlock, faceVector) -> Promise<void>: mineflayer
//   lib/plugins/place_block.js. The real one awaits the blockUpdate at
//   referenceBlock.position + faceVector and throws on timeout. The fake
//   writes 'crafting_table' into that cell at once and never times out.
//   bridge/interact.js keeps the same (ref, face) signature on v2.
// - bot.equip(item, 'hand') -> Promise<void>: mineflayer
//   lib/plugins/inventory.js. The fake is a no-op, since placement decides.
// - bot.inventory.items() -> Item[] (prismarine-windows). The fake carries
//   { name, count } only, which is all tableFor reads.
function bot(w) {
  const calls = []
  return {
    calls,
    entity: { position: { x: 0.5, y: 78, z: 0.5 } },
    inventory: { items: () => [{ name: 'crafting_table', count: 1 }] },
    blockAt: w.blockAt,
    equip: async () => {},
    placeBlock: async (ref, face) => {
      calls.push({ ref: ref.position, face: { x: face.x, y: face.y, z: face.z } })
      w.cells.set(w.key({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }), 'crafting_table')
    },
  }
}

describe('gfgx tableFor on a ledge', () => {
  it('no floored neighbour: the table goes beside the block under the feet', async () => {
    const b = bot(world())
    const r = await tableFor(b, {})
    assert.deepEqual(b.calls, [{ ref: { x: 0, y: 77, z: 0 }, face: { x: 1, y: 0, z: 0 } }])
    assert.equal(r.block.name, 'crafting_table')
    assert.deepEqual({ ...r.pos }, { x: 1, y: 77, z: 0 })
  })

  it('a floored neighbour still wins over the ledge', async () => {
    const w = world()
    w.cells.set('0,77,1', 'cobblestone')
    w.cells.set('-1,77,0', 'cobblestone')
    const b = bot(w)
    await tableFor(b, {})
    assert.deepEqual(b.calls, [{ ref: { x: -1, y: 77, z: 0 }, face: { x: 0, y: 1, z: 0 } }])
  })

  it('a refused floored cell yields to a fresh ledge cell', async () => {
    const w = world()
    w.cells.set('-1,77,0', 'cobblestone') // the one floored neighbour
    const b = bot(w)
    const okPlace = b.placeBlock
    b.placeBlock = async () => { throw new Error('refused') }
    const ctx = {}
    await assert.rejects(tableFor(b, ctx), /refused/)
    b.placeBlock = okPlace
    await tableFor(b, ctx)
    assert.deepEqual(b.calls, [{ ref: { x: 0, y: 77, z: 0 }, face: { x: 1, y: 0, z: 0 } }])
  })

  it('an overhang above the ledge cell blocks it (table top out of sight)', async () => {
    const w = world()
    for (const k of ['1,78,0', '-1,78,0', '0,78,1', '0,78,-1']) w.cells.set(k, 'cobblestone')
    const b = bot(w)
    await tableFor(b, {})
    // not the hidden ledge cell (1,77,0): the canopy spot on top instead
    assert.deepEqual(b.calls, [{ ref: { x: 1, y: 78, z: 0 }, face: { x: 0, y: 1, z: 0 } }])
  })

  it('canopy: leaves on every feet-level side -> the table sits on top of one, head level', async () => {
    const w = world()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      w.cells.set(`${dx},78,${dz}`, 'birch_leaves')
      w.cells.set(`${dx},77,${dz}`, 'birch_leaves')
    }
    const b = bot(w)
    const r = await tableFor(b, {})
    assert.deepEqual(b.calls, [{ ref: { x: 1, y: 78, z: 0 }, face: { x: 0, y: 1, z: 0 } }])
    assert.deepEqual({ ...r.pos }, { x: 1, y: 79, z: 0 })
  })

  it('castle plan cells are never table spots (home=none on the builder)', async () => {
    const castle = require('../src/castle')
    const site = { x: -18, y: 72, z: -10 } // puts (1,77,0) on the plan, (-1,77,0) off it
    const plan = castle.absPlan(site, 0, 2).at
    assert.ok(plan.has('1,77,0') && !plan.has('-1,77,0'))
    const b = bot(world())
    const r = await tableFor(b, { castle: { site, rot: 0, blueprintVersion: 2 } })
    assert.deepEqual(b.calls, [{ ref: { x: 0, y: 77, z: 0 }, face: { x: -1, y: 0, z: 0 } }])
    assert.deepEqual({ ...r.pos }, { x: -1, y: 77, z: 0 })
  })
})
