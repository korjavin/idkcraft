'use strict'

// idkcraft-qxql.2 (deterministic half): while a castle order is active the
// HOME house chain (gather/craft with home != built as their reason) is not
// feasible — the castle is the project. Castle wood rides castlefetch's wood
// leg, never the house steps. With the chain gone the FSM falls to
// explore/idle/rest and the qxql.10 LLM chooser takes over; without a key
// the menu stands. A failed fetch leg parks its KIND (per-kind hold, prkh),
// never the whole step, so the next fetch strategy still runs.

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

function makeBot({ items = [], at = pos(SITE.x - 4, 64, SITE.z - 4) } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at, onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities: {},
    health: 20,
    food: 20,
    blockAt: () => ({ name: 'air', position: pos(0, 64, 0), boundingBox: 'empty' }),
    findBlocks: () => [],
    registry: {
      blocksByName: {},
      itemsByName: { oak_planks: {}, birch_planks: {}, oak_log: {}, stick: {}, crafting_table: {}, stone_pickaxe: {} },
    },
    pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

function unbuiltHome() {
  return { site: { x: 0, y: 64, z: 0 }, built: false, v: 2 }
}

function builtHome() {
  return { site: { x: 0, y: 64, z: 0 }, built: true, v: 2 }
}

const realFact = castleMod.menuFact
afterEach(() => { castleMod.menuFact = realFact })

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('qxql.2 house chain veto while a castle order is active', () => {
  it('unbuilt home + active castle: the home-budget chop waits, named as castle-first', () => {
    const ctx = { home: unbuiltHome(), castle: castleState() }
    const bot = makeBot()
    // stone-batch never chops (the kit clause is -none/-some only), so a
    // short load reads pure home-budget here — and the castle owns the work.
    const gatherFacts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, home: 'site', beds: 'both', castle: 'stone-batch', health: 20, food: 20 }
    assert.equal(goal.MENU.gather.feasible(gatherFacts, bot, ctx), false, 'no house gather under a castle order')
    assert.equal(goal.stepWhy('gather', gatherFacts, bot, ctx, ''), 'gather: castle comes first')
  })

  it('unbuilt home + active castle: the kit path still bootstraps (chop, batch, table)', () => {
    const ctx = { home: unbuiltHome(), castle: castleState() }
    const bot = makeBot()
    const empty = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, home: 'site', beds: 'both', castle: 'stone-none', health: 20, food: 20 }
    // Core-1: an empty kit chops the castle chain — the old starvation shape.
    assert.equal(goal.MENU.gather.feasible(empty, bot, ctx), true, 'empty kit chops the castle chain')
    assert.equal(goal.stepWhy('gather', empty, bot, ctx, ''), null)
    // A chopped load converts while the kit is incomplete (pickaxe missing,
    // planks-equivalent on hand).
    const load = { ...empty, logs: 14 }
    assert.equal(goal.MENU.craft.feasible(load, bot, ctx), true, 'a chopped load converts for the kit')
    // The table branch arms equip while the pickaxe is still missing (rock
    // on hand for the head, planks for sticks, no table standing anywhere).
    const planks = { ...empty, maxPlanks: 4, planks: 4, cobble: 3 }
    assert.equal(goal.MENU.craft.feasible(planks, bot, ctx), true, 'the table branch runs while the kit is incomplete')
    // A finished kit reads as home-budget and waits.
    const done = { ...empty, pickaxe: 1, sword: 1, scaffold: 32 }
    assert.equal(goal.MENU.craft.feasible(done, bot, ctx), false, 'a finished kit waits out the castle')
    assert.equal(goal.stepWhy('craft', done, bot, ctx, ''), 'craft: castle comes first')
    // Discriminating (revmux 02 minor): a chopped load on a finished kit
    // must not convert — the batch is home-budget, veto or no veto aside.
    assert.equal(goal.MENU.craft.feasible({ ...done, logs: 14 }, bot, ctx), false, 'no batch on a finished kit')
    // The vetoed path excludes the door branch even mid-bootstrap: a
    // placed table plus planks must not mint the house door under a castle.
    const doorKit = { time: 'day', logs: 0, planks: 6, maxPlanks: 6, table: 0, door: 0, home: 'site', beds: 'both', castle: 'stone-none', health: 20, food: 20, tablePlaced: true, tableOwed: false }
    assert.equal(goal.MENU.craft.feasible(doorKit, bot, ctx), false, 'no house door while the kit is incomplete')
  })

  it('work-mode house (no castle): gather and craft run as before', () => {
    const ctx = { home: unbuiltHome() }
    const bot = makeBot()
    const base = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, home: 'site', beds: 'both', castle: 'none', health: 20, food: 20 }
    assert.equal(goal.MENU.gather.feasible(base, bot, ctx), true, 'house gather runs with no castle')
    assert.equal(goal.MENU.craft.feasible({ ...base, logs: 14 }, bot, ctx), true, 'house craft runs with no castle')
  })

  it('built home + active castle: the castle chop and kit craft survive (narrow veto)', () => {
    const ctx = { home: builtHome(), castle: castleState() }
    const bot = makeBot()
    // vmzq.17 pickaxe chain: a stone word with no logs still chops.
    const chop = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 1, door: 1, home: 'built', beds: 'both', castle: 'stone-none', health: 20, food: 20 }
    assert.equal(goal.MENU.gather.feasible(chop, bot, ctx), true, 'castle chop survives on a built home')
    const batch = { ...chop, logs: 14 }
    assert.equal(goal.MENU.craft.feasible(batch, bot, ctx), true, 'kit craft survives on a built home')
  })

  it('parked/complete castle releases the veto', () => {
    const bot = makeBot()
    const facts = { time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 1, home: 'site', beds: 'both', castle: 'none', health: 20, food: 20 }
    for (const castle of [castleState({ parked: true }), castleState({ phase: 'complete' })]) {
      const ctx = { home: unbuiltHome(), castle }
      assert.equal(goal.MENU.gather.feasible(facts, bot, ctx), true, 'parked/complete castle: house gather runs')
    }
  })
})

