'use strict'

// Swim primitive (idkcraft-be7, corrected by idkcraft-b50): fake-world test.
// A river 6 wide (x=4..9, surface feet y=62) cuts between flat banks flush
// with the surface (feet y=63); the goal stands on the far bank. Needs the
// real registry/block shapes, so this test builds a real Movements over a
// scripted blockAt (deps are pinned).
//
// b50 correction: a +2 exit from water standing on the bottom (head in air)
// is unexecutable — the body jumps ~1.25. dy=2 fires only with liquid above
// the feet (room to surface); dy=1 exits at flush banks carry crossings.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const { addSwimExits } = require('../src/swim')

// nameAt with tunable banks/water; lava pit + dry wall only in the main world.
function makeNameAt({ bankTop = 62, waterLo = 60, waterHi = 62, extras = true }) {
  return function nameAt(x, y, z) {
    if (extras && x === -2 && y >= 60 && y <= 62) return 'lava' // lava pit in the bank
    if (extras && x === -4 && (y === 63 || y === 64)) return 'stone' // 2-high wall on land
    const river = x >= 4 && x <= 9
    if (river) {
      if (y < waterLo) return 'stone'
      if (y <= waterHi) return 'water'
      return 'air'
    }
    if (y < waterLo) return 'stone'
    if (y <= bankTop - 1) return 'dirt'
    if (y === bankTop) return 'grass_block'
    return 'air'
  }
}

const nameAt = makeNameAt({})

function blockAtFor(nameFn) {
  return (p) => {
    const b = Block.fromStateId(mcData.blocksByName[nameFn(p.x, p.y, p.z)].minStateId, 0)
    b.position = new Vec3(p.x, p.y, p.z)
    return b
  }
}

function worldBot(nameFn = nameAt) {
  return {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt: (p) => blockAtFor(nameFn)(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))),
  }
}

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

// Movements wired exactly like production: ticker.setMovements applies the
// bot settings (no sprint) plus the swim exits.
function wiredMovements(nameFn = nameAt) {
  const bot = worldBot(nameFn)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return movements
}

describe("swim primitive (idkcraft-be7, idkcraft-b50)", () => {
  it('the exit edge exists: water-surface node reaches the flush bank', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(ns.some((m) => m.x === 10 && m.y === 63 && m.z === 0), 'swim exit 9,62 -> 10,63')
  })

  it('a goal across 6 water blocks plans success through the water', () => {
    const movements = wiredMovements()
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(14, 63, 0), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    assert.ok(r.path.length > 0)
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [14, 63, 0])
    assert.ok(r.path.some((m) => m.y < 63), 'path crosses at water level, not over the top')
  })

  it('1-deep water with a +2 bank offers no exit (the spawn trap)', () => {
    const shallow = makeNameAt({ bankTop: 63, waterLo: 62, waterHi: 62, extras: false })
    const movements = wiredMovements(shallow)
    const ns = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 10 && m.y === 64 && m.z === 0), 'no unexecutable 9,62 -> 10,64')
  })

  it('a submerged node with liquid head keeps the +2 exit', () => {
    const deep = makeNameAt({ bankTop: 62, waterLo: 61, waterHi: 62, extras: false })
    const movements = wiredMovements(deep)
    const ns = movements.getNeighbors(new Move(9, 61, 0, 0, 0))
    assert.ok(ns.some((m) => m.x === 10 && m.y === 63 && m.z === 0), 'swim exit 9,61 -> 10,63')
  })

  it('wrapping twice adds no duplicate exits; land nodes are untouched', () => {
    const bot = worldBot()
    const plain = new Movements(bot)
    const movements = new Movements(bot)
    addSwimExits(movements)
    addSwimExits(movements)
    const exits = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
      .filter((m) => m.x === 10 && m.y === 63 && m.z === 0)
    assert.equal(exits.length, 1)
    // The water guard: a dry-land node gets exactly the original neighbors.
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    assert.equal(hash(movements.getNeighbors(new Move(0, 63, 0, 0, 0))), hash(plain.getNeighbors(new Move(0, 63, 0, 0, 0))))
  })

  it('no phantom exits beside a dry-land wall', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(-3, 63, 0, 0, 0))
    assert.ok(!ns.some((m) => m.y >= 65), 'no 2-up jump the body cannot make')
  })

  it('no exits from lava feet', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(-2, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.y >= 64), 'lava never climbs to bank level')
  })
})
