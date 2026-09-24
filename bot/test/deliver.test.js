'use strict'

// Deliver step (idkcraft-atl.2): haul to the visible player, 3a7 hold when
// unseen, refusals when empty or nobody online.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const deliver = require('../src/behaviours/deliver')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot() {
  const inv = []
  const calls = { setGoal: 0, goals: [], tossed: [] }
  const chats = []
  const bot = {
    calls, chats, inv,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    registry: { blocksByName: {}, itemsByName: { coal: { id: 1 }, oak_log: { id: 2 } } },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => inv },
    greetCalls: [],
    toss: async (id, _, n) => {
      const names = Object.keys(bot.registry.itemsByName)
      const name = names.find((k) => bot.registry.itemsByName[k].id === id)
      for (let i = inv.length - 1; i >= 0 && n > 0; i--) {
        if (inv[i].name === name) {
          const take = Math.min(inv[i].count, n)
          inv[i].count -= take
          n -= take
          calls.tossed.push(`${take} ${name}`)
          if (inv[i].count <= 0) inv.splice(i, 1)
        }
      }
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function ctxWithHaul(haul) {
  return { lastGoalKey: '', stepStatus: 'running', haul: { ...haul }, greeter: { greetOnArrival: () => {} } }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('playerStatus', () => {
  it('near beats far: entity visible wins over bare online name', () => {
    const bot = mockBot()
    bot.players = {
      Far: { username: 'Far', entity: null },
      P: { username: 'P', entity: { position: pos(30, 64, 0) } },
    }
    const ps = deliver.playerStatus(bot)
    assert.equal(ps.level, 'near')
    assert.equal(ps.name, 'P')
  })

  it('far when online without entity, none when alone, self skipped', () => {
    const bot = mockBot()
    bot.players = { IdkBot: { username: 'IdkBot', entity: { position: pos(0, 64, 0) } } }
    assert.equal(deliver.playerStatus(bot).level, 'none')
    bot.players.P = { username: 'P', entity: null }
    const ps = deliver.playerStatus(bot)
    assert.equal(ps.level, 'far')
    assert.equal(ps.entity, null)
  })

  it('picks the nearest entity', () => {
    const bot = mockBot()
    bot.players = {
      A: { username: 'A', entity: { position: pos(20, 64, 0) } },
      B: { username: 'B', entity: { position: pos(5, 64, 0) } },
    }
    assert.equal(deliver.playerStatus(bot).name, 'B')
  })
})

describe('haul bookkeeping', () => {
  it('addHaul merges, haulLive prunes to the live inventory', () => {
    const ctx = {}
    deliver.addHaul(ctx, { coal: 5, oak_log: 2 })
    deliver.addHaul(ctx, { coal: 3 })
    assert.deepEqual(ctx.haul, { coal: 8, oak_log: 2 })
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 3 })
    const live = deliver.haulLive(bot, ctx)
    assert.deepEqual(live.items, { coal: 3 })
    assert.equal(live.total, 3)
    assert.equal(deliver.haulTotal(bot, ctx), 3)
  })
})

describe('deliver behaviour', () => {
  it('walks to the visible player and tosses the haul with a brought line', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.calls.tossed, ['2 coal'])
    assert.ok(bot.chats.some((m) => m === 'brought 2 coal'), JSON.stringify(bot.chats))
    assert.deepEqual(ctx.haul, { coal: 0 })
    assert.ok(bot.calls.goals.includes('GoalFollow'))
  })

  it('unseen player: waits at spawn, says once, keeps the haul', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    deliver(bot, ctx, null, {})
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(bot.calls.goals.includes('GoalNear'))
    const says = bot.chats.filter((m) => m.includes("I can't see you"))
    assert.equal(says.length, 1)
    assert.ok(says[0].includes('2 coal'))
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('resumes the approach when the player reappears', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    bot.players.P.entity = { position: pos(2, 64, 0) }
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
  })

  it('nobody online: failed:no-player, haul kept', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-player')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('empty haul: failed:empty', () => {
    const bot = mockBot()
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({})
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:empty')
  })

  it('registers in BEHAVIOURS under deliver', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.deliver, deliver)
  })
})

describe('reviewer atl.2 r2: unreachable player fails, haul kept', () => {
  // Real path, no constructed stuck fact (revmux 01: ctx.stuck never reaches
  // a goal step — the ticker routes stuck ticks to recover). Static body,
  // visible player out of toss range: follow paces, the step counts its own
  // fruitless ticks and fails with the haul kept.
  it('20 fruitless walk ticks -> failed:no-path, haul kept for retry', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 5 })
    bot.players.P = { username: 'P', entity: { position: pos(30, 64, 0) } }
    const ctx = ctxWithHaul({ coal: 5 })
    for (let i = 0; i < 25; i++) deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-path')
    assert.deepEqual(ctx.haul, { coal: 5 })
    assert.ok(bot.chats.join(' ').match(/holding|can't reach/), 'owner hears the hold')
  })

  it('a chase never trips it: displacement resets the count', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 5 })
    bot.players.P = { username: 'P', entity: { position: pos(30, 64, 0) } }
    const ctx = ctxWithHaul({ coal: 5 })
    for (let i = 0; i < 25; i++) {
      bot.entity.position = pos(i + 1, 64, 0) // closing on the player
      deliver(bot, ctx, null, {})
      if (ctx.stepStatus && ctx.stepStatus.startsWith('failed:')) break
    }
    assert.ok(!ctx.stepStatus || !ctx.stepStatus.startsWith('failed:'), 'chase keeps running')
  })
})
