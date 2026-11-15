'use strict'
const test = require('node:test')
const assert = require('node:assert')
const castlefetch = require('../src/behaviours/castlefetch')
const { goalOptions } = require('../src/goal-options')

// prod 2026-11-15 bot3: castle short of planks, the only chest unreachable
// (chest walk noPath held the kind, no world site), no tree remembered.
function prodState() {
  const now = Date.now()
  const ctx = {
    castle: { site: { x: 0, y: 64, z: 0 } },
    castleWord: { kind: 'planks', left: 40 },
    resources: { items: new Map() },
    stepFail: { castlefetch: { at: now, status: 'failed:castlefetch-no-planks', text: 'x', kinds: { planks: { at: now } } } },
  }
  const bot = { inventory: { items: () => [], emptySlotCount: () => 30 }, entity: { position: { x: 10, y: 64, z: 10 } } }
  return { bot, ctx }
}

test('held planks with no reachable chest or tree: demand hands the leg to acquire', () => {
  const { bot, ctx } = prodState()
  const d = castlefetch.demand(bot, ctx)
  assert.ok(d && d.acquire, 'acquire leg')
  assert.strictEqual(castlefetch.acquireItem(bot, 'planks'), 'oak_planks')
})

test('the castle goal menu offers acquire-oak_planks while the tree gate skips gather-far', () => {
  const { bot, ctx } = prodState()
  const skips = []
  const ids = goalOptions(bot, ctx, 'castle', skips).map((o) => o.id)
  assert.ok(ids.includes('acquire-oak_planks'), `options: ${ids}`)
  assert.ok(skips.some((s) => s.id === 'gather-far'))
})

test('a fresh acquire failure rests the kind (bounded, no tick churn)', () => {
  const { bot, ctx } = prodState()
  ctx.acquireHeld = { planks: Date.now() }
  assert.strictEqual(castlefetch.demand(bot, ctx), null)
})

test('a chosen acquire-<item> runs acquire even when the kind has a live chest/source leg', () => {
  const acq = require('../src/behaviours/acquire')
  const orig = acq.acquire
  const calls = []
  acq.acquire = (bot, ctx, item) => { calls.push(item); return 'running' }
  try {
    const { bot, ctx } = prodState()
    delete ctx.stepFail // no hold: demand serves the chest/source leg
    assert.ok(!(castlefetch.demand(bot, ctx) || {}).acquire, 'unchosen: the ordinary leg')
    const ids = goalOptions(bot, ctx, 'castle', []).map((o) => o.id)
    assert.ok(ids.includes('acquire-oak_planks'), `offered without a hold: ${ids}`)
    ctx.goal = { id: 'g', generation: 1, commit: { goalId: 'g', generation: 1, step: 'castlefetch', until: Date.now() + 60000, unlock: { acquire: 'planks' } } }
    assert.ok(castlefetch.demand(bot, ctx).acquire, 'chosen: the acquire leg')
    castlefetch(bot, ctx, null, {})
    assert.deepStrictEqual(calls, ['oak_planks'])
  } finally { acq.acquire = orig }
})

// Owner (never one material): every fetchable castle kind short with no
// chest gets acquire-<item>; with the next cells covered it does not.
test('every castle kind: short -> acquire offered, enough on hand -> not', () => {
  for (const kind of Object.keys(castlefetch.FETCH)) {
    const { bot, ctx } = prodState()
    delete ctx.stepFail
    ctx.castleWord = { kind, left: 40 }
    const item = castlefetch.acquireItem(bot, kind)
    assert.ok(item, `${kind} has an acquire item`)
    const ids = () => goalOptions(bot, ctx, 'castle', []).map((o) => o.id)
    assert.ok(ids().includes(`acquire-${item}`), `${kind} short: ${ids()}`)
    bot.inventory.items = () => [{ name: item, count: 1000 }]
    const skips = []
    assert.ok(!goalOptions(bot, ctx, 'castle', skips).some((o) => o.id === `acquire-${item}`), `${kind} covered`)
    assert.ok(skips.some((s) => s.id === 'acquire' && /enough on hand/.test(JSON.stringify(s))), `${kind} skip: ${JSON.stringify(skips)}`)
  }
})
