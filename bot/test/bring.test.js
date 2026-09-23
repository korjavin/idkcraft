'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const bring = require('../src/behaviours/bring')
const { dropFor, needsPickaxe, hasPickaxe, requiredTier } = require('../src/behaviours/bring')
const { handleChat, createTicker } = require('../src/index')
const { COMMANDS, lookupCommand } = require('../src/commands')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
  }
  return p
}

const BLOCKS = { coal_ore: 11, oak_log: 12, stone: 1, iron_ore: 31, gold_ore: 32 }
const ITEMS = { coal: 21, oak_log: 12, stone_pickaxe: 22, wooden_pickaxe: 23, iron_pickaxe: 24 }

function mockBot({ spots = [], names = {}, items = [], playerPos = null } = {}) {
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
    registry: { blocksByName, itemsByName },
    players: { P: { username: 'P', entity: playerPos ? { position: playerPos } : null } },
    _moving: false,
    _items: items,
    digCalls: 0,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
      bestHarvestTool: () => ({ name: 'stone_pickaxe', type: 99 }),
    },
    held: null,
    equipped: [],
    equip: async (item) => { bot.held = item && item.name; bot.equipped.push(bot.held) },
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
      const n = names[`${p.x},${p.y},${p.z}`]
      return n ? { name: n, position: pos(p.x, p.y, p.z) } : null
    },
    canDigBlock: () => true,
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp) delete names[`${bp.x},${bp.y},${bp.z}`]
      // Drops only land when a pickaxe is held (review: sword-dug ore drops nothing)
      if (bot.held && bot.held.endsWith('_pickaxe')) bot._items.push({ name: dropFor(block.name), count: 1 })
    },
    toss: async (id, meta, n) => { tossCalls.push([id, meta, n]) },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

