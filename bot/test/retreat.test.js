'use strict'

// Retreat chain (idkcraft-1tj): alone at low health with a hostile on the
// bot, the vetoed follow must offer retreat/pillar/gohome, never idle.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { RETREAT_ORDER, feasibleRetreat, chooseRetreat, retreat, pillar, mobPressure, MOB_CROWD_N, rangedNearCount, retreatFallback } = require('../src/behaviours/retreat')
const { hybridBrain, stubBrain } = require('../src/brain')
const { createTicker, BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Open field: solid floor y<=63, air above. Pit adds 4 walls at feet+head.
function fieldBot({ items = [], solids = null, entities = {}, home = null, health = 3 } = {}) {
  const ground = solids || new Set()
  if (!solids) {
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) ground.add(key(x, 63, z))
    }
  }
  const calls = { setGoal: 0, goals: [], chats: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities,
    health,
    food: 20,
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => items },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = ground.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      isMoving: () => false,
      setMovements: () => {},
    },
    setControlState: () => {},
    clearControlStates: () => {},
    getControlState: () => false,
    chat: (l) => { calls.chats.push(String(l)) },
  }
  return bot
}

function zombie(id, x, y, z) {
  return { id, name: 'zombie', type: 'mob', position: pos(x, y, z), isValid: true }
}

function pitSolids() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 63, z))
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) solids.add(key(dx, 64, dz))
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) solids.add(key(dx, 65, dz))
  return solids
}

function freshCtx(home) {
  return { lastGoalKey: '', stepStatus: null, goalText: null, home: home || null, brain: null }
}

const STATE = { bot_health: 3, hostile_distance: 1.5, nearby_hostiles: 3 }

describe('retreat gates', () => {
  it('open field with dirt: retreat and pillar, in owner order', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['retreat', 'pillar'])
  })
  it('pit walls shut flee: pillar only', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], solids: pitSolids(), entities: { 1: zombie(1, 1.5, 64, 0) } })
    bot.entity.position = pos(0.5, 64, 0.5)
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['pillar'])
  })
  it('no scaffold shuts pillar; built close home opens gohome', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['retreat'])
    const home = { site: { x: 10, y: 64, z: 0 }, built: true }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(home), STATE), ['retreat', 'gohome'])
  })
  it('far or unbuilt home stays shut; far hostile shuts flee', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const far = { site: { x: 200, y: 64, z: 0 }, built: true }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(far), STATE), ['retreat'])
    const raw = { site: { x: 10, y: 64, z: 0 }, built: false }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(raw), STATE), ['retreat'])
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), { ...STATE, hostile_distance: 10 }), [])
  })
  it('threatened player online: chain refuses (normal flow protects)', async () => {
    // neuc.65.7: the alone-only gate is threat-based now — a mob within 6 of
    // the visible player (the stub's near radius) keeps the refusal, so the
    // normal flow (fight/follow) protects them.
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat(null, bot, freshCtx(), { ...STATE, distance_to_player: 4, hostile_near_player: true })
    assert.equal(r, null)
  })

  it('visible but unthreatened bystander: chain proceeds (neuc.65.7)', async () => {
    // The rig puppet watches from 45+ out while the mob chews the bot: the
    // mob threatens the bot, not the bystander, so the chain runs instead of
    // deferring to a normal flow that never comes.
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat(null, bot, freshCtx(), { ...STATE, distance_to_player: 45, hostile_near_player: false })
    assert.ok(r && r.action === 'retreat', `chain runs past a far bystander, got ${JSON.stringify(r)}`)
  })
})

describe('mob pressure predicate (neuc.65.7)', () => {
  const st = (over) => ({ bot_health: 20, hostile_distance: 5, nearby_hostiles: 1, ...over })
  const open = { hurtFresh: true, sheltered: false, ordered: false, protectedTarget: false }

  it('ranged hits with no fight fact divert only with a shooter near (revmux 02 core-2)', () => {
    assert.equal(mobPressure(st({ hostile_distance: null, nearby_hostiles: 2 }), { ...open, rangedNear: 2 }), true)
  })

  it('hits with no fact and no shooter near do not divert (fall + creeper shape)', () => {
    // The snap count mixes in creepers/endermen and melee walkers that
    // fight.js owns — breaking contact blind over a fall or a milling
    // creeper wastes the escape. Only a nearby shooter justifies it.
    assert.equal(mobPressure(st({ hostile_distance: null, nearby_hostiles: 2 }), { ...open, rangedNear: 0 }), false)
  })

  it('a healthy pack diverts (death-3 shape: 6 near, fact live)', () => {
    assert.equal(mobPressure(st({ nearby_hostiles: 6 }), open), true)
  })

  it('crowd size follows the H2 pack number', () => {
    assert.equal(MOB_CROWD_N, 3)
    assert.equal(mobPressure(st({ nearby_hostiles: 2 }), open), false, 'a pair still fights fair')
    assert.equal(mobPressure(st({ nearby_hostiles: 3 }), open), true)
  })

  it('single reachable mob keeps fighting (no divert)', () => {
    assert.equal(mobPressure(st({ nearby_hostiles: 1 }), open), false)
  })

  it('no fresh hurt, no divert (old bruises do not route)', () => {
    assert.equal(mobPressure(st({ nearby_hostiles: 6 }), { ...open, hurtFresh: false }), false)
    assert.equal(mobPressure(st({ hostile_distance: null, nearby_hostiles: 2 }), { ...open, hurtFresh: false, rangedNear: 2 }), false)
  })

  it('no hostiles near, no divert', () => {
    assert.equal(mobPressure(st({ nearby_hostiles: 0 }), open), false)
  })

  it('shelter, orders and protected players keep their ticks', () => {
    const hot = st({ nearby_hostiles: 6 })
    assert.equal(mobPressure(hot, { ...open, sheltered: true }), false)
    assert.equal(mobPressure(hot, { ...open, ordered: true }), false)
    assert.equal(mobPressure(hot, { ...open, protectedTarget: true }), false)
  })

  it('null-safe: missing state or flags never divert', () => {
    assert.equal(mobPressure(null, open), false)
    assert.equal(mobPressure(st({ nearby_hostiles: 6 }), null), false)
    assert.equal(mobPressure(st({ nearby_hostiles: 6 }), {}), false)
  })
})

