'use strict'

// Castle stairs part 1 (idkcraft-g0z.47): v3 facing-aware placement,
// state-aware done(), the mis-faced dig/relay loop, castlefetch sourcing
// and residence adoption — all offline, on fake worlds.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const build = require('../src/behaviours/build')
const fetch = require('../src/behaviours/castlefetch')
const residence = require('../src/residence')
const { protectedReason } = require('../src/behaviours/util')

const SITE = { x: 100, y: 64, z: 200 }
const k3 = (x, y, z) => `${x},${y},${z}`
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// A stairs cell from the v3 plan (rot 0): the first ground-hall step.
function stairCell() {
  const c = blueprint.absPlan(SITE, 0, 3).cells.find((o) => o.kind === 'stairs')
  assert.ok(c && c.face, 'v3 has a faced stairs cell')
  return c
}

function block(name, x, y, z, props) {
  return {
    name,
    position: new Vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    getProperties: () => ({ ...(props || {}) }),
  }
}

describe('stairs done() (g0z.47)', () => {
  it('false for a wrong facing or top half, true for the plan state', () => {
    const c = stairCell()
    const want = blueprint.faceName(c.face)
    const botFor = (name, props) => ({ blockAt: () => block(name, c.x, c.y, c.z, props) })
    assert.equal(castleMod.done(botFor('cobblestone_stairs', { facing: want, half: 'bottom' }), c), true)
    assert.equal(castleMod.done(botFor('oak_stairs', { facing: want, half: 'bottom' }), c), true, 'any *_stairs')
    const wrong = want === 'north' ? 'south' : 'north'
    assert.equal(castleMod.done(botFor('cobblestone_stairs', { facing: wrong, half: 'bottom' }), c), false)
    assert.equal(castleMod.done(botFor('cobblestone_stairs', { facing: want, half: 'top' }), c), false)
    assert.equal(castleMod.done(botFor('cobblestone', {}), c), false)
    assert.equal(castleMod.done(botFor('air', {}), c), false)
    assert.equal(castleMod.done({ blockAt: () => null }, c), false)
  })

  it('stateAt reads name + facing + half; null when unreadable', () => {
    const c = stairCell()
    const bot = { blockAt: () => block('cobblestone_stairs', c.x, c.y, c.z, { facing: 'east', half: 'bottom' }) }
    assert.deepEqual(castleMod.stateAt(bot, c), { name: 'cobblestone_stairs', facing: 'east', half: 'bottom' })
    assert.equal(castleMod.stateAt({ blockAt: () => null }, c), null)
  })
})

describe('stairs placement (g0z.47)', () => {
  it('placeStairs looks along the face and places frozen with half bottom', async () => {
    const c = { x: 1, y: 64, z: 2, kind: 'stairs', face: { dx: 1, dz: 0 }, idx: 5 }
    const ref = { ref: block('cobblestone', 1, 63, 2), face: new Vec3(0, 1, 0) }
    const calls = { looks: [], faced: [] }
    const bot = {
      look: async (yaw, pitch) => { calls.looks.push([yaw, pitch]) },
      _placeBlockWithOptions: async (r, f, opts) => { calls.faced.push(opts) },
      placeBlock: async () => { throw new Error('must not re-look') },
    }
    await castleMod.placeStairs(bot, ref, c)
    assert.equal(calls.looks.length, 1)
    assert.equal(calls.looks[0][0], Math.atan2(-1, -0))
    assert.equal(calls.looks[0][1], 0)
    assert.deepEqual(calls.faced, [{ forceLook: 'ignore', half: 'bottom', swingArm: 'right' }])
  })

  it('findRef excludes only the top ref for stairs; sides still work', () => {
    // World: solid below the target, solid above it, air on the sides.
    const bot = {
      blockAt: (p) => {
        const n = (p.y === 63 || p.y === 65) && p.x === 0 && p.z === 0 ? 'cobblestone' : 'air'
        return { name: n, position: p, boundingBox: n === 'air' ? 'empty' : 'block' }
      },
    }
    const p = new Vec3(0, 64, 0)
    const plain = build.findRef(bot, p)
    assert.ok(plain, 'below ref without the exclusion')
    assert.deepEqual([plain.face.x, plain.face.y, plain.face.z], [0, 1, 0])
    // Only the top neighbour solid: excluded for stairs, usable otherwise.
    const topOnly = {
      blockAt: (q) => {
        const n = q.x === 0 && q.y === 65 && q.z === 0 ? 'cobblestone' : 'air'
        return { name: n, position: q, boundingBox: n === 'air' ? 'empty' : 'block' }
      },
    }
    assert.equal(build.findRef(topOnly, p, { excludeTop: true }), null)
    assert.ok(build.findRef(topOnly, p), 'other kinds still use the top ref')
    // A side neighbour stays usable for stairs.
    const side = {
      blockAt: (q) => {
        const n = q.x === 1 && q.y === 64 && q.z === 0 ? 'cobblestone' : 'air'
        return { name: n, position: q, boundingBox: n === 'air' ? 'empty' : 'block' }
      },
    }
    const r = build.findRef(side, p, { excludeTop: true })
    assert.ok(r, 'side ref for stairs')
    assert.deepEqual([r.face.x, r.face.y, r.face.z], [-1, 0, 0])
  })
})

