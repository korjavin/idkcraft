'use strict'

// idkcraft-klh2: same-kind tick hop after the per-kind hold park. The prkh
// hold parks the failed kind and the fence-relay test pins cross-kind
// switching, but the parked kind's next tick idled the whole hold window
// (explore/rest while the castle waits). The hold now parks the failed SITE:
// the next tick hops to the chest strategy for the SAME kind, and the failed
// site stays parked.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), chest = [] } = {}) {
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
  }
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { chest: { id: 54 } },
      itemsByName: { oak_fence: {}, birch_fence: {}, oak_planks: {}, birch_planks: {}, oak_log: {}, birch_log: {}, stick: {}, crafting_table: {}, cobblestone: {}, stone: {} },
    },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [...set].filter(([, n]) => n === 'chest').map(([k]) => {
      const [x, y, z] = k.split(',').map(Number)
      return pos(x, y, z)
    }),
    openChest: async () => ({
      containerItems: () => chest.map((s) => ({ name: s.name, type: s.name, metadata: null, count: s.count })),
      withdraw: async () => {},
      close() {},
    }),
    equip: async () => {},
    dig: async () => {},
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

// A world-stage failure recorded for KIND at the body's feet, with a chest
// nearby the hop leg can walk to.
function failWorldAt(bot, ctx, kind, status) {
  const bp = bot.entity.position
  ctx.castleFetchFailKind = kind
  ctx.castleFetchFailSite = { kind, x: bp.x, y: bp.y, z: bp.z }
  goal.recordOutcome(bot, ctx, {}, 'castlefetch', status, true, `castle=${kind}-none`)
}

function withChest(ctx) {
  ctx.castle.siteChest = { x: SITE.x - 2, y: 64, z: SITE.z - 2 }
  return ctx
}

