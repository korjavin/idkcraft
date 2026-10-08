'use strict'

// Bead idkcraft-vmzq.51: the vmzq.49 low-hp castle gate has no timeout —
// with hp<6, no food, no animals and no regen, castle work stands down
// until the goal watchdog parks or plan-B switches. Fix: bound the gate
// (LOW_HP_GATE_MS of continuous gating, then work resumes at low hp) and
// pin the stall + the release.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
require('../src/index') // BEHAVIOURS registration (goal.registered)

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function goalBot({ items = [], health = 5, food = 10, entities = {} } = {}) {
  return {
    chats: [],
    entity: { position: pos(0, 64, 0), onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    entities,
    health,
    food,
    chat: (m) => {},
  }
}

function castleState(site) {
  return { site: site || { x: 5, y: 64, z: 5 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
}

async function quietAsync(fn) {
  const origLog = console.log
  const origErr = console.error
  console.log = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.log = origLog; console.error = origErr }
}

describe('vmzq.51: the low-hp castle gate releases after a bounded stall', () => {
  const TOOLS = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
  const foodless = () => goalBot({ items: [...TOOLS], health: 5, food: 10 })
  const castleFacts = { time: 'day', castle: 'stone-batch', health: 5, food: 10 }
  const fetchFacts = { time: 'day', castle: 'torch-none', pickaxe: 1, health: 5, food: 10 }
  const fetchCtx = (over = {}) => ({ castle: castleState(), castleWord: { kind: 'torch', left: 3 }, ...over })

  it('fresh gate: castle + castlefetch still stand down (vmzq.49 stands)', () => {
    assert.equal(goal.MENU.castle.feasible(castleFacts, foodless(), {}), false)
    assert.equal(goal.MENU.castle.feasible(castleFacts, foodless(), { lowHpGateSince: Date.now() }), false)
    assert.equal(goal.MENU.castlefetch.feasible(fetchFacts, foodless(), fetchCtx()), false)
    assert.equal(goal.stepWhy('castle', castleFacts, foodless(), {}, ''), 'castle: eating first (low health, no food)')
  })

  it('past LOW_HP_GATE_MS without food: the gate opens, wording moves on', () => {
    const old = Date.now() - goal.LOW_HP_GATE_MS - 1
    assert.equal(goal.MENU.castle.feasible(castleFacts, foodless(), { lowHpGateSince: old }), true)
    assert.equal(goal.MENU.castlefetch.feasible(fetchFacts, foodless(), fetchCtx({ lowHpGateSince: old })), true)
    assert.notEqual(goal.stepWhy('castle', castleFacts, foodless(), { lowHpGateSince: old }, ''), 'castle: eating first (low health, no food)')
  })

  it('decide arms the clock while gated and clears it once fed', async () => {
    await quietAsync(async () => {
      const gated = goalBot({ items: [...TOOLS], health: 5, food: 10 })
      const c = { castle: castleState(), home: { site: { x: 0, y: 64, z: 0 }, built: true } }
      await goal.decide(gated, c)
      assert.ok(typeof c.lowHpGateSince === 'number', 'clock arms while gated')
      const fed = goalBot({ items: [...TOOLS, { name: 'bread', count: 2 }], health: 5, food: 10 })
      await goal.decide(fed, c)
      assert.equal(c.lowHpGateSince, null, 'food clears the clock')
    })
  })

  it('gate expiry wakes a steady menu: rest re-picks to castle through decide', async () => {
    await quietAsync(async () => {
      // Cobble on hand + flat world: the word reads stone-batch (probed).
      const world = {
        blockAt(p) {
          const n = Math.floor(p.y) <= 63 ? 'dirt' : 'air'
          return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
        },
      }
      const bot = goalBot({ items: [...TOOLS, { name: 'cobblestone', count: 64 }, { name: 'dirt', count: 32 }], health: 5, food: 10 })
      bot.blockAt = (p) => world.blockAt(p)
      const c = {
        castle: castleState(), // near site: no displacement, gate is the only veto
        home: { site: { x: 0, y: 64, z: 0 }, built: true },
        gear: { saidNeed: 'want-logs' }, // latch the ladder out (vmzq49 precedent)
        step: 'rest',
        stepStatus: 'running',
      }
      const text = goal.goalText(goal.goalFacts(bot, c), c.home)
      assert.match(text, /castle=stone-batch/, 'setup: a batch waits')
      c.goalText = text
      c.askedKey = `${text}\nrunning`
      assert.equal((await goal.decide(bot, c)).action, 'rest', 'gated: rest replays')
      // 5 min pass with steady facts (continuous: last stays fresh).
      c.lowHpGateLast = Date.now()
      c.lowHpGateSince = Date.now() - goal.LOW_HP_GATE_MS - 1
      const text2 = goal.goalText(goal.goalFacts(bot, c), c.home)
      assert.equal(text2, text, 'setup: facts steady')
      assert.equal((await goal.decide(bot, c)).action, 'castle', 'expiry forces a fresh pick')
    })
  })

  it('a silence past the gap restarts the window instead of opening (fight/follow)', async () => {
    await quietAsync(async () => {
      const gated = goalBot({ items: [...TOOLS], health: 5, food: 10 })
      const c = { castle: castleState(), home: { site: { x: 0, y: 64, z: 0 }, built: true } }
      await goal.decide(gated, c)
      // Fight owned the body for 10 min (no decide ticks): the stamp is old
      // but the gating was not continuous — the window restarts, no opening.
      c.lowHpGateSince = Date.now() - goal.LOW_HP_GATE_MS - 1
      c.lowHpGateLast = Date.now() - 10 * 60 * 1000
      await goal.decide(gated, c)
      assert.ok(Date.now() - c.lowHpGateSince < 5000, 'stale stamp re-arms')
      assert.equal(goal.MENU.castle.feasible({ time: 'day', castle: 'stone-batch', health: 5, food: 10 }, gated, c), false)
    })
  })
})
