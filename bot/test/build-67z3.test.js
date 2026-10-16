'use strict'

// Bead idkcraft-67z3: post-park build<->rest oscillation — build is picked,
// works one tick and fails WITHOUT a `build failed:<reason>` line, and the
// text-keyed failHolds releases every time the wandering rest moves the
// facts, so build re-picks every cycle (19 cycles / ~10 min on the rig).
// Fix: every build failure logs its reason, and a failed build holds
// BUILD_RETRY_MS past facts drift (the forage/bt8s time-keyed precedent).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
require('../src/index') // BEHAVIOURS registration (goal.registered)

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function mockBot(world, { items = [], spawn = pos(0, 64, 0), at = pos(0, 65, 0) } = {}) {
  const bot = {
    chats: [],
    spawnPoint: spawn,
    entity: { position: at },
    world: { getBlock: () => null },
    players: {},
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal: () => {} },
    equip: async (item) => { bot.held = item.name },
    dig: async () => {},
    placeBlock: async () => {},
    chat: (m) => { bot.chats.push(String(m)) },
  }
  return bot
}

// Capture console.log lines while fn runs.
function logged(fn) {
  const lines = []
  const orig = console.log
  console.log = (m, ...rest) => { lines.push([m, ...rest].join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines
}

describe('67z3: every build failure logs its reason', () => {
  it('failed:no-table writes build failed:no-table', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [] })
    // v1 home on open ground: next cell is the table, pack is empty.
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } } }
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-table')
    assert.ok(lines.some((l) => l === 'build failed:no-table'), lines.join('\n'))
  })

  it('failed:no-site writes build failed:no-site', () => {
    const world = makeWorld()
    // neuc.27: underground (the rock above reads as flat ground) refuses the
    // body-anchored fallback too.
    const bot = mockBot(world, { spawn: null, at: pos(0, 40, 0) })
    const ctx = {}
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.ok(lines.some((l) => l === 'build failed:no-site'), lines.join('\n'))
  })

  it('neuc.27: no spawn site falls back to a surface site around the body', () => {
    const world = makeWorld()
    const bot = mockBot(world, { spawn: null, at: pos(100, 64, 100) })
    const ctx = {}
    logged(() => build(bot, ctx))
    assert.ok(ctx.home && ctx.home.site, 'site founded')
    assert.equal(ctx.home.site.y, 64)
    assert.ok(Math.hypot(ctx.home.site.x - 100, ctx.home.site.z - 100) <= 8)
  })

  it('failed:skipped-cells writes build failed:skipped-cells', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 64 }] })
    const home = { site: { x: 0, y: 64, z: 0 } }
    const all = build.blueprintFor(home).map((_, i) => i)
    const ctx = { home, buildSkip: all }
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:skipped-cells')
    assert.ok(lines.some((l) => l === 'build failed:skipped-cells'), lines.join('\n'))
  })

  it('failed:cannot-reach-site writes build failed:cannot-reach-site', () => {
    const world = makeWorld()
    const at = pos(200, 65, 200)
    const bot = mockBot(world, { at })
    bot.blockAt = () => null // unloaded site: the scan reads nothing
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } }, buildSiteWalk: { x: at.x, z: at.z, ticks: 119 } }
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:cannot-reach-site')
    assert.ok(lines.some((l) => l === 'build failed:cannot-reach-site'), lines.join('\n'))
  })
})

