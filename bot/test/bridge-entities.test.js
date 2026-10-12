// idkcraft-neuc.3: entities + roster fold over the bridge. The REAL
// BaritoneBot adapter (wired: the poll folds entities, the event router
// folds notifications), the REAL perception (buildState/resolvePlayer),
// worker.players and follow.js run unchanged against FakeTransport
// fixtures shaped exactly like the mod's entities.list/roster.get.
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { handleBridgeEvent } = require('../src/bridge/entities')
const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const perception = require('../src/perception')
const worker = require('../src/worker')
const follow = require('../src/behaviours/follow')

// Registry stub: entitiesByName[name].{height,width,type}, the same shape
// minecraft-data serves in prod (zero bridge traffic).
const REGISTRY = {
  blocksByName: { air: { id: 0 } },
  entitiesByName: {
    player: { height: 1.8, width: 0.6, type: 'player' },
    zombie: { height: 1.95, width: 0.6, type: 'hostile' },
    creeper: { height: 1.7, width: 0.6, type: 'hostile' },
    sheep: { height: 1.3, width: 0.9, type: 'animal' },
    arrow: { height: 0.5, width: 0.5, type: 'projectile' },
  },
}

// Wire fixture shapes match PROTOCOL.md: entities.list ->
// {entities:[{id,uuid,type,name,displayName,kind,pos,vel,yaw,pitch,health,
// onGround,pose,self?}]}, roster.get -> {players:[{name,uuid,ping,gameMode}]}.
function wirePlayer(o = {}) {
  return {
    id: o.id ?? 7,
    uuid: o.uuid || '11111111-1111-1111-1111-111111111111',
    type: 'player',
    name: o.name || 'Owner',
    displayName: o.name || 'Owner',
    kind: 'player',
    pos: { x: o.x ?? 10, y: o.y ?? 64, z: o.z ?? 10 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 20,
    onGround: true,
    pose: 'standing',
    ...(o.self ? { self: true } : {}),
  }
}

function wireMob(o = {}) {
  return {
    id: o.id ?? 42,
    uuid: o.uuid || '22222222-2222-2222-2222-222222222222',
    type: o.type || 'zombie',
    displayName: o.displayName || 'Zombie',
    kind: o.kind || 'hostile',
    pos: { x: o.x ?? 3, y: o.y ?? 64, z: o.z ?? 4 },
    vel: { x: o.vx ?? 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 20,
    onGround: true,
    pose: 'standing',
  }
}

function rosterEntry(o = {}) {
  return {
    name: o.name || 'Owner',
    uuid: o.uuid || '11111111-1111-1111-1111-111111111111',
    ping: o.ping ?? 50,
    gameMode: o.gameMode ?? 0,
  }
}

async function foldBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  await bot.start({ pollMs: 0 }) // start() runs one wired poll round itself
  return { transport, bot }
}

describe('entities.list fold (bot.entities, mineflayer-shaped)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = await foldBot({
      entities: [wirePlayer(), wireMob()],
      roster: [rosterEntry(), rosterEntry({ name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })],
    }))
  })
  afterEach(async () => { await bot.stop() })

  it('folds players and mobs with the fields the logic reads', () => {
    const owner = bot.entities['7']
    assert.equal(owner.type, 'player')
    assert.equal(owner.name, 'player')
    assert.equal(owner.username, 'Owner')
    assert.deepEqual([owner.position.x, owner.position.y, owner.position.z], [10, 64, 10])
    assert.equal(typeof owner.position.distanceTo, 'function')
    assert.equal(typeof owner.position.clone, 'function')

    const zombie = bot.entities['42']
    assert.equal(zombie.type, 'hostile') // registry type, like v1 (flat.js skips 'projectile')
    assert.equal(zombie.name, 'zombie')
    assert.equal(zombie.displayName, 'Zombie')
    assert.equal(zombie.kind, 'hostile')
    assert.equal(zombie.health, 20)
    assert.equal(zombie.onGround, true)
    assert.equal(zombie.isValid, true)
    assert.equal(zombie.height, 1.95) // fight.js lookAt reads hostile.height
    assert.deepEqual([zombie.velocity.x, zombie.velocity.y, zombie.velocity.z], [0, 0, 0])
    assert.equal(typeof zombie.velocity.y, 'number')
  })

  it('mutates entities in place across polls (stable refs, no realloc)', async () => {
    const zombie = bot.entities['42']
    const pos = zombie.position
    const vel = zombie.velocity
    transport.state.entities = [wirePlayer(), wireMob({ x: 5, z: 6, vx: 1.5 })]
    await bot.refresh()
    assert.equal(bot.entities['42'], zombie, 'same entity object')
    assert.equal(zombie.position, pos, 'same position Vec3')
    assert.equal(zombie.velocity, vel, 'same velocity Vec3')
    assert.deepEqual([zombie.position.x, zombie.position.z], [5, 6])
    assert.equal(zombie.velocity.x, 1.5)
  })

  it('removes gone entities: entityGone, isValid=false, deleted', async () => {
    const zombie = bot.entities['42']
    const gone = []
    bot.on('entityGone', (e) => gone.push(e))
    transport.state.entities = [wirePlayer()]
    await bot.refresh()
    assert.deepEqual(gone, [zombie])
    assert.equal(zombie.isValid, false)
    assert.equal(bot.entities['42'], undefined)
    assert.ok(bot.entities['7'], 'the player survives')
  })

  it('emits entitySpawn for new sightings only', async () => {
    const spawned = []
    bot.on('entitySpawn', (e) => spawned.push(e.id))
    transport.state.entities = [wirePlayer(), wireMob(), wireMob({ id: 43, type: 'creeper', displayName: 'Creeper' })]
    await bot.refresh()
    assert.deepEqual(spawned, [43])
  })

  it('takes non-player types from the registry, kind bucket as fallback', async () => {
    transport.state.entities = [
      wireMob({ id: 44, type: 'arrow', displayName: 'Arrow', kind: 'other' }),
      wireMob({ id: 45, type: 'grue', displayName: 'Grue', kind: 'hostile' }),
      wireMob({ id: 46, type: 'gruecart', displayName: 'Gruecart', kind: 'other' }),
    ]
    await bot.refresh()
    assert.equal(bot.entities['44'].type, 'projectile', 'flat.js skips stuck arrows like v1')
    assert.equal(bot.entities['45'].type, 'mob', 'unmapped hostile name falls back')
    assert.equal(bot.entities['46'].type, 'object', 'unmapped MISC name falls back')
  })
})

