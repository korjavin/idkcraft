'use strict'

// Forage step (idkcraft-atl.2): best remembered find first, batch haul,
// ghosts forgotten, no stuck facts.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function mockBot() {
  const inv = []
  const calls = { setGoal: 0, goals: [], digs: 0, attacks: [] }
  const chats = []
  const bot = {
    calls, chats, inv,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    blocks: {},
    registry: { blocksByName: { iron_ore: { id: 1 }, oak_log: { id: 2 }, coal_ore: { id: 3 }, diamond_ore: { id: 4 } }, itemsByName: {} },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    inventory: { items: () => inv },
    findBlocks: () => [],
    blockAt: (p) => {
      const n = bot.blocks[`${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`]
      return n ? { name: n } : { name: 'stone' }
    },
    canDigBlock: () => true,
    dig: async (block) => { calls.digs++ },
    lookAt: () => {},
    attack: (e) => { calls.attacks.push(e && e.id) },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

function memCtx(cells) {
  const ctx = { lastGoalKey: '', stepStatus: 'running' }
  resources.noteSpots(ctx, cells, 1000)
  return ctx
}

const tick = () => new Promise((r) => setImmediate(r))

describe('planForage', () => {
  it('picks value over distance: far iron beats near coal and nearer logs', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 100, y: 60, z: 0, name: 'iron_ore' },
      { x: 5, y: 60, z: 0, name: 'coal_ore' },
      { x: 2, y: 64, z: 0, name: 'oak_log' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'ore')
    assert.equal(p.name, 'iron_ore')
    assert.equal(p.drop, 'raw_iron')
  })

  it('skips ore without the right pickaxe, falls back to logs', () => {
    const bot = mockBot() // no pickaxe
    const ctx = memCtx([
      { x: 5, y: 60, z: 0, name: 'iron_ore' },
      { x: 2, y: 64, z: 0, name: 'oak_log' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'log')
    assert.equal(p.name, 'oak_log')
  })

  it('diamond outranks iron at any distance', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 3, y: 60, z: 0, name: 'iron_ore' },
      { x: 90, y: 50, z: 0, name: 'diamond_ore' },
    ])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.name, 'diamond_ore')
  })

  it('null with empty memory and no animals: explore owns that', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    assert.equal(forage.planForage(bot, ctx), null)
  })

  it('food fallback: passive animal when nothing diggable is remembered', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(10, 64, 0), isValid: true } }
    const p = forage.planForage(bot, ctx)
    assert.equal(p.kind, 'food')
    assert.equal(p.drop, 'beef')
  })
})

