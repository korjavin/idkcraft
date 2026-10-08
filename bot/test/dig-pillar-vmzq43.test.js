'use strict'

// idkcraft-vmzq.43: pickless climb by dig-head-then-pillar (1 bare-hand dig
// per block) instead of the staircase (3-4 digs per block). Offered only
// when boxed — a 3-wide pocket centre reads walls=0/pit=no, so neither
// gates it, and on open ground the menu stays master-identical.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
  }
}

// Rig-faithful 3x2x3 air pocket in stone (CASTLE_BURY), body at y=45.
// cells overrides 'x,y,z' -> name (stone default, null removes).
function pocketBot({ items = [{ name: 'cobblestone', count: 64 }], cells = {}, at = [0.5, 45, 0.5] } = {}) {
  const air = new Set()
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) { air.add(`${x},45,${z}`); air.add(`${x},46,${z}`) }
  }
  const opened = new Set() // dug cells: air regardless of the sets below
  const bot = {
    username: 'IdkBot',
    players: {},
    entity: { position: pos(at[0], at[1], at[2]), onGround: true, velocity: { x: 0, y: 0, z: 0 } },
    inventory: { items: () => items },
    heldItem: null,
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    looks: [],
    lookAt(p) { bot.looks.push([p.x, p.z]) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = `${x},${y},${z}`
      if (opened.has(k)) return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'empty' }
      if (k in cells) {
        const n = cells[k]
        if (n === null) return null
        return { name: n, position: new Vec3(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block' }
      }
      const open = air.has(k)
      return {
        name: open ? 'air' : 'stone',
        position: new Vec3(x, y, z),
        boundingBox: open ? 'empty' : 'block',
      }
    },
    async equip(item, dest) { bot._equips.push([item && item.name, dest]); bot.heldItem = item },
    async placeBlock(ref, face) {
      bot._places++
      const h = bot.heldItem
      if (!h || (h.name !== 'dirt' && h.name !== 'cobblestone')) throw new Error('must be holding an item to place')
      const d = ref.position.plus(face)
      air.delete(`${d.x},${d.y},${d.z}`)
      opened.delete(`${d.x},${d.y},${d.z}`)
      if (typeof h.count === 'number') h.count--
    },
    async dig(b) {
      await Promise.resolve()
      bot.dug.push(`${b.position.x},${b.position.y},${b.position.z}`)
      opened.add(`${b.position.x},${b.position.y},${b.position.z}`)
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    dug: [],
    _places: 0,
    _equips: [],
  }
  return bot
}

function pocketCtx(goal = { x: 0, y: 70, z: 0 }) {
  return { stuck: { by: 'castle', goal, key: 'ticker' }, brain: null }
}

function menuOf(bot, ctx) {
  const f = recover.recoverFacts(bot, ctx, null, null)
  const names = recover.RECOVER_ORDER.filter((n) => {
    try { return recover.RECOVER_MENU[n].feasible(f, ctx) } catch (_) { return false }
  })
  return { facts: f, names }
}

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('dig_pillar menu (vmzq.43)', () => {
  it('pocket centre with scaffold offers the head-dig climb, not the staircase', () => {
    const { facts: f, names } = menuOf(pocketBot(), pocketCtx())
    assert.equal(f.boxed, true)
    assert.equal(f.walls, 0, 'centre reads open: walls/pit cannot gate it')
    assert.equal(f.pit, false)
    assert.equal(f.digStep, null, 'no adjacent step from the centre')
    assert.equal(f.digPillar, true)
    assert.deepEqual(names, ['dig_pillar', 'sidestep', 'wait'])
    assert.equal(recover.recoverFsm(f, names), 'dig_pillar')
  })

  it('a goal-less boxed raise climbs instead of waiting (vmzq.42 first pick)', () => {
    // Castle goals carry no coords: the buried raise reads goal=level,
    // dist=none. Boxed with no walk to resume, up is the only move.
    const { facts: f, names } = menuOf(pocketBot(), pocketCtx(null))
    assert.equal(f.goalDist, null)
    assert.equal(f.goalDy, 0)
    assert.ok(names.includes('dig_pillar'))
    assert.equal(recover.recoverFsm(f, names), 'dig_pillar')
  })

  it('shaping shrinks the ask menu to the climber alone', () => {
    assert.deepEqual(recover.shapeRecoverMenu(['dig_pillar', 'sidestep', 'wait']), ['dig_pillar'])
    assert.deepEqual(
      recover.shapeRecoverMenu(['dig_pillar', 'dig_step', 'sidestep', 'wait', 'call_player']),
      ['dig_pillar', 'call_player'],
      'a player who could teleport stays askable'
    )
  })

  it('shaping wins over the staircase branch on a level goal (r3)', () => {
    // Revmux 01 major: the y34 dig_step branch returns early for goalDy<2
    // and used to run first, keeping sidestep/wait on the menu.
    const { facts: f } = menuOf(pocketBot(), pocketCtx(null))
    assert.equal(f.goalDy, 0)
    assert.deepEqual(
      recover.shapeRecoverMenu(['dig_pillar', 'dig_step', 'sidestep', 'wait'], f),
      ['dig_pillar']
    )
  })

  it('a refusal does not bar the resume at a fresh head (r4)', () => {
    // r4 reverts the r3 latch (revmux 02 major): the refusal lands post-dig
    // with the head free, when this is already infeasible — the latch would
    // bind only at a fresh column, barring the resume and forcing a gave-up
    // plus re-entry per transient refusal (pillar_up has no head coupling,
    // so its latch stands). Rig c42c: 1 transient refusal, resumed same
    // episode after a 9 s sidestep detour.
    const bot = pocketBot()
    const { facts: f, names } = menuOf(bot, pocketCtx())
    assert.ok(names.includes('dig_pillar'))
    const refused = { ...f, placeError: true }
    assert.equal(recover.RECOVER_MENU.dig_pillar.feasible(refused, pocketCtx()), true)
  })

  it('decide picks dig_pillar without asking the brain', async () => {
    let asked = 0
    const bot = pocketBot()
    const ctx = pocketCtx()
    ctx.brain = { source: 'laya', ask: async () => { asked++; return 'wait' } }
    const cap = capture()
    let r
    try {
      r = await recover.decide(bot, ctx, null, null)
    } finally { cap.release() }
    assert.equal(r.action, 'dig_pillar')
    assert.equal(r.source, 'only-option')
    assert.equal(asked, 0)
  })

  it('a 1-wide sealed shaft with scaffold climbs head-first too', () => {
    // Sides solid at feet level: the staircase is feasible here as well,
    // but one dig plus a pillar beats three digs plus a mount.
    const cells = {}
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      cells[`${x},45,${z}`] = 'stone'
      cells[`${x},46,${z}`] = 'stone'
    }
    const { facts: f, names } = menuOf(pocketBot({ cells }), pocketCtx())
    assert.equal(f.boxed, true)
    assert.ok(names.includes('dig_step'), 'staircase feasible in the shaft')
    assert.deepEqual(names, ['dig_pillar', 'dig_step', 'wait'])
    assert.equal(recover.recoverFsm(f, names), 'dig_pillar')
  })
})