describe('roster.get fold (bot.players merged with entities)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = await foldBot({
      entities: [wirePlayer()],
      roster: [rosterEntry(), rosterEntry({ name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })],
    }))
  })
  afterEach(async () => { await bot.stop() })

  it('links in-range players, nulls out-of-range ones (mineflayer)', () => {
    assert.equal(bot.players.Owner.username, 'Owner')
    assert.equal(bot.players.Owner.uuid, '11111111-1111-1111-1111-111111111111')
    assert.equal(bot.players.Owner.entity, bot.entities['7'])
    assert.equal(bot.players.Guest.entity, null, 'Guest out of range reads null')
  })

  it('emits playerJoined/playerLeft on roster diffs', async () => {
    const joined = []
    const left = []
    bot.on('playerJoined', (p) => joined.push(p.username))
    bot.on('playerLeft', (p) => left.push(p.username))
    transport.state.roster = [rosterEntry(), rosterEntry({ name: 'Newbie', uuid: '44444444-4444-4444-4444-444444444444' })]
    await bot.refresh()
    assert.deepEqual(joined, ['Newbie'])
    assert.deepEqual(left, ['Guest'])
    assert.equal(bot.players.Guest, undefined)
    // The left payload feeds handlePlayerLeft -> clearLead(player.username).
    assert.equal(typeof left[0], 'string')
  })

  it('unlinks the roster entry when its entity despawns', async () => {
    assert.ok(bot.players.Owner.entity)
    transport.state.entities = []
    await bot.refresh()
    assert.equal(bot.players.Owner.entity, null)
    assert.ok(bot.players.Owner, 'roster entry survives; only the link drops')
  })
})

describe('bridge notifications (player.joined/left, entity.gone)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = await foldBot({
      entities: [wirePlayer()],
      roster: [rosterEntry()],
    }))
  })
  afterEach(async () => { await bot.stop() })

  it('player.joined adds + emits once; the next poll does not re-emit', async () => {
    const joined = []
    bot.on('playerJoined', (p) => joined.push(p.username))
    transport.inject('player.joined', { name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })
    assert.equal(bot.players.Guest.username, 'Guest')
    assert.deepEqual(joined, ['Guest'])
    transport.state.roster = [rosterEntry(), rosterEntry({ name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })]
    await bot.refresh()
    assert.deepEqual(joined, ['Guest'], 'poll converges, no double event')
  })

  it('player.left removes + emits once; the next poll does not re-emit', async () => {
    transport.state.roster = [rosterEntry(), rosterEntry({ name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })]
    await bot.refresh()
    const left = []
    bot.on('playerLeft', (p) => left.push(p.username))
    transport.inject('player.left', { name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })
    assert.equal(bot.players.Guest, undefined)
    assert.deepEqual(left, ['Guest'])
    await bot.refresh()
    assert.deepEqual(left, ['Guest'], 'poll converges, no double event')
  })

  it('entity.gone removes + emits; unknown ids and methods are no-ops', async () => {
    transport.state.entities = [wirePlayer(), wireMob()]
    await bot.refresh()
    const gone = []
    bot.on('entityGone', (e) => gone.push(e.id))
    transport.inject('entity.gone', { id: 42 })
    assert.equal(bot.entities['42'], undefined)
    assert.deepEqual(gone, [42])
    transport.inject('entity.gone', { id: 4242 })
    assert.deepEqual(gone, [42], 'unknown id is a no-op')
    assert.equal(handleBridgeEvent(bot, 'chat', {}), false, 'unknown methods route on')
  })
})