describe('forage behaviour', () => {
  it('walks, digs a batch of 8 and banks the haul', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const cells = []
    for (let i = 0; i < 8; i++) {
      cells.push({ x: 10 + i * 2, y: 60, z: 0, name: 'iron_ore' })
      bot.blocks[`${10 + i * 2},60,0`] = 'iron_ore'
    }
    const ctx = memCtx(cells)
    bot.dig = async (block) => {
      bot.calls.digs++
      bot.inv.push({ name: 'raw_iron', count: 1 })
    }
    for (let i = 0; i < 200 && !ctx.stepStatus.startsWith('done') && !ctx.stepStatus.startsWith('failed:'); i++) {
      forage(bot, ctx, null, {})
      await tick()
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(ctx.haul, { raw_iron: 8 })
    assert.ok(bot.calls.goals.includes('GoalNear'))
    assert.ok(bot.calls.goals.includes('GoalBlock'))
    assert.ok(bot.chats.some((m) => m.startsWith('foraging:')))
  })

  it('ghost cell is forgotten and the next plan runs, no stuck fact', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 5, y: 60, z: 0, name: 'iron_ore' }, // ghost: stone underneath
      { x: 30, y: 60, z: 0, name: 'coal_ore' },
    ])
    bot.blocks['30,60,0'] = 'coal_ore'
    forage(bot, ctx, null, {}) // plan ghost, issue walk
    bot.entity.position = pos(5, 64, 0)
    bot._moving = false
    forage(bot, ctx, null, {}) // settle: ghost -> forget + replan
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.stuck, undefined)
    assert.deepEqual(ctx.forage.target.name, 'coal_ore')
  })

  it('ten still ticks strike the cell and fail unreachable with an empty haul', () => {
    // Contract change (reviewer atl.2): a stall-out is one strike on the
    // point — skip it, memory intact — not a forget (forget flips known and
    // defeats the atl.4 hold, looping forage->explore->forage on rescan).
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true // executor claims motion, body stands still
    for (let i = 0; i < 14; i++) forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('40,60,0'))
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.stuck, undefined)
    assert.deepEqual(ctx.haul, {})
  })

  it('a banked batch keeps struck cells skipped', async () => {
    // Round-1 minor: finish() cleared the skip set on any bank, reviving
    // dead high-rank cells for the next batch's strikes.
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const cells = []
    for (let i = 0; i < 8; i++) {
      cells.push({ x: 10 + i * 2, y: 60, z: 0, name: 'iron_ore' })
      bot.blocks[`${10 + i * 2},60,0`] = 'iron_ore'
    }
    const ctx = memCtx(cells)
    ctx.forageSkip = new Set(['99,60,0'])
    bot.dig = async (block) => {
      bot.calls.digs++
      bot.inv.push({ name: 'raw_iron', count: 1 })
    }
    for (let i = 0; i < 200 && !ctx.stepStatus.startsWith('done') && !ctx.stepStatus.startsWith('failed:'); i++) {
      forage(bot, ctx, null, {})
      await tick()
    }
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('99,60,0'), 'struck cell stays skipped across the bank')
  })
  it('a pathfinder timeout walks on: no instant strike, stall backstop intact', () => {
    // Round-1 minor: timeout returns a partial path the bot walks while A*
    // recomputes — only noPath strikes at once.
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true
    forage(bot, ctx, null, {}) // issue the walk goal first (consumes any verdict)
    ctx.lastPathStatus = 'timeout'
    for (let i = 0; i < 3; i++) forage(bot, ctx, null, {})
    assert.ok(!(ctx.forageSkip && ctx.forageSkip.has('40,60,0')), 'no strike on timeout')
    assert.equal((ctx.forage && ctx.forage.streak) || 0, 0)
    for (let i = 0; i < 12; i++) forage(bot, ctx, null, {})
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('40,60,0'), 'ten still ticks still strike via displacement')
  })
  it('a grazing unreachable herd fails out instead of chasing forever', async () => {
    // Round-2 minor: the hunt goal key follows the animal, which used to
    // zero the stall counter on every move while the id flip zeroed the
    // streak — minutes at the fence, never failed.
    const bot = mockBot()
    const ctx = memCtx([])
    const cow = { id: 7, name: 'cow', position: pos(10, 64, 0) }
    bot.entities = { 7: cow }
    let n = 0
    for (let i = 0; i < 80 && !ctx.stepStatus.startsWith('failed:') && !ctx.stepStatus.startsWith('done'); i++) {
      n++
      cow.position = pos(10 + (i % 3), 64, 0) // graze: re-issues the goal
      forage(bot, ctx, null, {})
      await tick()
    }
    assert.equal(ctx.stepStatus, 'failed:unreachable', `herd failed out after ${n} ticks`)
    assert.ok(n < 80, 'bounded, not forever')
  })
  it('registers in BEHAVIOURS under forage', () => {
    const { BEHAVIOURS } = require('../src/index')
    assert.equal(BEHAVIOURS.forage, forage)
  })
})

