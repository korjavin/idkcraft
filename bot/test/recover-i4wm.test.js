'use strict'

// Shuffle-done guard (idkcraft-i4wm): follow-up to vmzq.47. A level-goal pit
// episode picks sidestep (corner stance: walls=2, pitClimb false), shuffles
// one block INSIDE the pit and calls it done (freed on displacement) —
// in-pit displacement without escape progress reads as success, so no
// fail-streak ever accrues and the dig-out switch never engages (castle rig
// c698: LEVEL gather goal dist 31, window ended before episode 2). Failing
// the shuffles instead is not the fix (a mid-pit gave-up used to latch;
// B4 only exempts gave-ups, not the done-loop). Fix: count consecutive
// same-anchor same-floor dones of shuffle kinds (sidestep/hop_step) while
// boxed in, ban the kind at 3 — climbing/tunneling dones neither count nor
// seed. Open ground never counts (a wedge that walks 2 blocks sideways is
// genuinely free), so open-ground sidesteps stay byte-identical.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return { x, y, z }
}

// 3-wide hollow corner stance (the c698 shape): the bot column with two
// adjacent mass sides (west + north, 2-high stone), the rest of the hollow
// open, a stone ring at |x|==2/|z|==2 bounding the reachability walk, dirt
// floor under the hollow. walls=2, pit=true, pitClimb=false, boxed=true.
function cornerBot() {
  const solidAt = (x, y, z) => {
    if (y === 60 && Math.abs(x) <= 2 && Math.abs(z) <= 2) return 'dirt' // hollow floor
    if (y >= 61 && y <= 66) {
      if ((x === -1 && z === 0) || (x === 0 && z === -1)) return 'stone' // the corner mass
      if (Math.abs(x) === 2 || Math.abs(z) === 2) return 'stone' // the ring
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
    look() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const n = solidAt(x, y, z)
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    async dig() {},
    async equip(item) { this.heldItem = item },
    pathfinder: { goal: null, setGoal(g) { this.goal = g } },
    chat() {},
  }
}

// Open flat ground (the fja shape a wedge walks free on): never boxed.
function openBot() {
  const bot = cornerBot()
  bot.blockAt = (p) => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const n = y <= 60 ? 'dirt' : 'air'
    return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
  }
  return bot
}

// Level gather goal through the open side: loose freed rule applies (not a
// backstop, goalDy 0), throughBlocked false, hop infeasible (no +1 mount).
function levelGoal() {
  return { x: 30, y: 61, z: 0 }
}

