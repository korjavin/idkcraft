'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const { buildState, stateKey, isFightTarget } = require('../src/perception')
const { stubBrain } = require('../src/brain')
const fight = require('../src/behaviours/fight')

// Mock helpers use the same shape as tick.test.js.
function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, attack: 0, lookAt: 0, equip: 0, goals: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    _items: [],
    _moving: false,
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => bot._items },
    equip: (item, dest) => { calls.equip++; calls.equipArgs = [item, dest] },
    lookAt: () => { calls.lookAt++ },
    attack: () => { calls.attack++ },
    pathfinder: {
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal) },
      stop: () => { calls.stop++ },
      isMoving: () => bot._moving,
      setMovements: (m) => { calls.movements = m }
    },
    chat: () => {}
  }
  return bot
}

function playerEntity(x) {
  return { id: 7, position: pos(x, 64, 0) }
}

function mobEntity(id, name, x, opts = {}) {
  const p = pos(x, 64, 0)
  p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
  return { id, name, type: 'mob', position: p, height: 1.95, ...opts }
}

describe('perception hostile facts', () => {
  it('finds the nearest zombie: distance, entity, near-player flag', () => {
    const bot = mockBot()
    const zombie = mobEntity(1, 'zombie', 2)
    bot.entities = { 1: zombie }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, 2)
    assert.equal(state.hostile, zombie)
    assert.equal(state.hostile_near_player, false) // zombie->player is 8 blocks
  })

  it('marks hostile_near_player when the mob is close to the player', () => {
    const bot = mockBot()
    bot.entities = { 1: mobEntity(1, 'zombie', 8) }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, 8)
    assert.equal(state.hostile_near_player, true) // zombie->player is 2 blocks
  })

  it('ignores creepers for fight but still counts them as nearby', () => {
    const bot = mockBot()
    bot.entities = { 9: mobEntity(9, 'creeper', 2) }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, null)
    assert.equal(state.hostile, null)
    assert.equal(state.hostile_near_player, false)
    assert.equal(state.nearby_hostiles, 1) // compatibility count kept
  })

  it('never ranks players or passive mobs as hostiles', () => {
    const bot = mockBot()
    const zombie = mobEntity(1, 'zombie', 5)
    bot.entities = {
      // 'zombie' is a legal player name: the type guard, not the allowlist,
      // is what keeps the escort target out of the fight scan.
      7: { id: 7, type: 'player', name: 'zombie', position: pos(2, 64, 0) },
      3: { id: 3, type: 'mob', name: 'pig', position: pos(3, 64, 0), height: 1.0 },
      1: zombie
    }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, 5)
    assert.equal(state.hostile, zombie)
    assert.equal(state.nearby_hostiles, 1) // real zombie only
  })

  it('isFightTarget classifies kinds, not ranges alone', () => {
    const botPos = pos(0, 64, 0)
    const zombie = mobEntity(1, 'zombie', 2)
    assert.equal(isFightTarget(zombie, botPos, null), true)
    assert.equal(isFightTarget(mobEntity(9, 'creeper', 2), botPos, null), false)
    assert.equal(isFightTarget({ id: 7, type: 'player', name: 'Steve', position: pos(2, 64, 0) }, botPos, null), false)
    assert.equal(isFightTarget({ id: 7, type: 'player', name: 'zombie', position: pos(2, 64, 0) }, botPos, null), false)
    assert.equal(isFightTarget({ id: 3, type: 'mob', name: 'pig', position: pos(2, 64, 0) }, botPos, null), false)
    assert.equal(isFightTarget(null, botPos, null), false)
    assert.equal(isFightTarget(mobEntity(2, 'skeleton', 20), botPos, null), false)
  })

  it('prefers the nearest non-creeper when a creeper is closer', () => {
    const bot = mockBot()
    const zombie = mobEntity(1, 'zombie', 5)
    bot.entities = { 9: mobEntity(9, 'creeper', 2), 1: zombie }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, 5)
    assert.equal(state.hostile, zombie)
  })

  it('finds a hostile far from the bot but near the player', () => {
    const bot = mockBot()
    bot.entities = { 1: mobEntity(1, 'zombie', 12) }
    const state = buildState(bot, playerEntity(10), null)
    assert.equal(state.hostile_distance, 12)
    assert.equal(state.hostile_near_player, true) // zombie->player is 2 blocks
  })

  it('treats exactly 8 blocks as in range for the bot arm', () => {
    const bot = mockBot()
    bot.entities = { 1: mobEntity(1, 'zombie', 8) }
    const state = buildState(bot, playerEntity(30), null)
    assert.equal(state.hostile_distance, 8)
    assert.equal(state.hostile_near_player, false)
  })

  it('yields null hostile when nothing is in range', () => {
    const bot = mockBot()
    bot.entities = { 2: mobEntity(2, 'skeleton', 20) }
    const state = buildState(bot, playerEntity(30), null)
    assert.equal(state.hostile_distance, null)
    assert.equal(state.hostile, null)
    assert.equal(state.hostile_near_player, false)
  })

  it('flags the current hostile unreachable when fight gave up on it', () => {
    const bot = mockBot()
    const zombie = mobEntity(1, 'zombie', 2)
    bot.entities = { 1: zombie }
    assert.equal(buildState(bot, playerEntity(10), null, null).hostile_reachable, true)
    assert.equal(buildState(bot, playerEntity(10), null, undefined).hostile_reachable, true)
    const unreach = buildState(bot, playerEntity(10), null, 1)
    assert.equal(unreach.hostile, zombie)
    assert.equal(unreach.hostile_reachable, false)
    assert.equal(buildState(bot, playerEntity(10), null, 2).hostile_reachable, true) // latch names another mob
  })

  it('stateKey changes when reachability flips', () => {
    const base = { distance_to_player: 10, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 1, hostile_distance: 6, hostile_near_player: false, hostile_reachable: true }
    assert.notEqual(stateKey(base), stateKey({ ...base, hostile_reachable: false }))
  })

  it('stateKey changes when a hostile approaches', () => {
    const base = { distance_to_player: 10, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 1, hostile_distance: null, hostile_near_player: false }
    assert.notEqual(stateKey(base), stateKey({ ...base, hostile_distance: 4 }))
    assert.notEqual(stateKey({ ...base, hostile_distance: 7.4 }), stateKey({ ...base, hostile_distance: 4.2 }))
    assert.notEqual(stateKey({ ...base, hostile_distance: 4 }), stateKey({ ...base, hostile_distance: 4, hostile_near_player: true }))
  })
})