describe('unreachable memory point (reviewer atl.2: strike, never loop)', () => {
  const { decide } = require('../src/goal')
  const CELL = { x: 50, y: 60, z: 0, name: 'oak_log' }

  // Deep-ore fake: the cell is remembered but never loads, never diggable,
  // the body never moves — the live iron-ore trap in miniature.
  function deepBot() {
    const bot = mockBot()
    bot.blockAt = () => null
    bot.canDigBlock = () => false
    bot.entity.position = pos(0, 64, 0)
    bot.time = { timeOfDay: 6000 }
    return bot
  }
  function deepCtx() {
    const ctx = { lastGoalKey: '', home: { built: true }, brain: null, step: null, stepStatus: null }
    resources.noteSpots(ctx, [CELL], 1000)
    return ctx
  }
  async function runStep(bot, ctx, cap) {
    for (let i = 0; i < (cap || 40); i++) {
      forage(bot, ctx, null, {})
      await tick()
      const s = ctx.stepStatus
      if (typeof s === 'string' && (s === 'done' || s.startsWith('failed:'))) return s
    }
    return ctx.stepStatus
  }

  it('explore rescan does not revive a struck point: <=3 forage picks, then explore', async () => {
    const bot = deepBot()
    const ctx = deepCtx()
    let foragePicks = 0
    let last = null
    for (let c = 0; c < 10; c++) {
      const r = await decide(bot, ctx)
      last = r.action
      if (r.action === 'forage') {
        foragePicks++
        await runStep(bot, ctx)
      } else {
        resources.noteSpots(ctx, [CELL], 2000 + c) // explore arrival scan re-adds the deep ore
      }
    }
    assert.ok(foragePicks <= 3, `forage re-picked ${foragePicks}x to the same dead point`)
    assert.equal(last, 'explore') // honest switch, not a silent rest
    assert.ok(ctx.stepFail && ctx.stepFail.forage, 'stepFail recorded for forage')
    assert.equal(ctx.stepFail.forage.status, 'failed:unreachable')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('50,60,0'), 'the point was skipped, not forgotten')
    assert.equal(resources.count(ctx), 1, 'memory intact across strikes and rescans')
  })

  it('noPath on the live goal strikes at once, memory intact', async () => {
    const bot = deepBot()
    const ctx = deepCtx()
    forage(bot, ctx, null, {}) // plan + issue the walk goal
    ctx.lastPathStatus = 'noPath' // pathfinder verdict on the live goal
    const end = await runStep(bot, ctx, 6)
    assert.equal(end, 'failed:unreachable')
    assert.equal(resources.count(ctx), 1)
    assert.deepEqual(ctx.haul, {})
    assert.equal(ctx.stuck, undefined)
  })

  it('same unreachable animal three stall-outs -> failed:unreachable', async () => {
    // Food fallback loop (revmux 01): one cow across a ravine replanned onto
    // itself forever. Empty memory so the hunt is the only plan.
    const bot = deepBot()
    bot.entities = { 5: { id: 5, name: 'cow', position: pos(40, 64, 0) } }
    const ctx = { lastGoalKey: '', stepStatus: 'running' }
    assert.equal(await runStep(bot, ctx, 60), 'failed:unreachable')
  })

  it('swapped memory releases the final: new cells get a fresh try', async () => {
    // 256-cap shape (revmux 01): same count, different content. Count-only
    // snapshots hold the failure forever; the content print must release.
    const bot = deepBot()
    const ctx = deepCtx()
    assert.equal(await runStep(bot, ctx), 'failed:unreachable')
    resources.forget(ctx, 50, 60, 0)
    resources.noteSpots(ctx, [{ x: 60, y: 60, z: 0, name: 'oak_log' }], 3000)
    assert.equal(resources.count(ctx), 1)
    ctx.stepStatus = 'running' // decide re-picked after relocation
    forage(bot, ctx, null, {})
    assert.ok(ctx.forage && ctx.forage.target, 'fresh step started, final released')
    assert.equal(ctx.forage.target.pos.x, 60)
    assert.equal(ctx.stepStatus, 'running')
  })

  it('a skipped cell loses to the next one: replan takes another point', () => {
    const bot = deepBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = deepCtx()
    resources.noteSpots(ctx, [{ x: 8, y: 64, z: 0, name: 'coal_ore' }], 1001)
    ctx.forageSkip = new Set(['50,60,0'])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.name, 'coal_ore')
  })
})

