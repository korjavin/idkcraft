'use strict'

// idkcraft-qphv.1: the farm structure (barn, pen, field) laid by the house
// builder on a farm-kind home — blueprint shape, site, an end-to-end build
// on a flat fake world, the house state left alone, and the menu wiring.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const fp = require('../src/farm-blueprint')
const farmbuild = require('../src/behaviours/farmbuild')
const { BEHAVIOURS } = require('../src/behaviours')
const { MENU, STEP_ORDER, STEP_CRITERIA } = require('../src/goal')

function world() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    cells,
    set(x, y, z, n) { cells.set(key(x, y, z), n) },
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      const fy = Math.floor(p.y)
      const name = cells.has(k) ? cells.get(k) : (fy === 63 ? 'grass_block' : fy < 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block', position: new Vec3(Math.floor(p.x), fy, Math.floor(p.z)) }
    },
  }
}

function mockBot(w) {
  const items = ['oak_planks', 'oak_fence', 'oak_fence_gate', 'oak_door', 'chest', 'wooden_hoe', 'water_bucket'].map((name) => ({ name, count: 64 }))
  let look = null
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    world: { getBlock: () => null },
    inventory: { items: () => items },
    blockAt: (p) => w.blockAt(p),
    held: null,
    chats: [],
    chat: (m) => bot.chats.push(m),
    pathfinder: {
      isMoving: () => false,
      // Teleport next to the goal: the fake has no walking.
      setGoal: (g) => {
        const t = g && (g.pos || (typeof g.x === 'number' ? g : null))
        if (t) bot.entity.position = new Vec3(t.x + 0.5, (typeof t.y === 'number' ? t.y : 64), (t.z || 0) - 1)
      },
    },
    equip: async (it) => { bot.held = it.name },
    dig: async (b) => w.set(b.position.x, b.position.y, b.position.z, 'air'),
    placeBlock: async (ref, face) => w.set(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z, bot.held),
    activateBlock: async (b) => { if (bot.held.endsWith('_hoe') && (b.name === 'dirt' || b.name === 'grass_block')) w.set(b.position.x, b.position.y, b.position.z, 'farmland') },
    lookAt: async (p) => { look = p },
    activateItem: async () => { if (bot.held === 'water_bucket' && look) w.set(look.x, look.y, look.z, 'water') },
  }
  return bot
}

const tick = () => new Promise((r) => setImmediate(r))

