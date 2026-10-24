'use strict'

// idkcraft-prkh: a stone castlefetch failure parked the WHOLE step for 5
// min (demand() + the menu hold), so a fence word the chest planks could
// fill never ran and the FSM fell to gather, which spun minutes among
// protected castle/house logs with zero gain. The hold is per kind now:
// stone-unreachable parks stone while fence still relays from the chest,
// and gather never chops for a held word.

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
      itemsByName: { oak_fence: {}, birch_fence: {}, oak_planks: {}, birch_planks: {}, oak_log: {}, birch_log: {}, stick: {}, crafting_table: {} },
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
      withdraw: async (type, _meta, n) => {
        const s = chest.find((c) => c.name === type)
        if (!s) return
        s.count -= n
        const it = items.find((i) => i.name === type)
        if (it) it.count += n
        else items.push({ name: type, count: n })
      },
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

const settle = () => new Promise((r) => setImmediate(r))

function heldCtx(kind, status = 'failed:castlefetch-unreachable') {
  return {
    castle: castleState(),
    castleWord: { kind, left: 6 },
    stepFail: { castlefetch: { status, kind, at: Date.now(), text: 'castle=stone-none', pos: null } },
  }
}

describe('prkh per-kind fetch hold', () => {
  const realFact = castleMod.menuFact
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => {
    castleMod.menuFact = realFact
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
  })

  it('a stone hold still serves a fence word from the chest', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    const ctx = heldCtx('stone')
    const bot = makeBot()
    const d = fetch.demand(bot, ctx)
    assert.ok(d && d.kind === 'fence' && d.short > 0, `fence demand survives the stone hold: ${JSON.stringify(d)}`)
  })

  it('the held kind itself stays parked, legacy holds park all', () => {
    const bot = makeBot()
    castleMod.menuFact = (b, c) => { c.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    assert.equal(fetch.demand(bot, heldCtx('stone')), null, 'stone demand parked')
    const other = fetch.demand(bot, heldCtx('fence'))
    assert.ok(other && other.kind === 'stone', `stone demand proceeds under a fence hold: ${JSON.stringify(other)}`)
    const legacy = heldCtx('stone')
    delete legacy.stepFail.castlefetch.kind
    castleMod.menuFact = (b, c) => { c.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    assert.equal(fetch.demand(bot, legacy), null, 'kindless hold parks every kind')
  })

  it('an expired hold releases the kind', () => {
    castleMod.menuFact = (b, c) => { c.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const ctx = heldCtx('stone')
    ctx.stepFail.castlefetch.at -= 6 * 60 * 1000
    assert.ok(fetch.demand(makeBot(), ctx), 'expired stone hold retries')
  })

  it('a gather-ended wood leg stamps its kind on the hold', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = () => ({ done: false }) // pack cannot craft: fall to the world
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'failed:no-trees' }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.equal(ctx.stepStatus, 'failed:no-trees')
    assert.equal(ctx.castleFetchFailKind, 'fence', 'the failed kind is stamped for the record')
    // The record carries the kind, so the next word decides per kind.
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:no-trees', true, 'castle=fence-none')
    assert.equal(ctx.stepFail.castlefetch.kind, 'fence')
  })

  it('recordOutcome without a stamp writes a kindless (hold-all) record', () => {
    const ctx = { castle: castleState() }
    goal.recordOutcome(makeBot(), ctx, {}, 'castlefetch', 'failed:castlefetch-unreachable', true, 'castle=stone-none')
    assert.ok(ctx.stepFail.castlefetch, 'hold recorded')
    assert.equal(ctx.stepFail.castlefetch.kind, undefined, 'no stamp: hold-all, as before')
  })

  it('the stamp is consumed: a later unstamped failure falls back to hold-all (revmux 01 core-1)', () => {
    const ctx = { castle: castleState(), castleFetchFailKind: 'stone' }
    goal.recordOutcome(makeBot(), ctx, {}, 'castlefetch', 'failed:castlefetch-unreachable', true, 'castle=stone-none')
    assert.equal(ctx.stepFail.castlefetch.kind, 'stone')
    assert.equal(ctx.castleFetchFailKind, null, 'consumed on read')
    // A pane leg that ends through an unstamped gather path (fuel/cobble
    // rungs) parks everything, never inherits the stone kind.
    goal.recordOutcome(makeBot(), ctx, {}, 'castlefetch', 'failed:no-trees', true, 'castle=pane-none')
    assert.equal(ctx.stepFail.castlefetch.kind, undefined, 'stale kind must not leak')
    assert.equal(fetch.holdFor(makeBot(), ctx, 'pane'), true, 'pane still parks')
  })

  it('holds accumulate per kind: torch fail, fence fail, torch still held (revmux 02 core-1)', () => {
    const bot = makeBot()
    const ctx = { castle: castleState() }
    ctx.castleFetchFailKind = 'torch'
    ctx.castleWord = { kind: 'torch', left: 3 }
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:castlefetch-no-torch', true, 'castle=torch-none')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds).sort(), ['torch'])
    ctx.castleFetchFailKind = 'fence'
    ctx.castleWord = { kind: 'fence', left: 9 }
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:no-trees', true, 'castle=fence-none')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds).sort(), ['fence', 'torch'], 'both holds survive')
    assert.equal(fetch.holdFor(bot, ctx, 'torch'), true, 'torch still parked')
    assert.equal(fetch.holdFor(bot, ctx, 'fence'), true, 'fence parked')
    assert.equal(fetch.holdFor(bot, ctx, 'pane'), false, 'an unfailed kind runs')
  })

  it('a done leg retires only its own kind: fence done, stone still held (revmux 02 core-1, 03 core-1)', () => {
    const bot = makeBot()
    const ctx = { castle: castleState() }
    ctx.castleFetchFailKind = 'stone'
    ctx.castleWord = { kind: 'stone', left: 75 }
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:castlefetch-unreachable', true, 'castle=stone-none')
    // The fence relays; decide() re-computes the word as stone BEFORE
    // recordOutcome runs, so only the leg's done stamp may retire fence.
    ctx.castleFetchDoneKind = 'fence'
    ctx.castleWord = { kind: 'stone', left: 75 }
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=stone-none')
    assert.ok(ctx.stepFail.castlefetch, 'the stone hold survives the relay')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds), ['stone'])
    assert.equal(ctx.castleFetchDoneKind, null, 'done stamp consumed')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'stone honestly parked')
    assert.equal(fetch.holdFor(bot, ctx, 'fence'), false, 'fence free')
    // The last kind done clears the slot, as before (re-arm from scratch).
    ctx.castleFetchDoneKind = 'stone'
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=stone-none')
    assert.equal(ctx.stepFail.castlefetch, undefined, 'empty map deletes the record')
  })

  it('a done leg with no stamp keeps the kinds map (revmux 03 core-1)', () => {
    const bot = makeBot()
    const ctx = { castle: castleState() }
    ctx.castleFetchFailKind = 'stone'
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'failed:castlefetch-unreachable', true, 'castle=stone-none')
    // No done leg ran (demand-null done, gather-done mid-leg): the stamp
    // is absent, so the stone hold must survive untouched.
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', 'done', true, 'castle=stone-none')
    assert.deepEqual(Object.keys(ctx.stepFail.castlefetch.kinds), ['stone'])
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), true)
  })

  it('a new leg drops a leftover stamp', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = () => ({ done: false })
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'running' }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    const ctx = { castle: castleState(), castleFetchFailKind: 'stone', castleFetchDoneKind: 'fence' }
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(ctx.castleFetchFailKind, null, 'leg start clears the fail stamp')
    assert.equal(ctx.castleFetchDoneKind, null, 'leg start clears the done stamp')
  })

  it('qxql.3: a leg re-opened past RESTART_MAX with no progress fails once and holds its kind', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = () => ({ done: false })
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'running' }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    const ctx = { castle: castleState() }
    for (let i = 0; i < fetch.RESTART_MAX; i++) {
      fetch(bot, ctx)
      await settle(); await settle()
      assert.equal(ctx.stepStatus, 'running', `start ${i + 1} still fetches`)
      if (i === 0) {
        // A leg that ran past the gap: its next tick re-stamps the streak.
        ctx.castleFetchRestarts.at -= 40 * 1000
        fetch(bot, ctx)
        await settle(); await settle()
      }
      ctx.castleFetch = null // the goal re-decide drops the leg (goal.js re-pick)
    }
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-fence')
    assert.equal(ctx.castleFetchFailKind, 'fence', 'the dead kind is stamped for the per-kind hold')
    assert.ok(ctx.castleFetchDry && ctx.castleFetchDry.has('fence'), 'the decor word skips the dead kind')
    goal.recordOutcome(bot, ctx, {}, 'castlefetch', ctx.stepStatus, true, 'castle=fence-none')
    assert.equal(fetch.holdFor(bot, ctx, 'fence'), true, 'fence parked')
    assert.equal(fetch.holdFor(bot, ctx, 'stone'), false, 'stone still runs')
  })

  it('a blocked fence word proceeds under a stone hold', () => {
    castleMod.menuFact = () => 'blocked'
    const ctx = heldCtx('stone')
    ctx.castleWord = { word: 'blocked', kind: 'fence', left: 9 }
    const d = fetch.demand(makeBot(), ctx)
    assert.ok(d && d.kind === 'fence' && d.word === 'blocked', `blocked fence relays: ${JSON.stringify(d)}`)
  })

  it('failHolds releases the menu entry when the word moved to another kind', () => {
    const text = 'castle=fence-none'
    const mk = (kind) => ({
      castle: castleState(),
      castleWord: { kind: 'fence', left: 6 },
      stepFail: { castlefetch: { status: 'failed:castlefetch-unreachable', kind, at: Date.now(), text, pos: null } },
    })
    assert.equal(goal.failHolds(mk('stone'), 'castlefetch', text, makeBot()), false, 'stone hold never holds a fence word')
    assert.equal(goal.failHolds(mk('fence'), 'castlefetch', text, makeBot()), true, 'fence hold still holds a fence word')
  })

  it('gather never chops for a fetch-held word', () => {
    const facts = { home: 'built', castle: 'stone-none', logs: 0, planks: 0, table: 1, door: 1, beds: 'both', time: 'day' }
    const bot = makeBot()
    // qxql.2: this scenario is a built home (the house-chain veto only fires
    // while the home is unbuilt), so the fixture carries the home record.
    const home = { site: { x: 0, y: 64, z: 0 }, built: true }
    const withHome = (ctx) => ({ ...ctx, home })
    assert.equal(goal.MENU.gather.feasible(facts, bot, withHome(heldCtx('stone'))), false, 'stone held: no chop')
    assert.equal(goal.MENU.gather.feasible(facts, bot, withHome(heldCtx('torch'))), true, 'another kind held: chop as before')
    assert.equal(goal.MENU.gather.feasible(facts, bot, withHome({ castle: castleState() })), true, 'no hold: chop as before')
  })

  it('stepWhy names the parked kind', () => {
    castleMod.menuFact = (b, c) => { c.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
    const facts = { castle: 'stone-none', time: 'day', health: 'ok', food: 'ok', pickaxe: 1 }
    const bot = makeBot()
    // Relocated past the failure point: the text hold releases but the
    // bounded kind hold still parks — the line must name it, not 'batch'.
    // (klh2 R2: the window holds kind-wide; relocation never releases it —
    // the quarry is castle-anchored, so a release would walk back and
    // re-fail the same ground. The hop serves the kind meanwhile.)
    const moved = heldCtx('stone')
    moved.stepFail.castlefetch.pos = { x: 0, y: 64, z: 0 }
    const line = goal.stepWhy('castlefetch', facts, bot, moved, 'castle=stone-none')
    assert.match(line, /stone fetch held/, `the gap is named: ${line}`)
    const freeFacts = { ...facts, pickaxe: 0 }
    const free = goal.stepWhy('castlefetch', freeFacts, bot, { castle: castleState() }, 'castle=stone-none')
    assert.equal(free, 'castlefetch: no pickaxe', 'no hold: the next line below decides')
  })
})
