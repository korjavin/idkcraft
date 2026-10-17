// idkcraft-neuc.48: the door kick — never path-start inside a closed door
// cell. The REAL BaritoneBot adapter runs unchanged against FakeTransport
// fixtures shaped like the mod's wire (PROTOCOL.md); the chunk cache is
// real (prismarine blocks, so door open/closed reads are honest).
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const Vec3 = require('vec3')
const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { goals } = require('mineflayer-pathfinder')
const registry = require('minecraft-data')('26.1.2')
const Block = require('prismarine-block')(registry)

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// The DOOR-ROOM fingerprint: feet + head in oak_door, standing on stone.
const DOOR_POS = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, onGround: true, vel: { x: 0, y: 0, z: 0 } }
function doorWorld(doorName = 'oak_door') {
  return {
    '0,63,0': 'stone',
    '0,64,0': doorName,
    '0,65,0': doorName,
  }
}

async function kickBot(blocks) {
  const transport = new FakeTransport({ pos: { ...DOOR_POS }, blocks })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  return { transport, bot }
}

// An open lower-half state id for the door (fixtures only carry names,
// which always decode to the closed defaultState).
function openDoorStateId(name) {
  const entry = registry.blocksByName[name]
  for (let s = entry.minStateId; s <= entry.maxStateId; s++) {
    const props = Block.fromStateId(s, 0).getProperties()
    if (props.half === 'lower' && props.open === true) return s
  }
  throw new Error(`no open state for ${name}`)
}

describe('bridge door kick (idkcraft-neuc.48)', () => {
  let transport
  let bot
  afterEach(async () => { if (bot) await bot.stop(); bot = null; transport = null })

  it('kicks a closed door at the feet before the goal cmd', async () => {
    ;({ transport, bot } = await kickBot(doorWorld()))
    assert.equal(bot.blockAt(new Vec3(0, 64, 0)).name, 'oak_door')
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick(200) // pause + interact + resume + the post-resume status wait
    assert.deepEqual(transport.state.blockInteracts, [
      { x: 0, y: 64, z: 0, face: 'up', cursor: { x: 0.5, y: 0.5, z: 0.5 }, sneak: false },
    ])
    assert.equal(transport.state.baritone, '#goto 10 64 10') // the goal still goes out, after the kick
    assert.equal(transport.state.baritoneSeq, 1)
    assert.equal(bot._goalId, 1)
  })

  it('sends the goal untouched on open ground', async () => {
    ;({ transport, bot } = await kickBot({ '0,63,0': 'stone' }))
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick()
    assert.equal((transport.state.blockInteracts || []).length, 0)
    assert.equal(transport.state.baritone, '#goto 10 64 10')
  })

  it('leaves an open door alone', async () => {
    ;({ transport, bot } = await kickBot(doorWorld()))
    transport.inject('block.update', { x: 0, y: 64, z: 0, stateId: openDoorStateId('oak_door') })
    assert.equal(bot.blockAt(new Vec3(0, 64, 0)).getProperties().open, true)
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick()
    assert.equal((transport.state.blockInteracts || []).length, 0)
    assert.equal(transport.state.baritone, '#goto 10 64 10')
  })

  it('leaves iron doors alone (no hand toggle exists)', async () => {
    ;({ transport, bot } = await kickBot(doorWorld('iron_door')))
    assert.equal(bot.blockAt(new Vec3(0, 64, 0)).getProperties().open, false)
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick()
    assert.equal((transport.state.blockInteracts || []).length, 0)
    assert.equal(transport.state.baritone, '#goto 10 64 10')
  })

  it('a stop during the kick stays stopped (no revived walk)', async () => {
    ;({ transport, bot } = await kickBot(doorWorld()))
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    bot.pathfinder.stop() // before the kick resolves
    await tick(200)
    assert.equal(transport.state.baritoneSeq || 0, 0) // the wedged goal cmd never went out
    assert.equal(bot.pathfinder.isMoving(), false)
  })

  it('one toggle per cell per window, then retries', async () => {
    ;({ transport, bot } = await kickBot(doorWorld()))
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick(200)
    assert.equal(transport.state.blockInteracts.length, 1)
    // Still wedged (the panel never opened): an immediate re-plan stays quiet …
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    transport.state.pos = { ...DOOR_POS }
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick(200)
    assert.equal(transport.state.blockInteracts.length, 1)
    // … but past the window it retries.
    bot._doorKickAt = 0
    bot.pathfinder.setGoal(new goals.GoalBlock(10, 64, 10))
    await tick(200)
    assert.equal(transport.state.blockInteracts.length, 2)
  })
})
