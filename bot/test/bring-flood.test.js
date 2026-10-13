'use strict'

// idkcraft-jlda.12: the MINE-10 vein pocket floods as the bot digs it — the
// last vein ore sits next to a water column, and digging it pours water
// onto the stance. A floating head can neither swim out (Paper 26.1.2
// rejects the wall-rise) nor descend (the swim prune), so the next walk
// stalls and the order fails 7/10. The dig phase skips a water-adjacent
// target whose water sits at or above the feet instead of digging it.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { buriedCand } = require('../src/behaviours/bring')
const { findNearest } = require('../src/behaviours/scout')
const { handleChat, createTicker } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset(ox, oy, oz) { return pos(x + ox, y + oy, z + oz) },
  }
}

const BLOCKS = { iron_ore: 31, dirt: 1 }
const ITEMS = { raw_iron: 41, stone_pickaxe: 22 }

function floodBot(cells, feet) {
  const lines = []
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: feet, onGround: true },
    registry: {
      blocksByName: { iron_ore: { id: BLOCKS.iron_ore }, dirt: { id: BLOCKS.dirt } },
      itemsByName: { raw_iron: { id: ITEMS.raw_iron }, stone_pickaxe: { id: ITEMS.stone_pickaxe } },
    },
    players: { P: { username: 'P', entity: { position: pos(30, 64, 0) } } },
    _items: [{ name: 'stone_pickaxe', count: 1 }],
    _moving: false,
    held: null,
    digCalls: 0,
    tossCalls: [],
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
      stop() {},
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    inventory: { items: () => bot._items },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const out = []
      for (const [k, n] of Object.entries(cells)) {
        const id = BLOCKS[n]
        if (id !== undefined && want.has(id)) {
          const [x, y, z] = k.split(',').map(Number)
          out.push(pos(x, y, z))
        }
      }
      return out
    },
    blockAt(p) {
      const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    canDigBlock: () => true,
    equip: async (item) => { bot.held = item && item.name },
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) delete cells[`${bp.x},${bp.y},${bp.z}`]
      if (bot.held && bot.held.endsWith('_pickaxe')) bot._items.push({ name: 'raw_iron', count: 1 })
    },
    toss: async (id, meta, n) => { bot.tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function capture() {
  const logged = []
  const origLog = console.log
  console.log = (m) => { logged.push(String(m)) }
  return { logged, release() { console.log = origLog } }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function flushDig(bot) {
  for (let i = 0; i < 10 && bot.digCalls === 0; i++) await flush()
}

describe('jlda.12 flood-risk dig skip (unit)', () => {
  it('skips a water-adjacent ore at stance level instead of digging it', async () => {
    const cells = { '2,64,0': 'iron_ore', '1,64,0': 'water' }
    const bot = floodBot(cells, pos(3.5, 64, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(2, 64, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
      await flushDig(bot)
    } finally {
      cap.release()
    }
    assert.equal(bot.digCalls, 0, 'the flooding dig never starts')
    assert.equal(ctx.bring.phase, 'find', 'search again after the skip')
    assert.equal(ctx.bring.pos, null, 'target cleared')
    assert.ok(ctx.bring.skip && ctx.bring.skip.has('2,64,0'), 'ore skipped')
    assert.equal(ctx.bring.sawSubmerged, true, 'honest refusal when all is skipped')
    assert.ok('2,64,0' in cells, 'ore left standing')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig iron_ore at 2 64 0 (flood-risk)'), cap.logged.join('\n'))
  })

  it('digs a water-adjacent ore below the stance (water stays down)', async () => {
    const cells = { '2,63,0': 'iron_ore', '1,63,0': 'water' }
    const bot = floodBot(cells, pos(3.5, 64, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(2, 63, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    await bring(bot, ctx, null, {})
    await flushDig(bot)
    assert.equal(bot.digCalls, 1, 'below-stance water is no flood risk')
    assert.ok(!('2,63,0' in cells), 'ore dug')
  })

  it('digs a dry ore (no behaviour change)', async () => {
    const cells = { '2,64,0': 'iron_ore' }
    const bot = floodBot(cells, pos(3.5, 64, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(2, 64, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    await bring(bot, ctx, null, {})
    await flushDig(bot)
    assert.equal(bot.digCalls, 1, 'dry digs are untouched')
  })

  it('digs when water sits only below the target (cannot flow up)', async () => {
    const cells = { '2,64,0': 'iron_ore', '2,63,0': 'water' }
    const bot = floodBot(cells, pos(3.5, 64, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(2, 64, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    await bring(bot, ctx, null, {})
    await flushDig(bot)
    assert.equal(bot.digCalls, 1, 'below-face water never enters the dug cell')
  })

  it('skips an atl.20 drop into a water-sided hole (the hole becomes the stance)', async () => {
    const cells = {
      '0,62,0': 'iron_ore', '0,61,0': 'dirt', '1,62,0': 'water',
      '1,63,0': 'dirt', '-1,63,0': 'dirt', '0,63,1': 'dirt',
    }
    const bot = floodBot(cells, pos(0.5, 63, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
      await flushDig(bot)
    } finally {
      cap.release()
    }
    assert.equal(bot.digCalls, 0, 'no drop into a flooding hole')
    assert.equal(ctx.bring.phase, 'find', 'search again after the skip')
    assert.ok(ctx.bring.skip && ctx.bring.skip.has('0,62,0'), 'ore skipped')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig iron_ore at 0 62 0 (flood-risk)'), cap.logged.join('\n'))
  })

  it('still digs an atl.20 drop into a dry hole (exemption intact)', async () => {
    const cells = {
      '0,62,0': 'iron_ore', '0,61,0': 'dirt',
      '1,63,0': 'dirt', '-1,63,0': 'dirt', '0,63,1': 'dirt',
    }
    const bot = floodBot(cells, pos(0.5, 63, 0.5))
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, want: 1 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
      await flushDig(bot)
    } finally {
      cap.release()
    }
    assert.equal(bot.digCalls, 1, 'dry atl.20 holes still dig')
    assert.ok(cap.logged.some((l) => l === 'below-feet iron_ore at 0 62 0 onto solid — digging (atl.20)'), cap.logged.join('\n'))
  })

  it('buriedCand reads a same-level ore dry despite column water (no shaft to flood)', () => {
    const cells = { '0,63,0': 'iron_ore', '0,66,0': 'water' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const c = buriedCand(pos(0.5, 64, 0.5), { name: 'iron_ore', position: pos(0, 63, 0), distance: 1 }, bot)
    assert.equal(c.depthBelow, 1)
    assert.equal(c.wet, false, 'a 1-block dig never breaches the column')
  })

  it('buriedCand reads a shaft ore wet under column water (shaft floods)', () => {
    const cells = { '0,59,0': 'iron_ore', '0,62,0': 'water' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const c = buriedCand(pos(0.5, 64, 0.5), { name: 'iron_ore', position: pos(0, 59, 0), distance: 5 }, bot)
    assert.equal(c.depthBelow, 5)
    assert.equal(c.wet, true, 'the shaft path keeps its wet flag')
  })

  it('findNearest ranks a near below-stance buried ore over a far level one (null refY)', () => {
    const cells = { '2,63,0': 'iron_ore', '20,64,0': 'iron_ore' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const res = findNearest(bot, 'iron_ore', null)
    assert.deepEqual([res.position.x, res.position.y, res.position.z], [2, 63, 0])
  })

  it('findNearest ranks a shallow-far buried ore over a deep-near shaft (null refY, revmux 02)', () => {
    const cells = { '6,59,0': 'iron_ore', '20,63,0': 'iron_ore' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const res = findNearest(bot, 'iron_ore', null)
    assert.deepEqual([res.position.x, res.position.y, res.position.z], [20, 63, 0])
  })

  it('findNearest keeps level-first for explicit refY (leads judge from the speaker)', () => {
    const cells = { '2,63,0': 'iron_ore', '20,64,0': 'iron_ore' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const res = findNearest(bot, 'iron_ore', 64)
    assert.deepEqual([res.position.x, res.position.y, res.position.z], [20, 64, 0])
  })

  it('findNearest keeps level-first among exposed hits (walkability)', () => {
    const cells = { '2,63,0': 'iron_ore', '2,63,1': 'air', '20,64,0': 'iron_ore', '21,64,0': 'air' }
    const bot = floodBot(cells, pos(0.5, 64, 0.5))
    const res = findNearest(bot, 'iron_ore', null)
    assert.deepEqual([res.position.x, res.position.y, res.position.z], [20, 64, 0])
  })

  it('skips the flooding ore and delivers the dry one (order recovers)', async () => {
    const cells = { '2,64,0': 'iron_ore', '1,64,0': 'water', '5,64,0': 'iron_ore' }
    const bot = floodBot(cells, pos(0, 64, 0))
    bot._moving = true
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    handleChat(bot, ticker, 'P', 'bring me iron_ore 1')
    const ctx = bot._tickerCtx
    const cap = capture()
    try {
      for (let i = 0; i < 80 && ctx.bring; i++) {
        bring(bot, ctx, null, {})
        await flush()
        const o = ctx.bring
        if (!o) break
        const gk = ctx.lastGoalKey
        if (gk.startsWith('bring:') && o.pos) {
          bot.entity.position = pos(o.pos.x + 1, o.pos.y, o.pos.z) // arrived
          bot._moving = false
        } else if (gk.startsWith('bring-pickup')) {
          bot._moving = false
        } else if (gk.startsWith('bring-return')) {
          const pp = bot.players.P.entity.position
          bot.entity.position = pos(pp.x + 1, pp.y, pp.z) // at the player
          bot._moving = false
        }
      }
      assert.equal(ctx.bring, null, 'order finished')
    } finally {
      cap.release()
    }
    assert.ok(bot.lines.includes('here is 1 raw_iron'), `delivered: ${bot.lines.join(' | ')}`)
    assert.ok('2,64,0' in cells, 'flooding ore left standing')
    assert.ok(!('5,64,0' in cells), 'dry ore dug')
    assert.equal(bot.digCalls, 1, 'exactly one dig')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig iron_ore at 2 64 0 (flood-risk)'), cap.logged.join('\n'))
  })
})