describe('forage successful hunt (idkcraft-9go)', () => {
  it('hunts a batch of 8 beef and banks the haul', async () => {
    // The food path end to end: find -> walk -> kill -> pickup per animal,
    // re-find onto the next cow, done when the batch fills. Previously only
    // stall-outs of the hunt were tested; kill/pickup never ran.
    const bot = mockBot()
    const ctx = memCtx([])
    let nextId = 7
    const spawned = []
    const spawnCow = (x) => {
      const id = nextId++
      spawned.push(id)
      const position = Object.assign(pos(x, 64, 0), { offset: (dx, dy, dz) => pos(x + dx, 64 + dy, dz) })
      bot.entities = { [id]: { id, name: 'cow', height: 1.4, position, isValid: true } }
      return id
    }
    spawnCow(10)
    let n = 0
    for (; n < 300 && !ctx.stepStatus.startsWith('done') && !ctx.stepStatus.startsWith('failed:'); n++) {
      forage(bot, ctx, null, {})
      await tick()
      const f = ctx.forage
      if (!f || !f.target || f.target.kind !== 'food') continue
      const ent = bot.entities[f.target.id]
      if ((f.phase === 'walk' || f.phase === 'find') && ent) {
        bot.entity.position = pos(ent.position.x - 1, 64, 0) // pathfinder walks into swing range
      } else if (f.phase === 'kill' && ent && bot.calls.attacks.includes(ent.id)) {
        delete bot.entities[ent.id] // the kill lands only after the bot swung at it
        bot.inv.push({ name: 'beef', count: 1 })
      } else if (f.phase === 'pickup' && f.dropPos) {
        bot.entity.position = pos(f.dropPos.x, 64, f.dropPos.z)
      }
      if (f.phase === 'find' && !bot.entities[f.target.id]) spawnCow(10 + n)
    }
    assert.equal(ctx.stepStatus, 'done', `hunt finished after ${n} ticks, status=${ctx.stepStatus}`)
    assert.deepEqual(ctx.haul, { beef: 8 })
    assert.deepEqual(bot.calls.attacks.slice(0, 8), spawned, 'every cow died to a recorded swing')
    assert.ok(bot.chats.some((m) => m.startsWith('foraging: hunting cow')), `announced, got: ${bot.chats.join(' | ')}`)
    assert.ok(bot.calls.goals.includes('GoalNear'))
  })

  it('replans onto a new species when the prey vanishes', () => {
    // Cow despawns, a pig is near: the re-find filters by the old drop, so
    // the hunt replans onto the pig instead of chasing a ghost.
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(10, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // plan the cow
    assert.equal(ctx.forage.target.name, 'cow')
    bot.entities = { 9: { id: 9, name: 'pig', position: pos(12, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // re-find: cow gone, pig drops porkchop, not beef
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.target.name, 'pig')
    assert.equal(ctx.forage.target.drop, 'porkchop')
    assert.equal(ctx.forage.phase, 'find')
  })

  it('vanished prey with empty memory fails no-known', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(10, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // plan the cow
    bot.entities = {}
    forage(bot, ctx, null, {}) // re-find: nothing, replan finds nothing
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.deepEqual(ctx.haul, {})
  })

  it('noPath on the hunt strikes toward unreachable', () => {
    // Like the ore walk, a noPath verdict on the live hunt goal strikes at
    // once; three strikes fail the step with the haul kept empty.
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(40, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // plan + issue the hunt goal
    for (const want of [1, 2]) {
      ctx.lastPathStatus = 'noPath'
      forage(bot, ctx, null, {})
      assert.equal(ctx.stepStatus, 'running')
      assert.equal(ctx.forage.foodStreak, want)
    }
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.deepEqual(ctx.haul, {})
  })

  it('walking displacement resets the hunt stall count', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(40, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // plan + issue the hunt goal
    for (let i = 0; i < 12; i++) {
      bot.entity.position = pos(i + 1, 64, 0) // chasing: real displacement
      forage(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.stalls || 0, 0)
  })
})

describe('forage walk and dig edges (idkcraft-9go)', () => {
  function oreTarget(x, y, z, name, drop) {
    return { kind: 'log', name, pos: { x, y, z }, drop, want: 8 }
  }

  it('third noPath strike fails unreachable at once', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    ctx.forage = {
      phase: 'walk', target: oreTarget(40, 60, 0, 'iron_ore', 'raw_iron'),
      stalls: 0, streak: 2, lastBotPos: { x: 0, y: 64, z: 0 },
      startInv: {}, drops: {}, announced: true,
    }
    ctx.lastGoalKey = 'forage:40,60,0'
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
    assert.deepEqual(ctx.haul, {})
  })

  it('noPath strike replans to the next point', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 40, y: 60, z: 0, name: 'iron_ore' },
      { x: 30, y: 60, z: 0, name: 'coal_ore' },
    ])
    bot.blocks['30,60,0'] = 'coal_ore'
    forage(bot, ctx, null, {}) // plan iron, issue the walk
    assert.equal(ctx.forage.target.name, 'iron_ore')
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx, null, {}) // strike iron, replan onto coal
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.target.name, 'coal_ore')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('40,60,0'))
    assert.equal(resources.count(ctx), 2, 'memory intact, cell skipped not forgotten')
  })

  it('walking displacement resets the ore stall count', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true
    forage(bot, ctx, null, {}) // issue the walk goal
    for (let i = 0; i < 12; i++) {
      bot.entity.position = pos(i + 1, 64, 0)
      forage(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.stalls || 0, 0)
  })

  it('third displacement strike fails unreachable', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true // executor claims motion, body stands still
    ctx.forage = {
      phase: 'walk', target: oreTarget(40, 60, 0, 'iron_ore', 'raw_iron'),
      stalls: 9, streak: 2, lastBotPos: { x: 0, y: 64, z: 0 },
      startInv: {}, drops: {}, announced: true,
    }
    ctx.lastGoalKey = 'forage:40,60,0'
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
  })

  it('dig without bot.dig forgets the cell and replans', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 40, y: 60, z: 0, name: 'iron_ore' },
      { x: 30, y: 60, z: 0, name: 'coal_ore' },
    ])
    delete bot.dig
    ctx.forage = {
      phase: 'dig', target: oreTarget(40, 60, 0, 'iron_ore', 'raw_iron'),
      stalls: 0, streak: 0, lastBotPos: null, startInv: {}, drops: {}, announced: true,
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.forage.target.name, 'coal_ore')
  })

  it('vanished dig block forgets the cell and replans', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 40, y: 60, z: 0, name: 'iron_ore' },
      { x: 30, y: 60, z: 0, name: 'coal_ore' },
    ])
    bot.blocks['30,60,0'] = 'coal_ore' // iron dug out by someone else
    ctx.forage = {
      phase: 'dig', target: oreTarget(40, 60, 0, 'iron_ore', 'raw_iron'),
      stalls: 0, streak: 0, lastBotPos: null, startInv: {}, drops: {}, announced: true,
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(resources.count(ctx), 1)
    assert.equal(ctx.forage.target.name, 'coal_ore')
  })

  it('null target fails no-known without crashing on inventory', () => {
    const bot = mockBot()
    bot.inventory.items = () => { throw new Error('no inventory') }
    const ctx = memCtx([])
    ctx.forage = {
      phase: 'walk', target: null,
      stalls: 0, streak: 0, lastBotPos: null, startInv: {}, drops: { raw_iron: true }, announced: true,
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
  })

  it('unknown phase replans', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    ctx.forage = {
      phase: 'bogus', target: oreTarget(40, 60, 0, 'iron_ore', 'raw_iron'),
      stalls: 0, streak: 0, lastBotPos: null, startInv: {}, drops: {}, announced: true,
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.phase, 'walk')
    assert.equal(ctx.forage.target.name, 'iron_ore')
  })

  it('unloaded block read error keeps the walk', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot._moving = true
    forage(bot, ctx, null, {}) // issue the walk goal
    bot.blockAt = () => { throw new Error('chunk not loaded') }
    for (let i = 0; i < 3; i++) forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.stalls, 3)
  })
})

