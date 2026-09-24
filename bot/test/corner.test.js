'use strict'

// Corner-cut repro (idkcraft-4ac): mineflayer-pathfinder 2.4.5 getMoveDiagonal
// offers a diagonal when only ONE side cell is free; the 0.6-wide body cuts
// the occupied corner and wedges until reset=stuck. Prod 2026-09-24: 18-24%
// of moving ticks are reset=stuck, almost all within 6 blocks of the plank
// home (guardOwnWalls makes every plank unbreakable, so the corner can never
// be dug through either). Fake-world harness: real Movements over a scripted
// blockAt, wired exactly like production (ticker.setMovements).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')

const PLANK = 'oak_planks'

// Flat feet-64 ground, optional plank post east of origin, optional 1x1 pit
// at origin (feet 63), optional plank wall across x=1.
function makeNameAt({ post = true, pit = false, wall = false } = {}) {
  return function nameAt(x, y, z) {
    if (post && x === 1 && (y === 64 || y === 65) && z === 0) return PLANK
    if (wall && x === 1 && z >= -1 && z <= 1 && (y === 63 || y === 64)) return PLANK
    if (pit && x === 0 && z === 0 && y === 63) return 'air'
    if (y < 63) return 'stone'
    if (y === 63) return 'grass_block'
    return 'air'
  }
}

function blockAtFor(nameFn) {
  return (p) => {
    const b = Block.fromStateId(mcData.blocksByName[nameFn(p.x, p.y, p.z)].minStateId, 0)
    b.position = new Vec3(p.x, p.y, p.z)
    return b
  }
}

function worldBot(nameFn) {
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

// Production wiring: ticker.setMovements applies bot settings (no sprint)
// plus neighbor wrappers. unbreakable=true mirrors guardOwnWalls (planks in
// blocksCantBreak for the whole session).
function wiredMovements(nameFn, { unbreakable = true } = {}) {
  const bot = worldBot(nameFn)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  if (unbreakable) movements.blocksCantBreak.add(mcData.blocksByName[PLANK].id)
  ticker.setMovements(movements)
  return movements
}

// Every diagonal step of a path must have both side cells open at body
// levels; returns the first cutting step or null.
function findCornerCut(movements, path) {
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1]
    const cur = path[i]
    const dx = cur.x - prev.x
    const dz = cur.z - prev.z
    if (Math.abs(dx) !== 1 || Math.abs(dz) !== 1) continue
    const lo = Math.min(prev.y, cur.y) - prev.y
    const hi = Math.max(prev.y, cur.y) - prev.y + 1
    for (let dy = lo; dy <= hi; dy++) {
      const s1 = movements.getBlock(prev, dx, dy, 0)
      const s2 = movements.getBlock(prev, 0, dy, dz)
      if ((s1.physical && !s1.safe) || (s2.physical && !s2.safe)) {
        return { from: [prev.x, prev.y, prev.z], to: [cur.x, cur.y, cur.z] }
      }
    }
  }
  return null
}

describe('corner-cut repro (idkcraft-4ac)', () => {
  it('no diagonal cuts the unbreakable plank post', () => {
    const movements = wiredMovements(makeNameAt({ post: true }))
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 1 && m.y === 64 && m.z === 1),
      'diagonal 0,64,0 -> 1,64,1 cuts the occupied side cell 1,64,0')
    assert.ok(!ns.some((m) => m.x === 1 && m.y === 64 && m.z === -1),
      'diagonal 0,64,0 -> 1,64,-1 cuts the occupied side cell 1,64,0')
  })

  it('pit + plank wall: plans success with no corner-cutting edge', () => {
    const movements = wiredMovements(makeNameAt({ post: false, pit: true, wall: true }))
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(2, 64, 2), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success', 'path out of the pit past the wall plans')
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [2, 64, 2])
    assert.equal(findCornerCut(movements, r.path), null, 'no path edge cuts an occupied corner')
  })

  it('open ground still plans through the old diagonal line', () => {
    const movements = wiredMovements(makeNameAt({ post: false }))
    const astar = new AStar(new Move(0, 64, 0, 0, 0), movements, new goals.GoalBlock(3, 64, 3), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [3, 64, 3])
  })
})

