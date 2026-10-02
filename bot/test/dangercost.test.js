'use strict'

// Danger path cost (idkcraft-zj2p): a water-death disc (r=32) costs A*
// moves, so walkers route around the drowned lake instead of re-walking
// its shore. Real Movements + A* on a flat fake world, the cost installed
// through the production site (body.movementsFor).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const body = require('../src/body')
const danger = require('../src/danger')

function nameAt(x, y) {
  if (y < 63) return 'stone'
  if (y === 63) return 'grass_block'
  return 'air'
}

function worldBot() {
  return {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null },
    blockAt: (p) => {
      const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const b = Block.fromStateId(mcData.blocksByName[nameAt(q.x, q.y, q.z)].minStateId, 0)
      b.position = q
      return b
    },
  }
}

// Movements wired the production way: the lease installs the cost.
function setup(marks, feet) {
  const bot = worldBot()
  if (feet) bot.entity.position = new Vec3(...feet)
  const ctx = { danger: { spots: marks } }
  ctx.movements = new Movements(bot)
  body.movementsFor('idle', bot, ctx)
  return ctx
}

function plan(ctx, from, to) {
  const goal = new goals.GoalBlock(to[0], to[1], to[2])
  return new AStar(new Move(from[0], from[1], from[2], 0, 0), ctx.movements, goal, 30000, 90000).compute()
}

const closest = (path, s) => Math.min(...path.map((n) => Math.hypot(n.x + 0.5 - s.x, n.z + 0.5 - s.z)))

describe('danger path cost (zj2p)', () => {
  const W = 40
  it('routes around a live water disc on open ground', () => {
    const mark = { x: 0.5, y: 63, z: 0.5, at: Date.now(), r: danger.WATER_RADIUS }
    const r = plan(setup([mark]), [-W, 64, 0], [W, 64, 0])
    assert.equal(r.status, 'success')
    assert.ok(closest(r.path, mark) > danger.WATER_RADIUS, `path entered the disc: ${closest(r.path, mark).toFixed(1)}`)
  })

  it('still plans a target inside the disc (cost, not a ban)', () => {
    const mark = { x: 0.5, y: 63, z: 0.5, at: Date.now(), r: danger.WATER_RADIUS }
    const r = plan(setup([mark], [-W + 0.5, 64, 0.5]), [-W, 64, 0], [-26, 64, 0])
    assert.equal(r.status, 'success')
  })

  it('a disc holding the feet past the rim band costs nothing (straight walk out)', () => {
    const mark = { x: 0.5, y: 63, z: 0.5, at: Date.now(), r: danger.WATER_RADIUS }
    const r = plan(setup([mark], [-9.5, 64, 0.5]), [-10, 64, 0], [W, 64, 0])
    assert.equal(r.status, 'success')
    assert.ok(r.path.every((n) => n.z === 0), 'straight leg expected')
  })

  it('the rim band stays costed (a partial path one step in keeps the detour)', () => {
    const mark = { x: 0.5, y: 63, z: 0.5, at: Date.now(), r: danger.WATER_RADIUS }
    const r = plan(setup([mark], [-30.5, 64, 0.5]), [-W, 64, 0], [W, 64, 0])
    assert.equal(r.status, 'success')
    assert.ok(closest(r.path, mark) > danger.WATER_RADIUS, `path entered the disc: ${closest(r.path, mark).toFixed(1)}`)
  })

  it('ignores expired marks and narrow pit marks (straight line)', () => {
    const stale = { x: 0.5, y: 63, z: 0.5, at: Date.now() - danger.TTL_MS - 1000, r: danger.WATER_RADIUS }
    const pit = { x: 0.5, y: 63, z: 10.5, at: Date.now() }
    for (const m of [stale, pit]) {
      const r = plan(setup([m]), [-W, 64, 0], [W, 64, 0])
      assert.equal(r.status, 'success')
      assert.ok(r.path.every((n) => n.z === 0), 'straight leg expected')
    }
  })

  it('installs once per Movements and skips flag-only mocks', () => {
    const ctx = setup([])
    const wrapped = ctx.movements.getNeighbors
    body.movementsFor('idle', worldBot(), ctx)
    assert.equal(ctx.movements.getNeighbors, wrapped)
    const mock = { canDig: true }
    danger.addPathCost(mock, ctx)
    assert.equal(mock._dangerCostInstalled, undefined)
  })
})
