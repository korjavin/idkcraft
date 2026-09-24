'use strict'

// Snow ground (idkcraft-2pt): snow layers read as non-physical air
// (boundingBox 'empty'), so the planner walks through them and Paper rolls
// the penetration back. layers=1 has no collision box at all (leave as
// air); layers>=2 are thin but real ground. Fake-world test over a real
// Movements with scripted snow states (deps are pinned).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements } = require('mineflayer-pathfinder')
const { addSnowGround } = require('../src/snow')

// Flat dirt floor (feet y=63), one snow cell at x=0 with tunable layers.
function worldBot(snowLayers) {
  const snowId = mcData.blocksByName.snow.minStateId + snowLayers - 1
  return {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt: (p) => {
      const fp = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const id = (fp.x === 0 && fp.z === 0 && fp.y === 63) ? snowId
        : mcData.blocksByName[fp.y < 63 ? 'dirt' : 'air'].minStateId
      const b = Block.fromStateId(id, 0)
      b.position = fp
      return b
    },
  }
}

function wrappedBot(snowLayers) {
  const bot = worldBot(snowLayers)
  const mov = new Movements(bot)
  addSnowGround(mov)
  return { bot, mov }
}

const node = { x: 0, y: 63, z: 1, remainingBlocks: 0 }

describe('snow ground', () => {
  it('layers=1 stays non-physical (no collision box)', () => {
    const { mov } = wrappedBot(1)
    const b = mov.getBlock(node, 0, 0, -1)
    assert.equal(b.name, 'snow')
    assert.equal(b.physical, false)
  })

  it('layers=2 and 8 become physical ground at shape height', () => {
    for (const layers of [2, 8]) {
      const { mov } = wrappedBot(layers)
      const b = mov.getBlock(node, 0, 0, -1)
      assert.equal(b.name, 'snow')
      assert.equal(b.physical, true)
      assert.ok(b.height > 63 && b.height < 64, `height ${b.height}`)
    }
  })

  it('dirt and air are untouched, install is idempotent', () => {
    const { mov } = wrappedBot(8)
    const floor = mov.getBlock(node, 0, -1, -1)
    assert.equal(floor.physical, true)
    const air = mov.getBlock(node, 0, 2, -1)
    assert.equal(air.physical, false)
    addSnowGround(mov) // second install: no double wrap
    const b = mov.getBlock(node, 0, 0, -1)
    assert.equal(b.physical, true)
  })

  it('ignores non-Movements mocks', () => {
    assert.doesNotThrow(() => addSnowGround(null))
    assert.doesNotThrow(() => addSnowGround({ allowSprinting: false }))
  })
})