describe('dig_pillar guards (vmzq.43)', () => {
  it('no pickaxe climbed: with a pick the old climbers own it', () => {
    const bot = pocketBot({ items: [{ name: 'cobblestone', count: 64 }, { name: 'stone_pickaxe', count: 1 }] })
    assert.ok(!menuOf(bot, pocketCtx()).names.includes('dig_pillar'))
  })

  it('no scaffold: the staircase still owns the climb', () => {
    const { facts: f, names } = menuOf(pocketBot({ items: [] }), pocketCtx())
    assert.ok(!names.includes('dig_pillar'))
    assert.equal(f.digStep, null, 'centre still has no step: sidestep shuffles, as on master')
  })

  it('lava near vetoes, like the staircase', () => {
    const bot = pocketBot({ cells: { '1,45,0': 'lava' } })
    const { facts: f, names } = menuOf(bot, pocketCtx())
    assert.equal(f.lavaNear, true)
    assert.ok(!names.includes('dig_pillar'))
  })

  it('lava on the head vetoes the dig', () => {
    const bot = pocketBot({ cells: { '0,48,0': 'lava' } })
    const { facts: f, names } = menuOf(bot, pocketCtx())
    assert.equal(f.digPillar, false)
    assert.ok(!names.includes('dig_pillar'))
  })

  it('in water: the pillar would be pointless, like pillar_up', () => {
    const bot = pocketBot()
    bot.entity.isInWater = true
    assert.ok(!menuOf(bot, pocketCtx()).names.includes('dig_pillar'))
  })

  it('an ore vein head is offered: shafts cannot route around (r2)', () => {
    const bot = pocketBot({ cells: { '0,47,0': 'coal_ore' } })
    const { facts: f, names } = menuOf(bot, pocketCtx())
    assert.equal(f.digPillar, true)
    assert.ok(names.includes('dig_pillar'))
  })

  it('an unbreakable head (obsidian) is not offered', () => {
    const bot = pocketBot({ cells: { '0,47,0': 'obsidian' } })
    const { facts: f, names } = menuOf(bot, pocketCtx())
    assert.equal(f.digPillar, false)
    assert.ok(!names.includes('dig_pillar'))
  })

  it('a known near goal stays unclimbable (4jr one-way door)', () => {
    const { names, facts: f } = menuOf(pocketBot(), pocketCtx({ x: 8, y: 45, z: 0 }))
    assert.ok(f.goalDist !== null && f.goalDist <= 24)
    assert.ok(!names.includes('dig_pillar'))
  })

  it('a goal below never climbs away from itself', () => {
    const { names } = menuOf(pocketBot(), pocketCtx({ x: 0, y: 15, z: 0 }))
    assert.ok(!names.includes('dig_pillar'))
  })

  // A 3x3 ceiling slab over open ground: capped, head diggable, but the
  // body walks out — offering the climb here would change normal pads.
  function openSlabBot() {
    const cells = {}
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) cells[`${x},47,${z}`] = 'stone'
    }
    const bot = pocketBot({ cells })
    const keep = bot.blockAt
    bot.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (`${x},${y},${z}` in cells) return keep(p)
      if (y >= 45) return { name: 'air', position: new Vec3(x, y, z), boundingBox: 'empty' }
      return { name: 'stone', position: new Vec3(x, y, z), boundingBox: 'block' }
    }
    return bot
  }

  it('capped but open ground never offers: the menu is master-identical', () => {
    const { facts: f, names } = menuOf(openSlabBot(), pocketCtx())
    assert.equal(f.boxed, false)
    assert.deepEqual(names, ['sidestep', 'wait'])
    assert.equal(recover.recoverFsm(f, names), 'sidestep')
  })

  it('capped-open head still digs: the gate is boxed, not diggability', () => {
    const { facts: f } = menuOf(openSlabBot(), pocketCtx())
    assert.equal(f.digPillar, true, 'head digs — but nobody is buried')
  })

  it('facts text carries no boxed word (stand replays keep parsing)', () => {
    const { facts: f } = menuOf(pocketBot(), pocketCtx())
    assert.equal(
      recover.recoverText(f),
      'stuck=fresh goal=high dist=25 scaffold=64 pickaxe=no bucket=no water=no ' +
      'head=blocked walls=0 pit=no player=none resets=0/0 last=none'
    )
  })
})

