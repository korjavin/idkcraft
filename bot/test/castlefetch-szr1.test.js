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
          if (!s) return // no matching stack: the real withdraw skips it
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
  const realCounts = stockpile.chestCounts
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
    stockpile.withdrawAnyFromChest = realWithdraw
    stockpile.chestCounts = realCounts
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
      // The peek sees oak only: birch is never opened.
      return names[0] === 'oak_planks' ? { got: n, name: names[0] } : { got: 0, name: null }
    }
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const { bot, ctx } = fenceLeg({ items, chest: [{ name: 'oak_planks', count: 24 }] })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.deepEqual(calls, [
      [['birch_fence', 'oak_fence'], 6],
      [['oak_planks'], 12],
    ])
  })

  it('an unreadable chest keeps the legacy full loop (same opens as before)', async () => {
    const calls = []
    stockpile.chestCounts = async () => null // non-ok open: null, not {} (core-2)
    stockpile.withdrawAnyFromChest = async (b, c, names, n) => {
      calls.push([names, n])
      return { got: 0, name: null }
    }
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const { bot, ctx } = fenceLeg({ items, chest: [] })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    assert.deepEqual(calls, [
      [['birch_fence', 'oak_fence'], 6],
      [['birch_planks'], 12],
      [['oak_planks'], 12],
      [['birch_log', 'oak_log'], 3],
    ])
  })

  it('the planks draw completes the pack wood first (exact-wood crafts cannot mix)', async () => {
    const calls = []
    stockpile.withdrawAnyFromChest = async (b, c, names, n) => {
      calls.push([names, n])
      const planksOnly = names.length > 0 && names.every((x) => x.endsWith('_planks'))
      return planksOnly ? { got: n, name: names[0] } : { got: 0, name: null }
    }
    const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_planks', count: 2 }]
    const chest = [{ name: 'birch_planks', count: 24 }, { name: 'oak_planks', count: 24 }]
    const { bot, ctx } = fenceLeg({ items, chest })
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    // Both woods in the chest: the held oak draws first and fills the need.
    assert.deepEqual(calls, [
      [['birch_fence', 'oak_fence'], 6],
      [['oak_planks'], 12],
    ])
  })

  it('mixed-short stacks never sum to funded: one variant draws, logs still run (send-back 1)', async () => {
    // Pack 3 birch + 3 oak, chest 3 + 3, fence left 2, no logs anywhere:
    // summing the mixed dregs zeroes the need and skips the logs list
    // while no variant crafts (needs 4 of one wood). The fix funds the
    // best single variant only, so the need survives and the logs list
    // (table/stick fund) still runs.
    const calls = []
    stockpile.withdrawAnyFromChest = async (b, c, names, n) => {
      calls.push([names, n])
      return { got: 0, name: null }
    }
    const items = [
      { name: 'stone_pickaxe', count: 1 },
      { name: 'birch_planks', count: 3 },
      { name: 'oak_planks', count: 3 },
    ]
    const chest = [{ name: 'birch_planks', count: 3 }, { name: 'oak_planks', count: 3 }]
    const { bot, ctx } = (() => {
      castleMod.menuFact = (b, c) => { c.castleWord = { kind: 'fence', left: 2 }; return 'fence-none' }
      fetch.deps.craftItem = () => 'running'
      fetch.deps.gather = (b, c) => { c.stepStatus = 'running' }
      const set = new Map([[`${SITE.x},${SITE.y},${SITE.z}`, 'chest']])
      const b = makeBot({ items, set, chest, at: pos(SITE.x + 1.5, 64, SITE.z - 0.5) })
      return { bot: b, ctx: { castle: castleState() } }
    })()
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    const plankCalls = calls.filter(([[n]]) => n.endsWith('_planks'))
    assert.equal(plankCalls.length, 1, `one variant draws, never a mix: ${JSON.stringify(calls)}`)
    assert.ok(calls.some(([[n]]) => n.endsWith('_log')), `logs list still runs: ${JSON.stringify(calls)}`)
  })

  it('a fund shortfall after a bank draw keeps done: the next draw heals it (core-3)', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    // Short of planks but structurally fine: 'done' re-picks and the next
    // draw tops up (the door's 4-plank first draw crafts on the second).
    fetch.deps.craftItem = () => ({ done: false, line: "can't make oak_fence: need 4 oak_planks (have 1)" })
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'running' }
    const homeChest = pos(SITE.x + 1.5, 64, SITE.z - 0.5)
    const set = new Map([[`${SITE.x + 1},${SITE.y},${SITE.z - 1}`, 'chest']])
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], set, at: pos(SITE.x + 1.5, 64, SITE.z - 0.5), chest: [{ name: 'oak_planks', count: 200 }] })
    const ctx = { castle: castleState(), home: { site: pos(SITE.x - 40, 64, SITE.z), chest: homeChest } }
    fetch(bot, ctx)
    await settle(); await settle(); await settle()
    fetch(bot, ctx)
    await settle(); await settle()
    fetch(bot, ctx)
    await settle(); await settle()
    assert.equal(ctx.stepStatus, 'done')
  })

  it('a bank draw the pack cannot craft fails into the hold instead of draining the chest (core-3)', async () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    // No table anywhere: the craft fails for a non-fund reason after a
    // full bank draw, so the leg must fail (hold) rather than read 'done'
    // and re-pick into a chest drain.
    fetch.deps.craftItem = () => ({ done: false, line: 'need a crafting table' })
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'running' }
    const homeChest = pos(SITE.x + 1.5, 64, SITE.z - 0.5)
    const set = new Map([[`${SITE.x + 1},${SITE.y},${SITE.z - 1}`, 'chest']])
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], set, at: pos(SITE.x + 1.5, 64, SITE.z - 0.5), chest: [{ name: 'oak_planks', count: 200 }] })
    const ctx = { castle: castleState(), home: { site: pos(SITE.x - 40, 64, SITE.z), chest: homeChest } }
    fetch(bot, ctx) // chest leg: withdraws the planks, latches bankFull
    await settle(); await settle(); await settle()
    fetch(bot, ctx) // craft fails on the table: one fresh-table retry
    await settle(); await settle()
    fetch(bot, ctx) // retry spent: craftOut latches, the bank batch cannot lay
    await settle(); await settle()
    assert.equal(ctx.stepStatus, 'failed:castlefetch-craft-fence')
    assert.ok(ctx.castleFetchDry && ctx.castleFetchDry.has('fence'), 'decor word skips the fence until restock')
  })
})