describe('ranged-nearby scan (neuc.65.7 revmux 02 core-2)', () => {
  function mob(id, name, x, y, z) {
    return { id, name, type: 'mob', position: pos(x, y, z), isValid: true }
  }

  it('counts only shooter kinds within 16 (skeleton yes, zombie/creeper/drowned no)', () => {
    const bot = fieldBot({
      entities: {
        1: mob(1, 'skeleton', 14, 64, 0), // shooter at range: counts
        2: mob(2, 'zombie', 5, 64, 0), // melee walker: fight.js owns it
        3: mob(3, 'creeper', 6, 64, 0), // snap filler, never shoots
        4: mob(4, 'drowned', 12, 64, 0), // melee read: no held-item proof of a trident
        5: mob(5, 'enderman', 10, 64, 0), // snap filler, never shoots
      },
    })
    assert.equal(rangedNearCount(bot), 1)
  })

  it('counts the full shooter set (pillager/witch/blaze/stray/bogged/ghast)', () => {
    const bot = fieldBot({
      entities: {
        1: mob(1, 'pillager', 15, 64, 0),
        2: mob(2, 'witch', 15, 64, 1),
        3: mob(3, 'blaze', 15, 64, 2),
      },
    })
    assert.equal(rangedNearCount(bot), 3)
  })

  it('ignores beyond-16 shooters, players, and entities without position', () => {
    const bot = fieldBot({
      entities: {
        1: mob(1, 'skeleton', 17, 64, 0), // outside the snap radius
        2: { id: 2, name: 'skeleton', type: 'player', position: pos(5, 64, 0) },
        3: { id: 3, name: 'skeleton', type: 'mob', position: null },
      },
    })
    assert.equal(rangedNearCount(bot), 0)
  })

  it('null-safe: missing bot or entity returns 0', () => {
    assert.equal(rangedNearCount(null), 0)
    assert.equal(rangedNearCount({}), 0)
  })
})

describe('ranged pillar cap (neuc.65.7 revmux 03 R3-4)', () => {
  function shooterBot() {
    return fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: {
        1: { id: 1, name: 'skeleton', type: 'mob', position: pos(12, 64, 0), isValid: true },
      },
      health: 20,
    })
  }
  const home = { site: { x: 10, y: 64, z: 0 }, built: true }
  const far = { bot_health: 20, hostile_distance: null, nearby_hostiles: 1 }

  it('one rise per column per minute against a still-far shooter', async () => {
    // A skeleton at 12 keeps hitting across pillar episodes: the first
    // pick rises, the next picks from the same column must not re-pillar —
    // one block never breaks archer line of sight, it only spends scaffold.
    const bot = shooterBot()
    const ctx = freshCtx(home)
    const r1 = await chooseRetreat(null, bot, ctx, far)
    assert.equal(r1 && r1.action, 'pillar', `first pick rises, got ${JSON.stringify(r1)}`)
    ctx.stepStatus = 'done' // the episode completed: the next divert tick decides fresh (the hold branch would return the running pick)
    const r2 = await chooseRetreat(null, bot, ctx, far)
    assert.equal(r2 && r2.action, 'gohome', `second pick from the same column walks, got ${JSON.stringify(r2)}`)
    ctx.stepStatus = 'done'
    const r3 = await chooseRetreat(null, bot, ctx, far)
    assert.equal(r3 && r3.action, 'gohome', `third pick still walks, got ${JSON.stringify(r3)}`)
  })

  it('cap releases on movement, closing, or age', async () => {
    const t0 = Date.now()
    const bot = shooterBot()
    const ctx = freshCtx(home)
    assert.equal((await chooseRetreat(null, bot, ctx, far, t0)).action, 'pillar')
    ctx.stepStatus = 'done' // episode over: decide fresh below
    bot.entity.position = pos(5.5, 64, 0.5) // walked a block: re-arm
    assert.equal((await chooseRetreat(null, bot, ctx, far, t0 + 1000)).action, 'pillar')
    ctx.stepStatus = 'done'
    bot.entity.position = pos(0.5, 64, 0.5)
    const ctx2 = freshCtx(home)
    assert.equal((await chooseRetreat(null, bot, ctx2, far, t0)).action, 'pillar')
    ctx2.stepStatus = 'done'
    assert.equal((await chooseRetreat(null, bot, ctx2, far, t0 + 61000)).action, 'pillar', 'minute-old stamp re-arms')
    const ctx3 = freshCtx(home)
    assert.equal((await chooseRetreat(null, bot, ctx3, far, t0)).action, 'pillar')
    ctx3.stepStatus = 'done'
    assert.equal(
      (await chooseRetreat(null, bot, ctx3, { ...far, hostile_distance: 4 }, t0 + 1000)).action,
      'retreat', 'closed to a fact: melee rules, run first'
    )
  })
})

describe('retreat fallback (neuc.65.7 revmux 02 core-3)', () => {
  it('pillars directly when the chain declines on a live fight', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    const r = retreatFallback(bot, ctx, {})
    assert.deepEqual(r, { action: 'pillar', source: 'retreat-fallback', model: null })
    assert.equal(ctx.retreat && ctx.retreat.action, 'pillar')
    assert.equal(ctx.recovery && ctx.recovery.action, 'pillar_up')
    assert.ok(bot.calls.chats.some((l) => l.includes('retreating: pillaring up (retreat-fallback)')))
  })

  it('no scaffold, no fallback (pillar-up cannot run)', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    assert.ok(!feasibleRetreat(bot, freshCtx(), STATE).includes('pillar'), 'fixture: pillar infeasible')
    assert.equal(retreatFallback(bot, freshCtx(), {}), null)
  })

  it('head blocked, no fallback (consistency with the honest gate)', () => {
    const ground = new Set()
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) ground.add(key(x, 63, z))
    }
    ground.add(key(0, 65, 0)) // ceiling over the head
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], solids: ground, entities: { 1: zombie(1, 2, 64, 0) } })
    assert.ok(!feasibleRetreat(bot, freshCtx(), STATE).includes('pillar'), 'fixture: pillar infeasible')
    assert.equal(retreatFallback(bot, freshCtx(), {}), null)
  })

  it('threatened player online: the chain veto stands, no fallback', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const st = { hostile_near_player: true, distance_to_player: 4 }
    assert.equal(retreatFallback(bot, freshCtx(), st), null)
  })

  it('a failed pillar re-arms the chain instead of looping the fallback', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    ctx.retreatFailed = 'pillar'
    assert.equal(retreatFallback(bot, ctx, {}), null)
  })
})

