'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const { createTicker, handleChat, BEHAVIOURS } = require('../src/index')
const { lookupCommand, helpReply, CHAT_LIMIT } = require('../src/commands')
const { Vec3 } = require('vec3')

const pos = (x, y, z) => new Vec3(x, y, z)

function tickBot({ at = { x: 30, y: 64, z: 30 }, players = { Steve: { username: 'Steve' } }, loadedAt = null, timeOfDay = 6000 } = {}) {
  const chats = []
  const goals = []
  const controls = {}
  let isMoving = false
  const bot = {
    username: 'IdkBot',
    players,
    entities: {},
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    time: { timeOfDay, day: 5 },
    chats,
    controls,
    _goals: goals,
    pathfinder: {
      goal: null,
      movements: { canDig: true, allowSprinting: false },
      setGoal(g) { goals.push(g); bot.pathfinder.goal = g || null },
      stop() { isMoving = false },
      isMoving: () => isMoving,
      setMovements(m) { bot.pathfinder.movements = m },
    },
    inventory: { items: () => [] },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      if (loadedAt && !loadedAt(fx, fy, fz)) return null
      if (fy < 64) return { name: 'dirt', boundingBox: 'block', position: pos(fx, fy, fz) }
      return { name: 'air', boundingBox: 'empty', position: pos(fx, fy, fz) }
    },
    chat(m) { chats.push(String(m)) },
    lookAt() {},
    setControlState(c, v) { controls[c] = !!v },
    clearControlStates() { for (const k in controls) delete controls[k] },
    isSleeping: false,
    wake: async () => { bot.isSleeping = false },
  }
  return bot
}

const idleBrain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
const fightBrain = { async decide() { return { action: 'fight', sprint: false, source: 'stub' } } }

function tickerWith(bot, brain = idleBrain, castle = null) {
  const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
  if (castle) ticker.setCastle(castle)
  return ticker
}

describe("'go home' alias (idkcraft-3qia)", () => {
  it("'go home' behaves identically to 'come home'", () => {
    const cmdCome = lookupCommand('come home')
    const cmdGo = lookupCommand('go home')
    assert.ok(cmdCome)
    assert.equal(cmdCome, cmdGo)

    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    handleChat(bot, ticker, 'Steve', 'go home')
    assert.deepEqual(bot.chats, ['no home yet — say build here'])
  })
})

