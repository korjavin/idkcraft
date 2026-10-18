// idkcraft-z591: the v2 door sill is never natural ground (Baritone hard-bans
// planks by name, not dirt; natural dirt under the door was broken from below and the door
// popped). v1 keeps the solid-ground rule.
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../src/behaviours/build')
const { BLUEPRINT_V2 } = build

const SITE = { x: 0, y: 64, z: 0 }
const SILL = BLUEPRINT_V2.findIndex((c) => c.sill)

// Block reads mirror bridge/chunks.js blockAt (mineflayer shape: name +
// boundingBox, null only for an unloaded chunk). Below the floor line is
// dirt, the house above is laid by paint().
function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      const name = cells.has(k) ? cells.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
    },
  }
}

function paint(world) {
  for (const c of BLUEPRINT_V2) {
    const name = c.kind === 'table' ? 'crafting_table' : c.kind === 'door' ? 'oak_door'
      : c.kind === 'planks' ? 'oak_planks' : null
    if (name) world.set(SITE.x + c.dx, SITE.y + c.dy, SITE.z + c.dz, name)
  }
}

function mockBot(world) {
  return {
    blockAt: (p) => world.blockAt(p),
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }] },
  }
}

const home = () => ({ site: { ...SITE }, v: 2, built: true })
const prev = process.env.BOT_BODY
afterEach(() => { if (prev === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prev })

describe('z591 v2 door sill', () => {
  it('the sill is the doorway fill cell, index unchanged (persisted skips)', () => {
    assert.equal(SILL, 5)
    assert.deepEqual(BLUEPRINT_V2[SILL], { dx: 3, dy: -1, dz: 0, kind: 'fill', sill: true })
    assert.equal(BLUEPRINT_V2.filter((c) => c.sill).length, 1)
  })

  it('v2: a dirt sill is undone, re-opens a built house and goes to the builder batch', () => {
    process.env.BOT_BODY = 'baritone'
    const world = makeWorld()
    paint(world)
    const bot = mockBot(world)
    const h = home()
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[SILL]), false)
    assert.equal(build.isComplete(bot, h), false)
    assert.equal(build.holeOwed(bot, h, []), true)
    assert.equal(build.holeOwed(bot, h, [SILL]), false, 'a skipped sill never re-opens')
    const batch = build.builderCells(bot, h, [])
    assert.deepEqual(batch.cells.map((c) => c.idx), [SILL])
    assert.equal(batch.cells[0].block, 'oak_planks')
    world.set(3, 63, 0, 'stone')
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[SILL]), false, 'any natural ground')
    world.set(3, 63, 0, 'cobblestone')
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[SILL]), true, 'a built (banned) kind stays done: the builder cannot replace it')
    world.set(3, 63, 0, 'spruce_planks')
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[SILL]), true, 'any planks variant')
    assert.equal(build.isComplete(bot, h), true)
    assert.equal(build.holeOwed(bot, h, []), false)
    // the other floor cells keep the solid-ground rule
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[1]), true)
  })

  it('v1: a dirt sill stays done, nothing re-opens', () => {
    delete process.env.BOT_BODY
    const world = makeWorld()
    paint(world)
    const bot = mockBot(world)
    const h = home()
    assert.equal(build.cellDone(bot, h, BLUEPRINT_V2[SILL]), true)
    assert.equal(build.isComplete(bot, h), true)
    assert.equal(build.holeOwed(bot, h, []), false)
  })
})