describe('farm blueprint (qphv.1)', () => {
  it('has a barn with door and chest, a fenced pen with one gate, and a 9x9 field around water', () => {
    const n = (k) => fp.PLAN.filter((c) => c.kind === k).length
    assert.equal(n('door'), 1)
    assert.equal(n('chest'), 1)
    assert.equal(n('gate'), 1)
    assert.equal(n('fence'), 31) // 9x9 ring minus the gate
    assert.equal(n('water'), 1)
    assert.equal(n('farmland'), 80)
    assert.equal(n('planks'), 21 * 2 + 42) // two wall rings + the roof
    const w = fp.PLAN.findIndex((c) => c.kind === 'water')
    assert.ok(w < fp.PLAN.findIndex((c) => c.kind === 'farmland'), 'water before farmland (hydration)')
  })

  it('finds a flat site clear of the castle box', () => {
    const w = world()
    const bot = mockBot(w)
    const s = fp.siteFor(bot, { x: 0, y: 64, z: 0 }, [{ x0: -10, z0: -10, x1: 10, z1: 10 }])
    assert.ok(s)
    assert.equal(s.y, 64)
    assert.ok(s.x + fp.W - 1 < -13 || s.x > 13 || s.z + fp.D - 1 < -13 || s.z > 13)
  })

  it('takes a field on sand with dirt soil cells under it', () => {
    const w = world()
    for (let x = -80; x <= 80; x++) for (let z = -80; z <= 80; z++) w.set(x, 63, z, 'sand')
    const s = fp.siteFor(mockBot(w), { x: 0, y: 64, z: 0 })
    assert.ok(s)
    assert.equal(s.prep.filter((c) => c.kind === 'soil' && c.dy === -1).length, 80) // the water pit is dug, not soiled
  })

  // qphv site prep: no flat strip anywhere — the cheapest graded site wins.
  function bumpy() {
    const w = world()
    for (let x = -80; x <= 80; x++) {
      for (let z = -80; z <= 80; z++) {
        const h = ((x * 7 + z * 13) % 5 + 5) % 5 // 0..4 relief: never 1-flat over 27x9
        for (let y = 64; y < 64 + h - 2; y++) w.set(x, y, z, 'stone')
        if (h < 2) for (let y = 63; y >= 64 + h - 2; y--) w.set(x, y, z, 'air')
        if (h !== 2) w.set(x, 64 + h - 3, z, 'grass_block')
      }
    }
    return w
  }

  it('picks the cheapest bumpy site with cut and fill prep cells before the barn', () => {
    const w = bumpy()
    const r = fp.pickSite(mockBot(w), { x: 0, y: 64, z: 0 }, [{ x0: -10, z0: -10, x1: 10, z1: 10 }])
    assert.ok(r.site, r.reason)
    assert.ok(r.tried > 100)
    const s = r.site
    assert.ok(s.cut > 0 && s.fill > 0 && s.cost === s.cut + s.fill)
    assert.ok(s.x + fp.W - 1 < -13 || s.x > 13 || s.z + fp.D - 1 < -13 || s.z > 13, 'clear of the castle')
    const plan = fp.planFor({ site: s })
    assert.equal(plan.length, s.prep.length + fp.PLAN.length)
    const kinds = new Set(s.prep.map((c) => c.kind))
    assert.ok(kinds.has('clear') && kinds.has('ground') && kinds.has('soil'))
    const lastCut = s.prep.map((c) => c.kind).lastIndexOf('clear')
    assert.ok(s.prep.findIndex((c) => c.kind !== 'clear') > lastCut, 'cuts before fills')
  })

  it('builds the farm on bumpy ground end to end', async () => {
    const w = bumpy()
    const bot = mockBot(w)
    bot.inventory.items().push({ name: 'dirt', count: 64 * 9 })
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, buildSkip: [], castle: null }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      for (let t = 0; t < 8000 && ctx.stepStatus === 'running'; t++) {
        farmbuild(bot, ctx)
        await tick()
      }
    } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done', logs.slice(-5).join('\n'))
    assert.ok(logs.some((l) => /^farm site=-?\d+,\d+,-?\d+ cost=[1-9]\d* cut=\d+ fill=\d+ tried=\d+$/.test(l)), logs.find((l) => l.startsWith('farm site')))
    const s = ctx.farmBuild.site
    const at = (dx, dy, dz) => w.blockAt({ x: s.x + dx, y: s.y + dy, z: s.z + dz }).name
    for (let dx = fp.FIELD.x0; dx <= fp.FIELD.x1; dx++) {
      for (let dz = fp.FIELD.z0; dz <= fp.FIELD.z1; dz++) {
        if (dx !== fp.WATER.dx || dz !== fp.WATER.dz) assert.equal(at(dx, -1, dz), 'farmland', `${dx},${dz}`)
      }
    }
    assert.equal(at(fp.DOOR.dx, 0, fp.DOOR.dz), 'oak_door')
  })

  it('logs no-site with tried and the reason', () => {
    const w = world()
    const bot = mockBot(w)
    bot.blockAt = () => null // nothing loaded
    bot.pathfinder.setGoal = () => {}
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try { for (let t = 0; t < 200 && ctx.stepStatus === 'running'; t++) farmbuild(bot, ctx) } finally { console.log = orig }
    assert.ok(/^farm no-site: walking to unloaded -?\d+,-?\d+ /.test(logs[0]), logs[0])
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.ok(logs.some((l) => /^farm failed:no-site tried=\d+ best=none reason=unloaded unloaded=\d+ built=0 castle=0 lava=0 deep=0 skipped=3$/.test(l)), logs.join('\n'))
  })

  it('a failed walk tries other unloaded targets each episode, then cools down (prod bot5 stuck loop)', () => {
    const w = world()
    const bot = mockBot(w)
    bot.blockAt = () => null
    bot.pathfinder.setGoal = () => {}
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const episode = () => {
      ctx.stepStatus = 'running'
      for (let t = 0; t < 200 && ctx.stepStatus === 'running'; t++) farmbuild(bot, ctx)
      return logs.splice(0).filter((l) => l.startsWith('farm no-site: walking'))
    }
    try {
      const a = episode()
      assert.equal(new Set(a).size, 3, a.join('\n'))
      assert.equal(ctx.stepStatus, 'failed:no-site')
      now += 60 * 1000
      assert.equal(episode().length, 0) // cooldown: fails at once, no walk
      now += 5 * 60 * 1000
      assert.equal(episode().length, 3) // after the cooldown it walks again, not once ever
    } finally { console.log = orig; Date.now = realNow }
  })

  it('walks toward the nearest unloaded candidate instead of failing', () => {
    const w = world()
    const bot = mockBot(w)
    const read = bot.blockAt
    bot.blockAt = (p) => (p.x > 20 ? read(p) : null) // only the far east is loaded... and too built to use
    w.blockAt = ((orig) => (p) => (p.y === 63 ? { ...orig(p), name: 'oak_planks' } : orig(p)))(w.blockAt)
    let goal = null
    bot.pathfinder.setGoal = (g) => { goal = g }
    const r = fp.pickSite(bot, bot.entity.position)
    assert.equal(r.site, null)
    assert.ok(r.why.unloaded > 0 && r.why.built > 0, JSON.stringify(r.why))
    assert.ok(r.walk)
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null }
    const orig = console.log
    console.log = () => {}
    try { farmbuild(bot, ctx) } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(goal && goal.x === r.walk.x && goal.z === r.walk.z)
  })

  it('an ordered spot (exact) sites the farm on the owner, not the cheapest spot (owner 2026-11-19)', () => {
    const w = world()
    const r = fp.pickSite(mockBot(w), { x: 100, y: 64, z: 40, exact: true })
    assert.ok(r.site, r.reason)
    assert.ok(Math.hypot(r.site.x + fp.W / 2 - 100, r.site.z + fp.D / 2 - 40) < 3, JSON.stringify(r.site))
  })

  it('prefers a far dry site over a near pond (owner: farm built over water)', () => {
    const w = world()
    const pond = (p) => p.x >= -20 && p.x <= 20 && p.z >= -20 && p.z <= 20
    w.blockAt = ((orig) => (p) => (p.y === 63 && pond(p) ? { ...orig(p), name: 'water', boundingBox: 'empty' } : orig(p)))(w.blockAt)
    const r = fp.pickSite(mockBot(w), { x: 0, y: 64, z: 0 })
    assert.ok(r.site, r.reason)
    let wet = 0
    for (let x = r.site.x; x < r.site.x + fp.W; x++) for (let z = r.site.z; z < r.site.z + fp.D; z++) if (pond({ x, z })) wet++
    assert.equal(wet, 0, JSON.stringify(r.site))
  })

  it('a dry site beats a nearer wet one; an owner spot stays exact (Codex fixture)', () => {
    const w = world()
    const inR = (x, z, ox, oz) => x >= ox && x < ox + fp.W && z >= oz && z < oz + fp.D
    for (let x = -60; x <= 60; x++) for (let z = -60; z <= 60; z++) if (!inR(x, z, -13, -4) && !inR(x, z, 17, -4)) w.set(x, 63, z, 'oak_planks')
    w.set(-13 + 3, 63, -4 + 3, 'water')
    for (let z = -4; z < -4 + fp.D; z++) { w.set(17, 64, z, 'dirt'); w.set(17, 65, z, 'dirt') }
    const r = fp.pickSite(mockBot(w), { x: 0, y: 64, z: 0 })
    assert.ok(r.site, r.reason)
    assert.deepEqual([r.site.x, r.site.z], [17, -4])
    const e = fp.pickSite(mockBot(w), { x: -13 + fp.W / 2, y: 64, z: -4 + fp.D / 2, exact: true })
    assert.deepEqual([e.site.x, e.site.z], [-13, -4])
  })

  it('widens the radius when the near ring is all built', () => {
    const w = world()
    const inner = (p) => Math.abs(p.x) < 50 && Math.abs(p.z) < 50
    w.blockAt = ((orig) => (p) => (p.y === 63 && inner(p) ? { ...orig(p), name: 'cobblestone_wall' } : orig(p)))(w.blockAt)
    const r = fp.pickSite(mockBot(w), { x: 0, y: 64, z: 0 })
    assert.ok(r.site, r.reason)
    assert.ok(!inner({ x: r.site.x, z: r.site.z }) || !inner({ x: r.site.x + fp.W - 1, z: r.site.z + fp.D - 1 }))
  })
})