describe('stairs protection (g0z.47)', () => {
  const st = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 3 })

  it('a mis-faced stair is not protected; the right one is', () => {
    const c = stairCell()
    const pos = { x: c.x, y: c.y, z: c.z }
    const want = blueprint.faceName(c.face)
    assert.equal(blueprint.protects(st(), pos, 'cobblestone_stairs', { facing: want, half: 'bottom' }), true)
    assert.equal(blueprint.protects(st(), pos, 'cobblestone_stairs', { facing: 'north', half: 'bottom' }) === (want === 'north'), true)
    const wrong = want === 'north' ? 'south' : 'north'
    assert.equal(blueprint.protects(st(), pos, 'cobblestone_stairs', { facing: wrong, half: 'bottom' }), false)
    assert.equal(blueprint.protects(st(), pos, 'cobblestone_stairs', { facing: want, half: 'top' }), false)
    assert.equal(blueprint.protects(st(), pos, 'cobblestone_stairs'), true, 'name-only callers still read laid')
    assert.equal(blueprint.protects(st(), pos, 'dirt'), false)
  })

  it('protectedReason: the castle step clears a mis-faced stair, others hit protected', () => {
    const c = stairCell()
    const want = blueprint.faceName(c.face)
    const wrong = want === 'north' ? 'south' : 'north'
    const mis = block('cobblestone_stairs', c.x, c.y, c.z, { facing: wrong, half: 'bottom' })
    const right = block('cobblestone_stairs', c.x, c.y, c.z, { facing: want, half: 'bottom' })
    const bot = { blockAt: () => null }
    assert.equal(protectedReason(bot, mis, { castle: st(), castleClear: true }), null)
    assert.equal(protectedReason(bot, mis, { castle: st() }), 'protected', 'no castleClear: default-deny')
    assert.equal(protectedReason(bot, right, { castle: st(), castleClear: true }), 'protected')
    assert.equal(protectedReason(bot, right, { castle: st() }), 'protected')
  })
})

