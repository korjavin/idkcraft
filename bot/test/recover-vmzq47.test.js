'use strict'

// Cross-episode failure memory (idkcraft-vmzq.47): prod run7 stall962 sat
// ~1.5h in a 4-wall pit holding a pickaxe and 19 scaffold while recover
// re-offered the refused pillar_up as the FIRST pick of every new episode
// (the p4s latch dies with the episode). A refused pillar leaves the menu
// at once; any other non-dig kind after 3 consecutive same-spot failures;
// the menu then digs out instead of looping.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return { x, y, z }
}

// Open 4-wall stone pit readings: floor + 4 sides 2-high solid, head free,
// walls continue up (no hop), far high goal (pillar/dig arms live).
function pitBot() {
  const solidAt = (x, y, z) => {
    if (y === 60) return 'dirt' // floor
    if (y >= 61 && y <= 66 && (Math.abs(x) === 1) !== (Math.abs(z) === 1)) {
      // The 4 side columns around the origin column read solid.
      if ((Math.abs(x) === 1 && z === 0) || (Math.abs(z) === 1 && x === 0)) return 'stone'
    }
    return 'air'
  }
  return {
    username: 'IdkBot',
    players: {},
    entity: { position: pos(0.5, 61, 0.5), onGround: true, velocity: { x: 0, y: 0, z: 0 } },
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 19 }] },
    heldItem: null,
    setControlState() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const n = solidAt(x, y, z)
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    async placeBlock() { throw new Error('Server refused to place dirt at (0, 61, 0): the block is still air') },
    async dig() {},
    async equip(item) { this.heldItem = item },
    pathfinder: { goal: null, setGoal(g) { this.goal = g } },
    chat() {},
  }
}

function pitCtx(key = 'pit') {
  return {
    stuck: { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key },
    brain: null, // stub: decide() takes the FSM answer
  }
}

function menuOf(bot, ctx) {
  const facts = recover.recoverFacts(bot, ctx, null, null)
  const names = recover.RECOVER_ORDER.filter((n) => {
    try { return recover.RECOVER_MENU[n].feasible(facts, ctx) } catch (_) { return false }
  })
  return { facts, names }
}