function gatherCtx() {
  return {
    stuck: { by: 'gather', goal: levelGoal(), key: 'gather-corner' },
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

describe('i4wm shuffle-done guard', () => {
  it('corner stance reads walls=2 pit boxed with no climb (the c698 facts)', () => {
    const bot = cornerBot()
    const ctx = gatherCtx()
    const { facts, names } = menuOf(bot, ctx)
    assert.equal(facts.walls, 2)
    assert.equal(facts.pit, true)
    assert.equal(facts.boxed, true)
    assert.equal(facts.goalDy, 0)
    assert.equal(facts.hopStep, null, 'no +1 mount in the corner')
    assert.equal(facts.throughBlocked, false, 'goal through the open side')
    assert.ok(names.includes('sidestep'), `sidestep offered, got ${names}`)
    assert.ok(names.includes('dig_step'), `dig_step feasible (the switch), got ${names}`)
    assert.equal(recover.recoverFsm(facts, names), 'sidestep', 'level corner opens with the shuffle')
  })

  it('three boxed same-floor sidestep dones ban the kind; the 4th menu digs', async () => {
    const bot = cornerBot()
    const ctx = gatherCtx()
    for (let ep = 1; ep <= 3; ep++) {
      ctx.stuck = { by: 'gather', goal: levelGoal(), key: `gather-corner-${ep}` }
      const d = await recover.decide(bot, ctx, null, null)
      assert.equal(d.action, 'sidestep', `episode ${ep} picks the shuffle`)
      // Drive the primitive for real: issue, shuffle inside the hollow,
      // freed on displacement — the c698 done.
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'running')
      bot.entity.position.x += 0.7
      bot.entity.position.z += 0.2
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'done', `episode ${ep} shuffles done in the pit`)
      await recover.decide(bot, ctx, null, null)
      assert.equal(ctx.recovery, null, `episode ${ep} released`)
      assert.equal(ctx.stuck, null)
      assert.equal(ctx.recoverLatch || null, null, 'boxed: no latch either way')
    }
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true, '3rd boxed same-floor done bans')
    // Episode 4 at the same spot: the shuffle is out, the stub takes the
    // post-shuffle staircase (the i4wm arm: boxed, dry, pick, done-banned,
    // hop gone). The model path digs too — and must, since the menu no
    // longer offers the shuffle.
    ctx.stuck = { by: 'gather', goal: levelGoal(), key: 'gather-corner-4' }
    const m = menuOf(bot, ctx)
    assert.ok(!m.names.includes('sidestep'), `banned shuffle stays out, got ${m.names}`)
    assert.ok(m.names.includes('dig_step'), `the dig-out stays offered, got ${m.names}`)
    assert.equal(m.facts.shuffleOut, true, 'facts carry the done-ban')
    assert.ok(recover.recoverText(m.facts).includes('shuf=out'), 'the text names it for the log')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_step', 'stub takes the post-shuffle staircase')
    ctx.recovery = null
    ctx.stuck = { by: 'gather', goal: levelGoal(), key: 'gather-corner-5' }
    ctx.brain = { source: 'jev-test', ask: async () => 'dig_step' }
    const dm = await recover.decide(bot, ctx, null, null)
    assert.equal(dm.action, 'dig_step', 'the post-ban menu offers the model the staircase')
  })

  it('hop_step dones count the same; climbing/tunneling dones never count and reset', () => {
    const bp = pos(0.5, 61, 0.5)
    const ctx = {}
    recover.noteRecoverDone(ctx, bp, 'hop_step', true)
    recover.noteRecoverDone(ctx, bp, 'hop_step', true)
    assert.equal(recover.recoverBanned(ctx, 'hop_step'), false, '2 dones: not yet')
    recover.noteRecoverDone(ctx, bp, 'hop_step', true)
    assert.equal(recover.recoverBanned(ctx, 'hop_step'), true, '3rd boxed done bans hop too')
    // Climbing/tunneling dones neither count nor seed — and break the run.
    const ctx2 = {}
    recover.noteRecoverDone(ctx2, bp, 'sidestep', true)
    recover.noteRecoverDone(ctx2, bp, 'sidestep', true)
    for (const kind of ['pillar_up', 'dig_up', 'water_up', 'dig_pillar', 'dig_step', 'dig_through', 'wait']) {
      recover.noteRecoverDone(ctx2, bp, kind, true)
      assert.equal(recover.recoverBanned(ctx2, kind), false, `${kind} done never bans`)
    }
    assert.equal((ctx2.recoverStreaks.dones.sidestep || {}).n || 0, 0, 'a climbing done resets the shuffle run')
    recover.noteRecoverDone(ctx2, bp, 'sidestep', true)
    assert.equal(recover.recoverBanned(ctx2, 'sidestep'), false, 'post-climb run restarts at 1')
  })

  it('a floor change restarts the run; moving out clears; bans expire', () => {
    const ctx = {}
    const f61 = pos(0.5, 61, 0.5)
    recover.noteRecoverDone(ctx, f61, 'sidestep', true)
    recover.noteRecoverDone(ctx, f61, 'sidestep', true)
    // A done one floor up (a climb that did not escape) restarts, not bans.
    recover.noteRecoverDone(ctx, pos(0.5, 62, 0.5), 'sidestep', true)
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, 'floor change restarts the run')
    assert.equal(ctx.recoverStreaks.dones.sidestep.n, 1)
    recover.noteRecoverDone(ctx, pos(0.5, 62, 0.5), 'sidestep', true)
    recover.noteRecoverDone(ctx, pos(0.5, 62, 0.5), 'sidestep', true)
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true, '3 same-floor dones at the new floor ban')
    // Escape clears dones like fails.
    recover.resetRecoverStreaksIfMoved(ctx, pos(0.5, 66, 0.5))
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, 'escape clears')
    // Expiry matches the fail bans: a stale shuffle loop retries.
    recover.noteRecoverDone(ctx, f61, 'sidestep', true)
    recover.noteRecoverDone(ctx, f61, 'sidestep', true)
    recover.noteRecoverDone(ctx, f61, 'sidestep', true)
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true)
    ctx.recoverStreaks.dones.sidestep.at -= recover.RECOVER_BAN_MS + 1
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, 'expired shuffle ban retries')
  })

  it('interleaved fails do not break the run: the flap bans on its third flat done', () => {
    // A fail is the absence of progress, like a flat done — only progress
    // breaks the run. (A done still clears the kind's FAILS per vmzq.47.)
    const ctx = {}
    const bp = pos(0.5, 61, 0.5)
    recover.noteRecoverDone(ctx, bp, 'sidestep', true)
    recover.noteRecoverDone(ctx, bp, 'sidestep', true)
    recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    assert.equal(ctx.recoverStreaks.dones.sidestep.n, 2, 'fail leaves the run alone')
    assert.equal(ctx.recoverStreaks.fails.sidestep.n, 1, 'the fail still counts as a fail')
    recover.noteRecoverDone(ctx, bp, 'sidestep', true)
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true, 'third flat done bans despite the fail')
    assert.equal((ctx.recoverStreaks.fails.sidestep || {}).n || 0, 0, 'the done cleared the fail streak')
  })

  it('open-ground shuffle dones never count: menus stay byte-identical', async () => {
    const bot = openBot()
    const ctx = gatherCtx()
    const before = menuOf(bot, ctx).names
    for (let ep = 1; ep <= 5; ep++) {
      ctx.stuck = { by: 'gather', goal: levelGoal(), key: `open-${ep}` }
      const d = await recover.decide(bot, ctx, null, null)
      assert.equal(d.action, 'sidestep', `open episode ${ep} still shuffles`)
      ctx.recovery.status = 'done'
      await recover.decide(bot, ctx, null, null)
      bot.entity.position.x += 1 // the wedge walks on
    }
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), false, 'no ban on open ground, ever')
    assert.deepEqual(ctx.recoverStreaks.dones || {}, {}, 'nothing counted')
    ctx.stuck = { by: 'gather', goal: levelGoal(), key: 'open-6' }
    assert.deepEqual(menuOf(bot, ctx).names, before, 'the open menu is unchanged')
  })

  it('S6-PIT shape (dig_up fail, dig_step chain) seeds no shuffle streak', () => {
    // The stuck oracle's pit: dig_up fails, the dig_step staircase rescues.
    // Shuffle counting must not see it: dig dones clear, dig fails ignore.
    const ctx = {}
    const bp = pos(0.5, 61, 0.5)
    recover.noteRecoverFail(ctx, bp, 'dig_up', 'failed:no-progress')
    for (let i = 0; i < 4; i++) recover.noteRecoverDone(ctx, { x: bp.x, y: 61 + i, z: bp.z }, 'dig_step', true)
    for (const kind of recover.RECOVER_ORDER) {
      assert.equal(recover.recoverBanned(ctx, kind), false, `${kind} unbanned after the S6-PIT chain`)
    }
    assert.deepEqual(ctx.recoverStreaks.dones || {}, {}, 'dig dones seed nothing')
  })

  it('parity by construction: no trigger, no ban, the legacy first pick', async () => {
    for (const kind of recover.RECOVER_ORDER) {
      assert.equal(recover.recoverBanned({}, kind), false, `${kind} unbanned on a fresh ctx`)
    }
    const bot = cornerBot()
    const d = await recover.decide(bot, gatherCtx(), null, null)
    assert.equal(d.action, 'sidestep', 'fresh level-corner ctx opens with the legacy shuffle')
  })
})

