'use strict'

// idkcraft-neuc.25: water-death discs reach the Baritone body. v1 steers
// A* through danger.addPathCost's getNeighbors wrap, which Baritone never
// calls, so v2 walked through the drowned shore (rig DROWNED-SHORE). The
// adapter now sends the live discs with every goal command; no disc = the
// old {command} wire. Movements wired the production way (body.movementsFor).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const { Movements, goals } = require('mineflayer-pathfinder')
const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const body = require('../src/body')
const danger = require('../src/danger')

function wired(marks, feet) {
  const transport = new FakeTransport({ pos: { x: feet[0], y: feet[1], z: feet[2], yaw: 0, pitch: 0, onGround: true } })
  const bot = new BaritoneBot(transport, { Vec3, registry: mcData, username: 'IdkBody' })
  bot.entity.position = new Vec3(...feet)
  const ctx = { danger: { spots: marks } }
  ctx.movements = new Movements({ registry: mcData, game: { minY: -64 }, entity: bot.entity, pathfinder: {} })
  bot.pathfinder.setMovements(ctx.movements)
  body.movementsFor('idle', bot, ctx)
  const sent = []
  const orig = transport.call.bind(transport)
  transport.call = async (method, params) => {
    if (method === 'baritone.cmd' && /^#(goto|near)/.test(params.command)) sent.push(params)
    return orig(method, params)
  }
  return { bot, sent }
}

const water = (x, z) => ({ x, y: 63, z, at: Date.now(), r: danger.WATER_RADIUS })

describe('danger discs on the Baritone body (neuc.25)', () => {
  it('a goal across a live water disc carries the disc', () => {
    const { bot, sent } = wired([water(0.5, 0.5)], [-60.5, 64, 0.5])
    bot.pathfinder.setGoal(new goals.GoalXZ(60, 0))
    assert.deepEqual(sent, [{ command: '#goto 60 0', avoid: [[0.5, 0.5, danger.WATER_RADIUS]] }])
  })

  it('feet or goal inside the disc shrink it to the deeper ring (v1 parity)', () => {
    const { bot, sent } = wired([water(0.5, 0.5)], [-19.5, 64, 0.5]) // feet ring 20
    bot.pathfinder.setGoal(new goals.GoalNear(10, 64, 0, 1)) // goal ring 10
    assert.deepEqual(sent[0].avoid, [[0.5, 0.5, 10]])
  })

  it('no live wide mark keeps the old {command} wire', () => {
    const pit = { x: 0.5, y: 63, z: 0.5, at: Date.now() } // default r=6: recover's, not the path cost's
    const { bot, sent } = wired([pit], [-60.5, 64, 0.5])
    bot.pathfinder.setGoal(new goals.GoalXZ(60, 0))
    assert.deepEqual(sent, [{ command: '#goto 60 0' }])
  })

  it('a Movements without the danger hook (unit mocks) keeps the old wire', () => {
    const transport = new FakeTransport({ pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true } })
    const bot = new BaritoneBot(transport, { Vec3, registry: mcData, username: 'IdkBody' })
    bot.pathfinder.setMovements({ canDig: true })
    const sent = []
    const orig = transport.call.bind(transport)
    transport.call = async (method, params) => { if (method === 'baritone.cmd' && params.command === '#goto 9 9') sent.push(params); return orig(method, params) }
    bot.pathfinder.setGoal(new goals.GoalXZ(9, 9))
    assert.deepEqual(sent, [{ command: '#goto 9 9' }])
  })

  it('v1: dangerDiscs is the getNeighbors cost\'s own disc list', () => {
    const m = { getNeighbors: () => [] }
    const ctx = { danger: { spots: [water(0.5, 0.5)] } }
    danger.addPathCost(m, ctx, { entity: { position: new Vec3(-60, 64, 0) }, pathfinder: { goal: new goals.GoalXZ(60, 0) } })
    assert.deepEqual(m.dangerDiscs({ x: -60, z: 0 }, { x: 60.5, z: 0.5 }), [{ x: 0.5, z: 0.5, lim: danger.WATER_RADIUS }])
    assert.deepEqual(m.dangerDiscs({ x: -10, z: 0.5 }, null), [{ x: 0.5, z: 0.5, lim: 10 }])
  })
})