describe('mob pressure end to end (neuc.65.7)', () => {
  function drowned(id, x, y, z) {
    return { id, name: 'drowned', type: 'mob', position: pos(x, y, z), isValid: true }
  }

  function fightMock() {
    return { async decide() { return { action: 'fight', sprint: false, source: 'stub' } } }
  }

  function pressuredTicker(bot) {
    const ticker = createTicker({ bot, brain: fightMock(), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = { built: true, site: { x: 5, y: 64, z: 5 } }
    ctx.lastHurtAt = Date.now()
    return { ticker, ctx }
  }

  it('pack on a healthy bot: runs instead of trading (death-3 shape)', async () => {
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: zombie(1, 4, 64, 0), 2: zombie(2, 5, 64, 0), 3: zombie(3, 6, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const { ticker } = pressuredTicker(bot)
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'retreat', `pack breaks contact, got ${r.decision && r.decision.action}`)
      assert.ok(bot.calls.chats.some((l) => l.startsWith('retreating: running from the hostile')))
    } finally {
      ticker.destroy()
    }
  })

  it('ranged hits with no fact: pillars instead of standing (skeleton shape, revmux 02 core-2)', async () => {
    // Two skeleton archers outside the hostile fact: the ranged shape breaks
    // contact via pillar. Drowned read melee now (pinned below); their
    // water-written-off shape routes via underFire, kind-agnostic.
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: skeleton(1, 10, 64, 0), 2: skeleton(2, 11, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const { ticker } = pressuredTicker(bot)
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'pillar', `ranged pressure breaks line of sight, got ${r.decision && r.decision.action}`)
    } finally {
      ticker.destroy()
    }
  })

  it('empty chain on a live fight fights explicitly instead of working (revmux 03 R3-1)', async () => {
    // A pack at 7-8 blocks with no scaffold and no near home: the chain is
    // empty, so the old fall-through let goal.decide pick forage and the
    // bot chopped while the pack closed. No escape feasible means fight.
    const bot = fieldBot({
      entities: { 1: zombie(1, 7, 64, 0), 2: zombie(2, 8, 64, 0), 3: zombie(3, 8, 64, 1) },
      health: 20,
    })
    bot.players = {}
    const ticker = createTicker({ bot, brain: fightMock(), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = null // no home in range: gohome infeasible, chain empty
    ctx.lastHurtAt = Date.now()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    const origLog = console.log
    const logged = []
    console.log = (l) => { logged.push(String(l)) }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight', `no escape feasible must fight, got ${r.decision && r.decision.action}`)
      assert.equal(fightRan, 1, 'the brain fight runs instead of goal work')
      assert.ok(logged.some((l) => l.includes('retreat none feasible')), `explicit-fight logged, got: ${logged.join(' | ')}`)
    } finally {
      BEHAVIOURS.fight = origFight
      console.log = origLog
      ticker.destroy()
    }
  })

  it('declined chain falls back to pillar on a live fight (revmux 02 core-3)', async () => {
    // A pack the model declines to escape: the old code fell through to
    // goal.decide and the bot died standing. A wrong pillar costs ticks; a
    // wrong stand costs the bot — bias to action when scaffold stands.
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: zombie(1, 4, 64, 0), 2: zombie(2, 5, 64, 0), 3: zombie(3, 6, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const declining = {
      async decide() { return { action: 'fight', sprint: false, source: 'stub' } },
      async ask() { return 'no' },
    }
    const ticker = createTicker({ bot, brain: declining, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = { built: true, site: { x: 5, y: 64, z: 5 } }
    ctx.lastHurtAt = Date.now()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'pillar', `declined chain must bias to pillar, got ${r.decision && r.decision.action}`)
      assert.ok(bot.calls.chats.some((l) => l.includes('retreating: pillaring up (retreat-fallback)')), `fallback chatted, got: ${bot.calls.chats.join(' | ')}`)
    } finally {
      ticker.destroy()
    }
  })

  function skeleton(id, x, y, z) {
    return { id, name: 'skeleton', type: 'mob', position: pos(x, y, z), isValid: true }
  }

  it('pillar first vs ranged attackers (leg-1 death 4: run dies in the open)', async () => {
    // A skeleton pack at dusk: the owner-order run pick jogs in the open
    // under arrows and dies. Pillar breaks line of sight first when the
    // scaffold stands; melee keeps the run-first order (pinned below).
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: skeleton(1, 4, 64, 0), 2: skeleton(2, 5, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const ctx = freshCtx()
    ctx.lastHurtAt = Date.now()
    const r = await chooseRetreat(null, bot, ctx, { bot_health: 20, hostile_distance: 4, nearby_hostiles: 2 })
    assert.equal(r && r.action, 'pillar', `ranged nearest pillars first, got ${JSON.stringify(r)}`)
  })

  it('melee keeps the run-first order (no pillar regression)', async () => {
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: zombie(1, 4, 64, 0), 2: zombie(2, 5, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const ctx = freshCtx()
    ctx.lastHurtAt = Date.now()
    const r = await chooseRetreat(null, bot, ctx, { bot_health: 20, hostile_distance: 4, nearby_hostiles: 2 })
    assert.equal(r && r.action, 'retreat', `melee nearest still runs first, got ${JSON.stringify(r)}`)
  })

  it('ambiguous drowned reads melee (trident unknown, run stays)', async () => {
    // A drowned may melee or throw; without a held-item read the chain
    // must not assume archers and strand a winnable run behind a pillar.
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: drowned(1, 4, 64, 0), 2: drowned(2, 5, 64, 0) },
      health: 20,
    })
    bot.players = {}
    const ctx = freshCtx()
    ctx.lastHurtAt = Date.now()
    const r = await chooseRetreat(null, bot, ctx, { bot_health: 20, hostile_distance: 4, nearby_hostiles: 2 })
    assert.equal(r && r.action, 'retreat', `drowned keeps run-first, got ${JSON.stringify(r)}`)
  })
})

describe('low-hp divert (neuc.65.7 leg-1 deaths 1-3)', () => {
  function stubTicker(bot) {
    const brain = { async decide(state) { return stubBrain.decide(state) } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    return ticker
  }

  it('single mob grinding a weak bot diverts to the chain (1v1 losses)', async () => {
    // Leg-1 deaths 1-2: one zombie each, no crowd, no ranged shape — the
    // stub idles at hp<6 and the arbiter keeps working (dies standing).
    // The revived 1tj trigger breaks contact instead.
    const bot = fieldBot({
      entities: { 1: zombie(1, 2, 64, 0) },
      health: 5,
    })
    bot.players = {}
    const ticker = stubTicker(bot)
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'retreat', `weak bot breaks contact, got ${r.decision && r.decision.action}`)
    } finally {
      ticker.destroy()
    }
  })

  it('low-hp non-fight tick falls back when the chain declines (stub is silent, revmux 02 core-3)', async () => {
    // hp<6 with a hostile fact that the stub cannot voice: the brain rests
    // while the mob chews. A declined chain must still bias to pillar —
    // the fallback treats lowHp like a live fight.
    const bot = fieldBot({
      items: [{ name: 'dirt', count: 5 }],
      entities: { 1: zombie(1, 2, 64, 0) },
      health: 5,
    })
    bot.players = {}
    const declining = {
      async decide() { return { action: 'rest', sprint: false, source: 'stub' } },
      async ask() { return 'no' },
    }
    const ticker = createTicker({ bot, brain: declining, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'pillar', `silent weak bot must bias to pillar, got ${r.decision && r.decision.action}`)
      assert.ok(bot.calls.chats.some((l) => l.includes('retreating: pillaring up (retreat-fallback)')))
    } finally {
      ticker.destroy()
    }
  })

  it('low-hp empty chain with a silent stub fights instead of gathering (revmux 03 R3-1)', async () => {
    // hp 5 with a live fact at 7 (retreat needs <=6), no scaffold, no home:
    // the chain is empty and the stub is silent, so goal.decide picked
    // gather and the bot chopped while chewed. The divert already decided
    // this tick is combat — fight explicitly.
    const bot = fieldBot({
      entities: { 1: zombie(1, 7, 64, 0) },
      health: 5,
    })
    bot.players = {}
    const restBrain = { async decide() { return { action: 'rest', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain: restBrain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight', `weak chewed bot must fight, got ${r.decision && r.decision.action}`)
      assert.equal(fightRan, 1, 'the synthetic fight runs instead of goal work')
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('threatened player keeps protection (no divert off the bodyguard)', async () => {
    const bot = fieldBot({
      entities: { 1: zombie(1, 2, 64, 0), 2: zombie(2, 9, 64, 0) },
      health: 5,
    })
    bot.players = { P: { username: 'P', entity: { position: pos(10, 64, 0) } } }
    const ticker = stubTicker(bot)
    try {
      const r = await ticker.tick()
      assert.notEqual(r.decision && r.decision.action, 'retreat', 'protection owns the tick')
      assert.notEqual(r.decision && r.decision.action, 'pillar', 'protection owns the tick')
    } finally {
      ticker.destroy()
    }
  })

  it('explicit order keeps its tick at low hp (no divert off an errand)', async () => {
    const bot = fieldBot({
      entities: { 1: zombie(1, 2, 64, 0) },
      health: 5,
    })
    bot.players = {}
    const ticker = stubTicker(bot)
    bot._tickerCtx.lead = { name: 'Steve' }
    try {
      const r = await ticker.tick()
      assert.notEqual(r.decision && r.decision.action, 'retreat', 'orders own their ticks')
      assert.notEqual(r.decision && r.decision.action, 'pillar', 'orders own their ticks')
    } finally {
      ticker.destroy()
    }
  })
})

describe('retreat chain', () => {
  function askBrain(answers) {
    const calls = []
    return {
      calls,
      source: 'laya',
      async ask({ criteria }) {
        calls.push(Object.keys(criteria))
        return answers[Math.min(calls.length - 1, answers.length - 1)]
      },
    }
  }
  it('single option asks nothing (only-option)', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], solids: pitSolids(), entities: { 1: zombie(1, 1.5, 64, 0) } })
    bot.entity.position = pos(0.5, 64, 0.5)
    const brain = askBrain([])
    const ctx = freshCtx()
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.deepEqual(r, { action: 'pillar', source: 'only-option', model: null })
    assert.equal(brain.calls.length, 0)
    assert.equal(ctx.recovery.action, 'pillar_up')
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.calls.chats.some((l) => l.startsWith('retreating: pillaring up')))
  })
  it('yes/no chain in owner order: no then pillar', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no', 'pillar'])
    const r = await chooseRetreat(brain, bot, freshCtx(), STATE)
    assert.equal(r.action, 'pillar')
    assert.equal(r.source, 'laya')
    assert.deepEqual(brain.calls[0], ['retreat', 'no'])
    assert.deepEqual(brain.calls[1], ['pillar', 'no'])
  })
  it('all declined: null once, then silent without re-asking', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no'])
    const ctx = freshCtx()
    assert.equal(await chooseRetreat(brain, bot, ctx, STATE), null)
    assert.equal(brain.calls.length, 2) // retreat? no; pillar? no (gohome infeasible)
    assert.equal(await chooseRetreat(brain, bot, ctx, STATE), null)
    assert.equal(brain.calls.length, 2) // stamped: no re-ask, situation unchanged
    // Same-bucket drift (hp 3->5, hd 1.5->1.9): still no re-ask.
    assert.equal(await chooseRetreat(brain, bot, ctx, { ...STATE, bot_health: 5, hostile_distance: 1.9 }), null)
    assert.equal(brain.calls.length, 2)
  })
  it('0ay: a healthy decline keys its own bucket, never silencing the low-hp leg', async () => {
    // Revmux 0ay round 1 (major): the under-fire leg calls the chain at
    // any hp — without a separate bucket a high-hp 'no' would stamp '3-5'
    // and permanently block a later real low-hp ask.
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no', 'no', 'pillar', 'pillar'])
    const ctx = freshCtx()
    const high = { bot_health: 19, hostile_distance: 1.5, nearby_hostiles: 3 }
    assert.equal(await chooseRetreat(brain, bot, ctx, high), null)
    assert.equal(brain.calls.length, 2)
    assert.ok(ctx.retreatAskedKey.startsWith('6-20:'), `own bucket: ${ctx.retreatAskedKey}`)
    const low = { bot_health: 4, hostile_distance: 1.5, nearby_hostiles: 3 }
    const r = await chooseRetreat(brain, bot, ctx, low)
    assert.equal(r && r.action, 'pillar', 'low-hp re-asks despite the healthy decline')
    assert.equal(brain.calls.length, 4)
  })
  it('0ay round 2: the 5.5-5.99 band buckets low (raw hp, like isHard)', async () => {
    // Math.round would read 6 here and take the healthy premise/bucket on
    // a genuine veto-leg ask; the branch must match isHard's raw < 6.
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no', 'no'])
    const ctx = freshCtx()
    const band = { bot_health: 5.7, hostile_distance: 1.5, nearby_hostiles: 3 }
    assert.equal(await chooseRetreat(brain, bot, ctx, band), null)
    assert.ok(ctx.retreatAskedKey.startsWith('3-5:'), `low bucket: ${ctx.retreatAskedKey}`)
    const over = { bot_health: 6.0, hostile_distance: 1.5, nearby_hostiles: 3 }
    assert.equal(await chooseRetreat(brain, bot, ctx, over), null)
    assert.ok(ctx.retreatAskedKey.startsWith('6-20:'), `healthy bucket: ${ctx.retreatAskedKey}`)
    assert.equal(brain.calls.length, 4, 'band and over re-ask (different buckets)')
  })
  it('invalid label continues the chain with a disagree note', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const errs = []
    const orig = console.error
    console.error = (m) => { errs.push(String(m)) }
    try {
      const brain = askBrain(['fight', 'pillar'])
      const r = await chooseRetreat(brain, bot, freshCtx(), STATE)
      assert.equal(r.action, 'pillar')
      assert.ok(errs.some((e) => e.includes('brain disagree') && e.includes('reason=retreat')))
    } finally {
      console.error = orig
    }
  })
  it('dead brain (every ask throws): fsm-fallback pick, unstamped', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const dead = { source: 'laya', async ask() { throw new Error('timeout') } }
    const ctx = freshCtx()
    const r1 = await chooseRetreat(dead, bot, ctx, STATE)
    assert.deepEqual(r1, { action: 'retreat', source: 'fsm-fallback', model: null })
    assert.equal(ctx.retreatAskedKey, undefined) // unasked: retry next tick
    const r2 = await chooseRetreat(dead, bot, freshCtx(), STATE)
    assert.equal(r2.action, 'retreat')
  })
  it('stub brain (no ask): first feasible, source fsm', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat({ source: 'stub' }, bot, freshCtx(), STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'fsm', model: null })
  })
  it('ongoing pick holds without re-asking', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['retreat'])
    const ctx = freshCtx()
    const r1 = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r1.action, 'retreat')
    assert.equal(brain.calls.length, 1)
    ctx.stepStatus = 'running'
    const r2 = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r2.action, 'retreat')
    assert.equal(r2.source, 'laya') // the stored pick origin, not a fallback
    assert.deepEqual(ctx.retreat, { action: 'retreat', source: 'laya', model: 'laya' })
    assert.equal(brain.calls.length, 1) // held, not re-asked
  })
  it('just-failed gohome excludes itself from the next menu', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const home = { site: { x: 10, y: 64, z: 0 }, built: true }
    // Decline everything: with gohome in the menu the chain would ask it
    // third and pick it; excluded, the chain ends after two questions.
    const brain = askBrain(['no', 'no', 'gohome'])
    const ctx = freshCtx(home)
    ctx.retreat = { action: 'gohome', source: 'laya', model: 'laya' }
    ctx.stepStatus = 'failed:cannot-reach-home'
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r, null)
    assert.equal(brain.calls.length, 2) // retreat? no; pillar? no (gohome never asked)
    assert.equal(ctx.retreatFailed, 'gohome')
  })
  it('just-failed option leaves the model menu while an alternative stands', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain([])
    const ctx = freshCtx()
    ctx.retreatFailed = 'pillar'
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r.action, 'retreat') // pillar excluded, retreat the only option: no ask
    assert.equal(brain.calls.length, 0)
  })
})

