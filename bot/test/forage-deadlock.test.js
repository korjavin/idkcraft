'use strict'

// Forage deadlock (idkcraft-atl.10): after the first failure the final gate
// instant-fails every re-pick while mem/haul stay put — and mem/haul never
// churn while forage is blocked and explore/deliver never run. Prod 36h:
// 103 picks / 265 ticks (2.6/pick), 1 bank. The gate must expire after
// GATED_MAX instant fails so the next pick runs honestly (skips intact per
// the atl.2 contract), and every failure must log its reason (prod had none).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const { FORAGE_RETRY_MS } = require('../src/goal')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function mockBot() {
  const inv = []
  const calls = { setGoal: 0 }
  const chats = []
  const bot = {
    calls, chats, inv,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    registry: { blocksByName: {}, itemsByName: {} },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    inventory: { items: () => inv },
    findBlocks: () => [],
    blockAt: () => ({ name: 'stone' }),
    canDigBlock: () => true,
    dig: async () => {},
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

let logs
let origLog
beforeEach(() => {
  logs = []
  origLog = console.log
  console.log = (...a) => { logs.push(a.join(' ')) }
})
afterEach(() => { console.log = origLog })

function memCtx(cells) {
  const ctx = { lastGoalKey: '', stepStatus: 'running' }
  resources.noteSpots(ctx, cells, 1000)
  return ctx
}

describe('forage deadlock (atl.10)', () => {
  it('logs the failure reason when banking nothing', () => {
    const bot = mockBot()
    const ctx = memCtx([]) // empty memory, no animals -> no-known on tick 1
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.match(logs.join('\n'), /forage failed:no-known strikes=0 drops=none mem=\S+ haul=/)
  })

  it('expires the final gate after 3 instant fails; next pick runs honestly', () => {
    const bot = mockBot() // no pickaxe: iron_ore unplannable -> fail
    const ctx = memCtx([{ x: 10, y: 60, z: 0, name: 'iron_ore' }])
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.ok(ctx.forageFinal, 'final recorded')
    assert.equal(bot.calls.setGoal, 0, 'no honest attempt on the failing run')

    // Re-picks with unchanged mem/haul: instant fails through the gate.
    // (A mid-cycle tool upgrade does NOT release the gate — mem/haul only.)
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.equal(bot.calls.setGoal, 0, 'gated #1: no attempt despite pickaxe')
    assert.match(logs.join('\n'), /forage gated failed:no-known n=1\/3/)
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.equal(bot.calls.setGoal, 0, 'gated #2: no attempt')

    // Third gated re-pick: gate expires (final dropped, failure still
    // reported this pick); the NEXT pick runs honestly and walks.
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known', 'expiring pick still reports failure')
    assert.equal(ctx.forageFinal, null, 'final cleared on expiry')
    assert.equal(bot.calls.setGoal, 0, 'no walk on the expiring pick itself')
    assert.match(logs.join('\n'), /forage gate expired after 3 gated fails/)
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.ok(bot.calls.setGoal >= 1, 'honest retry issues a walk goal')
  })

  it('past the goal hold bound the first pick runs honestly, not gated (bt8s revmux 01)', () => {
    const bot = mockBot() // no pickaxe: iron_ore unplannable -> fail
    const ctx = memCtx([{ x: 10, y: 60, z: 0, name: 'iron_ore' }])
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.ok(ctx.forageFinal, 'final recorded')
    // The goal hold waited out the failure and expired; mem/haul unchanged.
    ctx.stepFail = { forage: { status: 'failed:no-known', text: 'stale', pos: null, at: Date.now() - FORAGE_RETRY_MS - 1 } }
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.forageFinal, null, 'stale final dropped, not replayed')
    assert.ok(bot.calls.setGoal >= 1, 'honest retry issues a walk goal at once')
    assert.doesNotMatch(logs.join('\n'), /forage gated/, 'no gated replay past the bound')
  })

  it('a fresh hold record still replays: the tick-after-fail reason survives (bt8s revmux 01)', () => {
    const bot = mockBot()
    const ctx = memCtx([{ x: 10, y: 60, z: 0, name: 'iron_ore' }])
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    // decide() just stamped the failure (or hasn't run yet): replay, never restart.
    ctx.stepFail = { forage: { status: 'failed:no-known', text: 'fresh', pos: null, at: Date.now() } }
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.equal(bot.calls.setGoal, 0, 'gated: no attempt despite pickaxe')
    assert.match(logs.join('\n'), /forage gated failed:no-known n=1\/3/)
  })

  it('struck cells stay skipped across the expiry (atl.2 contract)', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    ctx.forageSkip = new Set(['40,60,0']) // pre-struck: plan null -> fail
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    for (let i = 0; i < 3; i++) {
      ctx.stepStatus = 'running'
      forage(bot, ctx, null, {})
    }
    assert.equal(ctx.forageFinal, null, 'final expired')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('40,60,0'), 'skip survives expiry')
    // Honest retry with all cells skipped fails no-known WITH a logged reason.
    ctx.stepStatus = 'running'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.match(logs.join('\n'), /forage failed:no-known/)
  })
})
