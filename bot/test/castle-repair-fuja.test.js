'use strict'

// idkcraft-fuja: creeper-damaged walls were never repaired once the repair
// cells retired — retired-but-open plan cells never reach pick/peek, so the
// word read done in silence. Now: reported like holes (status + one chat),
// transient ones reopen on a tidy return, the 'castle repair' command
// reopens all of them.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
function completeSet() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, { pane: 'glass_pane', fence: 'oak_fence', gate: 'oak_fence_gate' }[c.kind] || 'air')
  }
  return set
}
// creeper damage: four wall stones knocked out
function damaged() {
  const set = completeSet()
  const cells = blueprint.absPlan(SITE, 0, V).cells.filter((c) => c.kind === 'stone' && c.y === SITE.y + 1).slice(0, 4)
  for (const c of cells) set.set(`${c.x},${c.y},${c.z}`, 'air')
  return { set, cells }
}
function worldBot(set, items = []) {
  return {
    chats: [],
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null },
    setControlState() {}, clearControlStates() {},
    chat(m) { this.chats.push(String(m)) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = set.has(k) ? set.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const retired = (cells, why) => Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 8, until: 0, why, retired: true }]))
const state = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })

describe('fuja retired damage', () => {
  it('reports retired-open damage on the status + one chat, silent on repeat', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now, blocked: retired(cells, 'no-ref') }) }
    castle.menuFact(bot, ctx, now)
    assert.match(ctx.castle.status, /holes: .*stone: no-ref, retired/, 'status names the damage')
    assert.equal(bot.chats.length, 1, 'one honest chat line')
    assert.match(bot.chats[0], /^castle: 4 holes: .*no retries left$/, 'chat names the holes')
    const n = bot.chats.length
    castle.menuFact(bot, ctx, now + 1000)
    assert.equal(bot.chats.length, n, 'no repeat chat')
  })
  it('a tidy return reopens transient cells into the repair word', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now - 7200000, blocked: retired(cells, 'no-ref') }) }
    const w = castle.menuFact(bot, ctx, now)
    assert.equal(w, 'stone-batch', 'repair word back')
    assert.equal(Object.keys(ctx.castle.blocked).length, 0, 'entries cleared')
    assert.deepEqual(ctx.castleWord, { kind: 'stone', left: 4, repair: true }, 'repair latched')
  })
  it('permanent-whys stay retired but keep reporting', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now - 7200000, blocked: retired(cells, 'kept-chest') }) }
    castle.menuFact(bot, ctx, now)
    assert.equal(Object.keys(ctx.castle.blocked).length, 4, 'still retired')
    assert.match(ctx.castle.status, /kept-chest, retired/, 'still reported')
  })
  it("'castle repair' reopens every retired cell and resumes", () => {
    const { set, cells } = damaged()
    const bot = worldBot(set)
    bot.username = 'IdkBot'
    bot.registry = { itemsByName: {} }
    bot.time = { timeOfDay: 6000, day: 1 }
    bot.spawnPoint = { x: 0, y: 64, z: 0 }
    bot.on = () => {}
    bot.once = () => {}
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.castle = state({ blocked: { ...retired(cells.slice(0, 2), 'no-ref'), ...retired(cells.slice(2), 'kept-chest') } })
    handleChat(bot, ticker, 'Steve', 'castle repair')
    const line = bot.chats.pop()
    assert.match(line, /^castle: 4 cells missing .*; repairing/, 'reports and resumes')
    assert.equal(Object.keys(ctx.castle.blocked).length, 0, 'all reopened by the explicit order')
  })
  it('control: unretired damage still words the repair directly', () => {
    const { set } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now }) }
    assert.equal(castle.menuFact(bot, ctx, now), 'stone-batch')
  })
})