describe('stairs dig/relay loop (g0z.47)', () => {
  // Fake world where the castle's next cell is one stairs cell; the place
  // lays with the facing the fake chooses, so the loop is drivable.
  function loopBot({ lay = 'right' } = {}) {
    const c = stairCell()
    const world = new Map()
    const paint = (name, props) => world.set(k3(c.x, c.y, c.z), { name, props })
    paint('cobblestone_stairs', { facing: 'north', half: 'bottom' }) // overwritten per test
    const cells = blueprint.absPlan(SITE, 0, 3).cells
    for (const o of cells) {
      if (o.idx >= c.idx || !blueprint.isPlaceTarget(o.kind)) continue
      world.set(k3(o.x, o.y, o.z), { name: o.kind === 'stairs' ? 'cobblestone_stairs' : 'cobblestone', props: {} })
    }
    const calls = { looks: [], faced: [], digs: 0 }
    const bot = {
      calls, paint,
      entity: { position: new Vec3(c.x + 0.5, c.y, c.z + 2.5) },
      inventory: { items: () => [{ name: 'cobblestone_stairs', count: 64 }] },
      players: {},
      world: { getBlock: () => null },
      blockAt: (p) => {
        const k = k3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
        if (world.has(k)) {
          const e = world.get(k)
          return block(e.name, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), e.props)
        }
        const n = Math.floor(p.y) < SITE.y ? 'dirt' : 'air'
        return block(n, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), {})
      },
      look: async (yaw) => { calls.looks.push(yaw) },
      lookAt: async () => {},
      equip: async () => {},
      _placeBlockWithOptions: async (ref, face) => {
        calls.faced.push(true)
        const p = ref.position.offset(face.x, face.y, face.z)
        const want = blueprint.faceName(c.face)
        paint('cobblestone_stairs', { facing: lay === 'right' ? want : want === 'north' ? 'south' : 'north', half: 'bottom' })
        world.set(k3(p.x, p.y, p.z), world.get(k3(c.x, c.y, c.z)))
      },
      placeBlock: async () => { throw new Error('stairs must use the faced path') },
      dig: async (b) => {
        calls.digs++
        world.set(k3(b.position.x, b.position.y, b.position.z), { name: 'air', props: {} })
      },
      pathfinder: { isMoving: () => false, setGoal() {}, goal: null, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
      chat() {},
    }
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} } }
    return { bot, ctx, c }
  }

  it('wrong facing -> dug -> relaid right -> done', async () => {
    const { bot, ctx, c } = loopBot({ lay: 'right' })
    const want = blueprint.faceName(c.face)
    const wrong = want === 'north' ? 'south' : 'north'
    bot.paint('cobblestone_stairs', { facing: wrong, half: 'bottom' })
    assert.equal(castleMod.done(bot, c), false)
    for (let i = 0; i < 12; i++) { castleMod(bot, ctx); await settle() }
    assert.ok(bot.calls.digs >= 1, 'the mis-faced stair was dug')
    assert.ok(bot.calls.faced.length >= 1, 'it was relaid through the faced path')
    assert.equal(castleMod.done(bot, c), true)
    assert.equal(bot.calls.looks.length, bot.calls.faced.length, 'one look per faced place')
    assert.deepEqual(Object.keys(ctx.castle.blocked), [], 'no hole left behind')
  })

  it('placeCell asks findRef to exclude the top ref for stairs (revmux 01 core-5)', async () => {
    const { bot, ctx, c } = loopBot({ lay: 'right' })
    bot.paint('air', {})
    const real = build.findRef
    const opts = []
    build.findRef = (b, p, o) => { opts.push(o); return real(b, p, o) }
    try { for (let i = 0; i < 12; i++) { castleMod(bot, ctx); await settle() } } finally { build.findRef = real }
    assert.ok(opts.length >= 1, 'placeCell reached findRef')
    assert.ok(opts.every((o) => o && o.excludeTop), 'stairs ask for excludeTop')
  })

  it('a placement bug that keeps laying wrong blocks after STRIKES, never loops', async () => {
    const { bot, ctx, c } = loopBot({ lay: 'wrong-always' })
    // The fake always lays the opposite facing, so every lay is wrong.
    bot.paint('air', {})
    for (let i = 0; i < 30; i++) { castleMod(bot, ctx); await settle() }
    const entry = ctx.castle.blocked[`3:${c.idx}`]
    assert.ok(entry, 'the cell blocked')
    assert.equal(entry.tries, 1, 'one block after STRIKES wrong lays')
    assert.ok(bot.calls.faced.length <= castleMod.STRIKES + 1, `bounded places: ${bot.calls.faced.length}`)
    assert.ok(bot.calls.digs <= castleMod.STRIKES, `bounded digs: ${bot.calls.digs}`)
  })
})

