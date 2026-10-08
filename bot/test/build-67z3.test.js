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
  it('failed:no-planks writes build failed:no-planks', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [] })
    // v1 home on open ground: next cell is the table, pack is empty.
    const ctx = { home: { site: { x: 0, y: 64, z: 0 } } }
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-planks')
    assert.ok(lines.some((l) => l === 'build failed:no-planks'), lines.join('\n'))
  })

  it('failed:no-site writes build failed:no-site', () => {
    const world = makeWorld()
    const bot = mockBot(world, { spawn: null })
    const ctx = {}
    const lines = logged(() => build(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:no-site')
    assert.ok(lines.some((l) => l === 'build failed:no-site'), lines.join('\n'))
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
      const ctx = { step: 'build', stepStatus: 'failed:no-planks', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-planks'
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
      const ctx = { step: 'build', stepStatus: 'failed:no-planks', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      world.set(0 + 4, 64, 0 + 1, 'crafting_table') // the v1 table cell lands
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-planks'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1, 'progress resets the count')
    })
  })

  it('new resources between failures re-arm the counter', async () => {
    await quietAsync(async () => {
      const world = makeWorld()
      const items = [{ name: 'oak_planks', count: 5 }]
      const bot = decideBot(world, items)
      const ctx = { step: 'build', stepStatus: 'failed:no-planks', home: { site: { x: 0, y: 64, z: 0 } } }
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1)
      items.push({ name: 'oak_door', count: 1 }) // craft delivered
      ctx.step = 'build'
      ctx.stepStatus = 'failed:no-planks'
      await goal.decide(bot, ctx)
      assert.equal(nOf(ctx), 1, 'new resources reset the count')
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