describe('retreat behaviours', () => {
  it('flee: far hostile is done; no position fails loudly', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 20, 64, 0) } })
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    const blind = fieldBot({})
    blind.entity = null
    const ctx2 = freshCtx()
    retreat(blind, ctx2)
    assert.equal(ctx2.stepStatus, 'failed:retreat-no-pos')
    assert.equal(ctx2.retreatFailed, 'retreat')
  })
  it('flee: own no-path fails loudly; foreign no-path is ignored', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    ctx.lastGoalKey = 'retreat:1'
    ctx.lastPathStatus = 'noPath'
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:retreat-no-path')
    assert.equal(ctx.retreatFailed, 'retreat')
    const foreign = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx2 = freshCtx()
    ctx2.lastGoalKey = 'fight:1'
    ctx2.lastPathStatus = 'noPath'
    retreat(foreign, ctx2)
    assert.equal(ctx2.stepStatus, 'running') // not our goal: keep trying
  })
  it('flee: near hostile sets the away goal and runs', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.setGoal, 1)
    const g = bot.calls.goals[0]
    assert.ok(g.x < 0.5, `away from the hostile at +x, got x=${g.x}`) // bot x=0.5, hostile x=2
  })
  it('pillar wrapper mirrors rec.status to the step', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }] })
    const own = () => ({ action: 'pillar', source: 'laya', model: 'laya' })
    // A placed prim already verified: the wrapper maps, not recomputes.
    const done = {
      recovery: { action: 'pillar_up', status: 'running', st: { phase: 'place', placed: true, startFloor: 63 } },
      stepStatus: 'running', retreat: own(),
    }
    pillar(bot, done)
    assert.equal(done.stepStatus, 'done')
    assert.equal(done.recovery, null) // terminal: stuck detectors back on
    const failed = { recovery: { action: 'pillar_up', status: 'failed:no-scaffold' }, stepStatus: 'running', retreat: own() }
    pillar(bot, failed)
    assert.equal(failed.stepStatus, 'failed:pillar-no-scaffold')
    assert.equal(failed.retreatFailed, 'pillar')
    assert.equal(failed.recovery, null) // terminal: later stuck episodes start clean
    const running = { recovery: { action: 'pillar_up', status: 'running' }, stepStatus: 'running', retreat: own() }
    pillar(bot, running)
    assert.equal(running.stepStatus, 'running')
    assert.ok(running.recovery) // live episode keeps owning it
  })
  it('pillar wrapper keeps an adopted episode (no retreat ownership)', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }] })
    // A stuck flow adopted the prim and cleared ctx.retreat first: terminal
    // verdict maps, but the episode belongs to recover now.
    const adopted = { recovery: { action: 'pillar_up', status: 'failed:no-scaffold' }, stepStatus: 'running', retreat: null }
    pillar(bot, adopted)
    assert.equal(adopted.stepStatus, 'failed:pillar-no-scaffold')
    assert.ok(adopted.recovery)
  })
  it('registers in BEHAVIOURS under retreat and pillar', () => {
    assert.equal(BEHAVIOURS.retreat, retreat)
    assert.equal(BEHAVIOURS.pillar, pillar)
  })
})

