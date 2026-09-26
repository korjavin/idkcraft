'use strict'

// rest (idkcraft-p4s): with a player near, stroll near the player — never
// wander back to the site trap while the owner stands next to the bot.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const rest = require('../src/behaviours/rest')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot() {
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    calls,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    pathfinder: {
      goal: null,
      setGoal: (g, d) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
    },
    chat: () => {},
  }
  return bot
}

describe('rest near player (idkcraft-p4s)', () => {
  it('strolls near the visible player, not the far site', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '', home: { site: pos(100, 64, 100) } }
    const player = { id: 7, username: 'P', position: pos(5, 64, 0) }
    for (let i = 0; i < 20; i++) {
      rest(bot, ctx, player, {})
      const g = bot.calls.goals[bot.calls.goals.length - 1]
      const dPlayer = Math.hypot(g.x - 5, g.z - 0)
      const dSite = Math.hypot(g.x - 100, g.z - 100)
      assert.ok(dPlayer < dSite, `goal at ${g.x},${g.z} nearer site than player`)
    }
  })

  it('falls back to the site with nobody around', () => {
    const bot = mockBot()
    const ctx = { lastGoalKey: '', home: { site: pos(100, 64, 100) } }
    rest(bot, ctx, null, {})
    const g = bot.calls.goals[0]
    assert.ok(Math.hypot(g.x - 100, g.z - 100) <= 8, 'goal near site')
  })
})

function key(x, y, z) { return `${x},${y},${z}` }

// 1x1 shaft: solid floor at y=60, solid walls on all 4 sides from 61 up,
// air inside. Bot starts on the floor, the site above and away.
function pitBot() {
  const solids = new Set()
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
  }
  for (let y = 61; y <= 66; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    calls,
    username: 'IdkBot', players: {}, entities: {},
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'dirt', count: 10 }] },
    _moving: false,
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
    },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, boundingBox: solidCell ? 'block' : 'empty' }
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    setControlState(c, v) { (this.controls = this.controls || {})[c] = !!v },
  }
  return bot
}

describe('rest pit climbs to the site (idkcraft-q0h)', () => {
  const recover = require('../src/behaviours/recover')

  it('roam-back wedge carries the site goal, the menu pillars up', async () => {
    // Prod 2026-09-24: 82 min in a pit 4 below the site, recover facts
    // goal=level dist=none — roam-back returned before any detector and the
    // goal-less backstop chose sidestep/wait. Deleting the roam-back detector
    // fails this test (no stuck fact raised).
    const bot = pitBot()
    bot._moving = true // wedged executor claims motion, the body stands still
    const site = { x: 20, y: 65, z: 0 }
    const ctx = {
      work: true, step: 'rest', stepStatus: 'running',
      lastGoalKey: 'roam-back:undefined', stuckResets: 2,
      roamLastPos: pos(0.5, 61, 0.5), home: { site }, brain: null,
    }
    rest(bot, ctx, null, {})
    assert.ok(ctx.stuck, 'roam-back raises the wedge')
    assert.equal(ctx.stuck.by, 'roam')
    assert.deepEqual(ctx.stuck.goal, site)
    const facts = recover.recoverFacts(bot, ctx, {}, null)
    assert.equal(facts.goalDy, 4)
    assert.match(recover.recoverText(facts), /goal=high/)
    const decision = await recover.decide(bot, ctx, {}, null)
    assert.equal(decision.action, 'pillar_up')
  })

  it('two gave-ups in rest fail the step and hold new episodes at the point', async () => {
    // Same pit, unclimbable day: episodes must escalate to a failed step,
    // not spin at the same point. Deleting the escalation fails this test
    // (the step stays running and the gate never holds).
    const bot = pitBot()
    const site = { x: 20, y: 65, z: 0 }
    const ctx = {
      work: true, step: 'rest', stepStatus: 'running',
      home: { site }, brain: null,
      stuck: { by: 'roam', goal: { x: 20, y: 65, z: 0 }, key: 'roam-back:undefined' },
    }
    const failedEp = () => {
      ctx.recovery = {
        action: 'sidestep', source: 'fsm', model: null, status: 'failed:no-progress',
        st: null, attempts: 1, fails: 2, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null, placeError: false,
      }
    }
    failedEp()
    await recover.decide(bot, ctx, {}, null) // first gave-up: counted, step runs on
    assert.equal(ctx.recovery, null)
    assert.equal(ctx.stuck, null)
    assert.equal(ctx.restGaveUps, 1)
    assert.equal(ctx.stepStatus, 'running')
    ctx.stuck = { by: 'roam', goal: { x: 20, y: 65, z: 0 }, key: 'roam-back:undefined' }
    failedEp()
    await recover.decide(bot, ctx, {}, null) // second gave-up: step fails, point marked
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    assert.ok(ctx.restGaveUpAt, 'gave-up point marked')
    // No new episode at the same point: the shared gate holds ...
    assert.equal(recover.restGaveUpHolds(ctx, bot), true)
    // ... so a wedged roam-back stays silent instead of raising again.
    bot._moving = true
    ctx.lastGoalKey = 'roam-back:undefined'
    ctx.stuckResets = 2
    ctx.roamLastPos = pos(0.5, 61, 0.5)
    const goalsBefore = bot.calls.setGoal
    rest(bot, ctx, null, {})
    assert.equal(ctx.stuck, null)
    assert.equal(bot.calls.setGoal, goalsBefore)
    // Relocation re-arms the detectors.
    bot.entity.position = pos(6.5, 61, 0.5)
    assert.equal(recover.restGaveUpHolds(ctx, bot), false)
    assert.equal(ctx.restGaveUpAt, null)
  })
})

