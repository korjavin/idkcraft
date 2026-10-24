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
    assert.equal(fetch.hopDue(bot, ctx, 'stone'), false, 'no chest to hop to')
    assert.equal(fetch.demand(bot, ctx), null, 'demand stays parked')
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), true, 'the menu entry stays held')
  })

  it('relocated past the site: normal demand, no hop flag', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    failWorldAt(bot, ctx, 'stone', 'failed:castlefetch-unreachable')
    bot.entity.position = pos(0, 64, 0) // >32 from the failure point
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), false, 'relocated: the kind is free')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'stone' && !d.hop, `a full leg runs at the new site: ${JSON.stringify(d)}`)
  })

  it('a siteless (craft) failure never hops, even with a chest', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const bot = makeBot()
    const ctx = withChest({ castle: castleState() })
    ctx.castleFetchFailKind = 'fence' // no site stamp: the pack failed, not the ground
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:castlefetch-craft-fence', true, 'castle=fence-none')
    assert.equal(fetch.holdFor(bot, ctx, 'fence'), true, 'siteless hold parks kind-wide')
    assert.equal(fetch.hopDue(bot, ctx, 'fence'), false, 'no world site parked: no hop')
    assert.equal(fetch.demand(bot, ctx), null, 'demand stays parked')
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
    assert.equal(fetch.demand(bot, ctx), null, 'demand stays parked')
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
      fetch(bot, ctx)
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