describe('no-corner-cut guard (idkcraft-4ac fix)', () => {
  it('a diggable dirt corner is not cut either (planner takes the free side, executor would still clip)', () => {
    const dirt = makeNameAt({ post: false })
    const withDirt = (x, y, z) => (x === 1 && (y === 64 || y === 65) && z === 0 ? 'dirt' : dirt(x, y, z))
    const movements = wiredMovements(withDirt, { unbreakable: false })
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 1 && m.y === 64 && m.z === 1),
      'free-side passage still clips the dirt corner the executor never digs')
    const astar = new AStar(new Move(0, 64, 0, 0, 0), movements, new goals.GoalBlock(3, 64, 3), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success', 'cardinal routing around the corner still plans')
    assert.equal(findCornerCut(movements, r.path), null)
  })

  it('invariant: no kept diagonal leaves an undug solid side cell', () => {
    const movements = wiredMovements(makeNameAt({ post: true, pit: true, wall: true }))
    for (const [nx, ny, nz] of [[0, 64, 0], [0, 63, 0], [0, 64, 2], [2, 64, 0]]) {
      const node = new Move(nx, ny, nz, 0, 0)
      for (const m of movements.getNeighbors(node)) {
        const dx = m.x - node.x
        const dz = m.z - node.z
        if (Math.abs(dx) !== 1 || Math.abs(dz) !== 1) continue
        const broken = new Set((m.toBreak || []).map((q) => `${q.x},${q.y},${q.z}`))
        const lo = Math.min(0, m.y - node.y)
        const hi = Math.max(0, m.y - node.y) + 1
        for (let dy = lo; dy <= hi; dy++) {
          for (const [ox, oz] of [[dx, 0], [0, dz]]) {
            const cell = movements.getBlock(node, ox, dy, oz)
            if (cell && cell.physical && !cell.safe && !cell.openable) {
              assert.ok(broken.has(`${cell.position.x},${cell.position.y},${cell.position.z}`),
                `diagonal ${node.x},${node.y},${node.z} -> ${m.x},${m.y},${m.z} leaves solid ${cell.position.x},${cell.position.y},${cell.position.z} undug`)
            }
          }
        }
      }
    }
  })
})

  it('wrapping twice drops no extra edges; open nodes are untouched', () => {
    const { addNoCornerCut } = require('../src/nocorner')
    const bot = worldBot(makeNameAt({ post: false }))
    const plain = new Movements(bot)
    const movements = new Movements(bot)
    addNoCornerCut(movements)
    addNoCornerCut(movements)
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    assert.equal(hash(movements.getNeighbors(new Move(0, 64, 0, 0, 0))), hash(plain.getNeighbors(new Move(0, 64, 0, 0, 0))))
  })

  it('cardinal step-up out of the pit survives the filter', () => {
    const movements = wiredMovements(makeNameAt({ post: false, pit: true, wall: true }))
    const ns = movements.getNeighbors(new Move(0, 63, 0, 0, 0))
    assert.ok(ns.some((m) => m.y === 64 && Math.abs(m.x) + Math.abs(m.z) === 1), 'a cardinal +1 exit leaves the pit')
  })

describe('toBreak keep-branch (idkcraft-4ac)', () => {
  it('a diagonal the executor digs first is kept', () => {
    const dirt = makeNameAt({ post: false })
    const withDirt = (x, y, z) => (x === 1 && (y === 64 || y === 65) && z === 0 ? 'dirt' : dirt(x, y, z))
    const movements = wiredMovements(withDirt, { unbreakable: false })
    // Price the free side out of the search so the planner takes the dig
    // passage and slates the dirt corner for breaking first.
    movements.exclusionAreasStep.push((b) => (
      b.position.x === 0 && (b.position.y === 64 || b.position.y === 65) && b.position.z === 1 ? 100 : 0))
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    const diag = ns.find((m) => m.x === 1 && m.y === 64 && m.z === 1)
    assert.ok(diag, 'diagonal past a corner dug first is kept')
    assert.ok((diag.toBreak || []).some((q) => q.x === 1 && q.y === 64 && q.z === 0),
      'the solid side cell is slated for digging first')
  })
})
