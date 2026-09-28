'use strict'

// atl.17: ore under the feet in the bot's own shaft — the below-feet trap
// denial is a property of the PLACE, so re-finding the same nearest block
// never changes it. Bring raises the stuck fact and the recover menu owns
// the sidestep; release() resumes ctx.bring untouched.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
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

// 1-wide shaft: the bot stands on iron_ore at (0,62,0) with feet at y=63,
// three 2-high dirt walls (hop infeasible, sidestep feasible through the
// open south side), open sky above.
function shaftCells() {
  return {
    '0,62,0': 'iron_ore',
    '0,62,-1': 'dirt',
    '1,63,0': 'dirt', '-1,63,0': 'dirt', '0,63,1': 'dirt',
    '1,64,0': 'dirt', '-1,64,0': 'dirt', '0,64,1': 'dirt',
  }
}

function shaftBot(cells) {
  const lines = []
  const bot = {
    lines,
    username: 'IdkBot',
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 63, 0.5), onGround: true },
    registry: {
      blocksByName: { iron_ore: { id: BLOCKS.iron_ore }, dirt: { id: BLOCKS.dirt } },
      itemsByName: { raw_iron: { id: ITEMS.raw_iron }, stone_pickaxe: { id: ITEMS.stone_pickaxe } },
    },
    players: { P: { username: 'P', entity: { position: pos(4, 63, -4) } } },
    _items: [{ name: 'stone_pickaxe', count: 1 }],
    held: null,
    digCalls: 0,
    tossCalls: [],
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      isMoving: () => false,
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
  const origErr = console.error
  console.log = (m) => { logged.push(String(m)) }
  console.error = (m) => { logged.push(String(m)) }
  return { logged, release() { console.log = origLog; console.error = origErr } }
}

describe('atl.17 bring below-feet stance (unit)', () => {
  it('a below-feet denial raises the bring stuck fact and searches again', async () => {
    const bot = shaftBot(shaftCells())
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
    } finally {
      cap.release()
    }
    assert.equal(ctx.bring.phase, 'find', 'search again after the strike')
    assert.equal(ctx.bring.denyStrikes, 1, 'one strike counted')
    assert.ok(ctx.stuck, 'stuck fact raised')
    assert.equal(ctx.stuck.by, 'bring')
    assert.deepEqual([ctx.stuck.goal.x, ctx.stuck.goal.y, ctx.stuck.goal.z], [0, 62, 0])
    assert.equal(ctx.stuck.key, 'bring:0,62,0')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig iron_ore at 0 62 0 (below-feet)'), cap.logged.join('\n'))
  })

  it('a gravity denial searches again WITHOUT the stuck fact (below-feet scope only)', async () => {
    const cells = { '0,63,0': 'stone', '0,64,0': 'sand' }
    const bot = shaftBot(cells)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 63, 0), block: 'stone', drop: 'stone', have: 0 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
    } finally {
      cap.release()
    }
    assert.equal(ctx.bring.phase, 'find', 'search again after the strike')
    assert.equal(ctx.bring.denyStrikes, 1, 'one strike counted')
    assert.ok(!ctx.stuck, 'no stuck fact for gravity')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig stone at 0 63 0 (gravity)'), cap.logged.join('\n'))
  })

  it('the strike ceiling still refuses once an episode already runs', async () => {
    const bot = shaftBot(shaftCells())
    const ctx = {
      lastGoalKey: '',
      stuck: { by: 'bring', goal: { x: 0, y: 62, z: 0 }, key: 'bring:0,62,0' }, // episode running
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, denyStrikes: 3 },
    }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null, '4th denial refuses')
    assert.ok(bot.lines.some((l) => l.includes('could not reach iron_ore safely')), bot.lines.join('\n'))
  })
})

describe('atl.17 bring below-feet stance (fake-player e2e)', () => {
  it('shaft stance: one selftrap, sidestep episode, ore dug, here is 1 raw_iron', async () => {
    const cells = shaftCells()
    const bot = shaftBot(cells)
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }, // no ask: FSM reserve
      tickMs: 10,
      idleTickMs: 10,
    })
    handleChat(bot, ticker, 'P', 'bring me iron_ore 1')
    const ctx = bot._tickerCtx
    assert.match(bot.lines[0], /^going for 1 iron_ore, \d+ blocks away$/)
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.6, d) / d
      bot.entity.position = pos(bp.x + dx * s, 63, bp.z + dz * s)
    }
    const cap = capture()
    try {
      let t = 0
      for (; t < 150 && ctx.bring; t++) {
        await ticker.tick()
        stepBody()
      }
      assert.ok(!ctx.bring, 'order finished')
    } finally {
      cap.release()
    }
    const traps = cap.logged.filter((l) => l === 'selftrap: refused dig iron_ore at 0 62 0 (below-feet)')
    assert.equal(traps.length, 1, `exactly one below-feet refusal, got ${traps.length}:\n${cap.logged.join('\n')}`)
    assert.ok(bot.lines.includes('stuck, trying sidestepping (fsm)'), `episode ran: ${bot.lines.join(' | ')}`)
    assert.ok(!('0,62,0' in cells), 'ore dug after the stance change')
    assert.ok(bot.entity.position.z < -0.5, `stance changed: z=${bot.entity.position.z}`)
    assert.ok(bot.lines.includes('here is 1 raw_iron'), `chats: ${bot.lines.join(' | ')}`)
    assert.ok(!bot.lines.some((l) => l.includes('could not reach iron_ore safely')), 'never refused')
  })
})
