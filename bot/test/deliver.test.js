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

  it('follow-parked at 3.6 neither fails nor waits: satisfied follow tosses', async () => {
    // Revmux 02: GoalFollow(3) satisfaction is floored-cell based, so the
    // executor can legitimately rest at true distance ~3.6 > TOSS_RANGE.
    // That is arrival, not no-path: toss and done, never failed:no-path.
    const bot = mockBot()
    bot.entity.position = pos(7.3, 64, 0)
    bot.inv.push({ name: 'coal', count: 5 })
    bot.players.P = { username: 'P', entity: { position: pos(10.9, 64, 0.5) } }
    const ctx = ctxWithHaul({ coal: 5 })
    for (let i = 0; i < 25; i++) {
      deliver(bot, ctx, null, {})
      await tick()
      if (ctx.stepStatus && ctx.stepStatus !== 'running') break
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.join(' ').includes('brought 5 coal'))
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

describe('deliver toss failure (idkcraft-haj)', () => {
  it('failed:toss when bot.toss is missing, haul kept', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    delete bot.toss
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'failed:toss')
    assert.deepEqual(ctx.haul, { coal: 2 }, 'haul kept for the retry')
    assert.ok(bot.chats.some((m) => m === 'could not toss coal'), JSON.stringify(bot.chats))
  })

  it('failed:toss when the registry lacks the item', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'diamond', count: 1 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ diamond: 1 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'failed:toss')
    assert.deepEqual(ctx.haul, { diamond: 1 })
    assert.ok(bot.chats.some((m) => m === 'could not toss diamond'), JSON.stringify(bot.chats))
  })

  it('failed:toss when the toss throws, haul kept', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    bot.toss = async () => { throw new Error('window busy') }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'failed:toss')
    assert.deepEqual(ctx.haul, { coal: 2 })
    assert.deepEqual(bot.calls.tossed, [])
  })

  it('partial toss still banks what landed', async () => {
    // One kind throws mid-toss: the rest lands, done names what arrived,
    // the failed kind stays in the haul for the next deliver.
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.inv.push({ name: 'oak_log', count: 1 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const origToss = bot.toss.bind(bot)
    bot.toss = async (id, slot, n) => {
      if (id === 2) throw new Error('stuck')
      return origToss(id, slot, n)
    }
    const ctx = ctxWithHaul({ coal: 2, oak_log: 1 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'brought 2 coal'), JSON.stringify(bot.chats))
    assert.deepEqual(ctx.haul, { coal: 0, oak_log: 1 })
  })

  it('kind vanishing mid-toss-loop is skipped, rest banks', async () => {
    // Later kinds are counted after earlier kinds' awaits: eat reflex or
    // death mid-toss zeroes the count, the kind is skipped, the rest lands.
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.inv.push({ name: 'oak_log', count: 1 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const origToss = bot.toss.bind(bot)
    bot.toss = async (id, slot, n) => {
      const r = await origToss(id, slot, n)
      if (id === 1) {
        const i = bot.inv.findIndex((x) => x.name === 'oak_log')
        if (i >= 0) bot.inv.splice(i, 1) // eaten while the coal toss landed
      }
      return r
    }
    const ctx = ctxWithHaul({ coal: 2, oak_log: 1 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'brought 2 coal'), JSON.stringify(bot.chats))
    assert.deepEqual(ctx.haul, { coal: 0, oak_log: 1 })
  })
})

describe('deliver unseen wait placement (idkcraft-haj)', () => {
  function captureGoals(bot) {
    const issued = []
    const rawSet = bot.pathfinder.setGoal.bind(bot.pathfinder)
    bot.pathfinder.setGoal = (g) => { issued.push(g); rawSet(g) }
    return issued
  }

  it('unseen player: waits at the home site with its level', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const issued = captureGoals(bot)
    const ctx = ctxWithHaul({ coal: 2 })
    ctx.home = { site: { x: 100, y: 65, z: 200 } }
    deliver(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deliver-wait:100,200')
    assert.equal(issued.length, 1)
    assert.equal(issued[0].constructor.name, 'GoalNear')
    assert.deepEqual([issued[0].x, issued[0].y, issued[0].z], [100, 65, 200])
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('unseen player: site without y waits at the bot level', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const issued = captureGoals(bot)
    const ctx = ctxWithHaul({ coal: 2 })
    ctx.home = { site: { x: 100, z: 200 } }
    deliver(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deliver-wait:100,200')
    assert.equal(issued[0].y, 64, 'falls back to the bot level')
  })

  it('unseen player: nowhere to wait says the line and holds', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    bot.spawnPoint = null
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    deliver(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 0, 'no wait goal without home or spawn')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.haul, { coal: 2 })
    assert.ok(bot.chats.some((m) => m.includes("I can't see you")), JSON.stringify(bot.chats))
  })
})

describe('deliver robustness edges (idkcraft-haj)', () => {
  it('no position returns without crashing', () => {
    const bot = mockBot()
    bot.entity = null
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
  })

  it('plain-object position still resolves the player', () => {
    const bot = mockBot()
    bot.entity.position = { x: 0, y: 64, z: 0 } // no distanceTo: hypot fallback
    bot.players = { P: { username: 'P', entity: { position: pos(5, 64, 0) } } }
    const ps = deliver.playerStatus(bot)
    assert.equal(ps.level, 'near')
    assert.equal(ps.name, 'P')
  })

  it('throwing floored() still tosses in range', async () => {
    // followSatisfied never throws: a broken floored() reads as not
    // arrived, and true toss range still tosses.
    const bot = mockBot()
    bot.entity.position = Object.assign(pos(0, 64, 0), { floored() { throw new Error('no voxel') } })
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m === 'brought 2 coal'), JSON.stringify(bot.chats))
  })

  it('haulTotal survives a corrupt haul store', () => {
    const bot = mockBot()
    const ctx = {}
    Object.defineProperty(ctx, 'haul', { get() { throw new Error('corrupt') } })
    assert.equal(deliver.haulTotal(bot, ctx), 0)
  })
})