describe('self alias (bot.entity in bot.entities, mineflayer parity)', () => {
  it('links self by the wire flag without duplicating or emitting', async () => {
    const { transport, bot } = await foldBot({
      entities: [wirePlayer({ id: 1, name: 'IdkBody', uuid: '00000000-0000-0000-0000-000000000000', self: true })],
      roster: [rosterEntry({ name: 'IdkBody', uuid: '00000000-0000-0000-0000-000000000000' })],
    })
    try {
      const spawned = []
      bot.on('entitySpawn', (e) => spawned.push(e))
      assert.equal(bot.entities['1'], bot.entity, 'aliased, not duplicated')
      assert.equal(bot.entity.id, 1)
      assert.equal(bot.entity.type, 'player')
      // A second round with self still listed emits nothing for it.
      await bot.refresh()
      assert.deepEqual(spawned, [])
      // And a round WITHOUT self never removes the state.get-owned object.
      transport.state.entities = []
      await bot.refresh()
      assert.equal(bot.entities['1'], bot.entity)
      assert.equal(bot.players.IdkBody.entity, bot.entity, 'roster self falls back to bot.entity')
    } finally {
      await bot.stop()
    }
  })
})

describe('nearestEntity (mineflayer semantics)', () => {
  it('skips self, ranks by distance, honors the filter', async () => {
    const { bot } = await foldBot({
      entities: [
        wireMob({ id: 42, x: 3, z: 4 }), // dist 5
        wireMob({ id: 43, type: 'creeper', displayName: 'Creeper', x: 1, z: 1 }), // dist ~1.4
        wirePlayer({ id: 1, name: 'IdkBody', uuid: '00000000-0000-0000-0000-000000000000', self: true }),
      ],
      roster: [rosterEntry({ name: 'IdkBody', uuid: '00000000-0000-0000-0000-000000000000' })],
    })
    try {
      assert.equal(typeof bot.nearestEntity, 'function')
      assert.equal(bot.nearestEntity().id, 43)
      assert.equal(bot.nearestEntity((e) => e.name === 'zombie').id, 42)
      assert.equal(bot.nearestEntity((e) => e.name === 'enderman'), null)
    } finally {
      await bot.stop()
    }
  })
})

describe('REAL logic through the fold (perception + worker + follow)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = await foldBot({
      entities: [wirePlayer(), wireMob()],
      roster: [rosterEntry()],
    }))
  })
  afterEach(async () => { await bot.stop() })

  it('buildState + findTarget see the folded player and hostile', () => {
    const target = perception.findTarget(bot, 'Owner')
    assert.equal(target, bot.entities['7'])
    const state = perception.buildState(bot, target, null)
    assert.equal(state.player_visible, true)
    assert.ok(Math.abs(state.distance_to_player - Math.hypot(10, 10)) < 1e-9)
    assert.equal(state.nearby_hostiles, 1)
    assert.equal(state.hostile, bot.entities['42'])
    assert.ok(Math.abs(state.hostile_distance - 5) < 1e-9)
  })

  it('worker.players sieves self and the hybrid worker; resolvePlayer maps both', async () => {
    worker.configure({ WORKER_NAME: 'TestWorker' })
    try {
      transport.state.roster = [
        rosterEntry(),
        rosterEntry({ name: 'IdkBody', uuid: '00000000-0000-0000-0000-000000000000' }),
        rosterEntry({ name: 'TestWorker', uuid: '55555555-5555-5555-5555-555555555555' }),
      ]
      await bot.refresh()
      assert.deepEqual(Object.keys(worker.players(bot)), ['Owner'])
      assert.equal(perception.resolvePlayer(bot, 'Owner'), 'Owner')
      assert.equal(perception.resolvePlayer(bot, 'TestWorker'), null, 'the worker is never a player')
    } finally {
      worker.configure({})
    }
  })

  it('follow.js issues GoalFollow from the folded target (spike shape)', () => {
    const ctx = {}
    const target = worker.players(bot).Owner.entity
    follow(bot, ctx, target)
    assert.ok(bot.pathfinder.goal instanceof goals.GoalFollow)
    assert.equal(transport.state.baritone, '#goto 10.0 64.0 10.0')
  })
})