describe('fight behaviour', () => {
  it('swings once per call and sets the goal once at 2 blocks', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const state = { hostile: mobEntity(1, 'zombie', 2) }
    fight(bot, ctx, playerEntity(10), state)
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.attack, 1)
    assert.equal(bot.calls.lookAt, 1)
    bot._moving = true
    fight(bot, ctx, playerEntity(10), state)
    assert.equal(bot.calls.setGoal, 1) // same target, already moving: no re-issue
    assert.equal(bot.calls.attack, 2) // one swing per tick
  })

  it('walks but does not swing at 6 blocks', () => {
    const bot = mockBot()
    fight(bot, { lastGoalKey: '' }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 6) })
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.attack, 0)
    assert.equal(bot.calls.lookAt, 0)
  })

  it('swing gate: attacks at exactly 3 blocks, not at 3.1', () => {
    const near = mockBot()
    fight(near, { lastGoalKey: '' }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 3) })
    assert.equal(near.calls.attack, 1)
    const far = mockBot()
    fight(far, { lastGoalKey: '' }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 3.1) })
    assert.equal(far.calls.attack, 0)
    assert.equal(far.calls.setGoal, 1)
  })

  it('equips the first sword once per target', () => {
    const bot = mockBot()
    const sword = { name: 'iron_sword' }
    bot._items = [{ name: 'dirt' }, sword]
    const ctx = { lastGoalKey: '' }
    const first = { hostile: mobEntity(1, 'zombie', 2) }
    fight(bot, ctx, playerEntity(10), first)
    assert.equal(bot.calls.equip, 1)
    assert.deepEqual(bot.calls.equipArgs, [sword, 'hand'])
    // stationary at melee range: the steady state while swinging — still one equip
    fight(bot, ctx, playerEntity(10), first)
    fight(bot, ctx, playerEntity(10), first)
    assert.equal(bot.calls.equip, 1) // same target: no re-equip
    assert.equal(bot.calls.attack, 3)
    assert.equal(bot.calls.setGoal, 1) // goal satisfied: no re-issue
    bot._moving = false
    fight(bot, ctx, playerEntity(10), { hostile: mobEntity(2, 'zombie', 2) })
    assert.equal(bot.calls.equip, 2) // new target: equip again
  })

  it('never equips without a sword in inventory', () => {
    const bot = mockBot()
    bot._items = [{ name: 'dirt' }]
    fight(bot, { lastGoalKey: '' }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(bot.calls.equip, 0)
    assert.equal(bot.calls.attack, 1) // fists are fine
  })

  it('gives up pursuit and shadows the player instead of freezing', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    const zombie = mobEntity(1, 'zombie', 6)
    const state = { hostile: zombie }
    for (let t = 0; t < 7; t++) fight(bot, ctx, player, state)
    assert.equal(bot.calls.setGoal, 2) // initial + one spaced retry, not 7
    for (let t = 0; t < 18; t++) fight(bot, ctx, player, state)
    const mobGoals = bot.calls.goals.filter((g) => g.entity === zombie)
    assert.equal(mobGoals.length, 4) // initial + retries, then quiet
    assert.equal(bot.calls.stop, 0) // never stop an empty path
    assert.equal(bot.calls.attack, 0)
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(last.entity, player) // shadowing the player, not frozen
  })

  it('swings if a given-up mob walks into range', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    const near = { hostile: mobEntity(1, 'zombie', 6) }
    fight(bot, ctx, player, near)
    for (let t = 0; t < 20; t++) fight(bot, ctx, player, near)
    const mobGoals = () => bot.calls.goals.filter((g) => g.entity && g.entity.name === 'zombie')
    assert.equal(mobGoals().length, 4) // given up: mob goal retired
    assert.equal(bot.calls.stop, 0)
    fight(bot, ctx, player, { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(bot.calls.attack, 1) // re-engaged without a new pursuit
    assert.equal(mobGoals().length, 4) // the swing issued no new goal
  })

  it('holds the incumbent when the newcomer is only just nearer', () => {
    const bot = mockBot()
    const a = mobEntity(1, 'zombie', 5.0)
    bot.entities = { 1: a, 2: mobEntity(2, 'zombie', 5.2) }
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    fight(bot, ctx, player, { hostile: a })
    assert.equal(bot.calls.setGoal, 1)
    const b = mobEntity(2, 'zombie', 4.9) // genuinely nearest now, by 0.1
    bot.entities = { 1: a, 2: b }
    fight(bot, ctx, player, { hostile: b })
    assert.equal(bot.calls.setGoal, 1) // margin (2) not beaten: no switch
  })

  it('stays on target when the nearest rank flip-flops', () => {
    const bot = mockBot()
    bot._items = [{ name: 'iron_sword' }]
    const a = mobEntity(1, 'zombie', 5)
    const b = mobEntity(2, 'zombie', 6)
    bot.entities = { 1: a, 2: b }
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    fight(bot, ctx, player, { hostile: a })
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.equip, 1)
    fight(bot, ctx, player, { hostile: b }) // perception re-ranked
    assert.equal(bot.calls.setGoal, 1) // no crossover churn
    assert.equal(bot.calls.equip, 1)
    delete bot.entities[1] // A despawns: switch to B
    fight(bot, ctx, player, { hostile: b })
    assert.equal(bot.calls.setGoal, 2)
    assert.equal(bot.calls.equip, 2)
  })

  it('engages a new mob instead of resurrecting a given-up one', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    const a = mobEntity(1, 'zombie', 6)
    bot.entities = { 1: a }
    fight(bot, ctx, player, { hostile: a })
    for (let t = 0; t < 20; t++) fight(bot, ctx, player, { hostile: a })
    const b = mobEntity(2, 'zombie', 4) // reachable, now nearest
    bot.entities = { 1: a, 2: b }
    fight(bot, ctx, player, { hostile: b })
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(last.entity, b) // pursuing B, not shadowing past A
  })

  it('swings at a new mob in range while the incumbent is given up', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    const a = mobEntity(1, 'zombie', 6)
    bot.entities = { 1: a }
    fight(bot, ctx, player, { hostile: a })
    for (let t = 0; t < 20; t++) fight(bot, ctx, player, { hostile: a })
    const b = mobEntity(2, 'zombie', 2)
    bot.entities = { 1: a, 2: b }
    fight(bot, ctx, player, { hostile: b })
    assert.equal(bot.calls.attack, 1)
  })

  it('switches to a newcomer nearer by the margin', () => {
    const bot = mockBot()
    const a = mobEntity(1, 'zombie', 7)
    const b = mobEntity(2, 'zombie', 2)
    bot.entities = { 1: a, 2: b }
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    fight(bot, ctx, player, { hostile: a })
    assert.equal(bot.calls.setGoal, 1)
    fight(bot, ctx, player, { hostile: b }) // 5 nearer: margin (2) beaten
    assert.equal(bot.calls.setGoal, 2)
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(last.entity, b)
  })

  it('never re-probes on its own after give-up: shadows until the brain looks away', () => {
    // Re-probe lives in the ticker now (it clears the give-up latch after 30
    // ticks): fight called directly must NOT start a new pursuit by itself.
    const bot = mockBot()
    const ctx = { lastGoalKey: '' }
    const player = playerEntity(10)
    const zombie = mobEntity(1, 'zombie', 6)
    const state = { hostile: zombie }
    for (let t = 0; t < 21; t++) fight(bot, ctx, player, state)
    const mobGoals = () => bot.calls.goals.filter((g) => g.entity === zombie)
    assert.equal(mobGoals().length, 4) // given up
    for (let t = 0; t < 40; t++) fight(bot, ctx, player, state)
    assert.equal(mobGoals().length, 4) // still shadowing, no fresh pursuit
    const last = bot.calls.goals[bot.calls.goals.length - 1]
    assert.equal(last.entity, player)
    assert.equal(bot.calls.stop, 0)
    assert.equal(bot.calls.attack, 0)
  })

  it('shadows the player when fight has no hostile, stopping only a moving bot', () => {
    const missing = mockBot()
    const ctx = { lastGoalKey: 'fight:1' }
    const player = playerEntity(10)
    fight(missing, ctx, player, { hostile: null })
    assert.equal(missing.calls.stop, 0) // stationary: nothing to halt
    assert.equal(missing.calls.attack, 0)
    const last = missing.calls.goals[missing.calls.goals.length - 1]
    assert.equal(last.entity, player) // bodyguard, not parked
    const dead = mockBot()
    dead._moving = true
    fight(dead, { lastGoalKey: 'fight:1' }, player, { hostile: mobEntity(1, 'zombie', 2, { isValid: false }) })
    assert.equal(dead.calls.stop, 1) // halt the chase to the corpse
    assert.equal(dead.calls.attack, 0)
  })
})