describe('veto path ownership (live 1tj)', () => {
  it('interleaved work step ends the episode: next veto re-chains', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    const answers = ['no', 'pillar', 'no', 'pillar']
    let asks = 0
    let chainAsks = 0
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'follow', sprint: false, source: 'laya' } },
      // The goal menu asks through the same remote on tick 2: count only
      // the retreat chain's questions (retreat/pillar/gohome vs no).
      async ask({ criteria }) {
        asks++
        if (criteria && (criteria.retreat || criteria.pillar || criteria.gohome)) chainAsks++
        return answers[Math.min(asks - 1, answers.length - 1)]
      },
    }
    const brain = hybridBrain(remote)
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    // Tick 1: veto -> chain asks retreat (no) then pillar (yes).
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'pillar')
    assert.equal(chainAsks, 2)
    // Tick 2: healthy, no hostile: the goal arbiter takes the tick (rest),
    // which must release the pillar episode.
    bot.health = 20
    bot.entities = {}
    const r2 = await ticker.tick()
    assert.ok(r2.decision.action !== 'pillar' && r2.decision.action !== 'retreat')
    // Tick 3: low health + hostile again: a FRESH chain (2 more asks),
    // never a hold of the tick-1 pick.
    bot.health = 3
    bot.entities = { 1: zombie(1, 2, 64, 0) }
    const r3 = await ticker.tick()
    assert.equal(r3.decision.action, 'pillar')
    assert.equal(chainAsks, 4)
  })
})