describe('67z3: a failed build holds past facts drift, then retries', () => {
  const F = () => goal.MENU.build.feasible
  // Homeless + a full batch: feasible by the plank count alone.
  const facts = () => ({ time: 'day', planks: 16 })
  const bot = () => mockBot(makeWorld())

  it('normal path: no failure record, build stays feasible', () => {
    assert.equal(F()(facts(), bot(), {}), true)
  })

  it('first no-planks never holds: the xoj fail->craft->retry handoff', () => {
    const once = { stepFail: { build: { status: 'failed:no-planks', text: 't', pos: null, at: Date.now(), sig: 's', n: 1 } } }
    assert.equal(F()(facts(), bot(), once), true)
    const legacy = { stepFail: { build: { status: 'failed:no-planks', text: 't', pos: null, at: Date.now() } } }
    assert.equal(F()(facts(), bot(), legacy), true)
  })

  it('repeat no-planks with the same cause holds past facts drift', () => {
    const ctx = { stepFail: { build: { status: 'failed:no-planks', text: 'stale text', pos: null, at: Date.now(), sig: 's', n: 2 } } }
    assert.equal(F()(facts(), bot(), ctx), false)
    assert.equal(goal.stepWhy('build', facts(), bot(), ctx, 'new text'), 'build holds after failure')
  })

  it('neuc.43: no-table / no-door hold like no-planks', () => {
    for (const status of ['failed:no-table', 'failed:no-door']) {
      const once = { stepFail: { build: { status, text: 't', pos: null, at: Date.now(), sig: 's', n: 1 } } }
      assert.equal(F()(facts(), bot(), once), true, status)
      const ctx = { stepFail: { build: { status, text: 'stale', pos: null, at: Date.now(), sig: 's', n: 2 } } }
      assert.equal(F()(facts(), bot(), ctx), false, status)
    }
  })

  it('structural verdicts pace from the first failure', () => {
    for (const status of ['failed:skipped-cells', 'failed:cannot-reach-site']) {
      const ctx = { stepFail: { build: { status, text: 't', pos: null, at: Date.now(), sig: 's', n: 1 } } }
      assert.equal(F()(facts(), bot(), ctx), false, status)
    }
  })

  it('the hold expires after BUILD_RETRY_MS', () => {
    const ctx = { stepFail: { build: { status: 'failed:no-planks', text: 'stale text', pos: null, at: Date.now() - goal.BUILD_RETRY_MS - 1, sig: 's', n: 2 } } }
    assert.equal(F()(facts(), bot(), ctx), true)
  })

  it('failed:no-site: first retry stays prompt (vmzq.16), the repeat holds (67z3)', () => {
    const once = { stepFail: { build: { status: 'failed:no-site', text: 't', pos: null, at: Date.now(), sig: 'site=none', n: 1 } } }
    assert.equal(F()(facts(), bot(), once), true, 'chunk-load retry stays prompt')
    const twice = { stepFail: { build: { status: 'failed:no-site', text: 'stale text', pos: null, at: Date.now(), sig: 'site=none', n: 2 } } }
    assert.equal(F()(facts(), bot(), twice), false, 'hopeless spawn paces')
    assert.equal(goal.stepWhy('build', facts(), bot(), twice, 'new text'), 'build holds after failure')
  })

  it('a site now set voids a no-site hold (the build-here rescue)', () => {
    const rescued = {
      home: { site: { x: 0, y: 64, z: 0 } },
      stepFail: { build: { status: 'failed:no-site', text: 't', pos: null, at: Date.now(), sig: 'site=none', n: 2 } },
    }
    // Home with the table already placed: next is planks, batch on hand.
    const factsHome = { time: 'day', planks: 16, table: 0, door: 0 }
    const world = makeWorld()
    world.set(0 + 4, 64, 0 + 1, 'crafting_table') // v1 table cell done
    assert.equal(F()(factsHome, mockBot(world), rescued), true)
  })

  it('a same-text done still holds text-keyed only, never time-keyed (h9z stands)', () => {
    const F2 = F()
    const doneHold = { stepFail: { build: { status: 'done', text: 'same', pos: null } } }
    assert.equal(F2(facts(), bot(), doneHold), true) // feasible() ignores it...
    assert.equal(goal.failHolds(doneHold, 'build', 'same', bot()), true) // ...failHolds still binds it
  })
})