describe("Floodgate '.name' resolution through the fold", () => {
  it("chat 'Steve' resolves to roster '.Steve' (uuid wins on collision)", async () => {
    const { bot } = await foldBot({
      entities: [wirePlayer({ id: 8, name: '.Steve', uuid: '66666666-6666-6666-6666-666666666666', x: 5, z: 5 })],
      roster: [rosterEntry({ name: '.Steve', uuid: '66666666-6666-6666-6666-666666666666' })],
    })
    try {
      // The chat event carries 'Steve', the tab list carries '.Steve'.
      assert.equal(perception.resolvePlayer(bot, 'Steve'), '.Steve')
      assert.equal(perception.findTarget(bot, 'Steve'), bot.entities['8'])
      assert.equal(worker.players(bot)['.Steve'].entity, bot.entities['8'])
    } finally {
      await bot.stop()
    }
  })

  it("Java 'Alex' + Bedrock '.Alex' together disambiguate by sender uuid", async () => {
    const { bot } = await foldBot({
      entities: [
        wirePlayer({ id: 9, name: 'Alex', uuid: '77777777-7777-7777-7777-777777777777', x: 5, z: 5 }),
        wirePlayer({ id: 10, name: '.Alex', uuid: '88888888-8888-8888-8888-888888888888', x: 6, z: 6 }),
      ],
      roster: [
        rosterEntry({ name: 'Alex', uuid: '77777777-7777-7777-7777-777777777777' }),
        rosterEntry({ name: '.Alex', uuid: '88888888-8888-8888-8888-888888888888' }),
      ],
    })
    try {
      assert.equal(
        perception.resolvePlayer(bot, 'Alex', '88888888-8888-8888-8888-888888888888'),
        '.Alex',
      )
      assert.equal(
        perception.resolvePlayer(bot, 'Alex', '77777777-7777-7777-7777-777777777777'),
        'Alex',
      )
    } finally {
      await bot.stop()
    }
  })
})

describe('adapter wiring (fold lives in the poll + router)', () => {
  it('adapter.refresh() fills bot.entities/bot.players with no manual fold', async () => {
    const transport = new FakeTransport({
      entities: [wirePlayer(), wireMob()],
      roster: [rosterEntry()],
    })
    const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
    try {
      await bot.start({ pollMs: 0 }) // start() runs one wired poll round itself
      assert.ok(bot.players.Owner, 'roster folded by the adapter poll')
      assert.ok(bot.entities['42'], 'entities folded by the adapter poll')
      transport.inject('player.joined', { name: 'Guest', uuid: '33333333-3333-3333-3333-333333333333' })
      assert.ok(bot.players.Guest, 'notification folded by the adapter router')
    } finally {
      await bot.stop()
    }
  })

  // EP1 microcosm (the rig acceptance shape, FakeTransport loopback): the
  // guide stands at 10,10, the follower folds the roster through the wired
  // poll, follow.js issues GoalFollow, the fake #goto walks, arrival lands,
  // and chat from the guide resolves through the folded roster.
  it('EP1 shape: fold -> follow -> walk -> arrive -> chat answered', async () => {
    const { transport, bot } = await foldBot({
      entities: [wirePlayer()],
      roster: [rosterEntry()],
    })
    try {
      const ctx = {}
      bot.on('path_update', (r) => { ctx.lastPathStatus = r && r.status })
      const target = worker.players(bot).Owner.entity
      follow(bot, ctx, target) // fresh key: issues GoalFollow at the folded pos
      assert.ok(bot.pathfinder.goal instanceof goals.GoalFollow)
      assert.equal(transport.state.baritone, '#goto 10.0 64.0 10.0')
      await bot.refresh() // round 1: fake walk lands, motion witnessed
      assert.deepEqual([bot.entity.position.x, bot.entity.position.z], [10, 10])
      assert.equal(bot.pathfinder.isMoving(), true)
      await bot.refresh() // round 2: arrival -> path_update success
      assert.equal(bot.pathfinder.isMoving(), false)
      assert.equal(ctx.lastPathStatus, 'success')
      // Guide walks away: the next poll folds the new pos, follow re-issues.
      transport.state.entities = [wirePlayer({ x: 30, z: 30 })]
      await bot.refresh()
      assert.deepEqual([target.position.x, target.position.z], [30, 30], 'folded target tracks the guide')
      ctx.lastPathStatus = 'success'
      follow(bot, ctx, target)
      assert.equal(transport.state.baritone, '#goto 30.0 64.0 30.0')
      // Chat from the guide resolves through the folded roster (the 'follow
      // me'/'stay' acceptance half): sender name + uuid both hit.
      assert.equal(perception.resolvePlayer(bot, 'Owner'), 'Owner')
      assert.equal(perception.resolvePlayer(bot, 'Owner', '11111111-1111-1111-1111-111111111111'), 'Owner')
    } finally {
      await bot.stop()
    }
  })
})