describe('goal shortcut (live 1tj follow-up)', () => {
  it('lapsed low-hp divert holds the latched leg, then re-decides past expiry', async () => {
    // No dirt: the chain can only pick retreat (no asks anywhere).
    // neuc.65.7: the veto-gated entry is subsumed by the low-hp divert —
    // a weak bot with a live fact retreats on tick 0 instead of idling
    // one more tick into the same zombie. Latch, hold and release below
    // are unchanged.
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    const decides = ['idle', 'follow', 'idle', 'idle']
    let n = 0
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { n++; return { action: decides[Math.min(n - 1, decides.length - 1)], sprint: false, source: 'laya' } },
      async ask({ criteria }) {
        const keys = Object.keys(criteria || {})
        if (keys.includes('retreat') || keys.includes('pillar') || keys.includes('gohome')) {
          throw new Error('chain must not ask: retreat is the only option')
        }
        return keys[0] // any valid menu label; the point is a real re-decide
      },
    }
    const brain = hybridBrain(remote)
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    // Tick 0: hp 3 + adjacent zombie: the low-hp divert fires at once
    // (the old veto path idled this tick and died standing).
    // HP drifts 3->4->5 across ticks (same key bucket): the ticker caches
    // identical states, so each tick needs fresh facts.
    const r0 = await ticker.tick()
    assert.equal(r0.decision.action, 'retreat')
    // Tick 1: model follow -> veto -> only-option retreat pick, owns the step.
    bot.health = 4
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'retreat')
    // Tick 2: model idle again (veto lapsed), hp 5 with the zombie
    // adjacent: hysteresis (vmzq.49) holds the latched leg instead of
    // re-picking work into the same zombie (run8 15:52 died there).
    bot.health = 5
    const r2 = await ticker.tick()
    assert.equal(r2.decision.action, 'retreat')
    // Tick 3: hp recovered past release (8+) with the latch expired: the
    // arbiter re-decides (the 1tj release property), never re-issues the
    // stale leg. At hp 5 the divert would (rightly) re-latch instead.
    bot.health = 9
    bot._tickerCtx.retreatLatch.until = Date.now() - 1
    const r3 = await ticker.tick()
    assert.ok(r3.decision.action !== 'retreat', `expired latch re-issued retreat: ${r3.decision.action}`)
  })
})

describe('veto path acceptance (1tj)', () => {
  it('low health + hostile adjacent + noplayer: retreat, never idle', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    bot.inventory = { items: () => bot._items || [{ name: 'dirt', count: 5 }] }
    bot._items = [{ name: 'dirt', count: 5 }]
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'follow', sprint: false, source: 'laya' } },
      async ask() { return 'pillar' },
    }
    const brain = hybridBrain(remote)
    // Alone means autonomous work mode: with nobody on the roster the
    // cost-guard idle branch (no brain call at all) would park the tick
    // before the veto path. autonomous opts the tick into working alone.
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'pillar')
    assert.equal(r.decision.source, 'laya')
  })
})

describe('retreat empty menu (idkcraft-h13)', () => {
  it('no feasible option: null, stale pick cleared', async () => {
    // Boxed with no scaffold, hostile far, no home: feasibleRetreat is []
    // and the chain must say null (caller falls through to goal.decide),
    // clearing any stale pick instead of holding a dead escape.
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), { ...STATE, hostile_distance: 10 }), [])
    const ctx = freshCtx()
    ctx.retreat = { action: 'retreat', source: 'laya', model: 'laya' }
    const r = await chooseRetreat(null, bot, ctx, { ...STATE, hostile_distance: 10 })
    assert.equal(r, null)
    assert.equal(ctx.retreat, null)
    assert.equal(await chooseRetreat(null, bot, ctx, { ...STATE, hostile_distance: 10 }), null)
  })
})