describe("'go castle' command (idkcraft-3qia)", () => {
  const castleState = {
    site: { x: 50, y: 64, z: 50 },
    rot: 0,
    blueprintVersion: 2,
    phase: 'body',
    blocked: {},
    parked: false,
  }

  it("'go castle' without castle refuses text and arms no order", () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot)
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.deepEqual(bot.chats, ['no castle yet — say build castle'])
    assert.equal(bot._tickerCtx.gocastle, undefined)
  })

  it("'go castle' with castle arms order, reports going to castle", () => {
    const bot = tickBot({ at: { x: 0, y: 64, z: 0 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.deepEqual(bot.chats, ['going to castle'])
    assert.ok(bot._tickerCtx.gocastle)
    assert.equal(bot._tickerCtx.gocastle.phase, 'walk')

    // status report reflects mode
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.some((c) => c.startsWith('going to castle step=')))
  })

  it('far castle with unloaded entrance sets GoalNearXZ, loaded sets GoalNear', async () => {
    const ent = castleMod.entrance(castleState)
    // Entrance chunk not loaded
    const bot = tickBot({
      at: { x: 0, y: 64, z: 0 },
      players: { Steve: { username: 'Steve' } },
      loadedAt: (x, y, z) => Math.hypot(x, z) < 20,
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    await ticker.tick()

    assert.equal(bot._goals.length, 1)
    assert.equal(bot._goals[0].constructor.name, 'GoalNearXZ')
    assert.equal(bot._goals[0].x, ent.x)
    assert.equal(bot._goals[0].z, ent.z)
    assert.equal(bot.pathfinder.movements.canDig, false, 'castle walk never digs')

    // Move closer and load chunks
    bot.entity.position = pos(ent.x - 5, ent.y, ent.z - 5)
    bot.blockAt = (p) => ({ name: 'air', boundingBox: 'empty', position: p })
    await ticker.tick()

    assert.ok(bot._goals.length >= 2)
    const lastGoal = bot._goals[bot._goals.length - 1]
    assert.equal(lastGoal.constructor.name, 'GoalNear')
    assert.equal(lastGoal.x, ent.x)
    assert.equal(lastGoal.y, ent.y)
    assert.equal(lastGoal.z, ent.z)
  })

  it('arrival at entrance apron chats once and holds', async () => {
    const ent = castleMod.entrance(castleState)
    const bot = tickBot({
      at: { x: ent.x + 0.5, y: ent.y, z: ent.z + 0.5 },
      players: { Steve: { username: 'Steve' } },
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.deepEqual(bot.chats, ['going to castle'])

    await ticker.tick()
    assert.ok(bot.chats.includes('at the castle'), bot.chats.join(' | '))
    assert.equal(bot._tickerCtx.gocastle.phase, 'hold')

    const chatCount = bot.chats.length
    await ticker.tick()
    assert.equal(bot.chats.length, chatCount, 'holding still does not repeat chat')
    assert.equal(bot._tickerCtx.gocastle.phase, 'hold')
  })

  it('teleport away while holding silently re-arms walk phase', async () => {
    const ent = castleMod.entrance(castleState)
    const bot = tickBot({
      at: { x: ent.x + 0.5, y: ent.y, z: ent.z + 0.5 },
      players: { Steve: { username: 'Steve' } },
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    await ticker.tick()
    assert.equal(bot._tickerCtx.gocastle.phase, 'hold')

    // Teleport or die away from entrance
    bot.entity.position = pos(0, 64, 0)
    await ticker.tick()
    assert.equal(bot._tickerCtx.gocastle.phase, 'walk')
  })

  it('follow me clears go castle order', () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.equal(bot._tickerCtx.gocastle, null)
  })

  it('go work clears go castle order', () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    handleChat(bot, ticker, 'Steve', 'go work')
    assert.equal(bot._tickerCtx.gocastle, null)
  })

  it('stop clears go castle order', () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    handleChat(bot, ticker, 'Steve', 'stop')
    assert.equal(bot._tickerCtx.gocastle, null)
  })

  it('come home clears go castle order', () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    bot._tickerCtx.home = {
      site: { x: 10, y: 64, z: 20 },
      built: true,
      v: 2,
      interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 15, y: 65, z: 24 } },
    }
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    handleChat(bot, ticker, 'Steve', 'come home')
    assert.equal(bot._tickerCtx.gocastle, null)
  })

  it('night command wakes sleeping body', () => {
    const bot = tickBot({ players: { Steve: { username: 'Steve' } }, timeOfDay: 15000 })
    bot.isSleeping = true
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.equal(bot.isSleeping, false, 'wakeBody called')
  })

  it('fight preempts go castle but order survives', async () => {
    const bot = tickBot({ at: { x: 0, y: 64, z: 0 }, players: { Steve: { username: 'Steve' } } })
    const ticker = tickerWith(bot, fightBrain, { ...castleState })
    const orig = BEHAVIOURS.fight
    let ran = false
    BEHAVIOURS.fight = () => { ran = true }
    try {
      handleChat(bot, ticker, 'Steve', 'go castle')
      assert.ok(bot._tickerCtx.gocastle)

      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(ran, true)
      assert.ok(bot._tickerCtx.gocastle, 'order survives fight preemption')
    } finally {
      BEHAVIOURS.fight = orig
    }
  })

  it('go castle from inside home preserves comehome doorway exit legs', () => {
    const bot = tickBot({
      at: { x: 15, y: 64, z: 15 },
      players: { Steve: { username: 'Steve' } },
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    bot._tickerCtx.home = {
      site: { x: 10, y: 64, z: 10 },
      built: true,
      v: 2,
      interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 19, y: 65, z: 19 } },
    }
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.ok(bot._tickerCtx.comehome)
    assert.equal(bot._tickerCtx.comehome.exiting, false)

    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.comehome, 'comehome preserved for exit')
    assert.equal(bot._tickerCtx.comehome.exiting, true)
    assert.ok(bot._tickerCtx.gocastle, 'gocastle armed')
    assert.equal(bot._tickerCtx.inShelter, true)
  })

  it('find me clears standing go castle and dispatches lead', async () => {
    const bot = tickBot({
      at: { x: 0, y: 64, z: 0 },
      players: { Steve: { username: 'Steve', entity: { position: pos(2, 64, 2) } } },
    })
    bot.registry = { blocksByName: { coal_ore: { id: 16 } } }
    bot.findBlocks = () => [pos(10, 60, 0)]
    bot.blockAt = () => ({ name: 'coal_ore' })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    handleChat(bot, ticker, 'Steve', 'find me coal')
    assert.equal(bot._tickerCtx.gocastle, null, 'gocastle cleared by find me')
    assert.ok(bot._tickerCtx.lead, 'lead order created')

    const r = await ticker.tick()
    assert.equal(r.decision.action, 'lead')
  })

  it('re-arrival at entrance apron after displacement does not repeat chat', async () => {
    const ent = castleMod.entrance(castleState)
    const bot = tickBot({
      at: { x: ent.x + 0.5, y: ent.y, z: ent.z + 0.5 },
      players: { Steve: { username: 'Steve' } },
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    await ticker.tick()
    assert.equal(bot.chats.filter((c) => c === 'at the castle').length, 1)

    // Knockback or displacement
    bot.entity.position = pos(0, 64, 0)
    await ticker.tick()
    assert.equal(bot._tickerCtx.gocastle.phase, 'walk')

    // Return to apron
    bot.entity.position = pos(ent.x + 0.5, ent.y, ent.z + 0.5)
    await ticker.tick()
    assert.equal(bot._tickerCtx.gocastle.phase, 'hold')
    assert.equal(bot.chats.filter((c) => c === 'at the castle').length, 1, 'did not repeat at the castle')
  })

  it('give up after repeated stalls clears gocastle and chats cannot reach the castle', async () => {
    const bot = tickBot({
      at: { x: 0, y: 64, z: 0 },
      players: { Steve: { username: 'Steve' } },
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.gocastle)

    for (let i = 0; i < 35; i++) {
      await ticker.tick()
    }

    assert.equal(bot._tickerCtx.gocastle, null)
    assert.equal(bot._tickerCtx.stepStatus, 'failed:cannot-reach-castle')
    assert.ok(bot.chats.includes('cannot reach the castle'))
  })

  it('go castle while sheltered inside home at night arms door-exit legs', () => {
    const bot = tickBot({
      at: { x: 15, y: 64, z: 15 },
      players: { Steve: { username: 'Steve' } },
      timeOfDay: 14000,
    })
    const ticker = tickerWith(bot, idleBrain, { ...castleState })
    bot._tickerCtx.work = true
    bot._tickerCtx.step = 'stay'
    bot._tickerCtx.home = {
      site: { x: 10, y: 64, z: 10 },
      built: true,
      v: 2,
      interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 19, y: 65, z: 19 } },
    }
    bot._tickerCtx.stay = { phase: 'hold' }
    bot._tickerCtx.inShelter = true

    handleChat(bot, ticker, 'Steve', 'go castle')
    assert.ok(bot._tickerCtx.comehome, 'comehome armed for doorway exit')
    assert.equal(bot._tickerCtx.comehome.exiting, true)
    assert.ok(bot._tickerCtx.gocastle, 'gocastle armed')
    assert.equal(bot._tickerCtx.inShelter, true)
  })
})