describe('stairs sourcing (g0z.47)', () => {
  const realFact = castleMod.menuFact
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    castleMod.menuFact = realFact
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  function fetchBot(items = []) {
    return {
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => items },
      registry: { itemsByName: { cobblestone_stairs: {}, oak_stairs: {} }, blocksByName: {} },
      findBlocks: () => [],
      pathfinder: { isMoving: () => false, setGoal() {}, goal: null },
      blockAt: () => null,
      chat() {},
    }
  }

  it('stairs-none crafts cobblestone_stairs', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stairs', left: 60 }; return 'stairs-none' }
    const asked = []
    fetch.deps.craftItem = (bot, ctx, names, n) => { asked.push([names, n]); return 'running' }
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} } }
    fetch(fetchBot([{ name: 'cobblestone', count: 64 }]), ctx)
    assert.deepEqual(asked, [[['cobblestone_stairs'], 4]])
  })

  it('short on cobble (variants, or only the reserve) digs instead of crafting (revmux 01 core-1/6)', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stairs', left: 60 }; return 'stairs-none' }
    for (const items of [[{ name: 'andesite', count: 30 }], [{ name: 'cobblestone', count: 29 }]]) {
      const asked = []
      fetch.deps.craftItem = (bot, ctx, names, n) => { asked.push(names); return 'running' }
      const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} } }
      fetch(fetchBot(items), ctx) // no pickaxe: digTick ends the leg at once (equip rearms)
      assert.deepEqual(asked, [])
      assert.equal(ctx.stepStatus, 'done')
    }
  })

  it('a craft in flight owns the tick: the grid-held cobble never starts the dig (neuc.50)', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stairs', left: 60 }; return 'stairs-none' }
    fetch.deps.craftItem = () => { throw new Error('the in-flight tick must not re-enter the craft') }
    const ctx = { gearInFlight: true, castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} } }
    fetch(fetchBot([{ name: 'cobblestone', count: 23 }]), ctx) // 6 of 29 in the table grid mid-craft
    assert.equal(ctx.stepStatus, undefined, 'no dig leg ended the step mid-craft')
    ctx.gearInFlight = false
    fetch(fetchBot([{ name: 'cobblestone', count: 23 }]), ctx)
    assert.equal(ctx.stepStatus, 'done', 'the op over, short cobble digs again')
  })

  it('a live castle builder batch owns the body: wait while it lays, stop it once idle (neuc.63)', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stairs', left: 60 }; return 'stairs-none' }
    fetch.deps.craftItem = () => { throw new Error('no craft under a live builder') }
    const ctx = { castleBuildFlight: true, castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} } }
    let stops = 0
    const bot = fetchBot([{ name: 'cobblestone', count: 64 }])
    bot._build = { grownAt: Date.now(), preempted: false }
    bot.stopBuild = () => { stops++; bot._build.preempted = true; return Promise.resolve({ stopped: true }) }
    fetch(bot, ctx)
    assert.equal(stops, 0, 'a growing batch keeps laying')
    assert.equal(ctx.stepStatus, undefined)
    bot._build.grownAt = Date.now() - fetch.BUILDER_IDLE_MS - 1
    fetch(bot, ctx)
    fetch(bot, ctx)
    assert.equal(stops, 1, 'an idle batch is stopped once')
    assert.equal(ctx.stepStatus, undefined, 'still waiting for the preempted final')
  })

  it('stairs are castle material on v3 only; usable above a zero reserve', () => {
    assert.equal(fetch.FETCH.stairs, 16)
    assert.equal(castleMod.isMaterial('cobblestone_stairs', { blueprintVersion: 3 }), true)
    assert.equal(castleMod.isMaterial('oak_stairs', { blueprintVersion: 3 }), true)
    assert.equal(castleMod.isMaterial('cobblestone_stairs', { blueprintVersion: 2 }), false)
    assert.equal(castleMod.reserveOf('stairs'), 0)
    const bot = { inventory: { items: () => [{ name: 'cobblestone_stairs', count: 5 }] } }
    assert.equal(castleMod.usable(bot, 'stairs'), 5)
    assert.equal(castleMod.kindOf('cobblestone_stairs'), 'stairs')
  })
})

describe('stairs residence + rig paint (g0z.47)', () => {
  it('standing on any ground-stair step (low half feet at y+0.5) reads inside (codex P2)', () => {
    const home = { kind: 'castle', site: { ...SITE }, rot: 0 }
    const c = residence.CASTLE
    for (const [x, y, z] of [[8, 0, 12], [9, 1, 12], [10, 2, 12]]) {
      for (const dy of [0.5, 1.0]) {
        assert.equal(c.interior(home, { x: SITE.x + x + 0.5, y: SITE.y + y + dy, z: SITE.z + z + 0.5 }), true, `step ${x},${y},${z} feet +${dy}`)
      }
    }
  })

  it('a complete v3 castle is adopted; v1 still is not', () => {
    const v3 = { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'complete' }
    const home = residence.wanted({ castle: v3, home: null })
    assert.ok(home && home.kind === 'castle', 'v3 adopted')
    assert.equal(residence.wanted({ castle: { ...v3, blueprintVersion: 1 }, home: null }), undefined)
  })

  it('the rig seeds v3 stairs with facing; read-back checks it', () => {
    const { seedCastleCells, seedMatches } = require('../tools/castle-replay')
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 3 }
    const cells = seedCastleCells(st)
    const stairs = cells.filter((c) => c.kind === 'stairs')
    assert.equal(stairs.length, 60)
    for (const c of stairs) assert.match(c.block, /^cobblestone_stairs\[facing=(north|south|east|west),half=bottom\]$/)
    const one = stairs[0]
    const want = /facing=([a-z]+)/.exec(one.block)[1]
    assert.equal(seedMatches(one, 'cobblestone_stairs', { facing: want, half: 'bottom' }), true)
    assert.equal(seedMatches(one, 'cobblestone_stairs', { facing: 'north', half: 'bottom' }) === (want === 'north'), true)
    assert.equal(seedMatches(one, 'cobblestone_stairs'), true, 'name-only still matches')
    assert.equal(seedMatches(one, 'air'), false)
    const v2 = seedCastleCells({ site: { ...SITE }, rot: 0, blueprintVersion: 2 })
    assert.equal(v2.filter((c) => c.kind === 'stairs').length, 0, 'a v2 seed paints no stairs')
  })
})