describe('klh2 same-kind tick hop', () => {
  const realFact = castleMod.menuFact
  afterEach(() => { castleMod.menuFact = realFact })

  it('hop taken at the failed site, hold still parks it', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'the failed site stays parked')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'stone' && d.short > 0 && d.hop === true, `same-kind hop taken: ${JSON.stringify(d)}`)
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), false, 'the menu entry is released for the hop')
  })

  it('no chest: the park keeps idling honestly, no hop', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = { castle: castleState() }
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    ctx.acquireHeld = { stone: Date.now() } // acquire just failed: idle while it rests
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), false, 'no chest to hop to')
    assert.equal(fetch.demand(bot, ctx), null, 'demand stays parked')
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), true, 'the menu entry stays held')
  })

  it('relocated past the site: still hops, never a world leg (R2)', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    // Past the failure point but still in chest reach: the window holds
    // kind-wide (revmux 01-review — the quarry is castle-anchored, so a
    // release would walk back and re-fail the same ground), and the kind
    // runs as a hop, never as a full world leg.
    bot.entity.position = pos(SITE.x - 40, 64, SITE.z)
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'R2: relocation never releases the window')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'stone' && d.hop === true, `relocated: the same kind hops: ${JSON.stringify(d)}`)
  })

  it('a siteless (craft) failure never hops, even with a chest', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    ctx.castleFetchFailKind = 'fence' // no site stamp: the pack failed, not the ground
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:castlefetch-craft-fence', true, 'castle=fence-none')
    assert.equal(fetch.holdFor(bot, ctx, 'fence'), true, 'siteless hold parks kind-wide')
    assert.equal(fetch.hopDue(bot, ctx, 'fence'), false, 'no world site parked: no hop')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.acquire && !d.hop, `no hop, the acquire leg: ${JSON.stringify(d)}`)
  })

  it('a same-day parked kind never hops', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState({ phase: 'complete' }) })
    for (let i = 0; i < 3; i++) {
      ctx.castleFetchFailKind = 'fence'
      ctx.castleFetchFailSite = { kind: 'fence', x: 96, y: 64, z: 196 }
      goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:no-trees', true, 'castle=fence-none')
    }
    assert.equal(fetch.isParked(ctx, 'fence'), true, 'parked for the day')
    assert.equal(fetch.hopDue(bot, ctx, 'fence'), false, 'the day park owns it')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.acquire && !d.hop, `no hop, the acquire leg: ${JSON.stringify(d)}`)
  })

  it('a gather-ended no-trees leg stamps its chop site', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const realCraft = fetch.deps.craftItem
    const realGather = fetch.deps.gather
    fetch.deps.craftItem = () => ({ done: false })
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'failed:no-trees' }
    try {
      const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
      const ctx = { castle: castleState() } // chestless: the leg reaches the gather chop
      fetch(bot, ctx); fetch(bot, ctx) // gather no-trees, then the acquire expedition fails
      const settle = () => new Promise((r) => setImmediate(r))
      return settle().then(() => settle()).then(() => settle()).then(() => {
        assert.equal(ctx.stepStatus, 'failed:no-trees')
        assert.equal(ctx.castleFetchFailKind, 'fence')
        assert.ok(ctx.castleFetchFailSite && ctx.castleFetchFailSite.kind === 'fence', 'the chop site is stamped for the hop')
        withChest(ctx) // the chest the hop leg walks to next tick
        goal.recordOutcome(bot, ctx, {}, 'castlefetch', ctx.stepStatus, true, 'castle=fence-none')
        assert.equal(fetch.hopDue(bot, ctx, 'fence'), true, 'the same kind hops to the chest next tick')
      })
    } finally {
      fetch.deps.craftItem = realCraft
      fetch.deps.gather = realGather
    }
  })

  it('a hop leg that serves nothing keeps the hold (hopDry done)', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    // A running hop leg past chest+craft with no stock: chest already tried.
    ctx.castleFetch = { kind: 'stone', chestDone: true }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done', 'the hop leg ends quiet, never failed')
    assert.ok(ctx.castleFetchDoneKind == null, 'no retire stamp on an unserved hop')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds), ['stone'], 'the site hold survives the hop cycle')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'the failed site stays parked')
  })

  it('R1 F1: a partial-serve hop leg with a dry chest keeps the hold', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    ctx.acquireHeld = { stone: Date.now() }
    // Reachable state: the hop leg served partial last tick and is still
    // active, and the only chest just went dry on the drain.
    ctx.castleFetch = { kind: 'stone', chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: 0, haul: 70, hop: true }
    ctx.castleChestDry = { [`stone@${SITE.x - 2},64,${SITE.z - 2}`]: Date.now() }
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), false, 'setup: chest dry, no hop')
    assert.equal(fetch.demand(bot, ctx), null, 'setup: demand null')
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done', 'the unserved hop ends quiet, never failed')
    assert.ok(ctx.castleFetchDoneKind == null, 'no retire stamp on an unserved hop')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds), ['stone'], 'the site hold survives the partial-serve cycle')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'no world retry at the parked site')
  })

  it('R2 major-1: an unserved hop does not re-poll the same chest', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    ctx.acquireHeld = { stone: Date.now() }
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), true, 'setup: first hop due')
    // The hop leg tried the only chest and served nothing (chestTried is
    // the per-leg tried set a real leg carries out of chestTick).
    ctx.castleFetch = { kind: 'stone', chestDone: true, hop: true, chestTried: new Set([`${SITE.x - 2},64,${SITE.z - 2}`]) }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.stepFail.castlefetch.kinds.stone.hopTried, [`${SITE.x - 2},64,${SITE.z - 2}`], 'tried chests remembered on the hold entry')
    // Next tick: the only chest is tried — no hop, no churn, hold stands.
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), false, 'tried chest skipped for the window')
    assert.equal(fetch.demand(bot, ctx), null, 'no re-poll of the empty chest')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'the window still parks the kind')
  })

  it('R2 02-after-fix: a new hop leg inherits tried chests', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState(), home: { chest: { x: SITE.x - 10, y: 64, z: SITE.z - 10 } } })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    // Hop 1 tried the site chest and served nothing.
    ctx.castleFetch = { kind: 'stone', chestDone: true, hop: true, chestTried: new Set([`${SITE.x - 2},64,${SITE.z - 2}`]) }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    // The home chest appeared untried: hop 2 is due, and the created leg
    // skips the tried site chest straight to it.
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), true, 'untried chest keeps the hop due')
    fetch(bot, ctx)
    assert.ok(ctx.castleFetch.chestTried && ctx.castleFetch.chestTried.has(`${SITE.x - 2},64,${SITE.z - 2}`), 'hop 2 inherits hop 1’s tried chest')
    assert.equal(ctx.castleFetch.chest && ctx.castleFetch.chest.k, `${SITE.x - 10},64,${SITE.z - 10}`, 'hop 2 walks to the untried chest, not back to the empty one')
  })

  it('R1 F1 control: a served hop leg retires the hold', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 2 }; return 'stone-none' }
    const bot = makeBot({ items: [{ name: 'cobblestone', count: 500 }] })
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    ctx.castleFetch = { kind: 'stone', chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: 0, haul: 70, hop: true }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castleFetchDoneKind, 'stone', 'a served need stamps its retire')
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=stone-none')
    assert.equal(ctx.stepFail.castlefetch, undefined, 'the hold retires with the served need')
  })

  it('R1 F2: legacy kind-named records do not hop', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    // Old shape: kind + site, no kinds map (no writer produces these since
    // revmux 02 core-1) — the site park still holds, but never hops.
    const ctx = withChest({
      castle: castleState(),
      castleWord: { kind: 'stone', left: 75 },
      acquireHeld: { stone: Date.now() },
      stepFail: { castlefetch: { status: 'failed:castlefetch-unreachable', kind: 'stone', at: Date.now(), text: 'castle=stone-none', pos: { ...SITE } } },
    })
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), false, 'no kinds map: no hop')
    assert.equal(fetch.demand(bot, ctx), null, 'demand stays parked at the site')
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), true, 'the menu entry stays held')
  })

  it('an expired site hold releases the kind everywhere', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    ctx.stepFail.castlefetch.kinds.stone.at -= 6 * 60 * 1000
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), false, 'expired at the site too')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'stone' && !d.hop, `a full leg retries: ${JSON.stringify(d)}`)
  })
})