describe('forage planning edges (idkcraft-9go)', () => {
  it('stone memory never plans (value rank 99)', () => {
    const bot = mockBot()
    const ctx = memCtx([{ x: 1, y: 64, z: 0, name: 'stone' }])
    assert.equal(forage.planForage(bot, ctx), null)
  })

  it('non-string memory name never plans', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([])
    ctx.resources.items.set('1,64,0', { x: 1, y: 64, z: 0, name: 12345 })
    assert.equal(forage.planForage(bot, ctx), null)
  })

  it('no position returns without crashing', () => {
    const bot = mockBot()
    bot.entity = null
    const ctx = memCtx([])
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
  })

  it('plain-object position uses the hypot fallback', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    bot.entity.position = { x: 0, y: 64, z: 0 } // no distanceTo
    const ctx = memCtx([{ x: 5, y: 60, z: 0, name: 'iron_ore' }])
    const p = forage.planForage(bot, ctx)
    assert.equal(p.name, 'iron_ore')
  })

  it('throwing skip set still fails out instead of hanging', () => {
    // skipSet/strikeCell never throw: even a corrupt ctx.forageSkip ends in
    // failed:unreachable via the strike counter, never a wedged step.
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 40, y: 60, z: 0, name: 'iron_ore' }])
    bot.blocks['40,60,0'] = 'iron_ore'
    bot._moving = true
    Object.defineProperty(ctx, 'forageSkip', { get() { throw new Error('corrupt') } })
    for (let i = 0; i < 60 && !ctx.stepStatus.startsWith('failed:'); i++) forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:unreachable')
  })

  it('corrupt memory print releases the final', () => {
    // memPrint never throws: a corrupt items map prints 'none', which
    // differs from the recorded final and releases the step for a retry.
    class EvilMap extends Map { values() { throw new Error('corrupt') } }
    const bot = mockBot()
    const ctx = {
      lastGoalKey: '', stepStatus: 'running',
      forageFinal: { status: 'failed:unreachable', world: { mem: 'x', haul: 0 } },
      resources: { items: new EvilMap() },
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-known')
    assert.equal(ctx.forageFinal.world.mem, 'none')
  })
})

