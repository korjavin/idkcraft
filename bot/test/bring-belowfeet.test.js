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

  it('air below: the strike path still denies and raises the stuck fact', async () => {
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
    assert.ok(ctx.stuck && ctx.stuck.by === 'bring', 'stuck fact raised (atl.17 path)')
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

// idkcraft-x16j: the prod ping-pong — the only exposed ore sits below-feet,
// the sidestep episode runs, find re-picks the same exposure, the clock
// dies. The second denial of the SAME position skips it instead of
// re-striking, so the next cheapest candidate wins (one of the bead's three
// allowed fallbacks; no new movement primitives).
describe('x16j below-feet repeat skips the position (unit)', () => {
  // A in the atl.17 shaft, B reachable in the open (no 3-wall trap).
  const cellsWithNext = () => ({
    ...shaftCells(),
    '5,62,0': 'iron_ore',
  })

  it('re-denial of the same below-feet ore skips it; find commits the next ore', async () => {
    const bot = shaftBot(cellsWithNext())
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron', want: 1, have: 0, pos: pos(0, 62, 0) },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {}) // strike 1: episode, search again
      assert.equal(ctx.bring.phase, 'find')
      assert.equal(ctx.bring.denyStrikes, 1)
      assert.equal(ctx.bring.belowFeetKey, '0,62,0')
      // The episode did not move the stance: find re-picks A, walk returns.
      ctx.bring.phase = 'dig'
      ctx.bring.pos = pos(0, 62, 0)
      await bring(bot, ctx, null, {}) // strike 2, same position: skip, not strike
      assert.equal(ctx.bring.phase, 'find', 'repeat searches again')
      assert.equal(ctx.bring.denyStrikes, 1, 'the skip burns no strike')
      assert.ok(ctx.bring.skip && ctx.bring.skip.has('0,62,0'), 'A skipped')
      assert.ok(cap.logged.some((l) => l.includes('skipped, taking next (x16j)')), cap.logged.join('\n'))
      await bring(bot, ctx, null, {}) // find with A skipped: commits B
      assert.equal(ctx.bring.phase, 'walk', 'next cheapest candidate wins')
      assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [5, 62, 0])
    } finally {
      cap.release()
    }
  })

  it('the next ore digs: no ping-pong, no refusal', async () => {
    const cellMap = cellsWithNext()
    const bot = shaftBot(cellMap)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron', want: 1, have: 0, pos: pos(0, 62, 0) },
    }
    const cap = capture()
    try {
      for (let i = 0; i < 12 && ctx.bring && ctx.bring.phase !== 'pickup'; i++) {
        await bring(bot, ctx, null, {})
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        const o = ctx.bring
        // A re-commit walks straight back: simulate the arrival.
        if (o && o.phase === 'walk' && o.pos && o.pos.x === 0 && o.pos.z === 0) { o.phase = 'dig' }
      }
      assert.equal(ctx.bring && ctx.bring.phase, 'pickup', 'B dug, order advances')
      assert.ok(!('5,62,0' in cellMap), 'B gone from the world')
      assert.ok('0,62,0' in cellMap, 'denied A never dug')
      assert.ok(!bot.lines.some((l) => l.includes('could not reach iron_ore safely')), 'never refused')
      assert.equal(bot.digCalls, 1, 'exactly one dig')
    } finally {
      cap.release()
    }
  })

  it('a below-feet denial elsewhere still strikes (guard is per-position)', async () => {
    const bot = shaftBot(shaftCells())
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: pos(0, 62, 0), block: 'iron_ore', drop: 'raw_iron', have: 0, belowFeetKey: '9,62,9' },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {})
    } finally {
      cap.release()
    }
    assert.equal(ctx.bring.phase, 'find', 'search again after the strike')
    assert.equal(ctx.bring.denyStrikes, 1, 'a new position strikes, never skips')
    assert.ok(!ctx.bring.skip, 'nothing skipped')
    assert.ok(ctx.stuck && ctx.stuck.by === 'bring', 'episode still raised')
  })
})