describe('dig_pillar run (vmzq.43)', () => {
  it('digs exactly the head cell, then pillars through it', async () => {
    const bot = pocketBot()
    const ctx = pocketCtx()
    const cap = capture()
    try {
      const r = await recover.decide(bot, ctx, null, null)
      assert.equal(r.action, 'dig_pillar')
      // Dig ticks until the head breaks.
      for (let t = 0; t < 6 && bot.dug.length < 1; t++) {
        recover.run(bot, ctx)
        await flush()
      }
      assert.deepEqual(bot.dug, ['0,47,0'], `head first and only, dug ${bot.dug}`)
      // Transition tick: headroom clear, the jump starts.
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.st.dphase, 'pillar')
      // The mock has no jump physics: sample the leap above the trigger
      // height while rising, like a real jump tick would.
      bot.entity.position = pos(0.5, 45.7, 0.5)
      bot.entity.velocity = { x: 0, y: 0.5, z: 0 }
      await sleep(250) // the +150 ms jump-start timer issues
      await flush()
      recover.run(bot, ctx)
      assert.equal(bot._places, 1)
      assert.deepEqual(bot._equips, [['cobblestone', 'hand']])
      assert.equal(ctx.recovery.status, 'done')
    } finally { cap.release() }
  })

  it('an off-centre stance steers to the middle before pillaring (r2)', async () => {
    // Revmux 01 major 2: at frac-x 0.2 the west lip is in jump reach and
    // the pillar veto would fail the handoff — the centre phase walks out
    // of reach first. The mock has no physics: the test moves the body.
    const bot = pocketBot({ at: [0.2, 45, 0.5] })
    const ctx = pocketCtx()
    const cap = capture()
    try {
      const r = await recover.decide(bot, ctx, null, null)
      assert.equal(r.action, 'dig_pillar')
      for (let t = 0; t < 6 && bot.dug.length < 1; t++) {
        recover.run(bot, ctx)
        await flush()
      }
      assert.deepEqual(bot.dug, ['0,47,0'])
      recover.run(bot, ctx) // head clear -> centre steers, not pillars
      assert.equal(ctx.recovery.st.dphase, 'centre')
      assert.equal(ctx.recovery.status, 'running')
      assert.equal(bot.controls.forward, true)
      assert.deepEqual(bot.looks, [[0.5, 0.5]])
      bot.entity.position = pos(0.5, 45, 0.5) // the walk lands mid-cell
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.st.dphase, 'pillar')
      assert.equal(bot.controls.forward, false)
      assert.equal(bot.controls.jump, true)
    } finally { cap.release() }
  })

  it('a sealed shaft skips the walk: no lips, no cost (r2)', async () => {
    const cells = {}
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      cells[`${x},45,${z}`] = 'stone'
      cells[`${x},46,${z}`] = 'stone'
    }
    const bot = pocketBot({ cells, at: [0.2, 45, 0.5] })
    const ctx = pocketCtx()
    const cap = capture()
    try {
      await recover.decide(bot, ctx, null, null)
      for (let t = 0; t < 6 && bot.dug.length < 1; t++) {
        recover.run(bot, ctx)
        await flush()
      }
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.st.dphase, 'pillar', 'no lips in reach: straight to the jump')
      assert.ok(!bot.controls.forward)
      assert.deepEqual(bot.looks, [])
    } finally { cap.release() }
  })

  it('the steer is bounded: past the budget the veto decides (r2)', async () => {
    const bot = pocketBot({ at: [0.2, 45, 0.5] })
    await bot.dig({ position: new Vec3(0, 47, 0) }) // head already clear
    const ctx = {
      stuck: { by: 'castle', goal: { x: 0, y: 70, z: 0 }, key: 'ticker' },
      recovery: {
        action: 'dig_pillar', source: 'fsm', model: null, status: 'running',
        st: { dphase: 'centre', steer: 8, startFloor: null, digInFlight: false, digError: false },
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.dphase, 'pillar', 'budget out: jump anyway, the veto guards a real bonk')
    assert.ok(!bot.controls.forward)
  })

  it('chains one block per cycle while the new head is rock', async () => {
    const bot = pocketBot()
    const ctx = pocketCtx()
    const cap = capture()
    try {
      await recover.decide(bot, ctx, null, null)
      // One finished cycle: dug the head, pillared, verified at 45.
      ctx.recovery.status = 'done'
      ctx.recovery.st = { dphase: 'pillar', startFloor: 45 }
      bot.entity.position = pos(0.5, 46, 0.5) // landed on the pillar
      const r = await recover.decide(bot, ctx, null, null)
      assert.equal(r.action, 'dig_pillar')
      assert.equal(ctx.recovery.repeats, 1)
      assert.equal(ctx.recovery.status, 'running')
    } finally { cap.release() }
  })

  it('a protected head fails honest without digging', async () => {
    const bot = pocketBot()
    const ctx = pocketCtx()
    ctx.home = {
      site: { x: 0, y: 45, z: 0 },
      interior: { min: { x: -2, y: 40, z: -2 }, max: { x: 2, y: 48, z: 2 } },
      v: 1,
    }
    const cap = capture()
    try {
      assert.ok(menuOf(bot, ctx).names.includes('dig_pillar'), 'protection refuses at dig time, like dig_step')
      const r = await recover.decide(bot, ctx, null, null)
      assert.equal(r.action, 'dig_pillar')
      recover.run(bot, ctx)
      await flush()
      assert.equal(ctx.recovery.status, 'failed:protected')
      assert.deepEqual(bot.dug, [])
    } finally { cap.release() }
  })

  it('a failed dig_pillar yields to the next feasible primitive', async () => {
    const bot = pocketBot()
    const { facts: f } = menuOf(bot, pocketCtx())
    const names = ['dig_pillar', 'sidestep', 'wait']
    assert.equal(recover.recoverFsm({ ...f, last: 'dig_pillar:failed:lava' }, names), 'sidestep')
    // And the model never gets re-asked the failed kind (4jr exclusion).
    const seen = []
    const brain = { source: 'laya', ask: async (q) => { seen.push(Object.keys(q.criteria)); return 'sidestep' } }
    const cap = capture()
    let r
    try {
      r = await recover.chooseRecovery(brain, { ...f, last: 'dig_pillar:failed:lava' }, names)
    } finally { cap.release() }
    assert.deepEqual(seen, [['sidestep', 'wait']])
    assert.equal(r.action, 'sidestep')
  })

  it('a dig_pillar refusal retires pillar_up at the spot too (r2)', async () => {
    // The refusal breaks the spot, not the kind: with the head dug,
    // pillar_up would otherwise retry the same refused cell next.
    const bot = pocketBot()
    const ctx = pocketCtx()
    ctx.recovery = {
      action: 'dig_pillar', source: 'fsm', model: null, status: 'failed:place-error',
      st: { dphase: 'pillar', startFloor: 45 }, attempts: 1, fails: 0, repeats: 0,
      last: null, calledPlayer: false, endEpisode: false, lastDy: null, lastY: null,
      flats: 0, placeError: false,
    }
    const cap = capture()
    let r
    try {
      r = await recover.decide(bot, ctx, null, null)
    } finally { cap.release() }
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true)
    assert.notEqual(r.action, 'pillar_up')
  })

  it('the rise veto fires pre-rise and only pre-rise (r2)', () => {
    // Pre-rise with a blocked head: the old gate stands.
    const pre = pocketBot()
    const preCtx = {
      stuck: { by: 'test', goal: { x: 0, y: 70, z: 0 }, key: 'test' },
      recovery: {
        action: 'pillar_up', source: 'fsm', model: null, status: 'running',
        st: { phase: 'jump', startFloor: 45, waited: 0, timerArmed: true, placeInFlight: false, placed: false, placeError: false },
      },
    }
    recover.run(pre, preCtx)
    assert.equal(preCtx.recovery.status, 'failed:head-blocked')
    // Risen with a blocked new head and the pillar underfoot: the climb
    // verifies instead of vetoing (rig c42b: every post-rise tick failed).
    const post = pocketBot({ at: [0.5, 46, 0.5], cells: { '0,45,0': 'cobblestone' } })
    const postCtx = {
      stuck: { by: 'test', goal: { x: 0, y: 70, z: 0 }, key: 'test' },
      recovery: {
        action: 'pillar_up', source: 'fsm', model: null, status: 'running',
        st: { phase: 'place', startFloor: 45, waited: 0, timerArmed: false, placeInFlight: false, placed: true, placeError: false },
      },
    }
    recover.run(post, postCtx)
    assert.equal(postCtx.recovery.status, 'done')
  })

  it('registry parity: order, menu, criteria and the climb chain cap', () => {
    assert.deepEqual(Object.keys(recover.RECOVER_CRITERIA).sort(), [...recover.RECOVER_ORDER].sort())
    assert.deepEqual(Object.keys(recover.RECOVER_MENU).sort(), [...recover.RECOVER_ORDER].sort())
    const i = recover.RECOVER_ORDER.indexOf('dig_pillar')
    assert.ok(i > recover.RECOVER_ORDER.indexOf('water_up'), 'after the funded climbers')
    assert.ok(i < recover.RECOVER_ORDER.indexOf('dig_step'), 'before the staircase')
    assert.equal(recover.RECOVER_MENU.dig_pillar.chainCap, 32)
    for (const n of ['pillar_up', 'dig_up', 'water_up', 'dig_step']) {
      assert.equal(recover.RECOVER_MENU[n].chainCap, undefined, `${n} keeps the shared REPEATS bound`)
    }
  })
})