describe('deliver branch edges (idkcraft-haj)', () => {
  it('throwing distanceTo falls back to hypot', () => {
    const bot = mockBot()
    bot.entity.position = {
      x: 0, y: 64, z: 0,
      distanceTo: () => { throw new Error('no voxel') },
    }
    bot.players = { P: { username: 'P', entity: { position: pos(5, 64, 0) } } }
    const ps = deliver.playerStatus(bot)
    assert.equal(ps.level, 'near')
    assert.equal(ps.name, 'P')
  })

  it('addHaul ignores nulls and non-positive gains', () => {
    const ctx = {}
    deliver.addHaul(null, { coal: 1 })
    deliver.addHaul(ctx, null)
    deliver.addHaul(ctx, { coal: 0, dirt: -2 })
    assert.deepEqual(ctx.haul, {})
    deliver.addHaul(ctx, { coal: 2 })
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('zero-count haul prunes to empty', () => {
    const bot = mockBot()
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 0 })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:empty')
  })

  it('null roster entries are skipped', () => {
    const bot = mockBot()
    bot.players = { Ghost: null, P: { username: 'P', entity: { position: pos(5, 64, 0) } } }
    assert.equal(deliver.playerStatus(bot).name, 'P')
  })

  it('malformed site falls back to spawn', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const ctx = ctxWithHaul({ coal: 2 })
    ctx.home = { site: { z: 200 } } // no x: not a site
    deliver(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deliver-wait:0,0')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('spawn point without coords waits nowhere', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    bot.spawnPoint = {}
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, 0)
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('visible deliver works without a greeter', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = { lastGoalKey: '', stepStatus: 'running', haul: { coal: 2 } }
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
  })

  it('second tick while tossing does not double-toss', async () => {
    // The toss stays pending across the second tick (prod: window clicks
    // take ticks), so the second call must hit the tossInFlight latch —
    // with a synchronous mock toss it would take failed:empty instead and
    // the latch would go untested.
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    let release
    const gate = new Promise((r) => { release = r })
    let tossCalls = 0
    const origToss = bot.toss.bind(bot)
    bot.toss = async (id, slot, n) => { tossCalls++; await gate; return origToss(id, slot, n) }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {}) // starts the toss, pending on the gate
    deliver(bot, ctx, null, {}) // latched: must not start a second toss
    assert.equal(tossCalls, 1)
    assert.equal(ctx.stepStatus, 'running')
    release()
    await tick()
    await tick()
    assert.equal(tossCalls, 1)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.calls.tossed, ['2 coal'])
  })

  it('failed:toss when the registry entry lacks an id', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    bot.registry.itemsByName.coal = {}
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'failed:toss')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })


  it('no position resolves nobody even when listed', () => {
    const bot = mockBot()
    bot.entity = null
    bot.players = { P: { username: 'P', entity: { position: pos(5, 64, 0) } } }
    assert.equal(deliver.playerStatus(bot).level, 'none')
  })
})

