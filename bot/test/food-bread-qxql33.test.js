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
// Planner stub: real affordability is covered in food-bread-real-qxql33b.
fakeCraft.planCraft = () => ({ ok: table || inv.some((i) => i.name === 'crafting_table' || i.name.endsWith('_log')) })
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
  assert.ok(logs.some((l) => /food recovery source=bread table=none why=no-table-no-wood wheat=86/.test(l)))
  assert.equal(craftCalls, 0)
})

it('craft failure: bread-only backoff, episode falls through to chest/hunt', () => {
  const bot = mkBot(); const ctx = mkCtx()
  craftResult = { done: false, line: "can't make bread: crafting failed" }
  fr.run(bot, ctx)
  assert.equal(ctx.stepStatus, undefined)
  assert.ok(ctx.foodBreadRetryAt > Date.now() && ctx.foodRecovery.phase === 'chest')
  ctx.foodRecovery.valid = false
  assert.equal(fr.available(bot, ctx, facts), false, 'bread not re-offered, no chest/prey here')
  assert.equal(craftCalls, 1)
})

it('table gone mid-run and no wood: craftany ends it, honest table=none + backoff', () => {
  const bot = mkBot(); const ctx = mkCtx()
  fr.run(bot, ctx)
  table = false
  craftResult = { done: false, line: 'need a crafting table' }
  const logs = []; const log = console.log; console.log = (l) => logs.push(l)
  try { fr.run(bot, ctx) } finally { console.log = log }
  assert.ok(logs.some((l) => /source=bread table=none why="need a crafting table"/.test(l)), logs.join('\n'))
  assert.ok(ctx.foodBreadRetryAt > Date.now() && ctx.foodRecovery.phase === 'chest')
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

it('exactly 3 wheat: async craft 3->0 wheat, 0->1 bread reports crafted, not failed', () => {
  inv = [{ name: 'wheat', count: 3 }]
  const bot = mkBot(); const ctx = mkCtx()
  assert.equal(fr.available(bot, ctx, facts), true)
  const logs = []; const log = console.log; console.log = (l) => logs.push(l)
  try {
    craftResult = () => { ctx.gearInFlight = true; return 'running' }
    fr.run(bot, ctx) // op in flight
    inv = [{ name: 'bread', count: 1 }]; ctx.gearInFlight = false // craft lands, wheat gone
    craftResult = { done: false, line: "can't make bread: crafting failed" } // must not be consulted
    fr.run(bot, ctx)
  } finally { console.log = log }
  assert.ok(logs.some((l) => /source=bread table=reached why=crafted/.test(l)), logs.join('\n'))
  assert.ok(!logs.some((l) => /table=none/.test(l)))
  assert.ok(!ctx.foodRecoveryRetryAt)
  assert.equal(ctx.stepStatus, 'done')
})

it('cancel mid-craft clears the stale craftany run', () => {
  const bot = mkBot(); const ctx = mkCtx()
  craftResult = () => { ctx.craftany = { key: 'breadx1' }; return 'running' }
  fr.run(bot, ctx)
  assert.equal(ctx.craftany.key, 'breadx1')
  ctx.followName = 'Owner'
  fr.run(bot, ctx)
  assert.equal(ctx.craftany, null)
  assert.equal(ctx.foodRecovery.valid, false)
  delete ctx.followName
  ctx.craftany = { key: 'breadx1' }; fr.invalidate(ctx)
  assert.equal(ctx.craftany, null)
})

// idkcraft-qxql33b: prod V2b had table=no logs=few planks=none.
it('no table + a log: bread source on, craftany makes/places the table, crafts bread', () => {
  table = false
  inv = [{ name: 'wheat', count: 86 }, { name: 'oak_log', count: 2 }]
  const bot = mkBot(); const ctx = mkCtx()
  assert.equal(fr.available(bot, ctx, facts), true)
  const logs = []; const log = console.log; console.log = (l) => logs.push(l)
  try {
    craftResult = () => { inv = [{ name: 'wheat', count: 86 }, { name: 'oak_log', count: 1 }]; table = true; return 'running' } // 1 log -> planks -> placed table
    fr.run(bot, ctx)
    assert.equal(ctx.foodRecovery.phase, 'bread')
    craftResult = () => { inv = [{ name: 'wheat', count: 83 }, { name: 'oak_log', count: 1 }, { name: 'bread', count: 1 }]; return { done: true } }
    fr.run(bot, ctx)
  } finally { console.log = log }
  assert.ok(logs.some((l) => /source=bread table=placed why=crafted/.test(l)), logs.join('\n'))
  assert.equal(ctx.stepStatus, 'done')
  assert.ok(!ctx.foodRecoveryRetryAt)
  assert.equal(inv.find((i) => i.name === 'oak_log').count, 1)
})

it('table make never finishes: bounded by the bread deadline, then backoff', () => {
  table = false
  inv = [{ name: 'wheat', count: 86 }, { name: 'oak_log', count: 1 }]
  const bot = mkBot(); const ctx = mkCtx()
  fr.run(bot, ctx)
  ctx.foodRecovery.bread.at -= 121000
  const logs = []; const log = console.log; console.log = (l) => logs.push(l)
  try { fr.run(bot, ctx) } finally { console.log = log }
  assert.equal(craftCalls, 1)
  assert.ok(logs.some((l) => /source=bread table=none why="timeout"/.test(l)), logs.join('\n'))
  assert.ok(ctx.foodBreadRetryAt > Date.now() && ctx.foodRecovery.phase === 'chest')
  assert.equal(ctx.craftany, null)
})

it('cancel mid-placement clears the craftany run', () => {
  table = false
  inv = [{ name: 'wheat', count: 86 }, { name: 'oak_log', count: 1 }]
  const bot = mkBot(); const ctx = mkCtx()
  craftResult = () => { ctx.craftany = { key: 'breadx1', tableP: true, tableTries: 1 }; return 'running' }
  fr.run(bot, ctx)
  ctx.bring = { item: 'iron_ingot' }
  fr.run(bot, ctx)
  assert.equal(craftCalls, 1)
  assert.equal(ctx.craftany, null)
  assert.equal(ctx.foodRecovery.valid, false)
})
