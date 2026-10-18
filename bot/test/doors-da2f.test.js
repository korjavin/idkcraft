'use strict'

// idkcraft-da2f: the v2 house-doorway wedge. A shut north-wall house door
// (facing=north) has its panel on the cell's south (interior) edge, so a
// body walked in from the doorstep stands in the door cell with the panel
// ahead. Baritone clicks a door only in the cell it walks INTO, and the
// bridge no-ops door clicks mid-walk, so the craft/beds house-table walk
// (#goto the interior cell) wedged there: gallery rig, recover feet=oak_door
// head=oak_door at 261.5,70,358.5. doors.js opens a shut hand door under the
// feet after the gate dwell, v2 only (v1 keeps openNextDoor's seed).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const doors = require('../src/doors')

// The rig door after raise-house (bot/tools/raise-house.js:69): lower half at
// the feet, shut. Body pressed on the panel: z 358.5 (panel at 358.8125 minus
// the 0.3 half-body), the recover line's pos.
function wedgedBot({ moving = true, open = false, name = 'oak_door' } = {}) {
  const bot = {
    // mirrors the v2 bridge pathfinder: isMoving: () => !!self._pathing (bridge/index.js:372)
    pathfinder: { isMoving: () => moving },
    entity: { position: new Vec3(261.5, 70, 358.5) },
    toggles: 0,
    // bridge chunk cache read (bridge/chunks.js blockAt): name + getProperties like prismarine-block
    blockAt: (p) => {
      const at = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (at.x === 261 && at.y === 70 && at.z === 358) {
        return { name, position: at, getProperties: () => ({ open, facing: 'north', half: 'lower', hinge: 'left' }) }
      }
      return { name: 'air', position: at, getProperties: () => ({}) }
    },
    // bridge/look.js:163 activateBlock (async, interact.block)
    activateBlock: async () => { bot.toggles++ },
  }
  return bot
}

function run(bot, steps) {
  const ctx = {}
  const log = console.log
  const realNow = Date.now
  let now = 1e6
  Date.now = () => now
  console.log = () => {}
  try {
    for (const dt of steps) { doors.doorShutFast(bot, ctx); now += dt }
  } finally {
    console.log = log
    Date.now = realNow
  }
  return ctx
}

describe('v2 doorway wedge: shut door under the feet (idkcraft-da2f)', () => {
  const prev = process.env.BOT_BODY
  afterEach(() => { if (prev === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prev })

  it('v2: a shut hand door under the feet is opened once, after the dwell', () => {
    process.env.BOT_BODY = 'baritone'
    const bot = wedgedBot()
    const ctx = {}
    const log = console.log
    const realNow = Date.now
    let now = 1e6
    Date.now = () => now
    console.log = () => {}
    try {
      doors.doorShutFast(bot, ctx)
      now += 500
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 0, 'clicked inside the dwell')
      now += 600
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'wedge not opened')
      now += 300
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'double toggle')
    } finally {
      console.log = log
      Date.now = realNow
    }
  })

  it('v2: an open door, an iron door or an idle body is never clicked', () => {
    process.env.BOT_BODY = 'baritone'
    for (const opts of [{ open: true }, { name: 'iron_door' }, { moving: false }]) {
      const bot = wedgedBot(opts)
      run(bot, [600, 600, 600, 600, 600])
      assert.equal(bot.toggles, 0, JSON.stringify(opts))
    }
  })

  it('v1 (no BOT_BODY): zero diff, the under-feet door is not this path', () => {
    delete process.env.BOT_BODY
    const bot = wedgedBot()
    run(bot, [600, 600, 600, 600, 600])
    assert.equal(bot.toggles, 0)
  })
})