describe('deliver branches (idkcraft-g9k)', () => {
  it('unfloored position still arrives via the floor fallback, toss lands', async () => {
    // NOTE: the `!node` disjunct (:125) is untestable — node is null only
    // when bp is null, and then d0 is null too, so `arrived` is never read.
    // This pins the Math.floor fallback arm instead (floor -> ceil mutant
    // moves the node out of GoalFollow range and the toss never fires).
    const bot = mockBot()
    const px = 7.9
    bot.entity.position = {
      x: px, y: 64, z: 0,
      distanceTo: (q) => Math.hypot(px - q.x, 64 - q.y, 0 - q.z),
      clone() { return bot.entity.position },
    }
    bot.inv.push({ name: 'coal', count: 5 })
    bot.players = { P: { username: 'P', entity: { position: pos(4.0, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 5 })
    for (let i = 0; i < 25; i++) {
      deliver(bot, ctx, null, {})
      await tick()
      if (ctx.stepStatus && ctx.stepStatus !== 'running') break
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.join(' ').includes('brought 5 coal'))
  })

  it('throwing home store falls back to spawn, then nowhere', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: null } }
    const ctx = ctxWithHaul({ coal: 2 })
    Object.defineProperty(ctx, 'home', { get() { throw new Error('corrupt') } })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deliver-wait:0,0', 'spawn survives a corrupt home')
    assert.equal(ctx.stepStatus, 'running')
    bot.spawnPoint = null
    ctx.lastGoalKey = ''
    const calls = bot.calls.setGoal
    deliver(bot, ctx, null, {})
    assert.equal(bot.calls.setGoal, calls, 'nowhere to wait: no goal')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  // NOTE: no missing-greetOnArrival test: without the entry the call
  // throws into the greeting catch (:221), same outcome as the guard skip
  // (equivalent mutant). 'throwing greeter still delivers' pins the catch.

  it('throwing mover greets as moving', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    bot.pathfinder.isMoving = () => { throw new Error('no driver') }
    const seen = []
    const ctx = ctxWithHaul({ coal: 2 })
    ctx.greeter = { greetOnArrival: (b, name, d, standing) => { seen.push([name, d, standing]) } }
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(seen, [['P', 2, false]], 'unreadable motion assumes moving')
  })

  it('displacement resets the no-path budget', () => {
    // NO_PATH_TICKS still ticks fail the chase; walking keeps it alive.
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(30, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 2 })
    for (let i = 0; i < 6; i++) {
      bot.entity.position = pos(i + 1, 64, 0)
      deliver(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.deliver.noPathTicks, 0)
  })

  it('replaced deliver is not nulled by the late toss', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    let release
    const gate = new Promise((r) => { release = r })
    const origToss = bot.toss.bind(bot)
    bot.toss = async (...a) => { await gate; return origToss(...a) }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {}) // toss starts, pending on the gate
    const f = ctx.deliver
    ctx.deliver = { phase: 'wait' } // step superseded before the toss lands
    release()
    await tick()
    await tick()
    assert.equal(f.tossInFlight, true, 'latch clears only on the live step')
    // Note: completion still nulls ctx.deliver unconditionally — only
    // deliver() itself ever replaces the state (all writes are in this
    // file) and the latch holds re-entry, so no prod path triggers it.
  })

  it('a throwing toss for one kind still delivers the rest', async () => {
    // NOTE: the :242 haul inner-try is an equivalent mutant — dropping it
    // lands in the :243 per-kind catch, which continues the loop the same
    // way. This pins the :243 catch instead: without it the throw rejects
    // the toss task and the step never completes.
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.inv.push({ name: 'oak_log', count: 1 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const origToss = bot.toss.bind(bot)
    bot.toss = async (id, ...rest) => {
      if (id === 1) throw new Error('tray stuck') // coal (id 1) fails
      return origToss(id, ...rest)
    }
    const ctx = ctxWithHaul({ coal: 2, oak_log: 1 })
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.join(' ').includes('brought 1 oak_log'))
    assert.deepEqual(ctx.haul, { coal: 2, oak_log: 0 })
  })
})

describe('deliver live-stock branches (idkcraft-g9k)', () => {
  it('haul without stock fails empty', () => {
    const bot = mockBot()
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 2 }) // nothing in hand
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:empty')
  })

  it('throwing greeter still delivers', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: { position: pos(2, 64, 0) } } }
    const ctx = ctxWithHaul({ coal: 2 })
    ctx.greeter = { greetOnArrival: () => { throw new Error('no gesture') } }
    deliver(bot, ctx, null, {})
    await tick()
    await tick()
    assert.equal(ctx.stepStatus, 'done')
  })

  // NOTE: no null-roster test: `|| {}` (:97) is an equivalent mutant —
  // Object.keys(null) throws into the same catch with the same 'none'.
  it('a roster that throws mid-scan fails no-player', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = new Proxy({}, { ownKeys() { throw new Error('roster corrupt') } })
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-player')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })

  it('positionless entity waits as unseen', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'coal', count: 2 })
    bot.players = { P: { username: 'P', entity: {} } }
    const ctx = ctxWithHaul({ coal: 2 })
    deliver(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deliver-wait:0,0')
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(ctx.haul, { coal: 2 })
  })
})