describe('vmzq.47 cross-episode bans', () => {
  it('a refused pillar leaves the next episode menu; the FSM digs instead', async () => {
    const bot = pitBot()
    const ctx = pitCtx()
    // Sanity: no streaks, the pit menu opens with the pillar.
    const first = menuOf(bot, ctx)
    assert.ok(first.names.includes('pillar_up'), `pillar opens the pit menu, got ${first.names}`)
    assert.ok(first.names.includes('dig_step'), `dig_step is offered, got ${first.names}`)
    assert.equal(recover.recoverFsm(first.facts, first.names), 'pillar_up')

    // Episode 1: pillar refused, then two more fails burn the budget.
    let d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'pillar_up')
    ctx.recovery.status = 'failed:place-error'
    d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_step', 'in-episode escalation still digs first')
    ctx.recovery.status = 'failed:no-progress'
    d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_through', 'second fail moves to the next dig kind')
    ctx.recovery.status = 'failed:no-progress'
    d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'idle', 'budget spent: gave-up releases')
    assert.equal(ctx.recovery, null)
    assert.equal(ctx.stuck, null)
    assert.ok(recover.recoverBanned(ctx, 'pillar_up'), 'the refusal bans the pillar across episodes')

    // Episode 2 at the same spot: pillar is out of the menu, dig opens.
    ctx.stuck = { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key: 'pit-2' }
    const second = menuOf(bot, ctx)
    assert.ok(!second.names.includes('pillar_up'), `banned pillar stays out, got ${second.names}`)
    d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_step', 'the next episode digs instead of re-pillaring')
  })

  it('three same-spot fails ban a non-dig kind; dig kinds never ban', () => {
    const ctx = {}
    const bp = pos(56.5, 59, -26.5)
    for (let i = 0; i < 2; i++) {
      recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
      assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, `2 fails: not yet (${i})`)
    }
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true, '3rd consecutive fail bans')
    for (const kind of ['dig_up', 'dig_step', 'dig_through', 'wait', 'call_player']) {
      for (let i = 0; i < 5; i++) recover.noteRecoverFail(ctx, bp, kind, 'failed:no-progress')
      assert.equal(recover.recoverBanned(ctx, kind), false, `${kind} never bans`)
    }
  })

  it('a non-place pillar failure counts one; only refusal fast-forwards', () => {
    const ctx = {}
    const bp = pos(0.5, 61, 0.5)
    recover.noteRecoverFail(ctx, bp, 'pillar_up', 'failed:no-apex')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), false)
    recover.noteRecoverFail(ctx, bp, 'pillar_up', 'failed:place-error')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true, 'refusal fast-forwards to the ban')
  })

  it('moving 3+ blocks clears bans; a done episode re-anchors and clears the worked kind', () => {
    const ctx = {}
    const bp = pos(56.5, 59, -26.5)
    recover.noteRecoverFail(ctx, bp, 'pillar_up', 'failed:place-error')
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true)
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true)
    // In-pit shuffle (under the anchor dist) keeps the bans.
    recover.resetRecoverStreaksIfMoved(ctx, pos(57.5, 60, -25.5))
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true, 'pit shuffle keeps the ban')
    // Escape (3D: a climb-out keeps XZ) clears everything.
    recover.resetRecoverStreaksIfMoved(ctx, pos(57.5, 64, -25.5))
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), false, 'escape clears')
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, 'escape clears')
    // Done at the same spot: the worked kind clears, other streaks keep.
    recover.noteRecoverFail(ctx, bp, 'pillar_up', 'failed:place-error')
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    recover.noteRecoverDone(ctx, bp, 'pillar_up')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), false, 'the worked kind clears')
    assert.equal((ctx.recoverStreaks.fails.sidestep || {}).n, 2, 'other streaks keep')
  })

  it('bans expire after RECOVER_BAN_MS: a transient refusal retries', () => {
    const ctx = {}
    const bp = pos(0.5, 61, 0.5)
    recover.noteRecoverFail(ctx, bp, 'pillar_up', 'failed:place-error')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true)
    ctx.recoverStreaks.fails.pillar_up.at -= recover.RECOVER_BAN_MS + 1
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), false, 'expired ban retries the pillar')
  })

  it('a mid-pit gave-up does not latch; outside it latches as before (vmzq.47 B4)', () => {
    // The latch re-arms past 4 horizontal blocks, which a pit cannot
    // produce — latching a mid-pit gave-up would end all escapes with no
    // page. Bans bound the re-fire loop instead.
    const pit = pitBot()
    const pitCtx = {
      stuck: { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key: 'ticker' },
      recovery: { action: 'dig_step', source: 'fsm', status: 'gave-up', fails: 3 },
    }
    recover.release(pit, pitCtx, 'gave-up')
    assert.equal(pitCtx.stuck, null)
    assert.equal(pitCtx.recoverLatch || null, null, 'no latch in the pit')
    const open = pitBot()
    open.blockAt = (p) => ({ name: 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'empty' })
    const openCtx = {
      stuck: { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key: 'ticker' },
      recovery: { action: 'sidestep', source: 'fsm', status: 'gave-up', fails: 3 },
    }
    recover.release(open, openCtx, 'gave-up')
    assert.ok(openCtx.recoverLatch, 'open gave-up still latches')
    assert.equal(openCtx.recoverLatch.by, 'no-displacement')
  })

  it('parity by construction: no trigger, no ban, the legacy first pick', async () => {
    // The ban gate is the only choice-affecting delta vs master: with no
    // recorded trigger every kind reads unbanned and decide() opens with
    // the legacy first pick. One pair of noisy laid/h runs cannot prove
    // that; this battery does (orchestrator rule, #353).
    assert.deepEqual(recover.RECOVER_ORDER, ['pillar_up', 'dig_up', 'water_up', 'dig_step', 'hop_step', 'sidestep', 'dig_through', 'wait', 'call_player'])
    const bot = pitBot()
    const ctx = pitCtx()
    for (const kind of recover.RECOVER_ORDER) {
      assert.equal(recover.recoverBanned(ctx, kind), false, `${kind} unbanned on a fresh ctx`)
    }
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'pillar_up', 'fresh ctx opens with the legacy first pick')
  })

  it('parity by construction: sub-trigger failures never change the next pick', async () => {
    // A single fail, a cross-spot fail, and any number of non-bannable
    // fails leave the next episode menu identical to master's.
    const bot = pitBot()
    const here = pos(0.5, 61, 0.5)
    const away = pos(30.5, 61, 0.5)
    async function nextPick(setup) {
      const ctx = pitCtx()
      setup(ctx)
      for (const kind of recover.RECOVER_ORDER) {
        assert.equal(recover.recoverBanned(ctx, kind), false, `${kind} unbanned (${setup.name})`)
      }
      ctx.stuck = { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key: `next-${setup.name}` }
      const m = menuOf(bot, ctx)
      assert.ok(m.names.includes('pillar_up'), `pillar still offered (${setup.name})`)
      const d = await recover.decide(bot, ctx, null, null)
      assert.equal(d.action, 'pillar_up', `next episode still opens pillar (${setup.name})`)
    }
    function oneSidestep(ctx) { recover.noteRecoverFail(ctx, here, 'sidestep', 'failed:no-progress') }
    function onePillarNoPlace(ctx) { recover.noteRecoverFail(ctx, here, 'pillar_up', 'failed:no-apex') }
    function crossSpot(ctx) {
      recover.noteRecoverFail(ctx, here, 'sidestep', 'failed:no-progress')
      recover.noteRecoverFail(ctx, here, 'sidestep', 'failed:no-progress')
      recover.resetRecoverStreaksIfMoved(ctx, away) // the ticker resets on move
      recover.noteRecoverFail(ctx, away, 'sidestep', 'failed:no-progress')
    }
    function digFails(ctx) {
      for (let i = 0; i < 5; i++) recover.noteRecoverFail(ctx, here, 'dig_step', 'failed:no-progress')
    }
    await nextPick(oneSidestep)
    await nextPick(onePillarNoPlace)
    await nextPick(crossSpot)
    await nextPick(digFails)
  })

  it('a refusal notes on a bare ctx (the shelter/retreat call shape)', () => {
    // home.js and retreat.js call noteRecoverFail with no episode state.
    const ctx = {}
    recover.noteRecoverFail(ctx, pos(10.5, 64, -3.5), 'pillar_up', 'failed:place-error')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true)
    assert.ok(ctx.recoverStreaks.anchor, 'anchor set for the displacement reset')
  })
})
