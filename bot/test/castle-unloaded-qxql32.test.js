'use strict'
// idkcraft-qxql.32 (cache cause is a hypothesis): prod V2b struck no-ref on a ring over grass at a
// chunk edge — the v2 bridge cache read the ground column as null
// (unloaded). An unknown neighbour now asks the body to load it and strikes
// 'unloaded', never 'no-ref'; once the column loads the cell lays.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const EMPTY = new Set(['air', 'torch', 'wall_torch'])
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('castle no-ref vs an unloaded neighbour (qxql.32)', () => {
  it('logs unloaded, asks prefetch, strikes unloaded (not no-ref); lays once loaded', async () => {
    const cells = new Map()
    const k = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    let loaded = false
    const blockAt = (p) => {
      const y = Math.floor(p.y)
      if (!loaded && y === SITE.y - 1) return null // the ground column is not in the cache
      const name = cells.get(k(p)) || (y <= SITE.y - 1 ? 'dirt' : 'air')
      return { name, boundingBox: EMPTY.has(name) ? 'empty' : 'block', position: { x: Math.floor(p.x), y, z: Math.floor(p.z) } }
    }
    const prefetched = []
    const places = []
    const bot = {
      chats: [], players: {}, held: null,
      entity: { position: { x: SITE.x - 3, y: 64, z: SITE.z - 3 } },
      world: { getBlock: () => null },
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 }, { name: 'oak_door', count: 1 }, { name: 'torch', count: 8 }] },
      blockAt,
      prefetch: async (coords) => { prefetched.push(...coords) },
      pathfinder: {
        movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
        isMoving: () => false,
        setGoal: (g) => {
          if (g && g.pos) bot.entity.position = { x: g.pos.x + 0.5, y: g.pos.y + 2, z: g.pos.z + 0.5 }
          else if (g && typeof g.x === 'number') bot.entity.position = { x: g.x + 2.5, y: g.y, z: g.z + 0.5 }
        },
      },
      equip: async (item) => { bot.held = item.name },
      dig: async (b) => { cells.set(k(b.position), 'air') },
      placeBlock: async (ref, face) => {
        const p = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        places.push(p); cells.set(k(p), bot.held)
      },
      chat: (m) => bot.chats.push(String(m)),
    }
    const ctx = { castle: { site: SITE, rot: 0 } }
    const logs = []
    const log = console.log
    console.log = (m) => { logs.push(String(m)) }
    try { for (let i = 0; i < 30; i++) { castle(bot, ctx); await settle() } } finally { console.log = log }
    assert.ok(logs.some((l) => /^castle no-ref cell=.* unknown=\d\/6 cols=/.test(l)), logs.filter((l) => /castle/.test(l)).slice(0, 5).join('\n'))
    assert.ok(prefetched.length > 0, 'the body is asked to load the column')
    const blocked = Object.values(ctx.castle.blocked || {})
    assert.ok(!blocked.some((e) => e.why === 'no-ref'), JSON.stringify(blocked))
    assert.ok(blocked.some((e) => e.why === 'unloaded'), JSON.stringify(blocked))
    loaded = true
    for (const e of Object.values(ctx.castle.blocked)) e.until = 0
    const before = places.length
    for (let i = 0; i < 30; i++) { castle(bot, ctx); await settle() }
    assert.ok(places.length > before, 'once loaded the ring lays')
  })
})

describe('a retired unloaded cell re-enters via castlerecovery (qxql.32)', () => {
  const rec = require('../src/behaviours/castlerecovery')
  const run = (loaded) => {
    const env = process.env.BOT_BODY
    process.env.BOT_BODY = 'baritone'
    try {
      const c = { idx: 7, x: 1, y: 64, z: 1, kind: 'stone' }
      const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'build', blocked: { k7: { retired: true, until: 0, why: 'unloaded' } } }
      const bot = { entity: { position: { x: 2, y: 64, z: 2 } }, blockAt: () => (loaded ? { name: 'air' } : null) }
      const ctx = { brain: { plan: () => null } }
      const hooks = { bkey: (_s, i) => `k${i}`, done: () => false, findItem: () => ({ name: 'cobblestone' }) }
      return rec.eligible(bot, ctx, st, [c], Date.now(), hooks)
    } finally { if (env === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = env }
  }
  it('still unloaded: not eligible (no planner call on a cache gap)', () => assert.equal(run(false), null))
  it('column loaded later: eligible for the safe-primitive planner', () => assert.equal(run(true).idx, 7))
})

describe('prep stays open on an unloaded column; the column is fetched, rate-limited (qxql.32)', () => {
  it('prefetches once per window, then leaves prep once the column loads', async () => {
    let loaded = false
    const fetches = []
    const bot = {
      chats: [], players: {}, held: null,
      entity: { position: { x: SITE.x + 2, y: 64, z: SITE.z + 2 } },
      world: { getBlock: () => null },
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 }] },
      blockAt: (p) => {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
        if (!loaded && x >= SITE.x + 8) return null // one far column strip unloaded
        const name = y <= SITE.y - 1 ? 'dirt' : 'air'
        return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x, y, z } }
      },
      prefetch: async (c) => { fetches.push(c.length) },
      pathfinder: { movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, isMoving: () => false, setGoal: () => {} },
      equip: async () => {}, dig: async () => {}, placeBlock: async () => {}, chat: (m) => bot.chats.push(String(m)),
    }
    const ctx = { castle: { site: SITE, rot: 0, phase: 'prep' } }
    const log = console.log
    console.log = () => {}
    try { for (let i = 0; i < 20; i++) { castle(bot, ctx); await settle() } } finally { console.log = log }
    assert.equal(ctx.castle.phase, 'prep', 'an unknown column keeps prep open')
    assert.equal(fetches.length, 1, `rate-limited: ${fetches.length} fetches in 20 ticks`)
    loaded = true
    console.log = () => {}
    try { for (let i = 0; i < 5; i++) { castle(bot, ctx); await settle() } } finally { console.log = log }
    assert.notEqual(ctx.castle.phase, 'prep', 'loaded: prep ends, recovery can run')
  })
})