describe('retreat chain edges (idkcraft-h13)', () => {
  function askBrain(answers) {
    const calls = []
    return {
      calls,
      source: 'laya',
      async ask({ criteria }) {
        calls.push(Object.keys(criteria))
        return answers[Math.min(calls.length - 1, answers.length - 1)]
      },
    }
  }
  const armed = () => fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })

  it('brain without source or name answers as model', async () => {
    const r = await chooseRetreat({ async ask() { return 'retreat' } }, armed(), freshCtx(), STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'model', model: 'model' })
  })

  it('brain with name only answers under its name', async () => {
    const brain = { name: 'jev', async ask() { return 'retreat' } }
    const r = await chooseRetreat(brain, armed(), freshCtx(), STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'jev', model: 'jev' })
  })

  it('failed single option is still the only option', async () => {
    // Exclusion needs an alternative: with one feasible option the failed
    // label stays askable and the chain asks nothing.
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } }) // retreat only
    const brain = askBrain([])
    const ctx = freshCtx()
    ctx.retreatFailed = 'retreat'
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'only-option', model: null })
    assert.equal(brain.calls.length, 0)
  })

  it('null brain picks the first feasible, source fsm', async () => {
    const r = await chooseRetreat(null, armed(), freshCtx(), STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'fsm', model: null })
  })

  it('sourceless ongoing pick holds as retreat', async () => {
    const brain = askBrain([])
    const ctx = freshCtx()
    ctx.retreat = { action: 'retreat' }
    ctx.stepStatus = 'running'
    const r = await chooseRetreat(brain, armed(), ctx, STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'retreat', model: null })
    assert.equal(brain.calls.length, 0)
  })

  it('cross-bucket situation re-asks, unknown buckets stamp', async () => {
    const bot = armed()
    const brain = askBrain(['no'])
    const ctx = freshCtx()
    assert.equal(await chooseRetreat(brain, bot, ctx, STATE), null)
    assert.equal(brain.calls.length, 2)
    // hp 3->1 and hd 1.5->5 cross buckets: a new situation, re-asked.
    const drift = { bot_health: 1, hostile_distance: 5, nearby_hostiles: 3 }
    assert.equal(await chooseRetreat(brain, bot, ctx, drift), null)
    assert.equal(brain.calls.length, 4, 'new bucket re-asks')
    // Unknown health and distance stamp under '?' buckets and hold.
    const home = { site: { x: 10, y: 64, z: 0 }, built: true }
    const ctx2 = freshCtx(home)
    const brain2 = askBrain(['no'])
    assert.equal(await chooseRetreat(brain2, bot, ctx2, {}), null)
    assert.equal(brain2.calls.length, 2, 'pillar? no; gohome? no')
    assert.equal(await chooseRetreat(brain2, bot, ctx2, {}), null)
    assert.equal(brain2.calls.length, 2, 'unknown-bucket stamp holds')
  })

  it('null ctx with empty menu returns null', async () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat(null, bot, null, { ...STATE, hostile_distance: 10 })
    assert.equal(r, null)
  })
})

describe('retreat flee edges (idkcraft-h13)', () => {
  it('stacked hostile still flees along +x', () => {
    // dx === 0 && dz === 0 (mob inside the body): the run picks +x
    // instead of dividing by zero.
    const bot = fieldBot({ entities: { 1: zombie(1, 0.5, 64, 0.5) } })
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.setGoal, 1)
    assert.ok(bot.calls.goals[0].x > 0.5, `away along +x, got x=${bot.calls.goals[0].x}`)
    assert.ok(Number.isFinite(bot.calls.goals[0].x), 'no NaN from 0/0')
  })

  it('moving on the live away goal does not re-issue', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    bot.pathfinder.isMoving = () => true
    const ctx = freshCtx()
    ctx.lastGoalKey = 'retreat:1'
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.setGoal, 0, 'live goal keeps running')
  })

  it('throwing isMoving re-issues the away goal', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    bot.pathfinder.isMoving = () => { throw new Error('no driver') }
    const ctx = freshCtx()
    ctx.lastGoalKey = 'retreat:1'
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.setGoal, 1, 'stationary default re-issues')
  })

  it('throwing setGoal still runs', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    bot.pathfinder.setGoal = () => { throw new Error('no driver') }
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
  })
})

