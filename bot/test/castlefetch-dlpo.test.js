'use strict'

// idkcraft-dlpo: park castlefetch kinds that fail N times on the same
// calendar date (counts, not time). Prod 2026-10-22/23: a complete castle
// kept opening + instantly failing decor legs (banner x2,
// enchanting_table, bookshelf: 430 started / 0 finished, ~600 ticks/day) —
// the per-kind hold (prkh) covers retry timing, never same-day give-up.
// After PARK_FAILS same-date fails a kind parks (demand null, menu held, a
// parked line); it unparks next date or on a bank deposit. Only complete
// castles count (revmux 01-review core-3): build-phase stone/planks fails
// keep the 5-min retry. The key is the UTC calendar date, never the MC day
// (~20 real min — a 24h replay would otherwise open hundreds of legs per
// kind; revmux 01-review core-1).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const goal = require('../src/goal')
const budget = require('../src/budget')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const N = budget.CASTLEFETCH_PARK_FAILS
const DAY_MS = 24 * 60 * 60 * 1000
// Fixed clock inside one UTC date (2026-10-23); tests advance it by hand.
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0)
const realNow = Date.now

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot() {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(SITE.x - 4, 64, SITE.z - 4), onGround: true },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: { blocksByName: { chest: { id: 54 } }, itemsByName: {} },
    blockAt: (p) => ({ name: 'air', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'empty' }),
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'complete', blocked: {}, parked: false, ...extra }
}

function bannerWord(bot, ctx) {
  ctx.castleWord = { kind: 'banner', left: 2 }
  return 'banner-none'
}

function failKind(bot, ctx, kind, status = `failed:castlefetch-no-${kind}`) {
  ctx.castleFetchFailKind = kind
  goal.recordOutcome(bot, ctx, {}, 'castlefetch', status, true, `castle=${kind}-none`)
}

function expireTimeHold(ctx) {
  const sf = ctx.stepFail && ctx.stepFail.castlefetch
  if (!sf) return
  if (typeof sf.at === 'number') sf.at -= 6 * 60 * 1000
  if (sf.kinds && typeof sf.kinds === 'object') {
    for (const k of Object.keys(sf.kinds)) sf.kinds[k] -= 6 * 60 * 1000
  }
}

function fetchRetryFires(bot, ctx) {
  const f = goal.FORCES.find((x) => x.name === 'fetch-retry')
  return f.fires('castlefetch', {}, ctx, 'failed:castlefetch-no-banner', bot, 'castle=banner-none')
}

