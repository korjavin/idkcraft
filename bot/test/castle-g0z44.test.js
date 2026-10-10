'use strict'

// idkcraft-g0z.44: castle yard discipline — no own blocks on the fence ring
// (A* place guard + recover pillar + dig-in cap), a post-complete fence-band
// sweep, and no natural digging inside the yard. A 1-high block beside the
// fence is a mob foothold over it (vanilla step 0.6), so the yard ring (the
// site box grown by 1, dy 0..16) takes no placements and the yard takes no
// natural digs except the castle step's own work.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const recover = require('../src/behaviours/recover')
const { protectedReason } = require('../src/behaviours/util')

const SITE = { x: 100, y: 64, z: 200 }
const st2 = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, ...extra })
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Map-backed world, air unless set. Ground names the unset cells (null = air).
function worldBot(cells, opts = {}) {
  const bot = {
    entity: { position: pos(0.5, 62, 0.5), onGround: true },
    inventory: { items: () => opts.items || [] },
    heldItem: null,
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState(c, v) { (this.controls = this.controls || {})[c] = !!v },
    getControlState(c) { return !!(this.controls && this.controls[c]) },
    clearControlStates() { this.controls = {} },
    chat(m) { (this.chats = this.chats || []).push(String(m)) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (opts.ground ? opts.ground(x, y, z) : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) {
      bot._places = (bot._places || 0) + 1
      if (!bot.heldItem) throw new Error('must be holding an item to place')
      const d = ref.position.plus(face)
      cells.set(key(d.x, d.y, d.z), bot.heldItem.name)
    },
  }
  return bot
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('g0z.44 yardRing: the site box grown by 1, dy 0..16', () => {
  const st = st2({ phase: 'body' })
  it('holds on the ring, fails one further out and above/below', () => {
    assert.equal(blueprint.yardRing(st, { x: 99, y: 64, z: 200 }), true, 'dx -1 dy 0')
    assert.equal(blueprint.yardRing(st, { x: 100, y: 67, z: 227 }), true, 'dz d dy 3')
    assert.equal(blueprint.yardRing(st, { x: 131, y: 64, z: 200 }), true, 'dx w')
    assert.equal(blueprint.yardRing(st, { x: 110, y: 80, z: 210 }), true, 'dy 16')
    assert.equal(blueprint.yardRing(st, { x: 98, y: 64, z: 200 }), false, 'dx -2')
    assert.equal(blueprint.yardRing(st, { x: 100, y: 64, z: 228 }), false, 'dz d+1')
    assert.equal(blueprint.yardRing(st, { x: 100, y: 63, z: 200 }), false, 'dy -1')
    assert.equal(blueprint.yardRing(st, { x: 100, y: 81, z: 210 }), false, 'dy 17')
    assert.equal(blueprint.yardRing(st, { x: 0, y: 64, z: 0 }), false, 'far')
    assert.equal(blueprint.yardRing({}, { x: 100, y: 64, z: 200 }), false, 'no site')
    assert.equal(blueprint.yardRing(st, null), false, 'no pos')
  })
})

describe('g0z.44 fence band: within 1 of the ring line, dy 0..3', () => {
  const st = st2()
  it('covers the ring strips, not the interior or dy 4', () => {
    const cells = blueprint.fenceBandCells(st)
    const has = (x, y, z) => cells.some((c) => c.x === x && c.y === y && c.z === z)
    assert.equal(cells.length, 1344, 'v2 band cell count')
    assert.ok(has(99, 64, 200), 'outside the west line')
    assert.ok(has(100, 64, 200), 'on the ring (fence plan cell)')
    assert.ok(has(101, 64, 200), 'inside the west line')
    assert.ok(has(100, 67, 227), 'outside the south line, dy 3')
    assert.ok(has(99, 64, 199), 'the corner neighbourhood')
    assert.ok(!has(98, 64, 200), 'two out')
    assert.ok(!has(102, 64, 210), 'interior')
    assert.ok(!has(100, 68, 200), 'dy 4')
    assert.ok(!has(100, 63, 200), 'dy -1')
    assert.equal(new Set(cells.map((c) => key(c.x, c.y, c.z))).size, cells.length, 'deduped')
  })

  it('ownBandCells: own-placed band cells, off plan and off decor', () => {
    const placed = new Set(['99,64,200', '100,64,200', '0,64,0'])
    const out = blueprint.ownBandCells(placed, st).map((c) => key(c.x, c.y, c.z))
    assert.deepEqual(out, ['99,64,200'], 'the fence plan cell and the far key drop out')
    assert.deepEqual(blueprint.ownBandCells(new Set(), st), [])
    assert.deepEqual(blueprint.ownBandCells(placed, {}), [])
  })
})

describe('g0z.44 guardCastle: the ring vetoes places and yard digs', () => {
  function guarded() {
    const bot = worldBot(new Map())
    bot.pathfinder.movements = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
    const ctx = { castle: st2({ phase: 'body' }) }
    castle.guardCastle(bot, ctx)
    return { bot, ctx }
  }
  it('placeFn 100 on the ring, 0 one further out, box and moat as before', () => {
    const { bot } = guarded()
    const place = bot.pathfinder.movements.exclusionAreasPlace[0]
    assert.equal(place({ position: { x: 99, y: 64, z: 200 } }), 100, 'dx -1')
    assert.equal(place({ position: { x: 98, y: 64, z: 200 } }), 0, 'dx -2')
    assert.equal(place({ position: { x: 100, y: 64, z: 227 } }), 100, 'dz d')
    assert.equal(place({ position: { x: 105, y: 64, z: 203 } }), 100, 'box interior as before')
    assert.equal(place({ position: { x: 115, y: 63, z: 213 } }), 0, 'terrain below as before')
    assert.equal(place({ position: { x: 103, y: 63, z: 203 } }), 100, 'moat pit as before')
  })
  it('breakFn 100 for yard ground, 0 for plan cells and flora', () => {
    const { bot } = guarded()
    const fn = bot.pathfinder.movements.exclusionAreasBreak[0]
    assert.equal(fn({ name: 'grass_block', position: { x: 115, y: 65, z: 213 } }), 100, 'off-plan yard pad')
    assert.equal(fn({ name: 'dirt', position: { x: 111, y: 64, z: 207 } }), 0, 'wrong occupant of a wall cell')
    assert.equal(fn({ name: 'stone', position: { x: 103, y: 63, z: 203 } }), 0, 'moat dig cell')
    assert.equal(fn({ name: 'snow', position: { x: 115, y: 65, z: 213 } }), 0, 'snow')
    assert.equal(fn({ name: 'oak_leaves', position: { x: 115, y: 65, z: 213 } }), 0, 'leaves')
    assert.equal(fn({ name: 'dirt', position: { x: 90, y: 64, z: 200 } }), 0, 'off the box')
  })
})

describe('g0z.44 yard dig ban in protectedReason', () => {
  const st = st2({ phase: 'body' })
  const YARD = { x: 115, y: 65, z: 213 } // inside the box, dy 1, off-plan
  it('natural yard ground is protected for every executor but the castle step', () => {
    assert.equal(protectedReason(null, { name: 'grass_block', position: YARD }, { castle: st }), 'protected')
    assert.equal(protectedReason(null, { name: 'dirt', position: YARD }, { castle: st }), 'protected')
    assert.equal(protectedReason(null, { name: 'grass_block', position: YARD }, { castle: st, castleClear: true }), null, 'prep cuts keep working')
    // Own dirt in the yard: the ban sits before the placedByBot exemption.
    const own = { castle: st, placedByBot: new Set([key(YARD.x, YARD.y, YARD.z)]) }
    assert.equal(protectedReason(null, { name: 'dirt', position: YARD }, own), 'protected')
    assert.equal(protectedReason(null, { name: 'dirt', position: YARD }, { ...own, castleClear: true }), null, 'the sweep still clears')
  })
  it('plan cells, flora and off-box ground stay as before', () => {
    assert.equal(protectedReason(null, { name: 'dirt', position: { x: 111, y: 64, z: 207 } }, { castle: st }), null, 'dirt in a stone plan cell')
    assert.equal(protectedReason(null, { name: 'dirt', position: { x: 103, y: 63, z: 203 } }, { castle: st }), null, 'moat dig cell')
    assert.equal(protectedReason(null, { name: 'snow', position: YARD }, { castle: st }), null, 'snow')
    assert.equal(protectedReason(null, { name: 'oak_leaves', position: YARD }, { castle: st }), null, 'leaves')
    assert.equal(protectedReason(null, { name: 'coal_ore', position: YARD }, { castle: st }), null, 'ores')
    assert.equal(protectedReason(null, { name: 'dirt', position: { x: 90, y: 64, z: 200 } }, { castle: st }), null, 'off the box')
  })
})

describe('g0z.44 recover pillar: place-protected on the ring', () => {
  // Feet (0,61,0), solid below: a v1 site at x=1 puts the feet cell on the
  // ring (dx -1), a site at x=2 two cells out.
  function pillarBot() {
    const cells = new Map()
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.set(key(x, 60, z), 'dirt')
    const bot = worldBot(cells, { items: [{ name: 'dirt', count: 10 }] })
    bot.entity.position = pos(0.5, 62, 0.5)
    return bot
  }
  function pillarCtx(siteX) {
    return {
      stuck: { by: 'test', goal: { x: 0, y: 64, z: 0 } },
      castle: { site: { x: siteX, y: 61, z: 0 }, rot: 0 },
      recovery: {
        action: 'pillar_up', source: 'stub', model: null, status: 'running',
        st: { phase: 'place', startFloor: 61, waited: 0, placeInFlight: false, placed: false, placeError: false },
      },
    }
  }
  it('tick path: refused on the ring, placed two cells out', async () => {
    const bot = pillarBot()
    const ctx = pillarCtx(1)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:place-protected')
    assert.equal(bot._places || 0, 0, 'no placement attempted')
    const out = pillarBot()
    const octx = pillarCtx(2)
    recover.run(out, octx)
    assert.equal(octx.recovery.status, 'running')
    await flush()
    recover.run(out, octx)
    assert.equal(octx.recovery.status, 'done')
    assert.equal(out._places, 1)
  })
  it('timer path: the +150 ms fire refuses the same way', async () => {
    const bot = pillarBot()
    bot.entity.position = pos(0.5, 61.7, 0.5)
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    const ctx = pillarCtx(1)
    ctx.recovery.st.phase = 'jump'
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await sleep(300)
    await flush()
    assert.equal(bot._places || 0, 0, 'the timer issued nothing')
    assert.equal(ctx.recovery.st.syncFail, 'place-protected')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:place-protected')
  })
  it('place-protected bans the pillar at the spot like place-error', () => {
    const ctx = {}
    recover.noteRecoverFail(ctx, { x: 0, y: 64, z: 0 }, 'pillar_up', 'failed:place-protected')
    assert.equal(recover.recoverBanned(ctx, 'pillar_up'), true, 'fast-forward to the ban')
    const facts = { goalDy: 1, scaffold: 1, headBlocked: false, placeError: false, water: false }
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(facts, ctx), false, 'the menu falls through')
  })
})

describe('g0z.44 dig-in cap: refused above ground on the ring, flush allowed', () => {
  function capBot(feetY) {
    const cells = new Map()
    for (let x = 97; x <= 101; x++) for (let z = 198; z <= 202; z++) for (let y = 58; y <= 61; y++) cells.set(key(x, y, z), 'dirt')
    cells.set(key(98, 64, 200), 'dirt') // a solid side neighbour for the cap reference
    const bot = worldBot(cells, { items: [{ name: 'dirt', count: 3 }] })
    bot.entity.position = pos(99.5, feetY, 200.5)
    return bot
  }
  it('a cap above site.y on the ring is refused', () => {
    const bot = capBot(63) // cap lands at 65, above the site
    const r = recover.digInRun(bot, { castle: st2({ phase: 'body' }) }, { capping: true })
    assert.equal(r, 'failed:place-protected')
    assert.equal(bot._places || 0, 0)
  })
  it('a flush cap lands', async () => {
    const bot = capBot(62) // cap lands at 64, the site level
    const st = { capping: true }
    assert.equal(recover.digInRun(bot, { castle: st2({ phase: 'body' }) }, st), 'running')
    await flush()
    assert.equal(bot._places, 1)
    assert.equal(recover.digInRun(bot, { castle: st2({ phase: 'body' }) }, st), 'done')
  })
})

describe('g0z.44 post-complete band sweep', () => {
  const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
  function painted() {
    const cells = new Map()
    for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
      if (blueprint.isPlaceTarget(c.kind)) cells.set(key(c.x, c.y, c.z), LAID[c.kind])
    }
    return cells
  }
  function closeDecor(cells) {
    for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
      cells.set(key(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : 'white_wall_banner')
    }
  }
  it('litterTargets (complete) lists own band blocks, never the owner path or plan cells', () => {
    const cells = painted()
    cells.set(key(99, 64, 200), 'dirt') // dx -1 dy 0, ours
    cells.set(key(100, 64, 227), 'cobblestone') // dz d, ours
    cells.set(key(98, 64, 200), 'cobblestone') // outside the box, NOT ours: the owner path
    cells.set(key(100, 64, 200), 'dirt') // a fence plan cell holding dirt, key and all
    const bot = worldBot(cells)
    const ctx = {
      castle: st2(),
      placedByBot: new Set([key(99, 64, 200), key(100, 64, 227), key(100, 64, 200)]),
    }
    const list = castle.litterTargets(bot, ctx, ctx.castle, Date.now())
    const got = list.map((c) => key(c.x, c.y, c.z)).sort()
    assert.deepEqual(got, [key(100, 64, 227), key(99, 64, 200)])
    const { d } = blueprint.siteDimensions(0, 2)
    for (const c of list) {
      const dx = c.x - SITE.x; const dy = c.y - SITE.y; const dz = c.z - SITE.z
      assert.equal(c.idx, 2000000 + ((dx + 1) * (d + 2) + (dz + 1)) * 40 + dy, 'the band idx shape')
    }
    assert.ok(ctx.castleLitter.key.includes('v2'), `blueprint in the cache key: ${ctx.castleLitter.key}`)
  })
  it('band idx are unique across the band', () => {
    const cells = painted()
    const band = blueprint.fenceBandCells(st2())
    const placed = new Set()
    for (const c of band) {
      cells.set(key(c.x, c.y, c.z), 'dirt')
      placed.add(key(c.x, c.y, c.z))
    }
    const bot = worldBot(cells)
    const ctx = { castle: st2(), placedByBot: placed }
    const list = castle.litterTargets(bot, ctx, ctx.castle, Date.now())
    assert.ok(list.length > 1000, `the band lists at scale, got ${list.length}`)
    assert.equal(new Set(list.map((c) => c.idx)).size, list.length, 'idx unique')
  })
  it('litterTargets (body) still scans the box, cobblestone by name', () => {
    const cells = painted()
    cells.set(key(105, 64, 205), 'cobblestone') // inside the box, no key
    const bot = worldBot(cells)
    const ctx = { castle: st2({ phase: 'body' }), placedByBot: new Set() }
    const list = castle.litterTargets(bot, ctx, ctx.castle, Date.now())
    assert.ok(list.some((c) => c.x === 105 && c.y === 64 && c.z === 205), 'box scan as before')
  })
  it("menuFact: 'clear' with workable band litter, 'done' once swept", () => {
    const cells = painted()
    closeDecor(cells)
    cells.set(key(99, 64, 200), 'dirt')
    const bot = worldBot(cells)
    const ctx = { castle: st2(), placedByBot: new Set([key(99, 64, 200)]) }
    assert.equal(castle.menuFact(bot, ctx), 'clear')
    cells.set(key(99, 64, 200), 'air')
    ctx.placedByBot.delete(key(99, 64, 200))
    assert.equal(castle.menuFact(bot, ctx), 'done')
  })
  it('menuFact: held decor wins, a dry decor word never hides litter', () => {
    const pane = blueprint.decorPlan(SITE, 0, 2).cells[0]
    const cells = painted()
    closeDecor(cells)
    cells.set(key(pane.x, pane.y, pane.z), 'air') // one open window
    cells.set(key(99, 64, 200), 'dirt')
    const keys = new Set([key(99, 64, 200)])
    const held = worldBot(cells, { items: [{ name: 'glass_pane', count: 8 }] })
    assert.equal(castle.menuFact(held, { castle: st2(), placedByBot: keys }), 'pane-batch', 'decor wins when held')
    const dry = worldBot(cells)
    assert.equal(castle.menuFact(dry, { castle: st2(), placedByBot: keys, castleFetchDry: 'pane' }), 'clear', 'dry falls through to litter')
    const fetching = worldBot(cells)
    cells.set(key(99, 64, 200), 'air')
    keys.delete(key(99, 64, 200))
    assert.equal(castle.menuFact(fetching, { castle: st2(), placedByBot: keys }), 'pane-none', 'the fetch trigger survives')
  })
})