describe('rest gave-up hold lapses online (idkcraft-q0h round 2)', () => {
  const recover = require('../src/behaviours/recover')

  it('a player online lapses the hold, the marker survives for later', () => {
    // Round-1 core-1/body-2: muting every detector at the gave-up point also
    // muted call_player when the owner logged in. Roster presence re-arms.
    const bot = pitBot()
    const ctx = { work: true, step: 'rest', restGaveUpAt: { x: 0.5, y: 61, z: 0.5 } }
    assert.equal(recover.restGaveUpHolds(ctx, bot), true)
    bot.players = { Steve: { username: 'Steve' } }
    assert.equal(recover.restGaveUpHolds(ctx, bot), false, 'online lapses the hold')
    assert.ok(ctx.restGaveUpAt, 'marker kept for the next offline stretch')
    bot.players = {}
    assert.equal(recover.restGaveUpHolds(ctx, bot), true, 'hold resumes when alone')
  })
})

describe('rest gave-up hold calls once (idkcraft-q0h round 3)', () => {
  const recover = require('../src/behaviours/recover')

  it('two online episodes in one pit produce exactly one /tp chat', async () => {
    // Round-2 core-1: the online lapse was permanent — an AFK owner got a
    // /tp line every episode. One episode may ask; then the point holds.
    const bot = pitBot()
    const site = { x: 20, y: 65, z: 0 }
    const ctx = {
      work: true, step: 'rest', stepStatus: 'running',
      home: { site }, brain: null,
      stuck: { by: 'roam', goal: { x: 20, y: 65, z: 0 }, key: 'roam-back:undefined' },
    }
    const failedEp = () => {
      ctx.recovery = {
        action: 'sidestep', source: 'fsm', model: null, status: 'failed:no-progress',
        st: null, attempts: 1, fails: 2, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null, placeError: false,
      }
    }
    // Two offline gave-ups escalate and mark the point.
    failedEp()
    await recover.decide(bot, ctx, {}, null)
    ctx.stuck = { by: 'roam', goal: { x: 20, y: 65, z: 0 }, key: 'roam-back:undefined' }
    failedEp()
    await recover.decide(bot, ctx, {}, null)
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-home')
    // Owner logs in: one lapse episode runs and asks once ...
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    assert.equal(recover.restGaveUpHolds(ctx, bot), false, 'online lapses the hold')
    ctx.stuck = { by: 'no-displacement', goal: { x: 20, y: 65, z: 0 }, key: 'ticker' }
    failedEp()
    await recover.decide(bot, ctx, {}, null) // MAX_FAILS -> call_player chosen
    assert.equal(ctx.recovery.action, 'call_player')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    await recover.decide(bot, ctx, {}, null) // endEpisode -> gave-up, lapse consumed
    assert.equal(ctx.recovery, null)
    const calls = bot.chats.filter((m) => m.startsWith("I'm stuck at"))
    assert.equal(calls.length, 1, `exactly one /tp chat, got: ${bot.chats.join(' | ')}`)
    // ... then the point holds again even online: no second episode, no chat.
    assert.equal(recover.restGaveUpHolds(ctx, bot), true, 'hold resumes after one call')
    assert.equal(bot.chats.filter((m) => m.startsWith("I'm stuck at")).length, 1)
  })
})
