'use strict'

// Production-wired Movements (ticker.setMovements: doors, swim exits/prune,
// no-corner-cut, snow, jump cost) still find ordinary walks, including out
// of water and across a moat with no dig and no scaffold. Guards the
// "noPath for every goal" suspicion against the wrapper stack.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')

function plan(nameAt, start, goal, setup) {
  const bot = {
    registry: mcData, game: { minY: -64 }, time: { timeOfDay: 6000 },
    entity: { effects: [], position: new Vec3(start.x + 0.5, start.y, start.z + 0.5) },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    inventory: { items: () => [] }, setControlState() {}, clearControlStates() {},
    blockAt: (p) => {
      const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const b = Block.fromStateId(mcData.blocksByName[nameAt(q.x, q.y, q.z)].minStateId, 0)
      b.position = q
      return b
    },
  }
  const ticker = createTicker({ bot, brain: { async decide() { return { action: 'idle' } } }, tickMs: 10, idleTickMs: 10 })
  const m = new Movements(bot)
  m.allowSprinting = false
  ticker.setMovements(m)
  if (setup) setup(m)
  return new AStar(new Move(start.x, start.y, start.z, 0, 0), m, goal, 10000, 9000).compute()
}

const flat = (x, y, z) => (y < 63 ? 'stone' : y === 63 ? 'grass_block' : 'air')
const pond = (x, y, z) => (Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= 61 && y <= 63 ? 'water' : flat(x, y, z))
const moat = (x, y, z) => (x >= 5 && x <= 7 && y >= 60 && y <= 63 ? 'water' : flat(x, y, z))
const noDig = (m) => { m.canDig = false; m.scafoldingBlocks = [] }

describe('production-wired Movements find ordinary paths', () => {
  it('flat 30-block walk', () => {
    assert.equal(plan(flat, { x: 0, y: 64, z: 0 }, new goals.GoalBlock(30, 64, 0)).status, 'success')
  })
  it('out of a pond from the surface and from the bottom', () => {
    assert.equal(plan(pond, { x: 0, y: 63, z: 0 }, new goals.GoalBlock(10, 64, 0), noDig).status, 'success')
    assert.equal(plan(pond, { x: 0, y: 61, z: 0 }, new goals.GoalBlock(10, 64, 0), noDig).status, 'success')
  })
  it('across a 3-wide moat with no dig and no scaffold', () => {
    assert.equal(plan(moat, { x: 0, y: 64, z: 0 }, new goals.GoalBlock(12, 64, 0), noDig).status, 'success')
  })
})