describe('stub fight end-to-end', () => {
  it('zombie at 4 blocks -> fight; zombie gone -> follow', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: mobEntity(1, 'zombie', 4) }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'fight')
    assert.equal(r1.decision.source, 'stub')
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.attack, 0) // 4 blocks: walking in, out of swing range
    delete bot.entities[1] // zombie dies
    const r2 = await ticker.tick()
    assert.equal(r2.decision.action, 'follow')
    assert.equal(r2.calledBrain, true) // hostile facts changed the state key
  })

  it('fight is wired in the dispatch table', () => {
    assert.equal(BEHAVIOURS.fight, fight)
  })

  it('unreachable zombie -> brain yields follow, ticker re-probes -> fight', async () => {
    // Zombie at 6 blocks of the bot but far from the player: reachable means
    // fight, the give-up latch means follow, the 30-tick re-probe means fight.
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(30) } }
    bot.entities = { 1: mobEntity(1, 'zombie', 6) }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    const actions = []
    let r = await ticker.tick()
    actions.push(r.decision.action)
    assert.equal(actions[0], 'fight')
    for (let t = 0; t < 25; t++) actions.push((await ticker.tick()).decision.action)
    const firstFollow = actions.indexOf('follow')
    assert.ok(firstFollow > 0, `brain never yielded follow: ${actions.join(',')}`)
    assert.ok(actions.slice(0, firstFollow).every((a) => a === 'fight'))
    assert.ok(actions.slice(firstFollow).every((a) => a === 'follow'))
    for (let t = 0; t < 35; t++) actions.push((await ticker.tick()).decision.action)
    assert.ok(actions.slice(firstFollow + 30).includes('fight'), `ticker never re-probed: ${actions.slice(firstFollow).join(',')}`)
  })

  it('given-up incumbent with a nearer reachable mob -> fights the newcomer', async () => {
    // A at 6 blocks stalls pursuit; B appears at 5 (inside the 2-block sticky
    // margin, so fight holds A while perception ranks B nearest). After A is
    // written off the brain must send the body to reachable B — never re-arm
    // A forever, never strand on follow while B threatens.
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(30) } }
    const a = mobEntity(1, 'zombie', 6)
    bot.entities = { 1: a }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    for (let t = 0; t < 10; t++) await ticker.tick() // pursuing A
    const b = mobEntity(2, 'zombie', 5)
    bot.entities = { 1: a, 2: b }
    const actions = []
    for (let t = 0; t < 50; t++) actions.push((await ticker.tick()).decision.action)
    const goalsFor = (m) => bot.calls.goals.filter((g) => g.entity === m).length
    assert.ok(goalsFor(b) >= 1, 'newcomer B never pathed to')
    assert.ok(actions.includes('follow'), `brain never saw unreachable: ${actions.join(',')}`)
    assert.equal(bot.calls.attack, 0) // both out of swing range throughout
  })

  it('latched mob that walks into melee range gets swung on the next tick', async () => {
    // Pursuit stalls and the brain yields follow; the zombie then walks to 1
    // block with the player still far, so only the melee override can bring
    // fight back — the bot must swing instead of taking hits until re-probe.
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(30) } }
    bot.entities = { 1: mobEntity(1, 'zombie', 6) }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    for (let t = 0; t < 25; t++) await ticker.tick()
    bot.entities = { 1: mobEntity(1, 'zombie', 1) }
    const before = bot.calls.attack
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'fight')
    assert.ok(bot.calls.attack > before, 'no swing at a melee mob')
  })

  it('latched mob that despawns clears the latch instead of throwing', async () => {
    // Latch set on a stalled zombie; the mob then dies. The stale-latch
    // guard must clear it (and never dereference the gone entity): the next
    // tick still dispatches follow instead of dying in the tick catch.
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(30) } }
    bot.entities = { 1: mobEntity(1, 'zombie', 6) }
    const ticker = createTicker({ bot, brain: stubBrain, tickMs: 10, idleTickMs: 10 })
    for (let t = 0; t < 25; t++) await ticker.tick()
    delete bot.entities[1] // zombie dies after give-up
    const r = await ticker.tick()
    assert.ok(r.decision, 'tick threw on the gone entity')
    assert.equal(r.decision.action, 'follow')
  })
})