describe('qxql.2 castle order + both holds yields no house step', () => {
  it('stone held on both legs, unbuilt home: decide rests, never gather/craft for the home', async () => {
    await quiet(async () => {
      castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'stone', left: 75 }; return 'stone-none' }
      const bot = makeBot({
        items: [
          { name: 'stone_pickaxe', count: 1 },
          { name: 'stone_sword', count: 1 },
          { name: 'dirt', count: 32 },
        ],
      })
      const ctx = { home: unbuiltHome(), castle: castleState(), work: true, brain: null }
      const facts = goal.goalFacts(bot, ctx)
      assert.equal(facts.castle, 'stone-none')
      const text = goal.goalText(facts, ctx.home)
      const now = Date.now()
      ctx.stepFail = {
        castlefetch: { status: 'failed:castlefetch-unreachable', text, pos: null, at: now, kinds: { stone: now } },
        castle: { status: 'failed:build-stall', text, pos: null, at: now },
      }
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'rest', `both holds: no house step, got ${d.action}`)
      assert.ok(ctx.restWhy.includes('gather: stone fetch held'), `rest names the gather park: ${ctx.restWhy}`)
      assert.ok(ctx.restWhy.includes('craft: castle comes first'), `rest names the craft veto: ${ctx.restWhy}`)
    })
  })

  it('a stone hold still serves a fence word: decide relays castlefetch, never the house chain', async () => {
    await quiet(async () => {
      castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
      const bot = makeBot()
      const ctx = { home: builtHome(), castle: castleState(), work: true, brain: null }
      const facts = goal.goalFacts(bot, ctx)
      const text = goal.goalText(facts, ctx.home)
      const now = Date.now()
      ctx.stepFail = {
        castlefetch: { status: 'failed:castlefetch-unreachable', text, pos: null, at: now, kinds: { stone: now } },
      }
      const d = await goal.decide(bot, ctx)
      assert.equal(d.action, 'castlefetch', `fence relays under a stone hold, got ${d.action}`)
      assert.equal(fetch.holdFor(bot, ctx, 'stone'), true, 'stone stays parked')
      assert.equal(fetch.holdFor(bot, ctx, 'fence'), false, 'fence runs')
    })
  })
})