describe('67z3: decide counts consecutive same-cause failures, progress re-arms', () => {
  function decideBot(world, items) {
    const bot = mockBot(world, { items })
    bot.time = { timeOfDay: 6000, day: 1 }
    bot.health = 20
    bot.food = 20
    return bot
  }
  async function quietAsync(fn) {
    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    try { return await fn() } finally { console.log = origLog; console.error = origErr }
  }
  const nOf = (ctx) => ctx.stepFail && ctx.stepFail.build && ctx.stepFail.build.n

  it('identical repeats count up: n=1, then n=2 and held', async () => {
    await quietAsync(async () => {
      const world = makeWorld()
      const bot = decideBot(world, [{ name: 'oak_planks', count: 5 }])
      const ctx = { step: 'build', stepStatus: 'failed:no-table', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-table'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 2)
      // Held now: homeless-shaped facts keep every other gate open.
      assert.equal(goal.MENU.build.feasible({ time: 'day', planks: 16 }, bot, { stepFail: ctx.stepFail }), false)
    })
  })

  it('a placed cell between failures re-arms the counter', async () => {
    await quietAsync(async () => {
      const world = makeWorld()
      const bot = decideBot(world, [{ name: 'oak_planks', count: 5 }])
      const ctx = { step: 'build', stepStatus: 'failed:no-table', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      world.set(0 + 4, 64, 0 + 1, 'crafting_table') // the v1 table cell lands
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-table'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1, 'progress resets the count')
    })
  })

  it('new resources between failures re-arm the counter', async () => {
    await quietAsync(async () => {
      const world = makeWorld()
      const items = [{ name: 'oak_planks', count: 5 }]
      const bot = decideBot(world, items)
      const ctx = { step: 'build', stepStatus: 'failed:no-table', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      items.push({ name: 'oak_door', count: 1 }) // craft delivered
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-table'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1, 'new resources reset the count')
    })
  })

  it('an expired build hold wakes a steady menu: one pick per window', async () => {
    await quietAsync(async () => {
      // vmzq16's full kit: craft/equip/gather all infeasible, so build is
      // the only work step standing between rest and the site.
      const items = [
        { name: 'oak_planks', count: 200 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
        { name: 'stone_sword', count: 1 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'cobblestone', count: 64 },
      ]
      const bot = decideBot(makeWorld(), items)
      const ctx = { step: 'build', stepStatus: 'failed:no-table' }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-table'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 2)
      // Held now: steady rest replays.
      ctx.step = 'rest'
      ctx.stepStatus = 'running'
      const text = goal.goalText(goal.goalFacts(bot, ctx), null)
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      assert.equal((await goal.decide(bot, ctx)).action, 'rest', 'held: rest replays')
      // Window passes, facts steady: the expiry forces exactly one pick,
      // and the kept counter holds the very next identical failure (n=3).
      ctx.stepFail.build.at = Date.now() - goal.BUILD_RETRY_MS - 1
      const text2 = goal.goalText(goal.goalFacts(bot, ctx), null)
      assert.equal(text2, text, 'setup: facts steady')
      assert.equal((await goal.decide(bot, ctx)).action, 'build', 'expiry forces a fresh pick')
      assert.equal(ctx.stepFail.build.retryFired, true, 'force is one-shot')
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-table'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 3, 'kept counter counts on')
      assert.equal(goal.MENU.build.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'no second free pick')
    })
  })

  it('an expired no-site record is never retired by the clock (siteRetry owns it, L1 reads it)', async () => {
    await quietAsync(async () => {
      const items = [
        { name: 'oak_planks', count: 200 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
        { name: 'stone_sword', count: 1 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'cobblestone', count: 64 },
      ]
      const bot = decideBot(makeWorld(), items)
      bot.blockAt = () => null // dark spawn: the probe never retires
      const ctx = { step: 'rest', stepStatus: 'running' }
      const text = goal.goalText(goal.goalFacts(bot, ctx), null)
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      ctx.stepFail = { build: { status: 'failed:no-site', text, pos: null, at: Date.now() - goal.BUILD_RETRY_MS - 1, sig: 'site=none', n: 2 } }
      assert.equal((await goal.decide(bot, ctx)).action, 'rest', 'dark steady: rest replays')
      assert.equal(ctx.stepFail.build.status, 'failed:no-site', 'record survives for the stall clock')
    })
  })

  it('parked castle + table=no: no-site repeats count and pace (67z3 loop)', async () => {
    await quietAsync(async () => {
      const world = makeWorld()
      const bot = decideBot(world, [{ name: 'oak_planks', count: 16 }])
      // Dark spawn: siteFor never wins, so the probe never retires.
      bot.blockAt = () => ({ name: 'air', boundingBox: 'empty', position: { x: 0, y: 64, z: 0 } })
      const ctx = {
        step: 'build',
        stepStatus: 'failed:no-site',
        castle: { site: { x: 300, y: 64, z: 300 }, rot: 0, blueprintVersion: 1, phase: 'body', parked: true },
      }
      await goal.decide(bot, ctx)
      assert.equal(ctx.stepFail.build.sig, 'site=none')
      assert.equal(nOf(ctx), 1)
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-site'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 2)
      const f = goal.goalFacts(bot, ctx)
      assert.equal(f.table, 0, 'shape: table=no')
      assert.equal(goal.MENU.build.feasible(f, bot, ctx), false, 'repeat holds')
    })
  })
})

// neuc.32: prod v2 sat under a lake bed (44,58,-20, head blocked): every
// body-anchored footprint read water and the shore site sat 3 above the
// feet, so the homeless build failed:no-site forever. v2 widens to the
// nearest open-sky site; v1 keeps #484's refusal byte-identical.
describe('neuc.32: homeless under cover', () => {
  // Lake over x/z -15..15 (water at 63), dry meadow (feet 64) beyond.
  function lakeWorld() {
    const world = makeWorld()
    for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) world.set(x, 63, z, 'water')
    return world
  }
  function withBody(body, fn) {
    const prev = process.env.BOT_BODY
    if (body) process.env.BOT_BODY = body
    else delete process.env.BOT_BODY
    try { return fn() } finally {
      if (prev === undefined) delete process.env.BOT_BODY
      else process.env.BOT_BODY = prev
    }
  }

  it('v1 (BOT_BODY unset) under the lake bed still fails no-site', () => {
    const bot = mockBot(lakeWorld(), { spawn: null, at: pos(0, 58, 0) })
    const ctx = {}
    const lines = withBody(null, () => logged(() => build(bot, ctx)))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.equal(ctx.home, null)
    assert.ok(lines.includes('build failed:no-site'), lines.join('\n'))
  })

  it('v2 under the lake bed founds the nearest dry open-sky site', () => {
    const bot = mockBot(lakeWorld(), { spawn: null, at: pos(0, 58, 0) })
    const ctx = {}
    withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.ok(ctx.home && ctx.home.site, 'site founded')
    const s = ctx.home.site
    assert.equal(s.y, 64)
    // whole 7x6 footprint off the lake, within the ~30 ring
    const offLake = s.x > 15 || s.x + 6 < -15 || s.z > 15 || s.z + 5 < -15
    assert.ok(offLake, JSON.stringify(s))
    assert.ok(Math.hypot(s.x, s.z) <= 31, JSON.stringify(s))
  })

  it('v2 deep underground founds nothing (rock at the scan top is not sky), walks to open sky instead (neuc.35)', () => {
    const bot = mockBot(makeWorld(), { spawn: null, at: pos(0, 40, 0) })
    const set = []
    bot.pathfinder.setGoal = (g) => set.push(g)
    const ctx = {}
    const lines = withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.equal(ctx.home, null, 'no site founded on the rock above')
    assert.notEqual(ctx.stepStatus, 'failed:no-site', 'walking, not failing')
    assert.equal(set.length, 1)
    const g = set[0]
    assert.deepEqual([g.x, g.y, g.z], [0, 64, 0], 'the surface straight above')
    assert.ok(lines.includes('build no-site: walking to open sky at 0 64 0'), lines.join('\n'))
    // On arrival at the surface the scan finds the site.
    bot.entity.position = pos(0.5, 64, 0.5)
    withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.ok(ctx.home && ctx.home.site, 'site founded at the surface')
    assert.equal(ctx.home.site.y, 64)
    assert.equal(ctx.buildSiteWalk, null)
  })

  it('v1 deep underground still fails no-site without a walk (neuc.35 is v2-only)', () => {
    const bot = mockBot(makeWorld(), { spawn: null, at: pos(0, 40, 0) })
    const set = []
    bot.pathfinder.setGoal = (g) => set.push(g)
    const ctx = {}
    withBody(null, () => logged(() => build(bot, ctx)))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.equal(set.length, 0)
  })

  it('v2 sky walk that stops getting anywhere fails no-site (neuc.35)', () => {
    const bot = mockBot(makeWorld(), { spawn: null, at: pos(0, 40, 0) })
    const ctx = {}
    withBody('baritone', () => logged(() => {
      for (let i = 0; i <= build.CELL_TICK_BUDGET && ctx.stepStatus !== 'failed:no-site'; i++) build(bot, ctx)
    }))
    assert.equal(ctx.stepStatus, 'failed:no-site')
  })

  it('v2 sky walk latches its target and gives up on the hard cap while displacing (neuc.35 revmux 01)', () => {
    const bot = mockBot(makeWorld(), { spawn: null, at: pos(0, 40, 0) })
    const set = []
    bot.pathfinder.setGoal = (g) => set.push(g)
    const ctx = {}
    let ticks = 0
    withBody('baritone', () => logged(() => {
      build(bot, ctx)
      // Oscillate 2 blocks each tick under the cave roof: the no-progress
      // budget re-arms every tick, only the hard cap ends it.
      while (ctx.stepStatus !== 'failed:no-site' && ticks < build.SKY_WALK_CAP + 5) {
        ticks++
        bot.entity.position = pos(ticks % 2 ? 20 : 18, 40, 0)
        build(bot, ctx)
        if (ctx.buildSiteWalk) assert.deepEqual(ctx.buildSiteWalk.sky, { x: 0, y: 64, z: 0 }, 'target latched')
      }
    }))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.ok(ticks <= build.SKY_WALK_CAP + 1, String(ticks))
    assert.ok(set.every((g) => g.x === 0 && g.y === 64 && g.z === 0))
  })

  it('v2 at the surface with no flat ground anywhere fails no-site without a walk (neuc.35)', () => {
    // Checkerboard relief everywhere: no site fits, the sky cell is the
    // body's own column.
    const world = makeWorld()
    for (let x = -80; x <= 80; x++) for (let z = -80; z <= 80; z++) if ((x + z) % 2 === 0) { world.set(x, 64, z, 'dirt'); world.set(x, 65, z, 'dirt') }
    const bot = mockBot(world, { spawn: null, at: pos(1.5, 64, 0.5) })
    const set = []
    bot.pathfinder.setGoal = (g) => set.push(g)
    const ctx = {}
    withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.equal(set.length, 0)
  })

  it('v2 no-site hold releases when the wide sky ring validates (neuc.35)', () => {
    // Deep in a cave: no spawn site, the hold stands; the body surfaces
    // inside REFAIL_DIST (same column) and the sky probe releases it.
    const bot = mockBot(makeWorld(), { spawn: null, at: pos(0, 40, 0) })
    const ctx = { stepFail: { build: { status: 'failed:no-site', text: 't', pos: { x: 0, y: 40, z: 0 }, at: Date.now(), sig: 'site=none', n: 2 } } }
    withBody('baritone', () => {
      assert.equal(goal.failHolds(ctx, 'build', 't', bot), true, 'cave: hold stands')
      bot.entity.position = pos(0.5, 64, 0.5)
      delete ctx.skySiteProbe // the cached cave verdict ages out
      assert.equal(goal.failHolds(ctx, 'build', 't', bot), false, 'surface: hold releases')
    })
    withBody(null, () => {
      delete ctx.skySiteProbe
      assert.equal(goal.failHolds(ctx, 'build', 't', bot), true, 'v1: spawn-only probe, hold stands')
    })
  })

  it('skyOpen refuses a footprint under a leaf canopy', () => {
    const site = require('../src/site')
    const world = makeWorld()
    const bot = { blockAt: (p) => world.blockAt(p) }
    const home = site.makeHome(0, 64, 0, 2)
    assert.equal(site.skyOpen(bot, home, 72), true)
    world.set(3, 76, 2, 'oak_leaves') // above the scan top
    assert.equal(site.skyOpen(bot, home, 72), false)
    world.set(3, 76, 2, 'air')
    world.set(3, 70, 2, 'oak_leaves') // below it: read as ground
    assert.equal(site.skyOpen(bot, home, 72), false)
  })

  it('v2 under a flat leaf canopy never founds on the canopy top (revmux 01)', () => {
    // Forest floor feet 64 under a dark-oak-style leaf layer at 69 over
    // x/z -70..70: every site in range would sit on leaves.
    const world = makeWorld()
    for (let x = -70; x <= 70; x++) for (let z = -70; z <= 70; z++) world.set(x, 69, z, 'dark_oak_leaves')
    const bot = mockBot(world, { spawn: null, at: pos(0, 64, 0) })
    const ctx = {}
    withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.equal(ctx.stepStatus, 'failed:no-site')
  })

  it('v2 under a canopy wider than 30 founds past its edge on the far rings (neuc.35)', () => {
    const world = makeWorld()
    for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) world.set(x, 69, z, 'dark_oak_leaves')
    const bot = mockBot(world, { spawn: null, at: pos(0, 64, 0) })
    const ctx = {}
    withBody('baritone', () => logged(() => build(bot, ctx)))
    assert.ok(ctx.home && ctx.home.site, 'site founded')
    const s = ctx.home.site
    assert.equal(s.y, 64)
    assert.ok(s.x > 40 || s.x + 6 < -40 || s.z > 40 || s.z + 5 < -40, JSON.stringify(s))
  })
})
