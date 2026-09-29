'use strict'

// atl.17: ore under the feet in the bot's own shaft — the below-feet trap
// denial is a property of the PLACE, so re-finding the same nearest block
// never changes it. 6x7.2: bring no longer raises (the stance changes only
// when the body itself wedges and stuck.js raises off the bring key) — a
// standing-still strike loop refuses honestly at the denyStrikes ceiling.

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
  it('a below-feet denial strikes and searches again with no stuck fact', async () => {
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
    assert.ok(!ctx.stuck, 'no stuck fact from the order itself')
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
  it('shaft stance over unknown below: four selftraps, honest refusal, no episode', async () => {
    // 6x7.2: the atl.17 sidestep episode is gone with the bring raise — the
    // stance never changes (same nearest block every find), so the order
    // strikes out and refuses instead of digging. Solid below still digs
    // (atl.20, below); a wedged body still raises centrally off the key.
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
    assert.equal(traps.length, 4, `four strikes then refuse, got ${traps.length}:\n${cap.logged.join('\n')}`)
    assert.ok(!bot.lines.some((l) => l.includes('stuck, trying')), `no episode: ${bot.lines.join(' | ')}`)
    assert.ok('0,62,0' in cells, 'hazard never dug')
    assert.ok(bot.lines.some((l) => l.includes('could not reach iron_ore safely')), `refused: ${bot.lines.join(' | ')}`)
  })
})

// atl.20: the shaft-bottom loop (atl.18 5/9) died on the below-feet denial
// with SOLID stone under the ore — a safe 1-block drop, what a player
// does. Bring digs it instead of striking; the refusal stays for real
// hazards (air/water/lava/unknown below). The guard itself is untouched:
// every other behaviour keeps the old denial.
const { solidBelow } = require('../src/behaviours/util')

describe('atl.20 below-feet onto solid (unit)', () => {
  it('solidBelow proves only a known solid landing', () => {
    const bot = (below) => ({
      blockAt: () => below === undefined ? null : below,
    })
    assert.equal(solidBelow(bot({ name: 'stone' }), pos(0, 62, 0)), true, 'stone lands')
    assert.equal(solidBelow(bot({ name: 'dirt' }), pos(0, 62, 0)), true, 'dirt lands')
    assert.equal(solidBelow(bot({ name: 'deepslate_iron_ore' }), pos(0, 62, 0)), true, 'ore lands')
    assert.equal(solidBelow(bot({ name: 'air' }), pos(0, 62, 0)), false, 'air is a drop')
    assert.equal(solidBelow(bot({ name: 'cave_air' }), pos(0, 62, 0)), false, 'cave air is a drop')
    assert.equal(solidBelow(bot({ name: 'water' }), pos(0, 62, 0)), false, 'water is a hazard')
    assert.equal(solidBelow(bot({ name: 'lava' }), pos(0, 62, 0)), false, 'lava is a hazard')
    assert.equal(solidBelow(bot({ name: 'short_grass' }), pos(0, 62, 0)), false, 'flora is not a landing')
    assert.equal(solidBelow(bot(undefined), pos(0, 62, 0)), false, 'unknown stays denied')
    assert.equal(solidBelow(bot({ name: 'dirt', boundingBox: 'empty' }), pos(0, 62, 0)), false, 'walk-through stays denied')
    assert.equal(solidBelow(bot({ name: 'dirt', boundingBox: 'block' }), pos(0, 62, 0)), true, 'real solid lands')
    assert.equal(solidBelow(null, pos(0, 62, 0)), false, 'null bot denies')
  })

  it('solid below: the ore is dug with no strike and no stuck fact', async () => {
    const cells = shaftCells()
    cells['0,61,0'] = 'dirt' // proven landing under the ore
    const bot = shaftBot(cells)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      cap.release()
    }
    assert.equal(bot.digCalls, 1, 'ore dug')
    assert.ok(!('0,62,0' in cells), 'ore gone from the world')
    assert.equal(ctx.bring.phase, 'pickup', 'dig advances the order')
    assert.equal(ctx.bring.denyStrikes || 0, 0, 'no strike counted')
    assert.ok(!ctx.stuck, 'no stuck fact: no episode needed')
    assert.ok(cap.logged.some((l) => l.includes('onto solid') && l.includes('(atl.20)')), cap.logged.join('\n'))
    assert.ok(!cap.logged.some((l) => l.includes('refused dig iron_ore')), 'never refused')
  })

  it('solid below a BUILD still skips it, never digs (revmux 01 core-1)', async () => {
    // denyReason returns 'below-feet' before it checks protection, so the
    // exemption must unmask the type rules first — or bring would dig the
    // cabin floor it stands on.
    const cells = shaftCells()
    cells['0,62,0'] = 'oak_planks' // a build under the feet ...
    cells['0,61,0'] = 'dirt' // ... over a proven landing
    const bot = shaftBot(cells)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'oak_planks', drop: 'oak_planks', have: 0 },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
    } finally {
      cap.release()
    }
    assert.equal(bot.digCalls, 0, 'build never dug')
    assert.equal(ctx.bring.phase, 'find', 'take the next candidate')
    assert.ok(ctx.bring.skip && ctx.bring.skip.has('0,62,0'), 'build skipped')
    assert.ok(!ctx.stuck, 'a build is skipped, not struck')
    assert.ok(cap.logged.some((l) => l === 'protected: oak_planks at 0 62 0'), cap.logged.join('\n'))
    assert.ok(!cap.logged.some((l) => l.includes('onto solid')), 'exemption never fires on a build')
  })

  it('air below: the strike path still denies, with no stuck fact', async () => {
    const cells = shaftCells()
    cells['0,61,0'] = 'air' // explicit drop under the ore: a real hazard
    const bot = shaftBot(cells)
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
    assert.equal(bot.digCalls, 0, 'hazard never dug')
    assert.equal(ctx.bring.phase, 'find', 'search again after the strike')
    assert.equal(ctx.bring.denyStrikes, 1, 'one strike counted')
    assert.ok(!ctx.stuck, 'no stuck fact from the order itself')
    assert.ok(cap.logged.some((l) => l === 'selftrap: refused dig iron_ore at 0 62 0 (below-feet)'), cap.logged.join('\n'))
  })
})

describe('atl.20 below-feet onto solid (fake-player e2e)', () => {
  it('shaft stance over solid: no selftrap, ore dug, here is 1 raw_iron', async () => {
    const cells = shaftCells()
    cells['0,61,0'] = 'dirt' // the atl.18 shaft bottom: stone under the ore
    const bot = shaftBot(cells)
    const ticker = createTicker({
      bot,
      brain: { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }, // no ask: FSM reserve
      tickMs: 10,
      idleTickMs: 10,
    })
    handleChat(bot, ticker, 'P', 'bring me iron_ore 1')
    const ctx = bot._tickerCtx
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
    assert.ok(!cap.logged.some((l) => l.includes('refused dig iron_ore')), `no refusal:\n${cap.logged.join('\n')}`)
    assert.ok(!bot.lines.some((l) => l.startsWith('stuck, trying')), `no episode needed: ${bot.lines.join(' | ')}`)
    assert.ok(!('0,62,0' in cells), 'ore dug')
    assert.ok(bot.lines.includes('here is 1 raw_iron'), `chats: ${bot.lines.join(' | ')}`)
    assert.ok(!bot.lines.some((l) => l.includes('could not reach iron_ore safely')), 'never refused')
  })
})
