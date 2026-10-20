'use strict'

// idkcraft-szr1: the fence leg ignored chest planks (finished + logs only),
// so a chest of banked/owner-dropped planks never refilled a treeless world
// and the leg failed into the 5-min hold every window. Now the wood kinds
// (door/fence/gate) draw chest planks first, logs last.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const stockpile = require('../src/behaviours/stockpile')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function add(items, name, n) {
  const it = items.find((i) => i.name === name)
  if (it) it.count += n
  else items.push({ name, count: n })
}

function count(items, name) {
  return items.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
}

function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), chest = [] } = {}) {
  const calls = { goals: [], withdraw: [], dig: [], opens: [] }
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
  }
  return {
    username: 'IdkBot',
    calls,
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
    openChest: async () => {
      calls.opens.push(1)
      return {
        containerItems: () => chest.map((s) => ({ name: s.name, type: s.name, metadata: null, count: s.count })),
        withdraw: async (type, _meta, n) => {
          calls.withdraw.push([type, n])
          const s = chest.find((c) => c.name === type)
          s.count -= n
          add(items, type, n)
        },
        close() {},
      }
    },
    equip: async () => {},
    dig: async () => {},
    pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

const settle = () => new Promise((r) => setImmediate(r))

describe('castlefetch chest planks fund the fence leg (szr1)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  const realWithdraw = stockpile.withdrawAnyFromChest
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
    stockpile.withdrawAnyFromChest = realWithdraw
  })

  function fenceLeg({ items, chest, pack = [] }) {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = () => 'running' // the craft runs once stock lands
    let gathered = 0
    fetch.deps.gather = (bot, ctx) => { gathered++; ctx.stepStatus = 'running' }
    const set = new Map([[`${SITE.x},${SITE.y},${SITE.z}`, 'chest']])
    const bot = makeBot({ items, set, chest, at: pos(SITE.x + 1.5, 64, SITE.z - 0.5) })
    const ctx = { castle: castleState() }
    return { bot, ctx, gathered: () => gathered }
  }

  it('a chest of planks (no logs anywhere) refills the leg instead of failing to gather', async () => {
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const chest = [{ name: 'oak_planks', count: 24 }]
    const { bot, ctx, gathered } = fenceLeg({ items, chest })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.equal(count(items, 'oak_planks'), 12, 'one log worth of planks per log the kind draws (6 need / yield 2 * 4)')
    assert.equal(chest[0].count, 12)
    assert.equal(gathered(), 0, 'no gather trip: the chest refilled the leg')
  })

  it('planks draw one wood at a time until the need is met (never a mix)', async () => {
    const calls = []
    stockpile.withdrawAnyFromChest = async (b, c, names, n) => {
      calls.push([names, n])
      // Mixed chest, birch short: the birch call draws nothing, the oak
      // call funds the whole need alone.
      return names[0] === 'oak_planks' ? { got: n, name: names[0] } : { got: 0, name: null }
    }
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const { bot, ctx } = fenceLeg({ items, chest: [{ name: 'oak_planks', count: 24 }] })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.deepEqual(calls, [
      [['birch_fence', 'oak_fence'], 6],
      [['birch_planks'], 12],
      [['oak_planks'], 12],
    ])
  })

  it('the planks draw completes the pack wood first (exact-wood crafts cannot mix)', async () => {
    const calls = []
    stockpile.withdrawAnyFromChest = async (b, c, names, n) => {
      calls.push([names, n])
      return { got: 0, name: null }
    }
    const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_planks', count: 2 }]
    const { bot, ctx } = fenceLeg({ items, chest: [] })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.deepEqual(calls[1], [['oak_planks'], 12])
  })
})