describe('forage food pickup walk (idkcraft-9go)', () => {
  it('far pickup counts stalls, displacement resets, arrival picks up', () => {
    // Kill lands, the bot is pulled away before reaching the drop: the
    // pickup leg walks back, stalled ticks counted, displacement forgiven.
    const bot = mockBot()
    const ctx = memCtx([])
    const attackPos = Object.assign(pos(10, 64, 0), { offset: (dx, dy, dz) => pos(10 + dx, 64 + dy, dz) })
    bot.entities = { 7: { id: 7, name: 'cow', height: 1.4, position: attackPos, isValid: true } }
    forage(bot, ctx, null, {}) // plan the cow
    bot.entity.position = pos(9, 64, 0)
    forage(bot, ctx, null, {}) // into swing range -> kill
    assert.equal(ctx.forage.phase, 'kill')
    forage(bot, ctx, null, {}) // swing tick sets lastPos and attacks
    assert.ok(bot.calls.attacks.includes(7), 'the bot swung before the kill')
    delete bot.entities[7]
    bot.inv.push({ name: 'beef', count: 1 })
    bot.entity.position = pos(0, 64, 0) // dragged away from the drop
    forage(bot, ctx, null, {}) // kill -> pickup
    assert.equal(ctx.forage.phase, 'pickup')
    forage(bot, ctx, null, {}) // issue the walk back
    forage(bot, ctx, null, {})
    forage(bot, ctx, null, {})
    assert.equal(ctx.forage.stalls, 2, 'two still ticks far from the drop')
    bot.entity.position = pos(1, 64, 0)
    forage(bot, ctx, null, {})
    assert.equal(ctx.forage.stalls, 0, 'displacement resets the stall count')
    bot.entity.position = pos(10, 64, 0)
    forage(bot, ctx, null, {})
    assert.equal(ctx.forage.phase, 'find', 'one beef banked, hunting the next')
    assert.equal(ctx.stepStatus, 'running')
  })

  it('unknown food phase replans', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    bot.entities = { 7: { id: 7, name: 'cow', position: pos(10, 64, 0), isValid: true } }
    ctx.forage = {
      phase: 'bogus',
      target: { kind: 'food', name: 'cow', id: 7, pos: null, drop: 'beef', want: 8 },
      stalls: 0, streak: 0, lastBotPos: null, startInv: {}, drops: {}, announced: true,
    }
    forage(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.phase, 'find')
    assert.equal(ctx.forage.target.name, 'cow')
  })
})

