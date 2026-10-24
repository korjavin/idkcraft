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
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
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
    // MC day present like in prod (revmux 02-after-fix core-1): the park
    // key is the UTC date, so rolling the MC day must not release it.
    time: { timeOfDay: 6000, day: 0 },
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

// A painted complete v2 castle (every plan cell laid, decor open) with a
// body on site — the real menuFact words real decor kinds. Mirrors the
// g0z.31 castleBot fixture.
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
function paintedBot() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    set.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') set.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const at = (p) => {
    const k = k3(p.x, p.y, p.z)
    return set.has(k) ? set.get(k) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  }
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: new Vec3(SITE.x + 15.5, SITE.y, SITE.z + 13.5), onGround: true },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day: 0 },
    spawnPoint: new Vec3(0, 64, 0),
    players: {},
    registry: { blocksByName: { chest: { id: 2 } }, itemsByName: {} },
    blockAt: (p) => {
      const n = at(p)
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function paintedState() {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false }
}

function k3(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
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
    // klh2: entries are { at, pos } (legacy bare timestamps still read).
    for (const k of Object.keys(sf.kinds)) {
      const e = sf.kinds[k]
      if (typeof e === 'number') sf.kinds[k] = e - 6 * 60 * 1000
      else if (e && typeof e.at === 'number') e.at -= 6 * 60 * 1000
    }
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
    // may stop the replay. The MC day rolls ~72x across the sweep (as in
    // prod); an MC-day key would unpark and push legs far past N.
    const start = T0 - 12 * 60 * 60 * 1000
    for (let t = start; t < start + DAY_MS; t += 5 * 60 * 1000) {
      Date.now = () => t
      bot.time.day = Math.floor((t - start) / (20 * 60 * 1000))
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

  it('main materials keep retrying on a complete castle (revmux 02 core-2)', () => {
    Date.now = () => T0
    const bot = makeBot()
    const ctx = { castle: castleState() }
    for (const kind of ['stone', 'planks', 'stairs']) {
      for (let i = 0; i < N + 2; i++) failKind(bot, ctx, kind)
      assert.equal(fetch.isParked(ctx, kind), false, `${kind} never parks for the date`)
    }
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'the 5-min hold still parks stone')
  })

  it('a parked kinds[0] never pins the decor word (verifier major)', () => {
    // Real menuFact on a painted complete castle (no stubs): kinds[0] is
    // pane. Pre-fix, parking pane with every open kind dry pinned the
    // word on pane-none with null demand, starving every obtainable kind
    // for the date (noteDry never fires without a leg).
    Date.now = () => T0
    const bot = paintedBot()
    const ctx = { castle: paintedState() }
    const kinds = [...new Set(blueprint.decorPlan(SITE, 0, 2).cells.map((c) => c.kind))]
    const wordKind = (w) => w.slice(0, w.lastIndexOf('-'))
    const w0 = castleMod.menuFact(bot, ctx)
    const k0 = wordKind(w0)
    assert.equal(k0, kinds[0], `first decor word is kinds[0]: ${w0}`)
    for (let i = 0; i < N; i++) failKind(bot, ctx, k0)
    assert.equal(fetch.isParked(ctx, k0), true, `${k0} parked`)
    for (const k of kinds) castleMod.noteDry(ctx, k)
    expireTimeHold(ctx)
    // The word moves past the parked kinds[0] to an obtainable kind, and
    // demand serves it.
    const w1 = castleMod.menuFact(bot, ctx)
    const k1 = wordKind(w1)
    assert.notEqual(k1, k0, `word advances past parked ${k0}: ${w1}`)
    assert.equal(fetch.isParked(ctx, k1), false, `${k1} unparked`)
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === k1 && d.short > 0, `demand serves ${k1}: ${JSON.stringify(d)}`)
    // Every open kind parked: the word is the first parked one with null
    // demand, and the rest line still names the park.
    for (const k of kinds) {
      if (k === k0) continue
      for (let i = 0; i < N; i++) failKind(bot, ctx, k)
    }
    expireTimeHold(ctx)
    for (const k of kinds) assert.equal(fetch.isParked(ctx, k), true, `${k} parked`)
    const w2 = castleMod.menuFact(bot, ctx)
    assert.equal(wordKind(w2), k0, `all parked: word is kinds[0]: ${w2}`)
    assert.equal(fetch.demand(bot, ctx), null, 'all parked: null demand')
    const line = goal.stepWhy('castlefetch', { castle: w2, time: 'day', health: 'ok', food: 'ok' }, bot, ctx, `castle=${w2}`)
    assert.match(line, /parked/, `rest line names the park: ${line}`)
  })
})