describe('taking-fire retreat (0ay)', () => {
  // Alone + hurt + unreachable-close hostile: the FSM idles and the bot
  // dies standing (prod 11:50) — the same chain runs instead. No dirt and
  // no home here, so retreat is the only option and no model is asked.
  let origLog
  let logs
  beforeEach(() => {
    origLog = console.log
    logs = []
    console.log = (line) => { logs.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function idleRemote() {
    return {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'idle', sprint: false, source: 'laya' } },
      async ask() { throw new Error('chain must not ask: retreat is the only option') },
    }
  }
  function fireBot(health) {
    // Mob at ~4.5 blocks: beyond the latch melee override (a written-off
    // mob in swing reach reports reachable) but inside the retreat menu
    // (<=6) and the under-fire gate (<=8) — the prod 11:50 shape.
    // Field widened to x=5 so the mob stands on ground (2pkm: a mob over
    // air reads airborne and fight writes it off without a pursuit).
    const solids = new Set()
    for (let x = -4; x <= 5; x++) for (let z = -4; z <= 4; z++) solids.add(key(x, 63, z))
    const bot = fieldBot({ solids, entities: { 1: zombie(1, 5, 64, 0) }, health })
    bot.players = {}
    return bot
  }

  it('hurt + unreachable-close + nobody: retreats, never stands', async () => {
    const bot = fireBot(20)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick() // hp 20: arms lastTickHp, goal arbiter acts
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1 // fight wrote the mob off: unreachable
    bot.health = 19 // hurt lands between ticks
    const r = await ticker.tick()
    assert.equal(typeof ctx.lastHurtAt, 'number', 'hp drop stamps taking-fire')
    assert.equal(r.decision.action, 'retreat')
    assert.equal(r.decision.source, 'only-option')
    assert.ok(logs.some((l) => l.includes('taking-fire:')), `engage logged, got: ${logs.join(' | ')}`)
    ticker.destroy()
  })

  it('no hurt + unreachable: no retreat (quiet shadows are not fled)', async () => {
    const bot = fireBot(20)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1
    const r = await ticker.tick() // hp flat: no stamp
    assert.equal(ctx.lastHurtAt, undefined)
    assert.ok(r.decision.action !== 'retreat' && r.decision.action !== 'pillar', `stood down: ${r.decision.action}`)
    assert.ok(!logs.some((l) => l.includes('taking-fire:')), 'no engage log without hurt')
    ticker.destroy()
  })

  it('hurt + reachable: the fight path owns the tick, not the chain', async () => {
    const bot = fireBot(20)
    const remote = idleRemote()
    remote.decide = async () => ({ action: 'fight', sprint: false, source: 'laya' })
    const ticker = createTicker({ bot, brain: hybridBrain(remote), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    bot.health = 19 // hurt, but the mob was never written off: reachable
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(fightRan, 1)
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('hurt + unreachable + threatened player: no retreat (protection owns the tick)', async () => {
    const bot = fireBot(20)
    bot.players = { P: { username: 'P', entity: { position: pos(10, 64, 0) } } }
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1
    bot.health = 19
    const r = await ticker.tick()
    assert.ok(r.decision.action !== 'retreat' && r.decision.action !== 'pillar', `stood down: ${r.decision.action}`)
    assert.ok(!logs.some((l) => l.includes('taking-fire:')), 'no engage log with a player visible')
    ticker.destroy()
  })

  it('stale hurt + unreachable: no retreat (fire must be fresh)', async () => {
    const bot = fireBot(20)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1
    ctx.lastHurtAt = Date.now() - 60000 // an old wound, no fresh drop
    const r = await ticker.tick() // hp flat 20: no re-stamp
    assert.ok(r.decision.action !== 'retreat' && r.decision.action !== 'pillar', `stood down: ${r.decision.action}`)
    assert.ok(!logs.some((l) => l.includes('taking-fire:')), 'no engage log on stale hurt')
    ticker.destroy()
  })

  it('low hp + model fight + unreachable + hurt: the divert still retreats (fatal phase)', async () => {
    // Revmux 0ay round 1 (major): without the work-gate divert a fight
    // answer skips the whole work block and the give-up branch shadows
    // nobody — standing under fire exactly when hp is lowest.
    const bot = fireBot(5)
    const remote = idleRemote()
    remote.decide = async () => ({ action: 'fight', sprint: false, source: 'laya' })
    const ticker = createTicker({ bot, brain: hybridBrain(remote), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      await ticker.tick() // hp 5, no stamp yet: fight dispatches (today)
      assert.equal(fightRan, 1)
      const ctx = bot._tickerCtx
      ctx.fightGivenUpId = 1
      bot.health = 4 // hurt lands: stamp arms the divert
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'retreat')
      assert.equal(fightRan, 1, 'diverted tick never reaches fight')
      assert.ok(logs.some((l) => l.includes('taking-fire:')), 'diverted pick logged')
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('6-8m band: empty menu falls through to goal, claims no retreat', async () => {
    // Revmux 0ay round 1 (minor): the gate admits to 8m but retreat needs
    // hd<=6 — with no scaffold/home the chain nulls and the log must not
    // fire (it sits strictly after a dispatched pick).
    const bot = fieldBot({ entities: { 1: zombie(1, 6.5, 64, 0) }, health: 20 })
    bot.players = {}
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const ctx0 = bot._tickerCtx
    ctx0.fightGivenUpId = 1 // latched before tick 1: unreachable from the start
    await ticker.tick()
    const ctx = bot._tickerCtx
    assert.equal(ctx.fightGivenUpId, 1, 'latch holds at 6.5m (candidate within 8)')
    bot.health = 19
    const r = await ticker.tick()
    assert.ok(r.decision.action !== 'retreat' && r.decision.action !== 'pillar', `fell through: ${r.decision.action}`)
    assert.ok(!logs.some((l) => l.includes('taking-fire:')), 'no log on a nulled chain')
    ticker.destroy()
  })

  it('sheltered + hurt + unreachable: no retreat (pacing a 3x3 is not fleeing)', async () => {
    const bot = fireBot(20)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1
    ctx.inShelter = true
    bot.health = 19
    const r = await ticker.tick()
    assert.ok(r.decision.action !== 'retreat' && r.decision.action !== 'pillar', `stood down: ${r.decision.action}`)
    assert.ok(!logs.some((l) => l.includes('taking-fire:')), 'no log while sheltered')
    ticker.destroy()
  })

  it('weak + reachable + idle at low hp: low-hp divert retreats (revived 1tj)', async () => {
    // neuc.65.7 leg-1 deaths 1-3: a single reachable mob grinds a weak bot
    // 20->0 while the stub idles (hp<6) and the arbiter keeps working it to
    // death — no crowd, no ranged shape, so mobPress never fires either.
    // The revived 1tj trigger breaks contact instead of standing down.
    const bot = fireBot(5)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    bot.health = 4 // drop stamps, but the mob was never written off
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'retreat', `weak bot breaks contact, got ${r.decision.action}`)
    assert.ok(logs.some((l) => l.includes('low-hp:')), 'low-hp edge logged')
    ticker.destroy()
  })

  it('continued fire across ticks logs the engage once (latch resets on stale hurt only)', async () => {
    const bot = fireBot(20)
    const ticker = createTicker({ bot, brain: hybridBrain(idleRemote()), tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.fightGivenUpId = 1
    bot.health = 19
    const r2 = await ticker.tick()
    assert.equal(r2.decision.action, 'retreat')
    bot.health = 18 // still taking fire: the hold re-issues without re-asking
    const r3 = await ticker.tick()
    assert.equal(r3.decision.action, 'retreat')
    assert.equal(logs.filter((l) => l.includes('taking-fire:')).length, 1, 'one engage log per fire episode')
    // Round 2: quiet ticks let the hurt go stale (latch resets), and the
    // next fire episode logs again — every episode stays visible in prod.
    ctx.lastHurtAt = Date.now() - 60000
    bot.food = 19 // bust the decision cache without re-stamping hurt
    const r4 = await ticker.tick() // hp flat 18: no re-stamp, goal releases the episode
    assert.ok(r4.decision.action !== 'retreat', 'stale hurt releases to goal')
    bot.health = 17 // fresh hurt opens episode two
    const r5 = await ticker.tick()
    assert.equal(r5.decision.action, 'retreat')
    assert.equal(logs.filter((l) => l.includes('taking-fire:')).length, 2, 'second episode re-logs')
    ticker.destroy()
  })
})
