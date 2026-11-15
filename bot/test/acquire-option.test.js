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
