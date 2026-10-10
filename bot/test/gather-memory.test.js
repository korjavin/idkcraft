'use strict'

// Gather from resource memory (idkcraft-t9u): a remembered log commits
// g.pos as a PLAIN {x,y,z}, but real mineflayer blockAt throws on plain
// objects (WorldSync.getBlock calls pos.floored()). The walk used to catch
// that as block=null, g.far suppressed the re-find, and the arrived bot
// stalled 10 ticks per tree into 'failed:unreachable' with 0 dug — the
// same pair bring.js had before the t9k fix. commitTarget now carries a
// real Vec3, so the walk reads, digs and hauls. The mock blockAt below
// mirrors real semantics: null on unmapped cells (unloaded), a throw on
// mapped cells read via a plain pos.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gather = require('../src/behaviours/gather')
const resources = require('../src/resources')
const { NEED_LOGS } = require('../src/goal')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

const LOGREG = { oak_log: 17, oak_leaves: 18, stone: 1 }

function mockBot({ names = {}, items = [] } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks() { return [] }, // sync 48 empty: the grove is memory-only
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null // unloaded, like the real thing
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function (plain g.pos)')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    // Real mineflayer reach: a falsy block never digs.
    canDigBlock(block) {
      if (!block || !block.position) return false
      const e = bot.entity.position
      const dx = block.position.x + 0.5 - e.x
      const dy = block.position.y + 0.5 - (e.y + 1.65)
      const dz = block.position.z + 0.5 - e.z
      return Math.hypot(dx, dy, dz) <= 5.1
    },
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) names[`${bp.x},${bp.y},${bp.z}`] = 'air' // chopped: loaded, stale
      bot._items.push({ name: 'oak_log', count: 1 })
    },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function freshCtx() {
  return { lastGoalKey: '', stepStatus: 'running' }
}

// Drive the step; teleport along gather walks, hold still for digs/pickup.
async function drive(bot, ctx, maxTicks = 800) {
  for (let i = 0; i < maxTicks; i++) {
    gather(bot, ctx, null, {})
    await new Promise((resolve) => setImmediate(resolve)) // flush dig landings
    const g = ctx.gather
    if (!g || g.final) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('gather:') && g.pos) {
      bot.entity.position = pos(g.pos.x + 1, g.pos.y, g.pos.z)
      bot._moving = false
    } else if (gk.startsWith('gather-pickup')) {
      bot._moving = false
    }
  }
}

describe('gather from memory (idkcraft-t9u)', () => {
  it('remembered grove past 48 in loaded chunks: walks, chops, hauls to done', async () => {
    // NEED_LOGS oaks at x=60..: trunk bases are the memory cells, upper
    // logs + a leaf each so the tree guard reads them as trees.
    const names = {}
    const cells = []
    for (let i = 0; i < NEED_LOGS; i++) {
      const x = 60 + 2 * i
      names[`${x},64,0`] = 'oak_log'
      names[`${x},65,0`] = 'oak_log'
      names[`${x},66,0`] = 'oak_log'
      names[`${x + 1},66,0`] = 'oak_leaves'
      cells.push({ x, y: 64, z: 0, name: 'oak_log' })
    }
    const bot = mockBot({ names })
    const ctx = freshCtx()
    // Seeded finds memory: the grove as the scout noted it (plain cells).
    resources.noteSpots(ctx, cells, Date.now())
    await drive(bot, ctx)
    assert.ok(
      bot.lines.some((l) => /^going for oak_log, \d+ blocks away$/.test(l)),
      `memory verdict line: ${bot.lines}`,
    )
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.digCalls, NEED_LOGS, `digs: ${bot.digCalls}, lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === `got ${NEED_LOGS} logs`), `lines: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => /cannot reach|no trees/.test(l)), `lines: ${bot.lines}`)
  })
})

describe('gather memory gate (idkcraft-atl.24)', () => {
  it('a remembered log under the surface floor is skipped for a surface one', () => {
    const bot = mockBot({ names: {} }) // nothing loaded
    const ctx = { ...freshCtx(), home: { site: { x: 0, y: 65, z: 0 } } }
    resources.noteSpots(ctx, [{ x: 10, y: 30, z: 0, name: 'oak_log' }, { x: 50, y: 64, z: 0, name: 'oak_log' }], Date.now())
    gather(bot, ctx, null, {})
    assert.match(ctx.lastGoalKey, /^gather:50,64,0$/)
  })
})
