'use strict'

// idkcraft-qxql33: V2b rested forever at health 2.33 / food 15 holding 86
// wheat; food recovery now crafts bread at a standing table (wheat only).
const { it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const craftPath = require.resolve('../src/behaviours/craftany')
let table = true
let craftCalls = 0
let craftResult = 'running'
const fakeCraft = (bot, ctx, name, count) => {
  craftCalls++
  assert.equal(name, 'bread'); assert.equal(count, 1)
  return typeof craftResult === 'function' ? craftResult(bot) : craftResult
}
fakeCraft.standingTable = () => (table ? { block: { name: 'crafting_table' }, pos: { x: 1, y: 64, z: 0 } } : null)
require(craftPath)
require.cache[craftPath].exports = fakeCraft
const bring = require('../src/behaviours/bring')
const forage = require('../src/behaviours/forage')
bring.pickChest = () => null
forage.foodTarget = () => null
require('../src/behaviours/explore').castleActive = () => true // V2b: castle gated on eating
const fr = require('../src/behaviours/food-recovery')
const { pickEdible } = require('../src/reflexes')

process.env.BOT_BODY = 'baritone'
const facts = { time: 'day', health: 2.333332 }
let inv
function mkBot() {
  return { health: 2.333332, food: 15, entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => inv } }
}
function mkCtx() { return { work: true, step: 'foodRecovery' } }
beforeEach(() => { table = true; craftCalls = 0; craftResult = 'running'; inv = [{ name: 'wheat', count: 86 }] })

it('raw wheat is never edible', () => {
  assert.equal(pickEdible([{ name: 'wheat', count: 86 }]), null)
})

it('wheat + table: available, crafts bread, ends acquired so the eat reflex eats it', () => {
  const bot = mkBot(); const ctx = mkCtx()
  assert.equal(fr.available(bot, ctx, facts), true)
  fr.run(bot, ctx)
  assert.equal(ctx.foodRecovery.phase, 'bread')
  assert.equal(craftCalls, 1)
  assert.equal(ctx.stepStatus, undefined)
  craftResult = () => { inv = [{ name: 'wheat', count: 83 }, { name: 'bread', count: 1 }]; return { done: true, target: 'bread' } }
  fr.run(bot, ctx)
  assert.equal(ctx.stepStatus, 'done')
  assert.ok(!ctx.foodRecoveryRetryAt)
  assert.equal(pickEdible(inv).name, 'bread')
  assert.equal(fr.needed(bot, ctx, facts), false)
})

it('no table: not available via bread, honest log, no craft', () => {
  table = false
  const bot = mkBot(); const ctx = mkCtx()
  const logs = []; const log = console.log; console.log = (l) => logs.push(l)
  try { assert.equal(fr.available(bot, ctx, facts), false) } finally { console.log = log }
  assert.ok(logs.some((l) => /food recovery source=bread result=no-table wheat=86/.test(l)))
  assert.equal(craftCalls, 0)
})

it('craft failure: retry backoff, no immediate re-entry', () => {
  const bot = mkBot(); const ctx = mkCtx()
  craftResult = { done: false, line: "can't make bread: crafting failed" }
  fr.run(bot, ctx)
  assert.equal(ctx.stepStatus, 'done')
  assert.ok(ctx.foodRecoveryRetryAt > Date.now())
  assert.equal(fr.available(bot, ctx, facts), false)
})

it('table vanishes mid-run: fails honestly without crafting a table', () => {
  const bot = mkBot(); const ctx = mkCtx()
  fr.run(bot, ctx)
  table = false
  fr.run(bot, ctx)
  assert.equal(craftCalls, 1)
  assert.ok(ctx.foodRecoveryRetryAt > Date.now())
})

it('owner order preempts: follow stops the bread run without a craft call', () => {
  const bot = mkBot(); const ctx = mkCtx()
  fr.run(bot, ctx)
  ctx.followName = 'Owner'
  fr.run(bot, ctx)
  assert.equal(craftCalls, 1)
  assert.equal(ctx.foodRecovery.valid, false)
  assert.equal(ctx.stepStatus, undefined)
})

it('fewer than 3 wheat: bread source is off', () => {
  inv = [{ name: 'wheat', count: 2 }]
  assert.equal(fr.available(mkBot(), mkCtx(), facts), false)
})
