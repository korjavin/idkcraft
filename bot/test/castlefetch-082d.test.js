'use strict'

// idkcraft-082d: the dead planks leg stays dead-fixed, and every open leg
// gets its over line (S2/S3 completeness for chest-served legs).

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

// Fake contract: mineflayer 4.39 bot.blockAt(Vec3) (lib/plugins/blocks.js:612,
// set in the plugin install at :605-613) returns a prismarine Block (or null
// for an unloaded chunk); bot.findBlocks(options) (:156) scans loaded chunks;
// bot.openChest (lib/plugins/chest.js:31, openContainer) opens a chest block;
// bot.inventory.items() and bot.pathfinder (setGoal/isMoving/stop, the
// mineflayer-pathfinder plugin surface) report carried items and movement.
// Fields read on this path: `name`/`position`/`boundingBox` ('block'/'empty').
// Internal seam (not mineflayer): fetch.deps (castlefetch.js:160 craftItem /
// gather / driveFurnace stubs) and castleMod.menuFact (castle.js:1240,
// exported :2602) stubbed per test to pin the castle word.
function makeBot({ items = [] } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(SITE.x - 4, 64, SITE.z - 4), onGround: true },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { chest: { id: 54 } },
      itemsByName: { oak_planks: {}, birch_planks: {}, oak_log: {}, birch_log: {}, stick: {}, crafting_table: {}, cobblestone: {}, stone: {} },
    },
    blockAt: (p) => ({ name: 'air', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'empty' }),
    findBlocks: () => [],
    openChest: async () => { throw new Error('no chest') },
    equip: async () => {},
    dig: async () => {},
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

describe('idkcraft-082d dead planks leg', () => {
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  const realFact = castleMod.menuFact
  afterEach(() => {
    fetch.deps.craftItem = realCraft
    fetch.deps.gather = realGather
    castleMod.menuFact = realFact
  })

  it('woodless planks with no chests chops, and no-trees parks the kind — never craft-planks', () => {
    castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind: 'planks', left: 20 }; return 'planks-none' }
    fetch.deps.craftItem = () => ({ done: false, line: 'need 1 log' })
    let gathered = 0
    fetch.deps.gather = (b, c) => { gathered++; c.stepStatus = 'failed:no-trees' }
    const bot = makeBot({ items: [] })
    const ctx = { castle: castleState() }
    fetch(bot, ctx)
    assert.equal(ctx.stepStatus, null, 'no trees near: the acquire expedition runs before the leg fails')
    fetch(bot, ctx) // expedition tried (no mine on the fake)
    assert.equal(gathered, 1, 'the woodless leg opens the wood route instead of failing')
    assert.equal(ctx.stepStatus, 'failed:no-trees', 'the gather failure propagates (the prod "fetch held (failed:no-trees)" shape)')
    assert.equal(ctx.castleFetchFailKind, 'planks', 'the kind hold parks planks, not the whole step')
    assert.ok(ctx.castleFetchFailSite && ctx.castleFetchFailSite.kind === 'planks', 'the chop site parks with it')
    assert.equal(ctx.castleFetch, null, 'the leg ends instead of restarting in place')
  })
})

describe('woodless castle: expedition before the owner ask (prod 2026-11-16 bot3)', () => {
  const realFact = castleMod.menuFact
  const realCraft = fetch.deps.craftItem
  const realGather = fetch.deps.gather
  afterEach(() => { castleMod.menuFact = realFact; fetch.deps.craftItem = realCraft; fetch.deps.gather = realGather })

  for (const kind of ['planks', 'fence', 'door']) {
    it(`${kind}: no trees near starts the acquire expedition, no drop-logs ask`, async () => {
      castleMod.menuFact = (bot, ctx) => { ctx.castleWord = { kind, left: 20 }; return `${kind}-none` }
      fetch.deps.craftItem = () => ({ done: false, line: "can't make spruce_planks: need 1 spruce_log (have 0)" })
      fetch.deps.gather = (b, c) => { c.stepStatus = 'failed:no-trees' }
      const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
      bot.mine = () => Promise.reject(new Error('no blocks')) // nothing in the mine radius
      const ctx = { castle: castleState() }
      const lines = []
      const orig = console.log
      console.log = (m) => { lines.push(String(m)) }
      try {
        for (let i = 0; i < 6; i++) { fetch(bot, ctx); await new Promise((r) => setImmediate(r)) }
      } finally { console.log = orig }
      assert.ok(lines.some((l) => /no reachable source, expedition/.test(l)), lines.join('\n'))
      assert.ok(!lines.some((l) => /drop logs/.test(l)), 'never the owner ask while the expedition runs')
      assert.ok(!lines.some((l) => /need 1 spruce_log/.test(l)), 'the craft line names any log, not one variant')
      assert.equal(ctx.stepStatus == null, true, 'the leg stays open on the expedition')
    })
  }
})

describe('idkcraft-082d leg-over completeness', () => {
  const realFact = castleMod.menuFact
  afterEach(() => { castleMod.menuFact = realFact })

  it('a chest-served leg that never dug or walked still logs its over line', () => {
    castleMod.menuFact = () => null // the word moved on: the open leg ends done
    const bot = makeBot({ items: [] })
    const ctx = { castle: castleState(), castleFetch: { kind: 'stone', blocks0: 0, haul: 34, t0: Date.now() } }
    const lines = []
    const orig = console.log
    console.log = (m) => { lines.push(String(m)) }
    try { fetch(bot, ctx) } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done')
    const line = lines.find((m) => m.includes('leg over'))
    assert.ok(line, `lines: ${JSON.stringify(lines)}`)
    assert.match(line, /leg over \(done\) ticks dig=0 walk=0 other=0 starts=0 dug=0 blocks=\+0 target=34/)
  })
})
