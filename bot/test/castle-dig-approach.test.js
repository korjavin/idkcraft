'use strict'

// Unreachable plan cells (prod 2026-11-16 bot3: torch cells 15-40 below,
// retired 'unreachable' x82, 'no castle material owed'): far() opens the
// stuck window for one dig-approach ladder before striking, and a retired
// open cell keeps its material on the castle word.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2

describe('castle dig-approach for unreachable cells', () => {
  it('far() opens the stuck window once, then strikes', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} }
    const ctx = { castle: st }
    const cell = { x: SITE.x, y: SITE.y - 20, z: SITE.z, kind: 'torch', idx: 5 }
    const bot = { entity: { position: new Vec3(SITE.x, SITE.y, SITE.z) } }
    const orig = console.log
    console.log = () => {}
    try {
      const now = Date.now()
      for (let i = 0; i <= castle.STRIKES; i++) castle.far(bot, ctx, st, cell, 4.5, now)
      assert.equal(st.blocked['2:5'], undefined, 'no strike yet')
      assert.ok(ctx.ownBreakUntil > now, 'stuck window open')
      for (let i = 0; i < castle.STRIKES; i++) castle.far(bot, ctx, st, cell, 4.5, now)
      assert.equal(st.blocked['2:5'], undefined, 'step mover next, no strike')
      assert.ok(ctx.castleFar.step, 'step mover armed')
      castle.far(bot, ctx, st, cell, 4.5, now) // no blockAt: the mover stops, the cell strikes
      assert.equal(st.blocked['2:5'].why, 'unreachable')
    } finally { console.log = orig }
  })

  // World: stone below y=64 except a lava pocket where asked, air above.
  function stepBot(lava, solidAt) {
    const goals = []
    const controls = {}
    const dug = []
    const world = new Map()
    const bot = {
      entity: { position: new Vec3(SITE.x + 0.5, SITE.y, SITE.z + 0.5) },
      inventory: { items: () => [] },
      pathfinder: { setGoal(g) { goals.push(g) }, goal: null },
      blockAt(p) {
        const k = `${p.x},${p.y},${p.z}`
        const name = world.get(k) || (lava && lava(p) ? 'lava' : (solidAt ? solidAt(p) : p.y < SITE.y) ? 'stone' : 'air')
        return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'stone' ? 'block' : 'empty', hardness: 1.5 }
      },
      async dig(b) { dug.push(b.position); world.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air') },
      async equip() {},
      setControlState(k, v) { controls[k] = v },
      lookAt() {},
    }
    return { bot, goals, dug, controls, world }
  }

  it('step mover digs a staircase down through the ladder, one leg at a time', async () => {
    // Walled in to the head (prod 28e156b1: stop=refused:below-feet): only the own column is open.
    const { bot, goals, dug, controls } = stepBot(null, (p) => p.y < SITE.y || (p.y < SITE.y + 2 && !(p.x === SITE.x && p.z === SITE.z)))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    const target = { x: SITE.x + 10, y: SITE.y - 20, z: SITE.z }
    const s = { legs: 0, wait: 0, w: null, digging: false, err: false }
    let r
    for (let i = 0; i < 8 && !s.w; i++) { r = castle.stepMove(bot, ctx, target, s); await new Promise((res) => setImmediate(res)) }
    assert.equal(r, 'running')
    // Diagonal-down stair: ahead-below and its headroom dug (below-feet passes), never the own column.
    assert.deepEqual(dug.map((p) => [p.x, p.y, p.z]).sort(), [[SITE.x + 1, SITE.y - 1, SITE.z], [SITE.x + 1, SITE.y, SITE.z], [SITE.x + 1, SITE.y + 1, SITE.z]].sort())
    assert.deepEqual(s.w, { x: SITE.x + 1, y: SITE.y - 1, z: SITE.z })
    castle.stepMove(bot, ctx, target, s)
    assert.equal(goals.length, 0, 'no pathfinder leg')
    assert.equal(controls.forward, true, 'direct walk into the stair')
    for (let i = 0; i < 6; i++) castle.stepMove(bot, ctx, target, s)
    assert.equal(castle.stepMove(bot, ctx, target, s), 'stall', 'a leg that never lands times out in ticks')
    assert.equal(controls.forward, false)
  })

  it('step mover refuses a stair over a deep drop', async () => {
    const { bot } = stepBot(null, (p) => p.y < SITE.y - 10)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    assert.equal(castle.stepMove(bot, ctx, { x: SITE.x + 10, y: SITE.y - 20, z: SITE.z }, { legs: 0, wait: 0, w: null }), 'fall')
  })

  it('a straight rise pillars through the recover prim', () => {
    const { bot } = stepBot()
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    const s = { legs: 0, wait: 0, w: null }
    const target = { x: SITE.x, y: SITE.y + 20, z: SITE.z }
    assert.equal(castle.stepMove(bot, ctx, target, s), 'running')
    assert.ok(s.rec, 'pillar leg armed')
    // No scaffold in the pack: the prim fails at once instead of hanging.
    assert.equal(castle.stepMove(bot, ctx, target, s), 'stall:no-scaffold')
    assert.equal(ctx.recovery, null)
  })

  it('step mover refuses lava next to the line', () => {
    const { bot } = stepBot((p) => p.x === SITE.x + 2 && p.y === SITE.y - 1)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    const r = castle.stepMove(bot, ctx, { x: SITE.x + 10, y: SITE.y - 20, z: SITE.z }, { legs: 0, wait: 0, w: null })
    assert.equal(r, 'lava')
  })

  // Moat (prod bot3: stop=fluid 21x): water ahead is bridged with fill, or swum with none.
  function moatBot(items) {
    const moat = (p) => p.x === SITE.x + 1 && p.y === SITE.y - 1
    const h = stepBot(null, (p) => p.y < SITE.y && !moat(p))
    const base = h.bot.blockAt
    const placed = []
    h.bot.blockAt = (p) => moat(p) && !placed.length ? { name: 'water', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty' } : base(p)
    h.bot.inventory.items = () => items
    h.bot.placeBlock = async (ref, face) => { placed.push(ref.position.plus(face)) }
    return { ...h, placed }
  }
  it('step mover bridges a water floor with a fill block', async () => {
    const { bot, placed } = moatBot([{ name: 'cobblestone', count: 32 }])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    const target = { x: SITE.x + 10, y: SITE.y, z: SITE.z }
    const s = { legs: 0, wait: 0, w: null }
    const orig = console.log
    console.log = () => {}
    try {
      assert.equal(castle.stepMove(bot, ctx, target, s), 'running')
      await new Promise((res) => setImmediate(res))
      assert.deepEqual(placed.map((p) => [p.x, p.y, p.z]), [[SITE.x + 1, SITE.y - 1, SITE.z]])
      assert.equal(castle.stepMove(bot, ctx, target, s), 'running')
      assert.deepEqual(s.w, { x: SITE.x + 1, y: SITE.y, z: SITE.z }, 'walks onto the bridge')
    } finally { console.log = orig }
  })
  it('step mover swims a water floor with nothing to bridge', () => {
    const { bot, placed } = moatBot([])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: {} } }
    const s = { legs: 0, wait: 0, w: null }
    assert.equal(castle.stepMove(bot, ctx, { x: SITE.x + 10, y: SITE.y, z: SITE.z }, s), 'running')
    assert.equal(placed.length, 0)
    assert.deepEqual(s.w, { x: SITE.x + 1, y: SITE.y, z: SITE.z })
  })

  it('stale retired open cells requeue and word their material', () => {
    const plan = blueprint.absPlan(SITE, 0, V)
    const torches = plan.cells.filter((c) => c.kind === 'torch')
    assert.ok(torches.length > 0)
    const open = new Set(torches.map((c) => `${c.x},${c.y},${c.z}`))
    const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest' }
    const bot = {
      entity: { position: { x: SITE.x + 5.5, y: SITE.y, z: SITE.z + 5.5 } },
      inventory: { items: () => [] }, players: {}, pathfinder: { goal: null }, chat() {},
      blockAt(p) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
        const k = `${x},${y},${z}`
        const c = plan.at.get(k)
        let name = 'air'
        if (!c) name = y < SITE.y ? 'dirt' : 'air'
        else if (!open.has(k) && blueprint.isPlaceTarget(c.kind)) name = LAID[c.kind] || 'cobblestone'
        return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const now = Date.now()
    // Retired past RETIRE_MS: the built castle's requeue re-arms them.
    const blocked = Object.fromEntries(torches.map((c) => [`2:${c.idx}`, { tries: 6, until: 0, why: 'unreachable', retired: true, retiredAt: now - 11 * 60 * 1000 }]))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'body', blocked } }
    const orig = console.log
    console.log = () => {}
    try {
      castle.menuFact(bot, ctx, now)
      assert.equal(ctx.castleWord && ctx.castleWord.kind, 'torch')
    } finally { console.log = orig }
  })
})
