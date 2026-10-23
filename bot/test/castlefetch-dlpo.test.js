'use strict'

// idkcraft-dlpo: park castlefetch kinds that fail N times on the same day
// (counts, not time). Prod 2026-10-22/23: a complete castle kept opening +
// instantly failing decor legs (banner x2, enchanting_table, bookshelf:
// 430 started / 0 finished, ~600 ticks/day) — the per-kind hold (prkh)
// covers retry timing, never same-day give-up. After PARK_FAILS same-day
// fails a kind parks (demand null, menu held, a parked line); it unparks
// next day or on a bank deposit.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const goal = require('../src/goal')
const budget = require('../src/budget')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const N = budget.CASTLEFETCH_PARK_FAILS

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot(day = 7) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(SITE.x - 4, 64, SITE.z - 4), onGround: true },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day },
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

describe('dlpo same-day park', () => {
  const realFact = castleMod.menuFact
  const realLog = console.log
  let lines
  afterEach(() => {
    castleMod.menuFact = realFact
    console.log = realLog
  })

  function capture() {
    lines = []
    console.log = (...a) => { lines.push(a.join(' ')) }
  }

  it('parks after N same-day fails with a parked line', () => {
    assert.ok(typeof N === 'number' && N >= 2, `park limit sane: ${N}`)
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) {
      assert.equal(fetch.isParked(ctx, bot, 'banner'), false, `not parked after ${i} fails`)
      failKind(bot, ctx, 'banner')
    }
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, `parked after ${N} fails`)
    assert.ok(lines.some((l) => /castlefetch banner: parked for the day after/.test(l)), `parked line logged: ${JSON.stringify(lines)}`)
  })

  it('a parked kind stays held past the retry window while other kinds run', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    expireTimeHold(ctx)
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, 'park survives the expired window')
    assert.equal(fetch.holdFor(bot, ctx, 'banner'), true, 'parked kind held')
    assert.equal(fetch.demand(bot, ctx), null, 'parked kind fetches nothing')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), false, 'another kind runs')
  })

  it('a replay opens at most N legs for an unobtainable kind, then no churn', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    let legs = 0
    for (let i = 0; i < N + 3; i++) {
      const d = fetch.demand(bot, ctx)
      if (!d) break
      legs++
      failKind(bot, ctx, d.kind)
      expireTimeHold(ctx) // retry windows pass; only the park may hold now
    }
    assert.ok(legs <= N, `at most ${N} legs, got ${legs}`)
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, 'parked after the replay')
    assert.equal(fetch.demand(bot, ctx), null, 'no further legs, no kind-switch churn')
  })

  it('unparks next day', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot(7)
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, 'parked on day 7')
    bot.time.day = 8
    expireTimeHold(ctx)
    assert.equal(fetch.isParked(ctx, bot, 'banner'), false, 'unparked on day 8')
    assert.equal(fetch.holdFor(bot, ctx, 'banner'), false, 'no hold on day 8')
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'banner', `banner fetches again: ${JSON.stringify(d)}`)
  })

  it('unparks on a bank deposit', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, 'parked before the deposit')
    goal.recordOutcome(bot, ctx, {}, 'bank', 'done', true, 'castle=banner-none')
    assert.equal(fetch.isParked(ctx, bot, 'banner'), false, 'unparked after the deposit')
    assert.ok(lines.some((l) => /unparked after bank deposit/.test(l)), `unpark line logged: ${JSON.stringify(lines)}`)
  })

  it('a done leg unparks its kind', () => {
    capture()
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    assert.equal(fetch.isParked(ctx, bot, 'banner'), true, 'parked before stock')
    ctx.castleFetchDoneKind = 'banner'
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=banner-none')
    assert.equal(fetch.isParked(ctx, bot, 'banner'), false, 'unparked by stock')
  })

  it('stepWhy names the park', () => {
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    const line = goal.stepWhy('castlefetch', { castle: 'banner-none', time: 'day', health: 'ok', food: 'ok' }, bot, ctx, 'castle=banner-none')
    assert.match(line, /parked/, `the gap names the park: ${line}`)
  })

  it('failHolds holds the parked word, releases other kinds', () => {
    castleMod.menuFact = bannerWord
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (let i = 0; i < N; i++) failKind(bot, ctx, 'banner')
    expireTimeHold(ctx)
    ctx.castleWord = { kind: 'banner', left: 2 }
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=banner-none', bot), true, 'parked word held')
    ctx.castleWord = { kind: 'stone', left: 75 }
    assert.equal(goal.failHolds(ctx, 'castlefetch', 'castle=stone-none', bot), false, 'another kind released')
  })
})
