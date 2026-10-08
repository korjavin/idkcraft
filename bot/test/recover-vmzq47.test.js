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
const home = require('../src/behaviours/home')
const retreat = require('../src/behaviours/retreat')

function pos(x, y, z) {
  return { x, y, z }
}

// Open 4-wall stone pit readings: floor + 4 sides 2-high solid, head free,
// walls continue up (no hop), far high goal (pillar/dig arms live). The
// floor is the shaft footprint only (r4: the reachability gate walks
// floors, so a universal dirt plane would pave escapes that aren't there).
function pitBot() {
  const solidAt = (x, y, z) => {
    if (y === 60 && Math.abs(x) <= 1 && Math.abs(z) <= 1) return 'dirt' // floor
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
    // Physical open ground (r4: the reachability gate reads floors, so a
    // floorless all-air mock would — correctly — read as a void drop).
    open.blockAt = (p) => {
      const y = Math.floor(p.y)
      const n = y <= 60 ? 'dirt' : 'air'
      return { name: n, position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
    }
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

describe('vmzq.47r2 revmux 01 findings', () => {
  // Latch-skip shapes (body-1, r3/r4 boxed-in): the skip tests whether the
  // body can reach past the latch re-arm, not a wall count. Walk-out
  // shapes latch; only truly boxed shapes skip.
  function shapeBot(cell) {
    const bot = pitBot()
    bot.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const n = cell(x, y, z) || 'air'
      return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
    }
    return bot
  }
  // Floors are structure footprints (r4: a universal plane would pave
  // escapes past the ring being tested).
  const floor60 = (x, y, z, wall, bound) => {
    if (y === 60 && Math.abs(x) <= bound && Math.abs(z) <= bound) return 'dirt'
    if (y >= 61 && y <= 66 && wall(x, z)) return 'stone'
    return null
  }
  const corridor = (x, y, z) => floor60(x, y, z, (x) => Math.abs(x) === 1, 6)
  const alcove = (x, y, z) => floor60(x, y, z, (x, z) => Math.abs(x) === 1 || z === 1, 6)
  const hollow3 = (x, y, z) => floor60(x, y, z, (x, z) => Math.abs(x) === 2 || Math.abs(z) === 2, 6)
  // Hut ring with a door column at (2,0): boundingBox 'block' like the
  // real registry — the pass must come from the door name, not the box.
  const hut = (door) => (x, y, z) => {
    if (y === 60 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'dirt'
    if ((y === 61 || y === 62) && x === 2 && z === 0) return door
    if (y >= 61 && y <= 66 && (Math.abs(x) === 2 || Math.abs(z) === 2)) return 'stone'
    return null
  }
  // 1-deep 1x1 hole: ground to y62, dug cell at (0,63,0); the bot stands
  // at 63 and steps back up (r3 body-1).
  const hole1 = (x, y, z) => {
    if (y <= 62) return 'dirt'
    if (y === 63 && !(x === 0 && z === 0)) return 'grass_block'
    return null
  }
  // Notched 1x1 shaft (revmux 02 core-1's worry): one side cleared at head
  // height and above mid-dig — a step, not an exit (tall walls stand past
  // the notch, no floor beyond the shaft).
  const notched1 = (x, y, z) => {
    if (y === 60 && Math.abs(x) <= 1 && Math.abs(z) <= 1) return 'dirt'
    if (y >= 61 && y <= 66) {
      if ((Math.abs(x) === 1 && z === 0) || (Math.abs(z) === 1 && x === 0)) {
        if (x === 1 && z === 0 && (y === 62 || y === 63)) return null // the notch
        return 'stone'
      }
    }
    return null
  }

  function gaveUpCtx() {
    return {
      stuck: { by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key: 'ticker' },
      recovery: { action: 'dig_step', source: 'fsm', status: 'gave-up', fails: 3 },
    }
  }

  it('body-1: walk-out shapes latch; boxed shapes (1x1, 3x3 hollow) skip', () => {
    const hole = shapeBot(hole1)
    hole.entity.position = pos(0.5, 63, 0.5)
    for (const [name, bot] of [['corridor', shapeBot(corridor)], ['alcove', shapeBot(alcove)], ['oak-door hut', shapeBot(hut('oak_door'))], ['1-deep hole', hole]]) {
      const ctx = gaveUpCtx()
      recover.release(bot, ctx, 'gave-up')
      assert.ok(ctx.recoverLatch, `${name} gave-up latches as before`)
      assert.equal(ctx.recoverLatch.by, 'no-displacement')
    }
    for (const [name, bot] of [['1x1 shaft', pitBot()], ['3x3 hollow centre', shapeBot(hollow3)], ['notched 1x1 shaft', shapeBot(notched1)], ['iron-door hut', shapeBot(hut('iron_door'))]]) {
      const ctx = gaveUpCtx()
      recover.release(bot, ctx, 'gave-up')
      assert.equal(ctx.recoverLatch || null, null, `${name} skips the latch`)
    }
  })

  it('core-1: the online page fires once per situation per detector key', () => {
    const bot = pitBot()
    bot.players = { Owner: { username: 'Owner', entity: { position: pos(5.5, 61, 0.5) } } }
    const chats = []
    bot.chat = (m) => chats.push(m)
    const menu = recover.RECOVER_MENU.call_player
    const here = pos(0.5, 61, 0.5)
    const stuck = (key) => ({ by: 'no-displacement', goal: { x: 300, y: 71, z: 0 }, key })
    const facts = recover.recoverFacts(bot, { stuck: stuck('k1') }, null, null)
    assert.equal(facts.playerOnline, true, 'owner online')
    const ctx = { stuck: stuck('k1') }
    const episode = () => { ctx.recovery = { action: 'call_player', calledPlayer: false } }
    // Episode 1: feasible, pages, stamps the key.
    recover.resetRecoverStreaksIfMoved(ctx, here) // decide() anchors per episode
    episode()
    assert.equal(menu.feasible(facts, ctx), true)
    assert.equal(menu.run(bot, ctx), 'done')
    assert.equal(chats.length, 1, 'first episode pages')
    // Same-key re-fire: excluded from the menu (no silent-done lie).
    episode()
    assert.equal(menu.feasible(facts, ctx), false, 'same-key re-fire stays silent')
    // New detector key at the trap (cross-step, the rw4.9.1 pinned
    // repeat): feasible, pages.
    ctx.stuck = stuck('k2')
    episode()
    assert.equal(menu.feasible(facts, ctx), true)
    assert.equal(menu.run(bot, ctx), 'done')
    assert.equal(chats.length, 2, 'a new detector gets its word')
    // Failure A (r3 real sequence): page at P, /tp out with no episode in
    // between — stuck.update ticks the reset on the way out — then re-trap
    // at P with the same key: the observed departure re-armed, the ask
    // fires (the r2 test skipped the return leg and proved nothing).
    recover.resetRecoverStreaksIfMoved(ctx, pos(50.5, 61, 0.5)) // ticks while away
    recover.resetRecoverStreaksIfMoved(ctx, here) // back at P, episode entry
    ctx.stuck = stuck('k1')
    episode()
    assert.equal(menu.feasible(facts, ctx), true, 'a departure re-arms the same-spot re-trap')
    // Failure B: a nobody-online stamp never eats the online page.
    ctx.repeatGaveUpPage = { x: here.x, y: here.y, z: here.z, at: Date.now() }
    assert.equal(menu.feasible(facts, ctx), true, 'offline stamp does not exclude')
  })

  it('core-2: a refused retreat pillar bans; a working one clears', () => {
    const bot = { entity: { position: pos(56.5, 59, -26.5) } }
    const ctx = { recovery: { action: 'pillar_up', status: 'failed:place-error', st: {} }, retreat: {} }
    retreat.pillar(bot, ctx)
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true, 'refused retreat pillar bans')
    assert.equal(ctx.stepStatus, 'failed:pillar-place-error')
    assert.equal(ctx.recovery, null, 'terminal verdict releases the episode')
    // Same spot, pillar works again: the streak clears.
    const ctx2 = { recovery: { action: 'pillar_up', status: 'done' }, retreat: {} }
    recover.noteRecoverFail(ctx2, pos(56.5, 59, -26.5), 'pillar_up', 'failed:place-error')
    assert.equal(recover.recoverBanned(ctx2, 'pillar_up'), true, 'pre-seeded ban')
    retreat.pillar(bot, ctx2)
    assert.equal(recover.recoverBanned(ctx2, 'pillar_up'), false, 'working pillar clears')
    assert.equal(ctx2.stepStatus, 'done')
  })

  // Flat night world for the shelter drive (ed88 shape, trimmed): ground
  // y<=63, dirt digs into the pack, dirt places.
  function flatBot(at) {
    const key = (x, y, z) => `${x},${y},${z}`
    const dug = new Set()
    const placed = new Set()
    const items = []
    const solidAt = (x, y, z) => placed.has(key(x, y, z)) || (y <= 63 && !dug.has(key(x, y, z)))
    return {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      time: { timeOfDay: 15000, day: 5 },
      entity: { position: { ...at }, onGround: true },
      inventory: { items: () => items.filter((i) => i.count > 0) },
      heldItem: null,
      controls: {},
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
      setControlState(c, v) { this.controls[c] = !!v },
      clearControlStates() { this.controls = {} },
      findBlocks: () => [],
      chat: () => {},
      blockAt(p) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
        const s = solidAt(x, y, z)
        return { name: s ? (y === 63 ? 'grass_block' : 'dirt') : 'air', position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
      },
      async dig(b) {
        dug.add(key(b.position.x, b.position.y, b.position.z))
        const d = items.find((i) => i.name === 'dirt')
        if (d) d.count++
        else items.push({ name: 'dirt', count: 1 })
      },
      async equip(item) { this.heldItem = item },
      async placeBlock(ref, face) {
        if (!this.heldItem || this.heldItem.count < 1) throw new Error('no block')
        const d = ref.position.plus(face)
        placed.add(key(d.x, d.y, d.z))
        this.heldItem.count--
      },
    }
  }

  function v2home(site) {
    return {
      site: { ...site },
      built: true,
      v: 2,
      interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
      door: { x: site.x + 3, y: site.y, z: site.z },
    }
  }

  async function quiet(fn) {
    const orig = console.log
    console.log = () => {}
    try { await fn() } finally { console.log = orig }
  }

  it('core-2: a refused shelter pillar bans and digs in; a working one clears', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = {
      home: v2home({ x: 200, y: 64, z: 200 }), step: 'shelter', stepStatus: 'running', lastGoalKey: 'gohome',
      recovery: { action: 'pillar_up', status: 'failed:place-error', st: {} },
    }
    await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true, 'refused shelter pillar bans')
    assert.ok(ctx.shelter.dig, 'the hold digs in by hand')
    // Same spot, pillar works again: the streak clears, the bot perches.
    const ctx2 = {
      home: v2home({ x: 200, y: 64, z: 200 }), step: 'shelter', stepStatus: 'running', lastGoalKey: 'gohome',
      recovery: { action: 'pillar_up', status: 'done' },
    }
    recover.noteRecoverFail(ctx2, pos(0.5, 64, 0.5), 'pillar_up', 'failed:place-error')
    assert.equal(recover.recoverBanned(ctx2, 'pillar_up'), true, 'pre-seeded ban')
    await quiet(() => home.shelter(bot, ctx2, null, null))
    assert.equal(recover.recoverBanned(ctx2, 'pillar_up'), false, 'working pillar clears')
    assert.equal(ctx2.shelter.perched, true)
  })
})
