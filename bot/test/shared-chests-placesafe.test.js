'use strict'

// Owner 2026-11-18: a utility block never hems a bed/door in (refused spot,
// existing blocker moved), and every chest is shared (a peer bot's chest is
// a withdraw source).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const placesafe = require('../src/behaviours/placesafe')
const { tableFor } = require('../src/behaviours/tablespot')
const chestStock = require('../src/cheststock')
const stockpile = require('../src/behaviours/stockpile')

// Floor at y 63, extra blocks by 'x,y,z' -> name, air elsewhere.
function world(extra, at = { x: 0.5, y: 64, z: 0.5 }) {
  const cells = new Map(Object.entries(extra))
  const calls = { places: [], digs: [], goals: [] }
  const bot = {
    calls,
    entity: { position: new Vec3(at.x, at.y, at.z) },
    blockAt: (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const name = cells.get(`${x},${y},${z}`) || (y === 63 ? 'stone' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    inventory: { items: () => [{ name: 'crafting_table', count: 1 }] },
    equip: async () => {},
    placeBlock: async (ref) => { const k = `${ref.position.x},${ref.position.y + 1},${ref.position.z}`; calls.places.push(k); cells.set(k, 'crafting_table') },
    dig: async (b) => { calls.digs.push(`${b.position.x},${b.position.y},${b.position.z}`); cells.delete(`${b.position.x},${b.position.y},${b.position.z}`) },
    pathfinder: { setGoal: (g) => calls.goals.push(g), isMoving: () => false },
  }
  return bot
}

describe('placesafe: utilities never block a bed or door', () => {
  it('a table spot beside a bed is refused and the next neighbour is used', async () => {
    const bot = world({ '2,64,0': 'red_bed' }) // +x neighbour (1,64,0) touches the bed
    const r = await tableFor(bot, {})
    assert.deepEqual(bot.calls.places, ['-1,64,0'])
    assert.equal(r.block.name, 'crafting_table')
  })

  it('a table spot beside a door is refused too', async () => {
    const bot = world({ '2,64,0': 'oak_door', '2,65,0': 'oak_door' })
    await tableFor(bot, {})
    assert.deepEqual(bot.calls.places, ['-1,64,0'])
  })

  it('an existing table hemming a bed is broken (re-placed later from the pack)', async () => {
    const bot = world({ '0,64,2': 'red_bed', '0,64,3': 'red_bed', '1,64,2': 'crafting_table' })
    const ctx = { home: { site: { x: 100, y: 64, z: 100 } } } // designed table far away
    assert.equal(placesafe.clearBlockers(bot, ctx, [new Vec3(0, 64, 2), new Vec3(0, 64, 3)]), true)
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(bot.calls.digs, ['1,64,2'])
    assert.equal(placesafe.clearBlockers(bot, ctx, [new Vec3(0, 64, 2), new Vec3(0, 64, 3)]), false, 'clear now')
  })

  it('the designed residence table cell is left alone', () => {
    const site = { x: 0, y: 64, z: 0 }
    const bot = world({ '4,64,2': 'red_bed', '4,64,1': 'crafting_table' }) // hut table = site+(4,0,1)
    assert.equal(placesafe.clearBlockers(bot, { home: { site } }, [new Vec3(4, 64, 2)]), false)
  })
})

describe('shared chests: any known chest is a withdraw source', () => {
  it('another bot\'s chest covers a withdraw (gear lookup + stock count)', () => {
    const now = Date.now()
    const peer = { x: 10, y: 64, z: 10, at: now, contents: { iron_ingot: 9 } }
    const ctx = { home: { chest: { x: 0, y: 64, z: 5 } }, chests: [], peerChests: [peer], peerChestsAt: now }
    assert.equal(chestStock.anyChestWith(ctx, ['iron_ingot', 'raw_iron'], 5), peer)
    const bot = { entity: { position: new Vec3(0, 64, 0) } }
    assert.deepEqual(stockpile.nearbyChests(bot, ctx, []).map((c) => c.x), [10])
  })
})
