'use strict'

// v2 recover (idkcraft-neuc.52): on a Baritone body (BOT_BODY=baritone) the
// mineflayer ladder misfires, so a recover episode opens with one native
// escape goal instead — the nearest sky-open standable cell via GoalNear,
// Baritone digging/pillaring itself. v1 (BOT_BODY unset) is untouched.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const recoverV2 = require('../src/behaviours/recover-v2')
const { goals } = require('mineflayer-pathfinder')

const OLD_BODY = process.env.BOT_BODY
beforeEach(() => { delete process.env.BOT_BODY })
afterEach(() => {
  if (OLD_BODY === undefined) delete process.env.BOT_BODY
  else process.env.BOT_BODY = OLD_BODY
})

function pos(x, y, z) {
  return { x, y, z }
}

// DOOR-ROOM shape: a roofed 5x5 room (walls at |x|==2 or |z|==2, ceiling at
// y=67), floor at y=63, one door gap at (2,64..65,0). The body stands in the
// door cell; every interior column is cave (ceiling), the outside is sky.
function doorBot() {
  const solidAt = (x, y, z) => {
    if (y === 63 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'dirt'
    if ((y === 64 || y === 65) && x === 2 && z === 0) return null // the door gap
    if (y >= 64 && y <= 66 && (Math.abs(x) === 2 || Math.abs(z) === 2)) return 'stone'
    if (y === 67 && Math.abs(x) <= 2 && Math.abs(z) <= 2) return 'stone' // the roof
    return null
  }
  const nameAt = (x, y, z) => (solidAt(x, y, z) ? solidAt(x, y, z) : 'air')
  return {
    username: 'IdkBot',
    players: {},
    entity: { position: pos(2.5, 64, 0.5), onGround: true, velocity: { x: 0, y: 0, z: 0 } },
    inventory: { items: () => [] },
    heldItem: null,
    setControlState() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const n = nameAt(x, y, z)
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    async placeBlock() {},
    async dig() {},
    async equip(item) { this.heldItem = item },
    pathfinder: { goal: null, setGoal(g) { this.goal = g } },
    chat() {},
  }
}

function doorCtx(key = 'door-v2') {
  return {
    stuck: { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key },
    brain: null,
  }
}

describe('neuc.52 v2 escape', () => {
  it('a door-cell wedge issues one GoalNear toward the open sky, no ladder rung', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    const ctx = doorCtx()
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'escape', 'v2 opens with the escape, not the ladder')
    const g = bot.pathfinder.goal
    assert.ok(g, 'a goal is issued')
    assert.equal(g.constructor.name, 'GoalNear', 'one GoalNear through the setGoal path')
    assert.equal(typeof g.rangeSq === 'number' ? Math.sqrt(g.rangeSq) : NaN, 0, 'GoalNear range 0')
    const tx = g.x; const ty = g.y; const tz = g.z
    assert.ok(Math.abs(tx) > 2 || Math.abs(tz) > 2, `target outside the roofed room, got ${tx},${ty},${tz}`)
    assert.equal(ty, 64, 'target at feet level')
    // No ladder rung ran: the episode state carries the escape target.
    assert.equal(ctx.recovery.action, 'escape')
    assert.deepEqual(ctx.recovery.st.target, { x: tx, y: ty, z: tz })
    // Adjacent first candidate: still wedged on the issue tick, no
    // instant done before Baritone moves (revmux 01 critical).
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'no arrival before displacement')
    // A shuffle short of the tolerance still proves nothing.
    bot.entity.position = pos(2.9, 64, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', '0.4 shuffle is not an arrival')
    // Reaching the target ends the episode done.
    bot.entity.position = pos(tx + 0.5, ty, tz + 0.5)
    ctx.lastPathStatus = 'success'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    const rel = await recover.decide(bot, ctx, null, null)
    assert.equal(rel.action, 'idle', 'arrival releases the episode')
    assert.equal(ctx.recovery, null)
  })

  it('a stolen goal is re-issued, never waited on', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    const ctx = doorCtx('door-steal')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'escape')
    const live = bot.pathfinder.goal
    assert.ok(live, 'escape goal live')
    // An urgent fight parks its own goal over ours (raw setGoal path).
    const stolen = { kind: 'GoalFollow' }
    bot.pathfinder.goal = stolen
    ctx.lastGoalKey = 'fight'
    ctx.lastPathStatus = 'success' // the other owner's verdict must not end us
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'stale success never releases')
    assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear', 'our goal goes back out')
    assert.equal(ctx.lastGoalKey, recoverV2.ESCAPE_KEY, 'under our key')
    assert.equal(ctx.lastPathStatus, 'none', 'a fresh verdict judges the re-issue')
  })

  it('a verdict-less episode advances on the tick budget, then pages', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    bot.players = { Owner: { username: 'Owner', entity: { position: pos(50, 64, 0) } } }
    const ctx = doorCtx('door-budget')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'escape')
    const first = ctx.recovery.st.target
    // Silence until the budget: still running, same target.
    for (let i = 0; i < recoverV2.MAX_TICKS; i++) {
      ctx.lastPathStatus = 'none'
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'running')
    }
    assert.deepEqual(ctx.recovery.st.target, first, 'no verdict, no advance before the budget')
    ctx.lastPathStatus = 'none'
    recover.run(bot, ctx)
    assert.notDeepEqual(ctx.recovery.st.target, first, 'past the budget the next candidate goes out')
    assert.equal(ctx.recovery.status, 'running')
  })

  it('no sky cell: the episode opens and pages without touching the ladder', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    // Roof the world: every column is cave, not even the fallback applies.
    bot.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const n = y <= 63 ? 'dirt' : (y <= 80 ? 'stone' : 'air')
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    }
    bot.players = { Owner: { username: 'Owner', entity: { position: pos(50, 64, 0) } } }
    const ctx = doorCtx('door-roofed')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'escape', 'v2 owns the episode even with no candidate')
    assert.equal(bot.pathfinder.goal, null, 'no goal issued')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.action, 'call_player', 'straight to the last rung')
  })

  it('noPath twice tries the next candidate, then hands to call_player', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    bot.players = { Owner: { username: 'Owner', entity: { position: pos(50, 64, 0) } } }
    // Far candidates: arrival (within 1) must not fire before the noPaths.
    const ctx = doorCtx('door-nopath')
    ctx.recovery = {
      action: 'escape', source: 'fsm', model: null, status: 'running', attempts: 1,
      st: {
        candidates: [{ x: 10, y: 64, z: 0 }, { x: -10, y: 64, z: 5 }, { x: 10, y: 64, z: 5 }],
        idx: 0, target: { x: 10, y: 64, z: 0 }, anchor: { x: 2.5, y: 64, z: 0.5 },
      },
    }
    const issued = []
    bot.pathfinder.setGoal = (g) => { issued.push(g ? { x: g.x, y: g.y, z: g.z } : null); bot.pathfinder.goal = g }
    // Bridge answers noPath: the next candidate goes out, same episode.
    ctx.lastPathStatus = 'noPath'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'still escaping after the first noPath')
    assert.equal(issued.length, 1, 'second candidate issued')
    assert.deepEqual(issued[0], { x: -10, y: 64, z: 5 }, 'the next cell goes out')
    ctx.lastPathStatus = 'noPath'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(issued.length, 2, 'third candidate issued')
    assert.deepEqual(issued[1], { x: 10, y: 64, z: 5 }, 'the last cell goes out')
    // Third noPath: candidates spent, the episode pages like the old ladder.
    ctx.lastPathStatus = 'noPath'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.action, 'call_player', 'exhausted candidates hand to call_player')
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(issued.length, 2, 'no fourth goal: the page owns the episode now')
  })

  it('BOT_BODY unset: escape never runs, the ladder opens as before', async () => {
    let calls = 0
    const orig = recoverV2.escape
    recoverV2.escape = (...a) => { calls++; return orig(...a) }
    try {
      const bot = doorBot()
      const ctx = doorCtx('door-v1')
      const d = await recover.decide(bot, ctx, null, null)
      assert.equal(calls, 0, 'escape never called on v1')
      assert.notEqual(d.action, 'escape', 'no escape action on v1')
      assert.equal(bot.pathfinder.goal, null, 'no GoalNear issued on v1 entry')
    } finally {
      recoverV2.escape = orig
    }
  })

  it('escape returns false on v1 even when called directly', () => {
    const bot = doorBot()
    const ctx = doorCtx('door-direct')
    assert.equal(recoverV2.escape(bot, ctx, null), false)
    assert.equal(ctx.recovery || null, null, 'no episode state touched')
  })

  it('the escape lease forces canDig and allow1by1towers, v1 untouched', () => {
    const body = require('../src/body')
    const mov = () => ({ canDig: false, allowSprinting: false, allowParkour: true, allow1by1towers: false })
    // Explicit extra: digging even under a walk borrow.
    process.env.BOT_BODY = 'baritone'
    const ctx = { recovery: { action: 'escape' }, movements: mov(), deepRan: false }
    body.movementsFor('recover', { pathfinder: {} }, ctx, { walk: true, escape: true })
    assert.equal(ctx.movements.canDig, true, 'escape re-opens the drill')
    assert.equal(ctx.movements.allow1by1towers, true, 'Baritone may pillar')
    // Episode state alone (the tick-start claim shape) forces both too.
    const ctx2 = { recovery: { action: 'escape' }, movements: mov() }
    body.movementsFor('recover', { pathfinder: {} }, ctx2)
    assert.equal(ctx2.movements.canDig, true)
    assert.equal(ctx2.movements.allow1by1towers, true)
    // v1: no escape anywhere, flags stand as computed.
    delete process.env.BOT_BODY
    const ctx3 = { recovery: { action: 'pillar_up' }, movements: mov() }
    body.movementsFor('recover', { pathfinder: {} }, ctx3)
    assert.equal(ctx3.movements.allow1by1towers, false, 'v1 never gains the pillar flag')
  })

  it('moving clear of the wedge anchor ends the episode done', async () => {
    process.env.BOT_BODY = 'baritone'
    const bot = doorBot()
    const ctx = doorCtx('door-anchor')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'escape')
    // Baritone detoured 4 blocks without reaching the cell: free, not wedged.
    bot.entity.position = pos(6.5, 64, 3.5)
    ctx.lastPathStatus = 'partial'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done', 'clear of the anchor reads as escaped')
  })
})
