'use strict'

// Bounded retirement: a castle whose missing cells were all retired read
// done/clear with progress < total and no demand (prod 2026-11-16 bot3
// 11401/11493 flat). Past the bound the menu re-queues them and the word
// names their material again, so castlefetch has demand.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
function world() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) set.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) set.set(`${c.x},${c.y},${c.z}`, { pane: 'glass_pane', fence: 'oak_fence', gate: 'oak_fence_gate' }[c.kind] || 'air')
  const cells = blueprint.absPlan(SITE, 0, V).cells.filter((c) => c.kind === 'stone' && c.y === SITE.y + 1).slice(0, 3)
  for (const c of cells) set.set(`${c.x},${c.y},${c.z}`, 'air')
  const bot = {
    chats: [], entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => [] }, players: {}, pathfinder: { goal: null },
    setControlState() {}, clearControlStates() {}, chat(m) { this.chats.push(String(m)) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = `${x},${y},${z}`
      const name = set.has(k) ? set.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
  return { bot, cells }
}

describe('castle bounded retirement', () => {
  it('re-queues retired missing cells after the bound so the word owes their material', () => {
    const { bot, cells } = world()
    const now = Date.now()
    const blocked = Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 8, until: 0, why: 'unreachable', retired: true, retiredAt: now }]))
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', visitedAt: now, blocked } }
    const orig = console.log
    console.log = () => {}
    try {
      assert.notEqual(castle.menuFact(bot, ctx, now), 'stone-none', 'inside the bound the holes stay retired')
      assert.ok(ctx.castle.progress.done < ctx.castle.progress.total)
      const later = now + 11 * 60 * 1000
      ctx.castle.visitedAt = later
      assert.equal(castle.menuFact(bot, ctx, later), 'stone-none', 'past the bound the word owes stone')
      assert.ok(cells.every((c) => !ctx.castle.blocked[`2:${c.idx}`].retired))
    } finally { console.log = orig }
  })
  it('a legacy entry with no stamp starts its bound now, permanent whys wait longer', () => {
    const { bot, cells } = world()
    const now = Date.now()
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, blocked: { [`2:${cells[0].idx}`]: { tries: 3, why: 'protected', retired: true } } }
    const ctx = {}
    assert.equal(castle.requeueRetired(bot, ctx, st, now), 0)
    assert.equal(st.blocked[`2:${cells[0].idx}`].retiredAt, now)
    assert.equal(castle.requeueRetired(bot, ctx, st, now + 20 * 60 * 1000), 0, 'protected: 10 min is not enough')
    assert.equal(castle.requeueRetired(bot, ctx, st, now + 61 * 60 * 1000), 1)
  })
  it('skipped upkeep entries (litter/fill) stay skipped past the bound; only castle repair reopens them', () => {
    const { bot } = world()
    const now = Date.now()
    const key = `2:${castle.LITTER_BAND_BASE + 5}`
    const fkey = `2:${castle.FILL_BASE + 7}`
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: { [key]: { tries: 3, why: 'unreachable', retired: true, retiredAt: now }, [fkey]: { tries: 3, why: 'unreachable', retired: true, retiredAt: now } } }
    const ctx = {}
    assert.equal(castle.requeueRetired(bot, ctx, st, now + 11 * 60 * 1000), 0)
    assert.equal(castle.requeueRetired(bot, ctx, st, now + 24 * 60 * 60 * 1000), 0)
    assert.equal(st.blocked[key].retired, true)
    const orig0 = console.log
    console.log = () => {}
    try { assert.equal(castle.reopenRepairs(bot, ctx, st, true), 0, 'the hourly tidy return keeps them skipped') } finally { console.log = orig0 }
    assert.equal(st.blocked[key].retired, true)
    const orig = console.log
    console.log = () => {}
    try {
      const u = castle.upkeepStats(bot, {}, st, now)
      assert.deepEqual(Object.keys(u), ['clutter', 'workable', 'retired', 'backoff'])
      assert.ok(u.workable <= u.clutter)
      assert.equal(castle.reopenRepairs(bot, ctx, st, false), 2, 'castle repair reopens them')
      assert.equal(st.blocked[key], undefined)
    } finally { console.log = orig }
  })
})