describe('farmbuild step (qphv.1)', () => {
  it('lays the whole farm through the house builder and leaves the house state alone', async () => {
    const w = world()
    const bot = mockBot(w)
    const house = { site: { x: 100, y: 64, z: 100 }, v: 2, built: true }
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: house, buildSkip: [7], castle: null }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      for (let t = 0; t < 4000 && ctx.stepStatus === 'running'; t++) {
        farmbuild(bot, ctx)
        await tick()
      }
    } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done', logs.slice(-5).join('\n'))
    const fb = ctx.farmBuild
    assert.equal(fb.built, true)
    assert.ok(logs.some((l) => /^farm site=-?\d+,64,-?\d+ cost=0 cut=0 fill=0 tried=\d+$/.test(l)))
    assert.ok(logs.some((l) => /^farm progress built=\d+\/199 phase=barn cell=-?\d+,\d+,-?\d+ kind=\w+ loaded=[01]$/.test(l)))
    const s = fb.site
    const at = (dx, dy, dz) => w.blockAt({ x: s.x + dx, y: s.y + dy, z: s.z + dz }).name
    assert.equal(at(fp.WATER.dx, -1, fp.WATER.dz), 'water')
    assert.equal(at(fp.GATE.dx, 0, fp.GATE.dz), 'oak_fence_gate')
    assert.equal(at(fp.DOOR.dx, 0, fp.DOOR.dz), 'oak_door')
    assert.equal(at(18, -1, 0), 'farmland')
    assert.equal(ctx.home, house)
    assert.deepEqual(ctx.buildSkip, [7])
    assert.ok(bot.chats.some((m) => m.startsWith('farm done at')))
  })

  it('fills a prep cell over a 3-deep hole bottom-up instead of skipping it (prod (air) refusals)', async () => {
    const w = world()
    const bot = mockBot(w)
    bot.inventory.items().push({ name: 'dirt', count: 64 })
    // A 3x3 pit: the cell (y=63) has no floor and no side ground, 3 open blocks below it.
    for (let y = 60; y <= 63; y++) for (let x = 201; x <= 203; x++) for (let z = 201; z <= 203; z++) w.set(x, y, z, 'air')
    const fb = { site: { x: 200, y: 64, z: 200, prep: [{ dx: 2, dy: -1, dz: 2, kind: 'ground', phase: 'prep' }] } }
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, buildSkip: [], castle: null, farmBuild: fb }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      for (let t = 0; t < 4000 && ctx.stepStatus === 'running'; t++) {
        farmbuild(bot, ctx)
        await tick()
      }
    } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done', logs.slice(-5).join('\n'))
    assert.ok(!logs.some((l) => l.startsWith('build skip')), logs.filter((l) => l.startsWith('build skip')).join('\n'))
    for (let y = 60; y <= 63; y++) assert.equal(w.blockAt({ x: 202, y, z: 202 }).name, 'dirt', `y=${y}`)
  })

  it('a restored site re-plans its prep; a self-picked site with no progress for 30 min of work is re-picked', () => {
    const w = world()
    const bot = mockBot(w)
    bot.pathfinder.setGoal = () => {}
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null, farmBuild: { site: { x: 0, y: 64, z: 0 }, ordered: true } }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      farmbuild(bot, ctx)
      assert.ok(Array.isArray(ctx.farmBuild.site.prep), 'prep restored')
      assert.ok(logs.some((l) => l.startsWith('farm prep restored')))
      const fb = ctx.farmBuild
      for (let i = 0; i < 400 && ctx.farmBuild === fb; i++) { now += 5000; ctx.placeInFlight = true; farmbuild(bot, ctx) }
      assert.notEqual(ctx.farmBuild, fb)
      assert.equal(ctx.stepStatus, 'failed:site-stalled')
      assert.equal(ctx.farmBuild.ordered, true)
    } finally { console.log = orig; Date.now = realNow }
  })

  it('a stalled site that is >=90% raised is kept as built, not re-picked (prod bot2 198/199)', () => {
    const w = world()
    const bot = mockBot(w)
    bot.pathfinder.setGoal = () => {}
    const fb = { site: { x: 0, y: 64, z: 0, prep: [] }, ordered: true }
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null, farmBuild: fb }
    const build = require('../src/behaviours/build')
    const orig = build.houseProgress
    build.houseProgress = (b, h, o) => (o && o.includeClear ? { done: 300, total: 360 } : { done: 198, total: 199 })
    const logs = []
    const log = console.log
    console.log = (m) => { logs.push(String(m)) }
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      for (let i = 0; i < 400 && !fb.built; i++) { now += 5000; ctx.placeInFlight = true; farmbuild(bot, ctx) }
      assert.equal(ctx.farmBuild, fb)
      assert.equal(fb.built, true)
      assert.notEqual(ctx.stepStatus, 'failed:site-stalled')
      assert.ok(logs.some((l) => l.includes('-> keeping it as built')))
    } finally { console.log = log; Date.now = realNow; build.houseProgress = orig }
  })

  it('resets the stall timer on a cut and ignores drops and recoveries to the same count', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 10000 })
    const w = world()
    w.set(2, 67, 2, 'dirt')
    const bot = mockBot(w)
    const site = { x: 0, y: 64, z: 0, prep: [{ dx: 2, dy: 3, dz: 2, kind: 'clear', phase: 'prep' }] }
    const fb = { site, loggedAt: Date.now() }
    const ctx = { step: 'farmbuild', stepStatus: 'running', farmBuild: fb, placeInFlight: true }
    const run = () => {
      t.mock.timers.tick(1000)
      farmbuild(bot, ctx)
    }

    run()
    run()
    assert.equal(fb.stallRun, 1000)
    const beforeCut = fb.stallDone
    w.set(2, 67, 2, 'air')
    run()
    assert.equal(fb.stallDone, beforeCut + 1)
    assert.equal(fb.stallRun, 0)

    const read = bot.blockAt
    bot.blockAt = (p) => p.x === 2 && p.y === 67 && p.z === 2 ? null : read(p)
    run()
    assert.equal(fb.stallRun, 1000)
    bot.blockAt = read
    run()
    assert.equal(fb.stallRun, 2000)
  })

  it('prepAt: a partly built farm (own barn planks) still restores, unloaded waits (Codex)', () => {
    const w = world()
    w.set(2, 64, 2, 'oak_planks')
    assert.ok(Array.isArray(fp.prepAt(mockBot(w), { x: 0, y: 64, z: 0 })))
    const b = mockBot(w)
    b.blockAt = () => null
    assert.equal(fp.prepAt(b, { x: 0, y: 64, z: 0 }), null)
  })

  it('is feasible by day for an ordered farm or a complete castle, never once built', () => {
    const day = { time: 'day' }
    assert.equal(farmbuild.feasible(day, null, {}), false)
    assert.equal(farmbuild.feasible(day, null, { castle: { phase: 'complete' } }), true) // e.g. bot5's complete castle
    assert.equal(farmbuild.feasible({ time: 'night' }, null, { farmBuild: { ordered: true } }), false)
    assert.equal(farmbuild.feasible(day, null, { farmBuild: { ordered: true } }), true)
    assert.equal(farmbuild.feasible(day, null, { farmBuild: { ordered: true, built: true } }), false)
  })

  it('registers as a work step', () => {
    assert.equal(typeof BEHAVIOURS.farmbuild, 'function')
    assert.ok(STEP_ORDER.includes('farmbuild'))
    assert.equal(typeof MENU.farmbuild.feasible, 'function')
    assert.equal(typeof STEP_CRITERIA.farmbuild, 'string')
  })
})

