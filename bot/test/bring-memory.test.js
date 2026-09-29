'use strict'

// Bring-me memory verdicts (idkcraft-t9k): a remembered vein commits o.pos
// as a PLAIN {x,y,z}, but real mineflayer blockAt throws on plain objects
// (WorldSync.getBlock calls pos.floored()). The walk phase used to catch
// that as block=null, o.far suppressed the re-find, and the arrived bot
// stalled 10 ticks into 'could not reach' with 0 dug (atl.15 assay20).
// The verdict result now carries a real Vec3, so the walk reads, digs and
// delivers. The mock blockAt below mirrors real semantics: null on
// unmapped cells (unloaded), a throw on mapped cells read via a plain pos.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const resources = require('../src/resources')
const { handleChat, createTicker } = require('../src/index')

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

const BLOCKS = { coal_ore: 11, stone: 1 }
const ITEMS = { coal: 21, stone_pickaxe: 22 }

function mockBot({ items = [], playerPos = null, spots = [], names = {} } = {}) {
  const lines = []
  const tossCalls = []
  const calls = { setGoal: 0, goals: [] }
  const blocksByName = {}
  for (const [name, id] of Object.entries(BLOCKS)) blocksByName[name] = { id }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ITEMS)) itemsByName[name] = { id }
  const bot = {
    lines, tossCalls, calls,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    spawnPoint: pos(0, 64, 0),
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      stop: () => {},
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    lookAt() {},
    equip: async (item) => { bot.held = item && item.name },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      return spots.filter((q) => {
        const n = names[`${q.x},${q.y},${q.z}`]
        const id = n && blocksByName[n] ? blocksByName[n].id : undefined
        return want.has(id)
      })
    },
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null // unloaded, like the real thing
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function (plain o.pos)')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    // Real mineflayer reach: falsy block never digs (assay20 stalled here).
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
      if (bp) delete names[`${bp.x},${bp.y},${bp.z}`]
      if (bot.held && bot.held.endsWith('_pickaxe')) bot._items.push({ name: 'coal', count: 1 })
    },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot, brain) {
  return createTicker({
    bot,
    brain: brain || { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

// Drive the order; teleport along bring walks, hold still for digs/pickup.
async function drive(bot, ctx, maxTicks = 600) {
  for (let i = 0; i < maxTicks && ctx.bring; i++) {
    await bring(bot, ctx, null, {})
    const o = ctx.bring
    if (!o) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('bring:') && o.pos) {
      bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z)
      bot._moving = false
    } else if (gk.startsWith('bring-pickup')) {
      bot._moving = false
    } else if (gk.startsWith('bring-return:')) {
      bot._moving = false
      const pp = bot.players.P.entity.position
      bot.entity.position = pos(pp.x, pp.y, pp.z)
    }
  }
}

describe('bring-me memory verdict (idkcraft-t9k)', () => {
  it('remembered vein past 48 with a buried rival: walks, digs, delivers', async () => {
    // Buried decoy inside 48 (unmapped neighbours read null = not air),
    // exposed remembered vein at 60 (air above each cell).
    const names = {
      '20,40,0': 'coal_ore', '21,40,0': 'coal_ore',
      '60,64,0': 'coal_ore', '61,64,0': 'coal_ore', '62,64,0': 'coal_ore',
      '60,65,0': 'air', '61,65,0': 'air', '62,65,0': 'air',
    }
    const spots = [
      pos(20, 40, 0), pos(21, 40, 0),
      pos(60, 64, 0), pos(61, 64, 0), pos(62, 64, 0),
    ]
    const bot = mockBot({
      spots, names,
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(2, 64, 0),
    })
    const ticker = tickerFor(bot)
    // Seeded finds memory: the vein as the scout noted it (plain cells).
    resources.noteSpots(bot._tickerCtx, [
      { x: 60, y: 64, z: 0, name: 'coal_ore', exposed: true },
      { x: 61, y: 64, z: 0, name: 'coal_ore', exposed: true },
      { x: 62, y: 64, z: 0, name: 'coal_ore', exposed: true },
    ], Date.now())
    handleChat(bot, ticker, 'P', 'bring me coal_ore 3')
    // The depth-24 decoy is a gated shaft (chv), not a feasible rival, so
    // the memory commit carries no (exposed) suffix — feasible-rival
    // suffixes stay pinned in bring-source.test.js.
    assert.ok(
      bot.lines.some((l) => /^going for 3 coal_ore, \d+ blocks away$/.test(l)),
      `memory verdict line: ${bot.lines}`,
    )
    await drive(bot, bot._tickerCtx)
    assert.equal(bot._tickerCtx.bring, null)
    assert.equal(bot.digCalls, 3, `digs: ${bot.digCalls}, lines: ${bot.lines}`)
    assert.ok(bot.lines.some((l) => l === 'here are 3 coal'), `lines: ${bot.lines}`)
    assert.deepEqual(bot.tossCalls, [[ITEMS.coal, null, 3]])
    assert.ok(!bot.lines.some((l) => /could not reach/.test(l)), `lines: ${bot.lines}`)
  })
})