describe('melee reflex skip (one swing per tick)', () => {
  it('exports the swing and equipSword helpers for the tick reflex', () => {
    assert.equal(typeof fight.swing, 'function')
    assert.equal(typeof fight.equipSword, 'function')
    assert.equal(typeof fight.equipGear, 'function')
  })

  it('skips its own swing when the reflex swung this tick, at any mob', () => {
    const bot = mockBot()
    // different mob than fight holds: the arm still swung only once.
    fight(bot, { lastGoalKey: '', reflexSwung: true }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(bot.calls.attack, 0)
  })

  it('swings when the reflex did not fire this tick', () => {
    const bot = mockBot()
    fight(bot, { lastGoalKey: '', reflexSwung: false }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(bot.calls.attack, 1)
    const plain = mockBot()
    fight(plain, { lastGoalKey: '' }, playerEntity(10), { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(plain.calls.attack, 1) // direct callers set no reflex flag
  })

  it('skips the given-up-branch swing on a same-tick reflex swing', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '', fightGivenUpId: 1, reflexSwung: true }
    bot.entities = { 1: mobEntity(1, 'zombie', 2) }
    fight(bot, ctx, playerEntity(10), { hostile: mobEntity(1, 'zombie', 2) })
    assert.equal(bot.calls.attack, 0)
    assert.equal(ctx.fightGivenUpId, null) // latch still clears for re-engage
  })
})

describe('equipGear', () => {
  function gearBot(items, slots) {
    const bot = mockBot()
    bot._items = items
    bot.inventory.slots = slots || []
    const seen = []
    bot.equip = (item, dest) => { seen.push([item, dest]) }
    return { bot, seen }
  }

  it('equips sword to hand and chestplate to torso', () => {
    const sword = { name: 'iron_sword' }
    const chest = { name: 'iron_chestplate' }
    const { bot, seen } = gearBot([sword, chest])
    fight.equipGear(bot)
    assert.deepEqual(seen, [[sword, 'hand'], [chest, 'torso']])
  })

  it('equips the full iron set to the right destinations', () => {
    const kit = [{ name: 'iron_sword' }, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }, { name: 'iron_boots' }]
    const { bot, seen } = gearBot(kit)
    fight.equipGear(bot)
    assert.deepEqual(seen, [[kit[0], 'hand'], [kit[1], 'head'], [kit[2], 'torso'], [kit[3], 'legs'], [kit[4], 'feet']])
  })

  it('skips armor slots that are already filled', () => {
    const sword = { name: 'iron_sword' }
    const chest = { name: 'iron_chestplate' }
    const slots = []
    slots[6] = { name: 'iron_chestplate' } // torso already geared
    const { bot, seen } = gearBot([sword, chest], slots)
    fight.equipGear(bot)
    assert.deepEqual(seen, [[sword, 'hand']])
  })

  it('does nothing without inventory or equip', () => {
    assert.doesNotThrow(() => fight.equipGear({}))
    assert.doesNotThrow(() => fight.equipGear({ inventory: { items: () => [{ name: 'iron_sword' }] } }))
  })
})