describe('farm crop cycle and building blocks (qphv.2)', () => {
  const { acquire, fromChest } = require('../src/behaviours/acquire')
  const { denyReason } = require('../src/behaviours/util')
  const quiet = async (fn) => {
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try { await fn() } finally { console.log = orig }
    return logs
  }

  it('fills an empty bucket at the nearest still water (acquire resolver)', async () => {
    const w = world()
    w.set(3, 63, 0, 'water')
    const bot = mockBot(w)
    const items = [{ name: 'bucket', count: 1 }]
    bot.inventory.items = () => items
    bot.registry = { blocksByName: { water: { id: 1 } } }
    bot.findBlocks = () => [new Vec3(3, 63, 0)]
    bot.activateItem = async () => { items[0] = { name: 'water_bucket', count: 1 } }
    const ctx = {}
    let r
    await quiet(async () => {
      for (let t = 0; t < 50 && r !== 'done'; t++) { r = acquire(bot, ctx, 'water_bucket', 1); await new Promise((res) => setTimeout(res, 700)) }
    })
    assert.equal(r, 'done')
  })

  it('draws from a known chest before acquire', async () => {
    const w = world()
    w.set(2, 64, 0, 'chest')
    const bot = mockBot(w)
    const items = []
    bot.inventory.items = () => items
    const stock = [{ name: 'oak_fence', count: 40, type: 5 }]
    bot.openChest = async () => ({
      containerItems: () => stock,
      withdraw: async (type, meta, n) => { items.push({ name: 'oak_fence', count: n }); stock[0].count -= n },
      close: async () => {},
    })
    const ctx = { chests: [{ x: 2, y: 64, z: 0 }] }
    let r
    await quiet(async () => { for (let t = 0; t < 10 && r !== 'done'; t++) { r = fromChest(bot, ctx, ['oak_fence'], 31); await tick() } })
    assert.equal(r, 'done')
    assert.equal(items[0].count, 31)
    assert.equal(fromChest(bot, ctx, ['oak_door'], 1), 'none')
  })

  it('guards laid farm cells from other steps, not the empty ones', () => {
    const fb = { site: { x: 0, y: 64, z: 0 } }
    const ctx = { farmBuild: fb }
    const bot = { entity: { position: new Vec3(50, 64, 50) }, blockAt: () => null }
    const blk = (name, x, y, z) => ({ name, position: new Vec3(x, y, z) })
    assert.equal(denyReason(bot, blk('farmland', 18, 63, 0), ctx), 'protected')
    assert.equal(denyReason(bot, blk('oak_fence', 8, 64, 0), ctx), 'protected')
    assert.equal(denyReason(bot, blk('dirt', 18, 63, 0), ctx), null) // trampled: the builder re-tills it
    assert.equal(fp.protects(fb, new Vec3(22, 63, 4), 'water'), true)
    assert.equal(fp.inFieldAt(fb, new Vec3(20, 64, 3)), true)
    assert.equal(fp.inFieldAt(fb, new Vec3(10, 64, 3)), false)
  })

  it('requeues a trampled cell, then harvests ripe wheat and stores hay', async () => {
    const w = world()
    const bot = mockBot(w)
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: null, castle: null }
    await quiet(async () => {
      for (let t = 0; t < 4000 && ctx.stepStatus === 'running'; t++) { farmbuild(bot, ctx); await tick() }
    })
    const fb = ctx.farmBuild
    assert.equal(fb.built, true)
    const s = fb.site
    w.set(s.x + 18, s.y - 1, s.z, 'dirt') // trampled
    ctx.stepStatus = 'running'
    let logs = await quiet(async () => { for (let t = 0; t < 200 && ctx.stepStatus === 'running'; t++) { farmbuild(bot, ctx); await tick() } })
    assert.ok(logs.some((l) => l.startsWith(`farm own-dug cell=${s.x + 18},${s.y - 1},${s.z} kind=farmland requeued`)), logs.slice(-5).join('\n'))
    assert.equal(w.blockAt({ x: s.x + 18, y: s.y - 1, z: s.z }).name, 'farmland')
    assert.equal(fb.built, true)
    // A ripe crop: the built farm is due; the farm step harvests it.
    const at = { x: s.x + 19, y: s.y, z: s.z + 1 }
    const isAt = (p) => Math.floor(p.x) === at.x && Math.floor(p.y) === at.y && Math.floor(p.z) === at.z
    const base = bot.blockAt
    bot.blockAt = (p) => {
      const b = base(p)
      if (isAt(p) && b.name === 'wheat') b.getProperties = () => ({ age: 7 })
      return b
    }
    w.set(at.x, at.y, at.z, 'wheat')
    bot.registry = { blocksByName: { wheat: { id: 9 } } }
    bot.findBlocks = () => (w.cells.get(`${at.x},${at.y},${at.z}`) === 'wheat' ? [new Vec3(at.x, at.y, at.z)] : [])
    fb.cropAt = Date.now()
    assert.equal(farmbuild.feasible({ time: 'day' }, bot, ctx), true)
    ctx.stepStatus = 'running'
    logs = await quiet(async () => { for (let t = 0; t < 60 && !fb.harvested; t++) { farmbuild(bot, ctx); await tick() } })
    assert.equal(fb.harvested, 1, logs.slice(-8).join('\n'))
    assert.ok(logs.some((l) => /^farm crop planted=\d+ mature=\d+ harvested=\d+ hay=\d+$/.test(l)))
    // Hay in the pack goes into the barn chest.
    bot.inventory.items().push({ name: 'hay_block', count: 2, type: 77 })
    bot.openChest = async () => ({ containerItems: () => [], deposit: async () => {}, close: async () => {} })
    fb.walkKey = null
    await quiet(async () => { for (let t = 0; t < 20 && !fb.hay; t++) { farmbuild(bot, ctx); await tick() } })
    assert.equal(fb.hay, 2)
  })
})

