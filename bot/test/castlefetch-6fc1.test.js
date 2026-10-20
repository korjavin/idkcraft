'use strict'

// idkcraft-6fc1: the v2 chest walk verdicts noPath across water the v1
// pathfinder swims, and the fence leg used to burn its whole walk patience
// and fall through to gather/no-trees with the chest full of planks. Now
// the leg retries the walk from the live feet, then detours past staging
// cells, before the stalled abandon owns the give-up — v1 untouched.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }
const CHEST = { x: SITE.x, y: SITE.y, z: SITE.z }
const FAR = { x: SITE.x - 20, y: 64, z: SITE.z - 20 }

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

function makeBot({ items = [], chest = [] } = {}) {
  const calls = { goals: [], keys: [], withdraw: [], opens: [] }
  const bot = {
    username: 'IdkBot',
    calls,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(FAR.x, FAR.y, FAR.z), onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { chest: { id: 54 } },
      itemsByName: { oak_fence: {}, birch_fence: {}, oak_planks: {}, birch_planks: {}, oak_log: {}, birch_log: {}, stick: {}, crafting_table: {} },
    },
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = k === `${CHEST.x},${CHEST.y},${CHEST.z}` ? 'chest' : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [pos(CHEST.x, CHEST.y, CHEST.z)],
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
    pathfinder: {
      isMoving: () => false,
      goal: null,
      setGoal(g) {
        calls.goals.push(`${g && g.constructor ? g.constructor.name : '?'}@${g && g.x},${g && g.y},${g && g.z}`)
        bot.pathfinder.goal = g
      },
      stop() {},
    },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

const settle = () => new Promise((r) => setImmediate(r))

describe('castlefetch v2 chest-walk noPath retries (6fc1)', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  const wasBody = process.env.BOT_BODY
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
    if (wasBody === undefined) delete process.env.BOT_BODY
    else process.env.BOT_BODY = wasBody
  })

  function fenceLeg({ craft = () => 'running' } = {}) {
    process.env.BOT_BODY = 'baritone'
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = craft
    let gathered = 0
    fetch.deps.gather = (bot, ctx) => { gathered++; ctx.stepStatus = 'running' }
    const items = [{ name: 'stone_pickaxe', count: 1 }]
    const chest = [{ name: 'oak_planks', count: 24 }]
    const bot = makeBot({ items, chest })
    const ctx = { castle: castleState() }
    const seenKeys = []
    const keys = () => [...seenKeys]
    const tick = () => {
      fetch(bot, ctx)
      if (ctx.lastGoalKey !== seenKeys[seenKeys.length - 1]) seenKeys.push(ctx.lastGoalKey)
    }
    const verdict = (s) => { ctx.lastPathStatus = s }
    const move = (x, y, z) => { bot.entity.position.x = x; bot.entity.position.y = y; bot.entity.position.z = z }
    return { bot, ctx, items, chest, tick, verdict, move, keys, gathered: () => gathered }
  }

  it('a noPath chest walk re-issues, detours, and relays the planks with no gather', async () => {
    const t = fenceLeg()
    t.tick() // base walk issued
    assert.ok((t.keys().join(' ').match(/castlefetch-chest:/g) || []).length >= 1, `base walk issued: ${t.keys()}`)
    t.verdict('noPath') // the bridge verdicts the water crossing
    t.tick() // retry 1: re-issue from the live feet
    assert.ok(t.keys().some((k) => /#r1$/.test(k)), `retry re-issues the walk: ${t.keys()}`)
    t.verdict('noPath')
    t.tick() // retry 2: staging detour
    const via = t.keys().find((k) => /#via2$/.test(k))
    assert.ok(via, `retry detours past staging: ${t.keys()}`)
    // Walk the staging: the issued goal targets the floored cell.
    const g = t.bot.calls.goals[t.bot.calls.goals.length - 1]
    const m = /@(-?\d+),(-?\d+),(-?\d+)$/.exec(g)
    assert.ok(m, `staging goal has coords: ${g}`)
    t.move(Number(m[1]) + 0.5, Number(m[2]), Number(m[3]) + 0.5)
    t.tick() // arrival drops back to the chest approach
    assert.equal(t.bot.calls.goals.length >= 3, true)
    // Into chest reach: the draw relays the planks.
    t.move(CHEST.x + 0.5, CHEST.y, CHEST.z + 0.5)
    t.tick()
    await settle(); await settle(); await settle(); await settle()
    assert.equal(count(t.items, 'oak_planks'), 12, 'one log worth of planks per log the kind draws')
    assert.equal(t.chest[0].count, 12)
    assert.equal(t.gathered(), 0, 'no gather trip: the retried walk relayed the chest')
  })

  it('a stale or foreign noPath never spends the retry budget', () => {
    const t = fenceLeg()
    t.verdict('noPath') // stale: no walk of ours is out
    t.tick()
    t.tick()
    assert.ok(!t.keys().some((k) => /#r\d|#via\d/.test(k || '')), `no retry without our walk: ${t.keys()}`)
  })

  it('v1 never re-issues or detours on noPath (behaviour unchanged)', () => {
    process.env.BOT_BODY = 'mineflayer'
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'fence', left: 6 }; return 'fence-none' }
    fetch.deps.craftItem = () => 'running'
    fetch.deps.gather = (bot, ctx) => { ctx.stepStatus = 'running' }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], chest: [{ name: 'oak_planks', count: 24 }] })
    const ctx = { castle: castleState() }
    const keys = []
    for (let i = 0; i < 4; i++) {
      fetch(bot, ctx)
      if (ctx.lastGoalKey !== keys[keys.length - 1]) keys.push(ctx.lastGoalKey)
      ctx.lastPathStatus = 'noPath' // v1 executor verdicts too: still no retry
    }
    assert.ok(keys.length >= 1, 'the base walk issues')
    assert.ok(!keys.some((k) => /#r\d|#via\d/.test(k || '')), `v1 keeps the single walk: ${keys}`)
  })

  it('a permanently ponded chest exhausts the budget and falls through to gather', () => {
    // The craft cannot fund the fence either, so the leg reaches the wood
    // branch: bounded retries first, then the old gather fallthrough.
    const t = fenceLeg({ craft: () => ({ done: false, line: "can't craft fence: no planks or logs" }) })
    for (let i = 0; i < 60 && t.gathered() === 0; i++) {
      t.tick()
      t.verdict('noPath') // every walk — base, re-issue, both detours — verdicts noPath
    }
    const keys = t.keys().join(' ')
    assert.ok(keys.includes('#r1'), `re-issue spent: ${keys}`)
    assert.ok(keys.includes('#via2'), `first detour spent: ${keys}`)
    assert.ok(keys.includes('#via3'), `second detour spent: ${keys}`)
    assert.ok(!keys.includes('#via4') && !keys.includes('#r4'), `budget bounded at ${fetch.CHEST_RETRIES}: ${keys}`)
    assert.equal(t.gathered(), 1, 'budget spent: the old gather fallthrough owns the give-up')
  })

  it('chestVia stands past mid-leg, alternating sides', () => {
    const bp = { x: 0, y: 64, z: 0 }
    const at = { x: 0, y: 64, z: 20 }
    const v2 = fetch.chestVia(bp, at, 2)
    const v3 = fetch.chestVia(bp, at, 3)
    assert.equal(v2.z, 10)
    assert.equal(v3.z, 10)
    assert.ok(Math.abs(v2.x) === 6 && Math.abs(v3.x) === 9, `widening offsets: ${v2.x},${v3.x}`)
    assert.ok(v2.x * v3.x < 0, 'alternating sides')
    assert.equal(fetch.chestVia(null, at, 2), null)
    assert.equal(fetch.chestVia(bp, bp, 2), null, 'degenerate leg: direct re-issue, never a waypoint')
    assert.equal(fetch.CHEST_RETRIES, 3)
  })
})
