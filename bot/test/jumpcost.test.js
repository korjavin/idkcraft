'use strict'

// Jump-up cost penalty (idkcraft-8yy): the executor leaps every planned +1
// climb with a run-up and Paper 26.1.2 cancels face-meeting arcs server-side
// (wqt: rise 0.00), so each climb is a stuck lottery. The lib has no jump-up
// cost knob, so addJumpUpCost penalises climbing edges in a getNeighbors
// wrap. Fake-world harness with real Movements + A*, wired exactly like
// production (ticker.setMovements) — same shape as corner.test.js.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const { addJumpUpCost, JUMP_UP_COST, WEDGE_COST } = require('../src/jumpcost')

// Flat feet-64 ground; a +1 step wall across x=1 (block at y=64) for
// z in [lo, hi). Gap course: short wall, open gap past the end. Forced
// course: long wall both ways, so walking around costs more than climbing.
function makeNameAt(lo, hi) {
  return function nameAt(x, y, z) {
    if (x === 1 && y === 64 && z >= lo && z < hi) return 'stone'
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

// Production wiring: ticker.setMovements installs all neighbor wrappers.
function wiredMovements(nameFn) {
  const bot = worldBot(nameFn)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return movements
}

// Same flags, no wrappers: the unpatched baseline.
function rawMovements(nameFn) {
  const movements = new Movements(worldBot(nameFn))
  movements.allowSprinting = false
  return movements
}

// Climbing edges: +1 rise with horizontal motion (ladder/tower excluded).
// A* paths omit the start node, so it is prepended for edge counting.
function climbs(path, start) {
  const full = start ? [start, ...path] : path
  let n = 0
  for (let i = 1; i < full.length; i++) {
    const dy = full[i].y - full[i - 1].y
    const dh = Math.abs(full[i].x - full[i - 1].x) + Math.abs(full[i].z - full[i - 1].z)
    if (dy === 1 && dh > 0) n++
  }
  return n
}

function plan(movements, sx, sy, sz, gx, gy, gz, near = 0) {
  const goal = near > 0 ? new goals.GoalNear(gx, gy, gz, near)
    : new goals.GoalBlock(gx, gy, gz)
  const astar = new AStar(new Move(sx, sy, sz, 0, 0), movements, goal, 30000, 90000)
  return astar.compute()
}

// Staircase hill: top surface rises +1 per x for x in [0, H).
function stairNameAt(H) {
  return function nameAt(x, y, z) {
    const top = 63 + Math.max(0, Math.min(H, x + 1))
    if (y < top) return 'stone'
    if (y === top) return 'grass_block'
    return 'air'
  }
}

// Pit at (1,63,0) with a +1 step past it (x=2, open sides): raw A* leaps the
// pit onto the ledge (parkour-up); the patched planner walks around.
function pitNameAt(x, y, z) {
  if (x === 1 && z === 0 && y === 63) return 'air'
  if (x === 2 && y === 64 && z >= -1 && z <= 1) return 'stone'
  if (y < 63) return 'stone'
  if (y === 63) return 'grass_block'
  return 'air'
}

// 1-wide shaft at x=2,z=0 (cells y=61..63 air, stone floor y=60), flat
// feet-64 ground everywhere else. The shaft bottom (2,61,0) has all 4
// feet-level sides solid: landing there wedges the body on Paper (o6n).
function shaftNameAt(x, y, z) {
  if (x === 2 && z === 0 && y >= 61 && y <= 63) return 'air'
  if (y < 63) return 'stone'
  if (y === 63) return 'grass_block'
  return 'air'
}

function parkourUps(path, start) {
  const full = [start, ...path]
  return full.filter((p, i) => i > 0 && p.parkour && p.y - full[i - 1].y === 1)
}

describe('jump-up cost penalty (idkcraft-8yy)', () => {
  it('penalises the climb edge, leaves flat edges alone', () => {
    const movements = wiredMovements(makeNameAt(-4, 2))
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    const climb = ns.find((m) => m.x === 1 && m.y === 65 && m.z === 0)
    assert.ok(climb, 'jump-up edge onto the step exists')
    assert.equal(climb.cost, 2 + JUMP_UP_COST)
    const flat = ns.find((m) => m.x === 0 && m.y === 64 && m.z === 1)
    assert.ok(flat, 'flat edge exists')
    assert.equal(flat.cost, 1)
  })

  it('install is idempotent and plain-object safe', () => {
    const movements = wiredMovements(makeNameAt(-4, 2))
    addJumpUpCost(movements) // second install: no double penalty
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    const climb = ns.find((m) => m.x === 1 && m.y === 65 && m.z === 0)
    assert.equal(climb.cost, 2 + JUMP_UP_COST)
    assert.doesNotThrow(() => addJumpUpCost({ allowSprinting: false }))
    assert.doesNotThrow(() => addJumpUpCost(null))
  })

  it('planner detours through the gap instead of climbing', () => {
    const nameFn = makeNameAt(-4, 2)
    const raw = plan(rawMovements(nameFn), 0, 64, 0, 3, 64, 0)
    assert.equal(raw.status, 'success')
    assert.ok(climbs(raw.path, { x: 0, y: 64, z: 0 }) >= 1, 'unpatched planner takes the climb')
    const fixed = plan(wiredMovements(nameFn), 0, 64, 0, 3, 64, 0)
    assert.equal(fixed.status, 'success')
    assert.equal(climbs(fixed.path, { x: 0, y: 64, z: 0 }), 0, `patched planner avoids the climb, got: ${fixed.path.map((p) => `${p.x},${p.y},${p.z}`).join(' ')}`)
  })

  it('parkour-up takes the penalty and the planner walks around the pit', () => {
    const rawNs = rawMovements(pitNameAt).getNeighbors(new Move(0, 64, 0, 0, 0))
    const rawLeap = rawNs.find((m) => m.parkour && m.x === 2 && m.y === 65 && m.z === 0)
    assert.ok(rawLeap, 'setup offers the pit leap')
    const fixedNs = wiredMovements(pitNameAt).getNeighbors(new Move(0, 64, 0, 0, 0))
    const fixedLeap = fixedNs.find((m) => m.parkour && m.x === 2 && m.y === 65 && m.z === 0)
    assert.equal(fixedLeap.cost, rawLeap.cost + JUMP_UP_COST)
    const start = { x: 0, y: 64, z: 0 }
    const raw = plan(rawMovements(pitNameAt), 0, 64, 0, 4, 64, 0)
    assert.equal(raw.status, 'success')
    assert.ok(parkourUps(raw.path, start).length >= 1, 'unpatched planner leaps the pit')
    const fixed = plan(wiredMovements(pitNameAt), 0, 64, 0, 4, 64, 0)
    assert.equal(fixed.status, 'success')
    assert.equal(parkourUps(fixed.path, start).length, 0,
      `patched planner avoids the pit leap, got: ${fixed.path.map((p) => `${p.x},${p.y},${p.z}${p.parkour ? 'P' : ''}`).join(' ')}`)
  })

  it('forced staircase climb stays within a node budget (no A* flood)', () => {
    const nameFn = stairNameAt(10)
    const raw = plan(rawMovements(nameFn), 0, 64, 0, 25, 74, 0, 2)
    assert.equal(raw.status, 'success')
    const fixed = plan(wiredMovements(nameFn), 0, 64, 0, 25, 74, 0, 2)
    assert.equal(fixed.status, 'success')
    assert.ok(fixed.visitedNodes < 40 * raw.visitedNodes,
      `patched visited ${fixed.visitedNodes} vs raw ${raw.visitedNodes}`)
  })

  it('wedged landings take the penalty, open and unknown landings do not', () => {
    const movements = wiredMovements(shaftNameAt)
    // drop-down move landing at the shaft bottom (2,61,0): 4 solid sides
    const from = new Move(1, 64, 0, 0, 0)
    const down = movements.getNeighbors(from).find((m) => m.x === 2 && m.y === 61 && m.z === 0)
    assert.ok(down, 'drop-down move into the shaft exists')
    const rawDown = rawMovements(shaftNameAt).getNeighbors(from)
      .find((m) => m.x === 2 && m.y === 61 && m.z === 0)
    assert.equal(down.cost, rawDown.cost + WEDGE_COST)
    // flat move onto open ground: no penalty
    const flat = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
      .find((m) => m.x === 0 && m.y === 64 && m.z === 1)
    assert.equal(flat.cost, 1)
  })

  it('carpeted floors are not wedges (thin blocks fail open)', () => {
    const carpetAt = (x, y, z) => {
      if (y === 64 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'moss_carpet'
      if (y < 63) return 'stone'
      if (y === 63) return 'grass_block'
      return 'air'
    }
    const movements = wiredMovements(carpetAt)
    const flat = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
      .find((m) => m.x === 1 && m.y === 64 && m.z === 0)
    assert.ok(flat, 'flat step across carpet exists')
    assert.equal(flat.cost, 1)
  })

  it('unknown side cells fail open (no penalty at chunk edge)', () => {
    const base = worldBot(shaftNameAt)
    const nullBot = { ...base, blockAt: (p) => (p.x === 3 && p.y === 61 && p.z === 0 ? null : base.blockAt(p)) }
    const mk = (wired) => {
      const m = new Movements(nullBot)
      m.allowSprinting = false
      if (wired) {
        const ticker = createTicker({ bot: nullBot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
        ticker.setMovements(m)
      }
      return m
    }
    const from = new Move(1, 64, 0, 0, 0)
    const fixed = mk(true).getNeighbors(from).find((m) => m.x === 2 && m.y === 61 && m.z === 0)
    const raw = mk(false).getNeighbors(from).find((m) => m.x === 2 && m.y === 61 && m.z === 0)
    assert.ok(fixed && raw, 'shaft drop exists on both stacks')
    assert.equal(fixed.cost, raw.cost)
  })

  it('dug descents skip the wedge charge (no A* flood underground)', () => {
    const dirtAt = (x, y, z) => (y <= 63 ? 'dirt' : 'air')
    const raw = plan(rawMovements(dirtAt), 6, 64, 0, 6, 56, 0, 1)
    assert.equal(raw.status, 'success')
    const fixed = plan(wiredMovements(dirtAt), 6, 64, 0, 6, 56, 0, 1)
    assert.equal(fixed.status, 'success')
    assert.ok(fixed.visitedNodes < 3 * raw.visitedNodes,
      `wired visited ${fixed.visitedNodes} vs raw ${raw.visitedNodes}`)
  })

  it('forced shaft descent still plans (penalty never forbids)', () => {
    const mk = (wired) => {
      const m = wired ? wiredMovements(shaftNameAt) : rawMovements(shaftNameAt)
      // walls unbreakable: the shaft is the only way down (corner.test.js shape)
      m.blocksCantBreak.add(mcData.blocksByName.stone.id)
      return m
    }
    const fixed = plan(mk(true), 0, 64, 0, 2, 61, 0)
    assert.equal(fixed.status, 'success')
    const last = fixed.path[fixed.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [2, 61, 0])
  })

  it('forced climb still plans (penalty never forbids)', () => {
    const fixed = plan(wiredMovements(makeNameAt(-8, 8)), 0, 64, 0, 3, 64, 0)
    assert.equal(fixed.status, 'success')
    assert.ok(climbs(fixed.path, { x: 0, y: 64, z: 0 }) >= 1, 'no flat alternative: still climbs')
  })
})
