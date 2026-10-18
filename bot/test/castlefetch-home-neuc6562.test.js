'use strict'

// idkcraft-neuc.65.6.2: castlefetch's exposed-stone picks never undermine
// our own house — a stone cell under the house floor, under the doorstep
// or in the apron is refused by acceptStone at any depth (the e5ba/0mlh
// house-footprint guard in canBreak, which acceptStone shares); a cell
// QUARRY_GAP past the apron is accepted.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')
const { makeHome } = require('../src/site')

// The prod house shape (v2, site -88 88 -3): interior x -87..-83,
// z -2..1, door (-85,88,-3), doorstep/outsidePos (-85,88,-4).
const HOME = { ...makeHome(-88, 88, -3, 2), built: true }
const GY = 88 // ground anchor of the stone window

function makeBot(stone) {
  return {
    username: 'IdkBotV2',
    entity: { position: { x: -120, y: 88, z: -40 } },
    inventory: { items: () => [] },
    registry: { blocksByName: { stone: { id: 1 } } },
    // Every probed cell is stone with air above (exposed).
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = stone.has(k) ? 'stone' : 'air'
      return { name, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}

function accepts(p) {
  const bot = makeBot(new Set([`${p.x},${p.y},${p.z}`]))
  const ctx = { home: HOME, castle: { site: { x: -150, y: 88, z: -80 }, rot: 0, blueprintVersion: 1 } }
  return fetch.acceptStone(bot, ctx, p, GY)
}

describe('neuc.65.6.2 castlefetch stone picks spare the house footprint and apron', () => {
  it('refuses a stone cell under the house floor, at any depth in the window', () => {
    for (const y of [GY - 2, GY - 1, GY]) assert.equal(accepts({ x: -86, y, z: -1 }), false, `floor column y=${y}`)
    // the north wall line (z=-3) where the prod slab is missing
    assert.equal(accepts({ x: -84, y: GY - 1, z: -3 }), false, 'north wall line')
  })
  it('refuses a stone cell under the doorstep', () => {
    for (const y of [GY - 2, GY - 1, GY]) assert.equal(accepts({ x: -85, y, z: -4 }), false, `doorstep y=${y}`)
  })
  it('refuses a stone cell in the apron', () => {
    assert.equal(accepts({ x: -90, y: GY - 1, z: 0 }), false, 'west apron')
    assert.equal(accepts({ x: -85, y: GY - 2, z: -6 }), false, 'door-side apron')
    assert.equal(accepts({ x: -80, y: GY, z: 4 }), false, 'south-east apron corner')
  })
  it('accepts a stone cell QUARRY_GAP outside the apron', () => {
    // apron edge: interior min.x - 3 = -90; QUARRY_GAP (3) past it
    assert.equal(accepts({ x: -90 - 3, y: GY - 1, z: 0 }), true, 'west of the apron')
    // door side apron edge: min(min.z - 3, site.z - 3) = -6
    assert.equal(accepts({ x: -85, y: GY - 1, z: -6 - 3 }), true, 'north of the door apron')
  })
})