describe('forage pickup stall-out (idkcraft-9go)', () => {
  it('ten still ticks far from the drop replan onto live prey', () => {
    // The pickup leg stalls (fence, water): ten still ticks replan the hunt
    // onto another animal instead of waiting at the drop forever.
    const bot = mockBot()
    const ctx = memCtx([])
    const attackPos = Object.assign(pos(10, 64, 0), { offset: (dx, dy, dz) => pos(10 + dx, 64 + dy, dz) })
    bot.entities = { 7: { id: 7, name: 'cow', height: 1.4, position: attackPos, isValid: true } }
    forage(bot, ctx, null, {}) // plan the cow
    bot.entity.position = pos(9, 64, 0)
    forage(bot, ctx, null, {}) // into swing range -> kill
    forage(bot, ctx, null, {}) // swing tick sets lastPos and attacks
    assert.ok(bot.calls.attacks.includes(7), 'the bot swung before the kill')
    delete bot.entities[7]
    bot.inv.push({ name: 'beef', count: 1 })
    bot.entity.position = pos(0, 64, 0) // dragged away from the drop
    bot.entities = { 9: { id: 9, name: 'cow', position: pos(2, 64, 0), isValid: true } }
    forage(bot, ctx, null, {}) // kill -> pickup
    forage(bot, ctx, null, {}) // issue the walk back
    for (let i = 0; i < 10; i++) forage(bot, ctx, null, {}) // stand still, far away
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.forage.phase, 'find', 'stalled pickup replans the hunt')
    assert.equal(ctx.forage.target.id, 9)
    assert.equal(ctx.forage.foodStreak, 1)
  })
})