describe('dlpo same-day park', () => {
  const realFact = castleMod.menuFact
  const realLog = console.log
  let lines
  afterEach(() => {
    castleMod.menuFact = realFact
    console.log = realLog
    Date.now = realNow
  })

  function capture() {
    lines = []
    console.log = (...a) => { lines.push(a.join(' ')) }
  }

  function parkBanner(bot, ctx, n = N) {
    for (let i = 0; i < n; i++) failKind(bot, ctx, 'banner')
  }

  it('parks after N same-date fails with a parked line', () => {
    assert.ok(typeof N === 'number' && N >= 2, `park limit sane: ${N}`)
    Date.now = () => T0
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) {
      assert.equal(fetch.isParked(ctx, 'banner'), false, `not parked after ${i} fails`)
      failKind(bot, ctx, 'banner')
    }
    assert.equal(fetch.isParked(ctx, 'banner'), true, `parked after ${N} fails`)
    assert.ok(lines.some((l) => /castlefetch banner: parked for the day after/.test(l)), `parked line logged: ${JSON.stringify(lines)}`)
  })

  it('a parked kind stays held past the retry window while other kinds run', () => {
    Date.now = () => T0
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    expireTimeHold(ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'park survives the expired window')
    assert.equal(fetch.holdFor(bot, ctx, 'banner'), true, 'parked kind held')
    assert.equal(fetch.demand(bot, ctx), null, 'parked kind fetches nothing')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), false, 'another kind runs')
  })

  it('a 24h replay opens at most N legs for an unobtainable kind, then no churn', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    let legs = 0
    // A full UTC date in 5-min steps: every step the kind may be fetched,
    // then fails; the 5-min hold is expired on purpose so only the park
    // may stop the replay.
    for (let t = T0 - 12 * 60 * 60 * 1000; t < T0 + 12 * 60 * 60 * 1000; t += 5 * 60 * 1000) {
      Date.now = () => t
      const d = fetch.demand(bot, ctx)
      if (!d) continue
      legs++
      failKind(bot, ctx, d.kind)
      expireTimeHold(ctx)
    }
    assert.ok(legs <= N, `at most ${N} legs in 24h, got ${legs}`)
    Date.now = () => T0 + 12 * 60 * 60 * 1000 - 1
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'parked after the replay')
    assert.equal(fetch.demand(bot, ctx), null, 'no further legs, no kind-switch churn')
    assert.equal(lines.filter((l) => /parked for the day/.test(l)).length, 1, `one parked line: ${JSON.stringify(lines)}`)
  })

  it('unparks next date', () => {
    Date.now = () => T0
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'parked on the date')
    Date.now = () => T0 + DAY_MS
    expireTimeHold(ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), false, 'unparked next date')
    assert.equal(fetch.holdFor(bot, ctx, 'banner'), false, 'no hold next date')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'banner', `banner fetches again: ${JSON.stringify(d)}`)
  })

  it('unparks on a bank deposit', () => {
    Date.now = () => T0
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'parked before the deposit')
    goal.recordOutcome(bot, ctx, {}, 'bank', 'done', true, 'castle=banner-none')
    assert.equal(fetch.isParked(ctx, 'banner'), false, 'unparked after the deposit')
    assert.ok(lines.some((l) => /unparked after bank deposit/.test(l)), `unpark line logged: ${JSON.stringify(lines)}`)
  })

  it('a done leg unparks its kind', () => {
    Date.now = () => T0
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'parked before stock')
    ctx.castleFetchDoneKind = 'banner'
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=banner-none')
    assert.equal(fetch.isParked(ctx, 'banner'), false, 'unparked by stock')
  })

  it('stepWhy names the park', () => {
    Date.now = () => T0
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    const line = goal.stepWhy('castlefetch', { castle: 'banner-none', time: 'day', health: 'ok', food: 'ok' }, bot, ctx, 'castle=banner-none')
    assert.match(line, /parked/, `the gap names the park: ${line}`)
  })

  it('failHolds holds the parked word, releases other kinds', () => {
    Date.now = () => T0
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    expireTimeHold(ctx)
    ctx.castleWord = { kind: 'banner', left: 2 }
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=banner-none', bot), true, 'parked word held')
    ctx.castleWord = { kind: 'stone', left: 75 }
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), false, 'another kind released')
  })

  it('an expired time hold retires but the park survives fetch-retry (revmux 01 core-2)', () => {
    Date.now = () => T0
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    expireTimeHold(ctx)
    assert.equal(fetchRetryFires(bot, ctx), true, 'the force fires on the expired hold')
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'the park survives the force')
    assert.equal(fetch.holdFor(bot, ctx, 'banner'), true, 'the kind stays held past the window')
  })

  it('an unrelated done keeps every other parked kind (revmux 01 core-2)', () => {
    Date.now = () => T0
    const bot = makeBot()
    const ctx = { castle: castleState() }
    parkBanner(bot, ctx)
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'banner parked')
    ctx.castleFetchDoneKind = 'stone'
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=stone-none')
    assert.equal(fetch.isParked(ctx, 'banner'), true, 'banner stays parked past a stone done')
  })

  it('no park while the castle is still being built (revmux 01 core-3)', () => {
    Date.now = () => T0
    const bot = makeBot()
    const ctx = { castle: castleState({ phase: 'body' }) }
    for (let i = 0; i < N + 2; i++) failKind(bot, ctx, 'stone')
    assert.equal(fetch.isParked(ctx, 'stone'), false, 'build-phase stone never parks')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'the 5-min hold still parks it')
  })
})