describe('i4wm post-shuffle staircase arm', () => {
  // 4-wall shaft, near level goal (pitClimb false: near): shuffles
  // infeasible from the start, but nothing looped, so the arm stays shut
  // and the legacy tunnel owns the episode (fail storms keep the legacy
  // fall-through too — only a DONE-ban opens the arm).
  function shaftBot() {
    const bot = cornerBot()
    bot.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      let n = 'air'
      if (y === 60 && Math.abs(x) <= 2 && Math.abs(z) <= 2) n = 'dirt'
      else if (y >= 61 && y <= 66) {
        if ((Math.abs(x) === 1 && z === 0) || (Math.abs(z) === 1 && x === 0)) n = 'stone'
        else if (Math.abs(x) === 2 || Math.abs(z) === 2) n = 'stone'
      }
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    }
    return bot
  }

  function nearCtx() {
    return {
      stuck: { by: 'gather', goal: { x: 10, y: 61, z: 0 }, key: 'gather-shaft' },
      brain: null,
    }
  }

  it('a fail-ban does not open the arm: fail storms keep the legacy fall-through', async () => {
    const bot = cornerBot()
    const ctx = gatherCtx()
    const bp = pos(0.5, 61, 0.5)
    for (let i = 0; i < 3; i++) recover.noteRecoverFail(ctx, bp, 'sidestep', 'failed:no-progress')
    assert.equal(recover.recoverBanned(ctx, 'sidestep'), true, 'fail-ban binds')
    assert.equal(recover.recoverShuffleBanned(ctx, 'sidestep'), false, 'no done-ban without dones')
    const m = menuOf(bot, ctx)
    assert.equal(m.facts.shuffleOut, false)
    assert.ok(!recover.recoverText(m.facts).includes('shuf='), 'unbanned text stays byte-identical')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'wait', 'fail-banned corner still falls through to wait, never the staircase')
  })

  it('infeasible shuffles without a loop do not open the arm (shaft legacy)', async () => {
    const bot = shaftBot()
    const ctx = nearCtx()
    const m = menuOf(bot, ctx)
    assert.equal(m.facts.walls, 4)
    assert.equal(m.facts.boxed, true)
    assert.ok(!m.names.includes('sidestep'), '4 walls: no sidestep to loop')
    assert.ok(!m.names.includes('hop_step'), 'no mount either')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_through', 'near-goal shaft tunnels as before, no staircase')
  })

  it('pickless and water boxes keep the legacy fall-through', async () => {
    // Pickless dirt corner: the staircase is hand-feasible, but the arm
    // needs a pick (resourceless pits page instead of digging blind).
    const dirt = cornerBot()
    dirt.inventory = { items: () => [{ name: 'dirt', count: 19 }] }
    const origBlock = dirt.blockAt.bind(dirt)
    dirt.blockAt = (p) => {
      const b = origBlock(p)
      if (b.name === 'stone') return { ...b, name: 'dirt' }
      return b
    }
    const dctx = gatherCtx()
    const bp = pos(0.5, 61, 0.5)
    for (let i = 0; i < 3; i++) recover.noteRecoverDone(dctx, bp, 'sidestep', true)
    assert.equal(recover.recoverShuffleBanned(dctx, 'sidestep'), true, 'done-ban binds pickless too')
    const dm = menuOf(dirt, dctx)
    assert.ok(dm.names.includes('dig_step'), 'hand staircase feasible')
    const dd = await recover.decide(dirt, dctx, null, null)
    assert.equal(dd.action, 'wait', 'pickless done-ban still falls through')
    // Water corner with a pick: swimming owns the escape, not the staircase.
    const wet = cornerBot()
    const origWet = wet.blockAt.bind(wet)
    wet.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (x === 0 && (y === 61 || y === 60) && z === 0) {
        return { name: y === 61 ? 'water' : 'dirt', position: new Vec3(x, y, z), boundingBox: y === 61 ? 'empty' : 'block' }
      }
      return origWet(p)
    }
    const wctx = gatherCtx()
    for (let i = 0; i < 3; i++) recover.noteRecoverDone(wctx, bp, 'sidestep', true)
    const wm = menuOf(wet, wctx)
    assert.equal(wm.facts.water, true)
    assert.equal(wm.facts.boxed, true)
    const wd = await recover.decide(wet, wctx, null, null)
    assert.equal(wd.action, 'wait', 'water done-ban still falls through')
  })

  it('a done-ban followed by open ground does not open the arm (boxed gate)', async () => {
    // Three boxed dones ban the kind; the bot then drifts sub-anchor onto
    // open ground against a 2-high dirt bank (dig-feasible, hopless,
    // goalward-solid) and wedges again. shuffleOut still reads true, but
    // the arm needs the box: the legacy tunnel owns it, not the staircase.
    const bot = openBot()
    bot.blockAt = ((orig) => (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if ((x === 1 || x === 2) && (y === 61 || y === 62) && z === 0) {
        return { name: 'dirt', position: new Vec3(x, y, z), boundingBox: 'block' }
      }
      return orig(p)
    })(bot.blockAt.bind(bot))
    const ctx = gatherCtx()
    const bp = pos(0.5, 61, 0.5)
    for (let i = 0; i < 3; i++) recover.noteRecoverDone(ctx, bp, 'sidestep', true)
    const m = menuOf(bot, ctx)
    assert.equal(m.facts.boxed, false)
    assert.equal(m.facts.shuffleOut, true, 'the streak survives the drift out')
    assert.ok(!m.names.includes('sidestep'), 'the ban still holds outside')
    assert.ok(!m.names.includes('hop_step'), '2-high bank: no mount')
    assert.ok(m.names.includes('dig_step'), 'hand staircase feasible')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'dig_through', 'unboxed done-ban tunnels as before, never the staircase')
  })

  it('a just-failed hop escalates to the staircase (4jr order pin)', () => {
    // Done-banned sidestep, hop offered but just failed: the hop line
    // yields (4jr exclusion) and the arm takes it instead of re-hopping.
    const facts = {
      goalDy: 0, goalDist: 29, scaffold: 19, pickaxe: true, bucket: 0, water: false,
      headBlocked: false, walls: 2, pit: true, boxed: true, shuffleOut: true,
      playerOnline: false, stuckTicks: 0, resetsStuck: 0, resetsPlaceError: 0,
      last: 'hop_step:failed:no-progress',
    }
    assert.equal(recover.recoverFsm(facts, ['dig_step', 'hop_step', 'wait']), 'dig_step')
    assert.equal(
      recover.recoverFsm({ ...facts, last: 'none' }, ['dig_step', 'hop_step', 'wait']),
      'hop_step', 'a fresh hop still mounts first')
  })

  it('an available hop goes before the staircase (order pin)', async () => {
    // Corner with the north column cut to 1-high: hop mounts it, pit drops
    // (one two-high side left) but the box holds (the vmzq.47 notch).
    const bot = cornerBot()
    const origBlock = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (x === 0 && z === -1 && y >= 62) {
        return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'empty' }
      }
      return origBlock(p)
    }
    const ctx = gatherCtx()
    const bp = pos(0.5, 61, 0.5)
    for (let i = 0; i < 3; i++) recover.noteRecoverDone(ctx, bp, 'sidestep', true)
    const m = menuOf(bot, ctx)
    assert.equal(m.facts.boxed, true, 'the notch still boxes')
    assert.ok(m.names.includes('hop_step'), 'the mount is offered')
    const d = await recover.decide(bot, ctx, null, null)
    assert.equal(d.action, 'hop_step', 'hop mounts before any staircase')
  })
})