describe('rw4.12 forage detour', () => {
  const danger = require('../src/danger')
  const CELL = { x: 40, y: 64, z: 0, name: 'oak_log' } // logs: no pickaxe needed
  const PIT = { x: 20, y: 60, z: 0 }
  function detourCtx() {
    // CELL2 outlives CELL's strike so replans survive for assertions.
    const ctx = memCtx([{ ...CELL }, { x: 0, y: 64, z: 50, name: 'oak_log' }])
    danger.mark(ctx, PIT)
    return ctx
  }

  it('a pit on the leg diverts the first goal perpendicular', () => {
    const bot = mockBot()
    const ctx = detourCtx()
    forage(bot, ctx) // plan + walk issue
    assert.equal(bot.calls.setGoal, 1)
    const g = bot.pathfinder.goal
    assert.equal(g.constructor.name, 'GoalNearXZ')
    assert.deepEqual({ x: g.x, z: g.z }, { x: 20, z: 8 })
  })

  it('reaching the waypoint re-issues direct to the cell', () => {
    const bot = mockBot()
    const ctx = detourCtx()
    forage(bot, ctx) // issues the via goal
    bot.entity.position = pos(20, 64, 8) // walked around
    forage(bot, ctx) // arrived: flips + re-issues direct
    assert.equal(bot.calls.setGoal, 2)
    const g = bot.pathfinder.goal
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: 40, y: 64, z: 0 })
  })

  it('noPath on the detour leg falls back direct without a strike', () => {
    const bot = mockBot()
    const ctx = detourCtx()
    forage(bot, ctx) // issues the via goal
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx) // detour dead: flip direct, no strike
    assert.equal(ctx.forage.streak, 0)
    assert.ok(!ctx.forageSkip || ctx.forageSkip.size === 0, 'the cell is not struck')
    forage(bot, ctx) // re-issues direct
    const g = bot.pathfinder.goal
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: 40, y: 64, z: 0 })
    ctx.lastPathStatus = 'noPath'
    forage(bot, ctx) // direct dead too: the cell strikes honestly
    assert.equal(ctx.forage.streak, 1)
    assert.deepEqual(ctx.forage.target.pos, { x: 0, y: 64, z: 50 }, 'replan moves past the struck cell')
  })

  it('a stalled detour leg falls back direct, the cell strikes after', () => {
    const bot = mockBot()
    bot._moving = true // walking but frozen: stall counting runs
    bot.blocks['40,64,0'] = 'oak_log' // loaded-correct: no ghost rule
    const ctx = detourCtx()
    for (let i = 0; i < 12; i++) forage(bot, ctx) // via leg stalls out
    const g = bot.pathfinder.goal
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: 40, y: 64, z: 0 }, 'falls back direct')
    assert.equal(ctx.forage.streak, 0, 'no strike for the detour')
    for (let i = 0; i < 12 && !(ctx.forageSkip && ctx.forageSkip.has('40,64,0')); i++) forage(bot, ctx) // direct leg stalls too
    assert.equal(ctx.forage.streak, 1, 'the cell strikes honestly')
    assert.ok(ctx.forageSkip.has('40,64,0'))
  })

  it('diagonal arrival fires from the pathfinder near cell', () => {
    // Fractional raw waypoint (15.2,21.4): the XZ goal aims at (15,21)
    // and arrival reads xz-only from its centre. The bot stops two
    // cells past — inside range, outside the old 3D check.
    const bot = mockBot()
    const ctx = memCtx([{ x: 40, y: 64, z: 30, name: 'oak_log' }, { x: 0, y: 64, z: 60, name: 'oak_log' }])
    danger.mark(ctx, { x: 20, y: 60, z: 15 }) // mid-segment on the diagonal
    bot.entity.position = pos(0, 64, 0)
    forage(bot, ctx) // issues the via goal
    const g0 = bot.pathfinder.goal
    assert.equal(g0.constructor.name, 'GoalNearXZ')
    assert.deepEqual({ x: g0.x, z: g0.z }, { x: 15, z: 21 })
    bot.entity.position = pos(13.2, 64, 21.5) // end cell (13,21), far edge
    forage(bot, ctx) // arrived: flips + re-issues direct
    const g1 = bot.pathfinder.goal
    assert.equal(g1.constructor.name, 'GoalNear')
    assert.deepEqual({ x: g1.x, y: g1.y, z: g1.z }, { x: 40, y: 64, z: 30 })
  })

  it('stationary on the via leg never settles to dig a far cell', () => {
    const bot = mockBot() // frozen mid-leg, executor idle
    bot.blocks['40,64,0'] = 'oak_log' // target reads diggable from afar
    const ctx = detourCtx()
    for (let i = 0; i < 12; i++) forage(bot, ctx)
    assert.equal(ctx.forage.phase, 'walk', 'no thin-air dig')
    assert.equal(bot.calls.digs, 0)
    const g = bot.pathfinder.goal
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, { x: 40, y: 64, z: 0 }, 'stalls fall back direct')
  })
})