// Supply ladder (prod 2026-11-15 bot3: 12 hops/h, 0 acquire lines): one chest
// hop per kind per window, then acquire — even while the world site stays parked.
describe('supply ladder: hop once, then acquire', () => {
  const realFact = castleMod.menuFact
  afterEach(() => { castleMod.menuFact = realFact })

  it('chest hop tried (dry, failed or preempted) -> the next demand is acquire, site still parked', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'planks', left: 64 }; return 'planks-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'planks', 'failed:castlefetch-no-trees')
    assert.equal(fetch.demand(bot, ctx).hop, true, 'first rung: the chest hop')
    ctx.supplyHop = { planks: Date.now() } // the hop leg started (tick stamps it)
    // the hop failed on the path: a fresh record drops hopTried, the chest stays a candidate
    failWorldAt(bot, ctx, 'planks', 'failed:castlefetch-unreachable')
    assert.equal(fetch.hopDue(bot, ctx, 'planks'), true, 'the chest is still a hop candidate')
    assert.equal(fetch.holdFor(bot, ctx, 'planks'), true, 'the world site stays parked')
    for (let i = 0; i < 5; i++) {
      const d = fetch.demand(bot, ctx)
      assert.ok(d && d.acquire === true && !d.hop, `tick ${i}: acquire, not another hop: ${JSON.stringify(d)}`)
    }
  })

  it('hop window expired -> chests get one more try', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'planks', left: 64 }; return 'planks-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'planks', 'failed:castlefetch-no-trees')
    ctx.supplyHop = { planks: Date.now() - require('../src/budget').CASTLEFETCH_RETRY_MS - 1 }
    assert.equal(fetch.demand(bot, ctx).hop, true)
  })

  it('a running acquire leg off-site keeps the body: gocastle not feasible by day', () => {
    const bot = makeBot({ at: pos(SITE.x + 300, 64, SITE.z) })
    const ctx = { castle: castleState(), step: 'castlefetch', stepStatus: 'running', castleFetch: { kind: 'planks', acquire: { item: 'oak_planks', n: 64 } } }
    assert.equal(goal.displacedFromCastle(bot, ctx), true, 'displaced')
    assert.equal(goal.MENU.gocastle.feasible({ time: 'day' }, bot, ctx), false, 'no walk back mid-acquire')
    ctx.castleFetch = { kind: 'planks', hop: true }
    assert.equal(goal.MENU.gocastle.feasible({ time: 'day' }, bot, ctx), true, 'a non-acquire leg still walks back')
  })
})
