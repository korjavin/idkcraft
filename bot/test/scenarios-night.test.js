'use strict'

// E2E scenarios: owner-facing night behaviour through work-mode ticks.
// rw4.14: one dawn line summarising the night (deaths + banked haul +
// position) at the end of the stay episode.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker } = require('../src/index')
const { fakeClock, record, golden } = require('./characterize-util')

const SITE = { x: 10, y: 64, z: 20 }
const DOOR = { x: 11, y: 64, z: 20 }
const OUTSIDE = { x: 11, y: 64, z: 19 }
const INSIDE = { x: 11, y: 64, z: 21 }

function nightBot() {
  const chats = []
  const state = { doorOpen: false }
  const bot = {
    chats,
    username: 'IdkBot',
    players: {}, // autonomous night: nobody online
    entities: {},
    health: 20,
    food: 20,
    entity: { position: { x: 12, y: 64, z: 22 }, onGround: true },
    time: { timeOfDay: 12500, day: 5 }, // dusk
    pathfinder: {
      goal: null,
      movements: { canDig: true },
      isMoving: () => false,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
    },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (fx === DOOR.x && (fy === DOOR.y || fy === DOOR.y + 1) && fz === DOOR.z) {
        return { name: 'oak_door', position: { x: fx, y: fy, z: fz }, getProperties: () => ({ open: state.doorOpen }) }
      }
      return { name: 'air', boundingBox: 'empty', position: { x: fx, y: fy, z: fz } }
    },
    activateBlock: async () => { state.doorOpen = !state.doorOpen },
    chat: (m) => { chats.push(String(m)) },
    lookAt() {},
    setControlState() {},
    clearControlStates() {},
    getControlState: () => false,
  }
  return bot
}

function ctxHome() {
  return {
    site: { ...SITE },
    built: true,
    interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 12, y: 65, z: 22 } },
  }
}

describe('rw4.14: one dawn line tells the night', () => {
  it('dusk hold -> 2 deaths + 14 coal overnight -> dawn report at close', async () => {
    // The owner wakes to a silent log; the stay episode ends with one
    // line: survived or not, deaths, banked haul, position. Deaths arrive
    // through the ticker seam (onDeath->noteDeath is unit-pinned); haul
    // merges the way forage finish merges it.
    const bot = nightBot()
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
      autonomous: true,
    })
    const ctx = bot._tickerCtx
    const journal = record(bot, ctx, { ticker })
    ctx.work = true
    ctx.home = ctxHome()
    ctx.deaths = 5 // previous days: the tally must snapshot, not lifetime-sum
    ctx.haul = { coal: 20 }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const r1 = await ticker.tick() // dusk: stay holds, tally snapshots
      assert.equal(r1.decision.action, 'stay')
      assert.ok(ctx.night && !ctx.night.reported, 'tally open')
      bot.time.timeOfDay = 14000 // night falls
      for (let i = 0; i < 3; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'stay', 'night holds')
      }
      ticker.noteDeath()
      ticker.noteDeath()
      ctx.haul = { coal: 34 } // the night shift banks 14 onto 20
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'stay')
      assert.ok(!bot.chats.some((m) => m.startsWith('night: ')), 'no report before dawn')
      bot.time.timeOfDay = 1000 // dawn: open, exit, close
      await ticker.tick() // open: toggle the closed door
      await ticker.tick() // door open while inside: exit starts
      bot.entity.position = { ...OUTSIDE } // stepped out
      await ticker.tick() // exit arrives -> close
      now += 5000
      await ticker.tick() // close the door
      const r3 = await ticker.tick() // shut -> done + the one line
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(r3.decision.action, 'stay')
      assert.deepEqual(
        bot.chats.filter((m) => m.startsWith('night: ')),
        ['night: survived, 2 deaths, banked 14 coal, at home; back to work'],
        `exactly one dawn line: ${bot.chats.join(' | ')}`)
      assert.equal(ctx.night.reported, true, 'tally closed')
      golden('scenarios-night', 'rw4.14 dusk hold -> deaths -> dawn report', journal.events)
    } finally {
      Date.now = realNow
      ticker.destroy()
    }
  })
})