// idkcraft-x16j r1 (codex verifier): skips must not strand a freed ore,
// and must never read as absent.
// 2081: the walls that made a cell a trap may be mined after the skip —
// find re-validates skipped cells when candidates run out.
// 2084: with only skipped-known ore left, the no-candidates line reads
// unsafe, never 'no X within N blocks'.
describe('x16j r1 skip re-validation and honest refusal (unit)', () => {
  async function untilPhase(bot, ctx, phase, cap, what) {
    for (let i = 0; i < 10 && ctx.bring && ctx.bring.phase !== phase; i++) {
      await bring(bot, ctx, null, {})
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    }
    assert.equal(ctx.bring && ctx.bring.phase, phase, what)
  }

  it('a freed skip is found again: wall mined after the skip, order completes', async () => {
    const cellMap = shaftCells()
    const bot = shaftBot(cellMap)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron', want: 1, have: 0, pos: pos(0, 62, 0) },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {}) // strike 1
      assert.equal(ctx.bring.denyStrikes, 1)
      await untilPhase(bot, ctx, 'walk', cap, 'find re-picks A, walk back')
      ctx.bring.phase = 'dig' // arrival without moving the stance
      await bring(bot, ctx, null, {}) // repeat: skip
      assert.ok(ctx.bring.skip && ctx.bring.skip.has('0,62,0'), 'A skipped')
      assert.ok(ctx.bring.bfSkip && ctx.bring.bfSkip.has('0,62,0'), 'skip tracked as below-feet origin')
      delete cellMap['1,63,0'] // the wall is mined: the trap is gone
      await untilPhase(bot, ctx, 'walk', cap, 're-validation finds freed A')
      assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.y, ctx.bring.pos.z], [0, 62, 0], 'A committed, not stranded')
      assert.ok(!ctx.bring.skip.has('0,62,0'), 'skip cleared by re-validation')
      await untilPhase(bot, ctx, 'pickup', cap, 'A digs')
      assert.ok(!('0,62,0' in cellMap), 'A gone from the world')
      assert.ok(!bot.lines.some((l) => l.includes('only got')), `no partial line: ${bot.lines.join(' | ')}`)
    } finally {
      cap.release()
    }
  })

  it('only skipped-known ore reads unsafe, never absent', async () => {
    const bot = shaftBot(shaftCells())
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron', want: 1, have: 0, pos: pos(0, 62, 0) },
    }
    const cap = capture()
    try {
      await bring(bot, ctx, null, {}) // strike 1
      await untilPhase(bot, ctx, 'walk', cap, 'find re-picks A, walk back')
      ctx.bring.phase = 'dig' // arrival without moving the stance
      await bring(bot, ctx, null, {}) // repeat: skip
      assert.equal(ctx.bring.denyStrikes, 1, 'the skip burns no strike')
      for (let i = 0; i < 500 && ctx.bring; i++) {
        await bring(bot, ctx, null, {}) // find runs normally: shells, then the honest line
      }
      assert.equal(ctx.bring, null, 'order refused')
      assert.ok(bot.lines.includes('could not reach iron_ore safely'), `honest line: ${bot.lines.join(' | ')}`)
      assert.ok(!bot.lines.some((l) => l.includes('within 48 blocks')), 'never reads as absent')
    } finally {
      cap.release()
    }
  })

  it('alternating trap positions still hit the strike ceiling', async () => {
    const cellMap = shaftCells()
    cellMap['1,62,0'] = 'iron_ore' // second denied cell in the same shaft
    const bot = shaftBot(cellMap)
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'iron_ore', block: 'iron_ore', drop: 'raw_iron', want: 1, have: 0, pos: pos(0, 62, 0) },
    }
    const cap = capture()
    try {
      // Alternating positions: never a repeat, so every denial strikes and
      // the ceiling still ends the order.
      for (const k of ['0,62,0', '1,62,0', '0,62,0', '1,62,0', '0,62,0']) {
        if (!ctx.bring) break
        ctx.bring.phase = 'dig'
        const [x, y, z] = k.split(',').map(Number)
        ctx.bring.pos = pos(x, y, z)
        await bring(bot, ctx, null, {})
      }
      assert.equal(ctx.bring, null, 'the ceiling refuses')
      assert.ok(bot.lines.some((l) => l.includes('could not reach iron_ore safely')), `lines: ${bot.lines.join(' | ')}`)
    } finally {
      cap.release()
    }
  })
})