// Prod bot5: v2 walked toward an unloaded farm site for hours (moving=true
// path=success, built=0/199): every segment moved the body, and the old
// displacement budget reset each time. Progress is now a new closest
// approach; a walk that never gets closer drops the site and re-picks.
describe('farm site walk that never gets closer (bot5)', () => {
  const run = (step) => {
    const bot = mockBot(world())
    bot.blockAt = () => null // the site never loads
    bot.pathfinder.isMoving = () => true
    bot.pathfinder.setGoal = () => {}
    const site = { x: 200, y: 64, z: 200, prep: [] }
    const ctx = { step: 'farmbuild', stepStatus: 'running', farmBuild: { site, built: false } }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      for (let t = 0; t < 200 && ctx.farmBuild.site; t++) {
        bot.entity.position = step(t)
        farmbuild(bot, ctx)
      }
    } finally { console.log = orig }
    return { ctx, logs }
  }

  it('a walk that moves every tick but never gets closer drops the site', () => {
    const { ctx, logs } = run((t) => new Vec3(t % 2 ? 5 : 0, 64, 0))
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-site')
    assert.equal(ctx.farmBuild.site, undefined, 'site dropped')
    assert.deepEqual(ctx.farmBuild.avoid, [{ x0: 200, z0: 200, x1: 200 + fp.W - 1, z1: 200 + fp.D - 1 }])
    assert.ok(logs.some((l) => /^build site-walk gave up target=/.test(l)), logs.join('\n'))
    assert.ok(logs.some((l) => /^build site-walk target=\S+ why=unloaded dist=/.test(l)), 'waiting reason logged')
    assert.ok(logs.some((l) => /^farm progress built=0\/\d+ phase=\w+ cell=\S+ kind=\w+ loaded=0$/.test(l)), logs.join('\n'))
  })

  it('a steady approach keeps walking', () => {
    const { ctx } = run((t) => new Vec3(t, 64, t))
    assert.equal(ctx.stepStatus, 'running')
    assert.ok(ctx.farmBuild.site)
  })
})