function tickerFor(bot) {
  return createTicker({
    bot,
    brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) },
    tickMs: 10,
    idleTickMs: 10,
  })
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('bring me order', () => {
  it("'bring me coal' walks, digs 3, returns, tosses at the player", async () => {
    const names = { '2,64,0': 'coal_ore', '6,64,0': 'coal_ore', '9,64,0': 'coal_ore' }
    const spots = [pos(2, 64, 0), pos(6, 64, 0), pos(9, 64, 0)]
    const bot = mockBot({ spots, names, items: [{ name: 'stone_pickaxe', count: 1 }], playerPos: pos(30, 64, 0) })
    bot._moving = true
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal')
    const ctx = bot._tickerCtx
    assert.match(bot.lines[0], /^going for 3 coal_ore, \d+ blocks away$/)
    assert.equal(ctx.bring.want, 3)
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
    assert.equal(ctx.bring, null)
    assert.deepEqual(bot.tossCalls, [[ITEMS.coal, null, 3]])
    assert.ok(bot.lines.includes('here are 3 coal'), `chats: ${bot.lines.join(' | ')}`)
  })

  it('no pickaxe: refuses ore at order time', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'coal_ore' },
      items: [],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.deepEqual(bot.lines, ['need a stone pickaxe for coal_ore'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('logs need no tool; defaults are ore 3 / logs 4, cap 16', () => {
    const logBot = mockBot({ spots: [pos(2, 64, 0)], names: { '2,64,0': 'oak_log' }, items: [] })
    handleChat(logBot, tickerFor(logBot), 'P', 'bring me oak_log')
    assert.match(logBot.lines[0], /^going for 4 oak_log, \d+ blocks away$/)
    const capBot = mockBot({
      spots: [pos(2, 64, 0)], names: { '2,64,0': 'coal_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
    })
    handleChat(capBot, tickerFor(capBot), 'P', 'bring me coal 99')
    assert.match(capBot.lines[0], /^going for 16 coal_ore, \d+ blocks away$/)
  })

  it('unknown block and nothing in range refuse', () => {
    const weird = mockBot({})
    handleChat(weird, tickerFor(weird), 'P', 'bring me unobtanium')
    assert.deepEqual(weird.lines, ['unknown block: unobtanium'])
    assert.ok(!weird._tickerCtx.bring, 'no order created')
    const empty = mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }] })
    handleChat(empty, tickerFor(empty), 'P', 'bring me coal')
    assert.deepEqual(empty.lines, ['no coal within 48 blocks (loaded area)'])
    assert.ok(!empty._tickerCtx.bring, 'no order created')
  })

  it('finds a block at 60 blocks via the tick-sliced far search (amb)', async () => {
    const ore = pos(60, 64, 0)
    const bot = mockBot({
      spots: [ore],
      names: {
        '60,64,0': 'coal_ore',
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
      },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => {
      // Emulate the real client: only hits near the scan center come back.
      const c = o.point || { x: 0, y: 64, z: 0 }
      return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
    }
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.deepEqual(bot.lines, ['nothing within 48, widening the search for coal…'])
    for (let i = 0; i < 200 && !bot._tickerCtx.bring; i++) await ticker.tick()
    assert.ok(bot._tickerCtx.bring, 'order created on far completion')
    assert.ok(bot.lines.includes('going for 3 coal_ore, 60 blocks away'), `lines: ${bot.lines}`)
    assert.equal(bot._tickerCtx.bring.exposed, false, 'buried ore flagged at find time')
  })

  it('walk stall on buried ore names it (amb session note)', () => {
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    bot._moving = true // pathfinder working but the body never displaces
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      name: 'iron', want: 3, by: 'P', block: 'iron_ore', drop: 'iron',
      pos: pos(10, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true, exposed: false,
    }
    for (let i = 0; i < 12 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('could not reach iron_ore (buried, no path in)'), `lines: ${bot.lines}`)
  })

  it('walk stall on exposed ore keeps the plain refusal', () => {
    const bot = mockBot({
      spots: [pos(10, 64, 0)],
      names: { '10,64,0': 'iron_ore', '11,64,0': 'air' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    bot._moving = true
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = {
      name: 'iron', want: 3, by: 'P', block: 'iron_ore', drop: 'iron',
      pos: pos(10, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true, exposed: true,
    }
    for (let i = 0; i < 12 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('could not reach iron_ore'), `lines: ${bot.lines}`)
    assert.ok(!bot.lines.some((l) => l.includes('buried')), `lines: ${bot.lines}`)
  })

  it('searchfar finds far ore over bring ticks (amb)', () => {
    const ore = pos(60, 64, 0)
    const bot = mockBot({
      spots: [ore],
      names: {
        '60,64,0': 'coal_ore',
        '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone',
      },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const inner = bot.findBlocks.bind(bot)
    bot.findBlocks = (o) => {
      const c = o.point || { x: 0, y: 64, z: 0 }
      return inner(o).filter((q) => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) <= o.maxDistance)
    }
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = { name: 'coal', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'searchfar', 'sync miss parks a far cursor')
    for (let i = 0; i < 200 && c.bring.phase === 'searchfar'; i++) bring(bot, c, null, {})
    assert.equal(c.bring.phase, 'walk', 'far completion walks')
    assert.deepEqual([c.bring.pos.x, c.bring.pos.y, c.bring.pos.z], [60, 64, 0])
  })

  it('searchfar refuses honestly when nothing is out there (amb)', () => {
    const bot = mockBot({
      spots: [],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    tickerFor(bot)
    const c = bot._tickerCtx
    c.bring = { name: 'coal', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
    for (let i = 0; i < 200 && c.bring; i++) bring(bot, c, null, {})
    assert.equal(c.bring, null, 'order refused')
    assert.ok(bot.lines.includes('no coal within 160 blocks (loaded area)'), `lines: ${bot.lines}`)
  })

  it('stop retires a pending far search, no late order (amb)', async () => {
    const bot = mockBot({
      spots: [],
      names: { '48,64,0': 'stone', '96,64,0': 'stone', '128,64,0': 'stone', '160,64,0': 'stone' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.ok(bot._tickerCtx.pendingSearch, 'far search pending')
    assert.ok(!bot._tickerCtx.bring, 'no order yet')
    handleChat(bot, ticker, 'P', 'stop')
    assert.equal(bot._tickerCtx.pendingSearch, null, 'stop retires the search')
    for (let i = 0; i < 5; i++) await ticker.tick()
    assert.ok(!bot._tickerCtx.bring, 'no late order after stop')
    assert.ok(bot._tickerCtx.paused, 'still parked')
  })

  it("'stop' mid-order cancels", () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'coal_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.ok(bot._tickerCtx.bring)
    handleChat(bot, ticker, 'P', 'stop')
    assert.equal(bot._tickerCtx.bring, null)
  })

  it('unseen player at return time: honest wait, chat once, order held', () => {
    const bot = mockBot({ items: [{ name: 'coal', count: 3 }], playerPos: null })
    bot._tickerCtx = { lastGoalKey: '', bring: null }
    const ctx = bot._tickerCtx
    ctx.bring = {
      name: 'coal', want: 3, by: 'P', block: 'coal_ore', drop: 'coal',
      pos: null, phase: 'return', stalls: 0, lastPos: null, have: 3, announced: true,
    }
    bring(bot, ctx, null, {})
    assert.match(bot.lines[0], /^I can't see you — I'm at 0 64 0 with your 3 coal; come closer$/)
    bring(bot, ctx, null, {})
    assert.equal(bot.lines.length, 1, 'wait line chats once')
    assert.ok(ctx.bring, 'order held until the player is back')
  })

  it('dropFor maps ores to drops, logs to themselves', () => {
    assert.equal(dropFor('iron_ore'), 'raw_iron')
    assert.equal(dropFor('deepslate_gold_ore'), 'raw_gold')
    assert.equal(dropFor('coal_ore'), 'coal')
    assert.equal(dropFor('lapis_ore'), 'lapis_lazuli')
    assert.equal(dropFor('oak_log'), 'oak_log')
    assert.equal(needsPickaxe('coal_ore'), true)
    assert.equal(needsPickaxe('oak_log'), false)
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }] }), 'coal_ore'), true)
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'wooden_pickaxe', count: 1 }] }), 'coal_ore'), false)
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'stone_pickaxe', count: 1 }] }), 'gold_ore'), false)
    assert.equal(hasPickaxe(mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] }), 'gold_ore'), true)
    assert.equal(requiredTier('deepslate_diamond_ore'), 'iron')
    assert.equal(requiredTier('iron_ore'), 'stone')
    assert.equal(hasPickaxe(mockBot({ items: [] })), false)
  })

  it('bring order owns tick dispatch with action=bring', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    ctx.bring = {
      name: 'coal', want: 3, by: 'P', block: 'coal_ore', drop: 'coal',
      pos: pos(2, 64, 0), phase: 'return', stalls: 0, lastPos: null,
      have: 3, announced: true,
    }
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'bring')
    assert.match(ctx.lastGoalKey, /^bring-return:/)
  })

  it("non-ore non-log blocks refuse ('bring me stone')", () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'stone' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me stone')
    assert.deepEqual(bot.lines, ["can't bring stone — ores and logs only"])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('wooden pickaxe is refused for iron ore', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'iron_ore' },
      items: [{ name: 'wooden_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me iron')
    assert.deepEqual(bot.lines, ['need a stone pickaxe for iron_ore'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
  })

  it('unseen requester mid-walk: tick still dispatches bring, counter frozen', async () => {
    const bot = mockBot({ playerPos: pos(30, 64, 0) })
    const ticker = tickerFor(bot)
    const ctx = bot._tickerCtx
    handleChat(bot, ticker, 'P', 'follow me') // follow mode: target is P
    ctx.bring = {
      name: 'coal', want: 3, by: 'P', block: 'coal_ore', drop: 'coal',
      pos: pos(2, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true,
    }
    bot.players.P.entity = null // walked past tracking range mid-order
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'bring')
    assert.equal(ctx.unseenTicks, 0, 'homing math frozen mid-order')
  })

  it('fight preempts bring; bring beats work', async () => {
    const fightBot = mockBot({ playerPos: pos(30, 64, 0) })
    const fightTicker = createTicker({
      bot: fightBot,
      brain: { decide: async () => ({ action: 'fight', sprint: false, source: 'jev' }) },
      tickMs: 10,
      idleTickMs: 10,
    })
    fightBot._tickerCtx.bring = {
      name: 'coal', want: 3, by: 'P', block: 'coal_ore', drop: 'coal',
      pos: pos(2, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true,
    }
    assert.equal((await fightTicker.tick()).decision.action, 'fight')
    const workBot = mockBot({ playerPos: pos(30, 64, 0) })
    const workTicker = tickerFor(workBot)
    workBot._tickerCtx.work = true
    workBot._tickerCtx.bring = {
      name: 'coal', want: 3, by: 'P', block: 'coal_ore', drop: 'coal',
      pos: pos(2, 64, 0), phase: 'walk', stalls: 0, lastPos: null,
      have: 0, announced: true,
    }
    assert.equal((await workTicker.tick()).decision.action, 'bring')
  })

  it('setBring supersedes a pending spawn work-resume', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'coal_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    const ticker = tickerFor(bot)
    bot._tickerCtx.resumeWork = true
    handleChat(bot, ticker, 'P', 'bring me coal')
    assert.ok(bot._tickerCtx.bring, 'order created')
    assert.equal(bot._tickerCtx.resumeWork, false, 'resume cannot cancel the order')
  })

  it('stone pickaxe is refused for gold ore (iron tier)', () => {
    const bot = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'gold_ore' },
      items: [{ name: 'stone_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(bot, tickerFor(bot), 'P', 'bring me gold')
    assert.deepEqual(bot.lines, ['need an iron pickaxe for gold_ore'])
    assert.ok(!bot._tickerCtx.bring, 'no order created')
    const rich = mockBot({
      spots: [pos(2, 64, 0)],
      names: { '2,64,0': 'gold_ore' },
      items: [{ name: 'iron_pickaxe', count: 1 }],
      playerPos: pos(30, 64, 0),
    })
    handleChat(rich, tickerFor(rich), 'P', 'bring me gold')
    assert.match(rich.lines[0], /^going for 3 gold_ore, \d+ blocks away$/)
  })

  it("'bring me' is in COMMANDS with usage", () => {
    const cmd = lookupCommand('bring me')
    assert.ok(cmd, 'bring me resolves')
    assert.ok(COMMANDS.some((c) => c.names.includes('bring me')))
    assert.match(cmd.usage, /bring me <block> \[count\]/)
  })
})
