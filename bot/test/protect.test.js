'use strict'

// Owner-build protection (idkcraft-drq): one shared canBreak guard used by
// every direct dig site. Breakable = natural terrain (dirt/stone/sand/ores,
// leaves, tree logs) or blocks the bot placed itself this session. Everything
// else (planks, glass, doors, crafted stone, wool, fences, foreign torches
// and containers, bare/stripped logs) is protected. Default deny.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { canBreak, denyReason, logDeny, trackPlaced, CLEAR_FLORA } = require('../src/behaviours/util')

function blk(name, x = 0, y = 64, z = 0) {
  return { name, position: new Vec3(x, y, z) }
}

// Fake world: map "x,y,z" -> name, everything else air.
function worldBot(cells) {
  return {
    blockAt: (p) => {
      const n = cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || 'air'
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
  }
}

describe('canBreak guard (idkcraft-drq)', () => {
  it('allows natural terrain, denies crafted builds', () => {
    const bot = worldBot(new Map())
    const ctx = {}
    const natural = ['dirt', 'grass_block', 'stone', 'granite', 'deepslate', 'sand', 'gravel',
      'clay', 'coal_ore', 'deepslate_iron_ore', 'oak_leaves', 'ancient_debris', 'snow', 'air',
      'ice', 'netherrack', 'end_stone']
    for (const n of natural) assert.equal(canBreak(bot, blk(n), ctx), true, n)
    const crafted = ['oak_planks', 'glass', 'oak_door', 'white_wool', 'oak_fence',
      'torch', 'wall_torch', 'chest', 'furnace', 'crafting_table', 'bed',
      'cobblestone', 'stone_bricks', 'stripped_oak_log', 'oak_wood',
      'blue_ice', 'obsidian', 'crying_obsidian']
    for (const n of crafted) assert.equal(canBreak(bot, blk(n), ctx), false, n)
  })

  it('allows tree logs (column + leaves), denies bare and stripped logs', () => {
    // oak trunk (0,64..66,0) with leaves at (1,66,0)
    const cells = new Map([
      ['0,64,0', 'oak_log'], ['0,65,0', 'oak_log'], ['0,66,0', 'oak_log'],
      ['1,66,0', 'oak_leaves'],
      ['5,64,0', 'oak_log'], // lone placed log, no column, no leaves
      ['6,64,0', 'stripped_oak_log'], ['6,65,0', 'stripped_oak_log'],
    ])
    const bot = worldBot(cells)
    const ctx = {}
    assert.equal(canBreak(bot, blk('oak_log', 0, 64, 0), ctx), true, 'trunk base')
    assert.equal(canBreak(bot, blk('oak_log', 5, 64, 0), ctx), false, 'lone log')
    assert.equal(canBreak(bot, blk('stripped_oak_log', 6, 64, 0), ctx), false, 'stripped')
  })

  it('allows nether stems with wart nearby, denies them bare', () => {
    const cells = new Map([
      ['0,64,0', 'crimson_stem'], ['0,65,0', 'crimson_stem'],
      ['1,65,0', 'nether_wart_block'],
      ['5,64,0', 'crimson_stem'], ['5,65,0', 'crimson_stem'],
    ])
    const bot = worldBot(cells)
    const ctx = {}
    assert.equal(canBreak(bot, blk('crimson_stem', 0, 64, 0), ctx), true, 'wart forest stem')
    assert.equal(canBreak(bot, blk('crimson_stem', 5, 64, 0), ctx), false, 'bare stem')
  })

  it('allows bot-placed blocks via ctx.placedByBot', () => {
    const bot = worldBot(new Map())
    const ctx = { placedByBot: new Set(['7,64,0']) }
    assert.equal(canBreak(bot, blk('dirt', 7, 64, 0), ctx), true, 'own scaffold dirt')
    assert.equal(canBreak(bot, blk('oak_planks', 7, 64, 0), ctx), true, 'own house planks')
    assert.equal(canBreak(bot, blk('dirt', 8, 64, 0), { placedByBot: new Set() }), true, 'natural dirt anyway')
  })

  it('fails closed on nulls and missing world view', () => {
    assert.equal(canBreak(null, blk('dirt'), {}), true, 'dirt needs no world view')
    assert.equal(canBreak(null, null, {}), false)
    assert.equal(canBreak(null, {}, {}), false)
    assert.equal(canBreak(worldBot(new Map()), blk('oak_log', 0, 64, 0), {}), false, 'log without world proof')
    assert.equal(canBreak(null, blk('oak_log', 0, 64, 0), {}), false, 'log without bot')
  })

  it('trackPlaced records successful placements, ignores failures', async () => {
    const calls = []
    const bot = {
      placeBlock: async (ref, face) => { calls.push([ref, face]) },
    }
    const ctx = {}
    trackPlaced(bot, ctx)
    trackPlaced(bot, ctx) // idempotent: single wrap
    await bot.placeBlock({ position: new Vec3(1, 2, 3) }, new Vec3(0, 1, 0))
    assert.equal(calls.length, 1, 'original ran once')
    assert.ok(ctx.placedByBot.has('1,3,3'), 'ref+face recorded')
    const failing = { placeBlock: async () => { throw new Error('refused') } }
    const ctx2 = {}
    trackPlaced(failing, ctx2)
    await assert.rejects(failing.placeBlock({ position: new Vec3(0, 0, 0) }, new Vec3(0, 1, 0)))
    assert.equal(ctx2.placedByBot ? ctx2.placedByBot.size : 0, 0, 'failed place not recorded')
  })

  it('logDeny prints the protected line without throwing', () => {
    assert.doesNotThrow(() => logDeny(blk('oak_planks', 1, 2, 3), 'protected'))
    assert.doesNotThrow(() => logDeny(null, 'protected'))
    assert.doesNotThrow(() => logDeny({}, null))
  })

  it('logDeny prints the selftrap line for below-feet denials', () => {
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(String(l))
    try {
      logDeny(blk('dirt', -10, 56, 124), 'below-feet')
    } finally { console.log = orig }
    assert.ok(lines.some((l) => l.startsWith('selftrap: dirt at -10 56 124')), lines.join('\n'))
  })

  it('CLEAR_FLORA is exported for stockpile', () => {
    assert.ok(CLEAR_FLORA.has('short_grass'))
    assert.ok(!CLEAR_FLORA.has('torch'), 'foreign torches stay protected')
  })

  it('stockpile flora is always breakable (subset invariant)', () => {
    // stockpile digs only CLEAR_FLORA, so its guard wire is vacuous by
    // construction — this pins the subset so a future protected addition
    // (e.g. torch) fails loudly instead of silently bricking stockpile.
    const bot = worldBot(new Map())
    for (const n of CLEAR_FLORA) {
      assert.equal(canBreak(bot, blk(n), {}), true, n)
    }
  })
})

describe('dig-site wiring (idkcraft-drq)', () => {
  it('gather skips a placed log instead of chopping the house', () => {
    const gather = require('../src/behaviours/gather')
    let digs = 0
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: () => ({ name: 'oak_log', position: new Vec3(2, 64, 0) }),
      dig: async () => { digs++ },
    }
    const ctx = {
      lastGoalKey: '', stepStatus: 'running',
      gather: { phase: 'dig', pos: { x: 2, y: 64, z: 0 }, block: { name: 'oak_log', position: new Vec3(2, 64, 0) }, skip: new Set() },
    }
    gather(bot, ctx, null, {})
    assert.equal(digs, 0, 'placed log never dug')
    assert.ok(ctx.gather.skip.has('2,64,0'), 'target skipped')
    assert.equal(ctx.gather.pos, null, 'search restarts')
  })

  it('forage forgets a bare-log target instead of stripping it', () => {
    const forage = require('../src/behaviours/forage')
    let digs = 0
    const bot = {
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      inventory: { items: () => [] },
      blockAt: (p) => ({ name: 'oak_log', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }),
      dig: async () => { digs++ },
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
    }
    const ctx = {
      lastGoalKey: '', stepStatus: 'running', resources: { items: new Map() },
      forage: { phase: 'dig', target: { kind: 'block', pos: { x: 2, y: 64, z: 0 }, name: 'oak_log' } },
    }
    forage(bot, ctx, null, {})
    assert.equal(digs, 0, 'bare log never dug')
    assert.equal(ctx.forage, null, 'replan finds nothing: episode finishes without digging')
  })

  it('equip fails no-dirt instead of mining a cobble hut', () => {
    const equip = require('../src/behaviours/equip')
    let digs = 0
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(String(l))
    try {
      const bot = {
        entity: { position: new Vec3(0, 64, 0), onGround: true },
        inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }] },
        findBlocks: () => [new Vec3(1, 64, 0), new Vec3(0, 64, 1)],
        blockAt: (p) => {
          const y = Math.floor(p.y)
          const n = y <= 64 ? 'cobblestone' : 'air'
          return { name: n, position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
        },
        dig: async () => { digs++ },
        pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
      }
      const ctx = { lastGoalKey: '', stepStatus: 'running', equip: {} }
      equip(bot, ctx)
      assert.equal(digs, 0, 'cobble walls never mined')
      assert.ok(String(ctx.stepStatus).startsWith('failed:equip-blocks'), `fails loudly, got ${ctx.stepStatus}`)
      assert.ok(lines.some((l) => l.startsWith('protected: cobblestone')), lines.join('\n'))
    } finally { console.log = orig }
  })

  it('bring re-searches when its dig target is protected', async () => {
    const bring = require('../src/behaviours/bring')
    let digs = 0
    const bot = {
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      blockAt: () => ({ name: 'oak_planks', position: new Vec3(2, 64, 0) }),
      dig: async () => { digs++ },
      chat: () => {},
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
    }
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: { x: 2, y: 64, z: 0 }, block: 'oak_planks' },
    }
    await bring(bot, ctx, null, {})
    assert.equal(digs, 0, 'planks never dug')
    assert.equal(ctx.bring.phase, 'find', 'denied mid-order: search again')
    assert.equal(ctx.bring.pos, null, 'denied target dropped')
  })
})

describe('recover dig guards (idkcraft-drq)', () => {
  const recover = require('../src/behaviours/recover')

  function recBot(cells) {
    const digs = []
    const bot = {
      digs,
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
      blockAt: (p) => {
        const n = cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || 'air'
        return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
      },
      canDigBlock: () => true,
      setControlState: () => {},
      dig: async (b) => { digs.push(b.name) },
    }
    return bot
  }

  function recCtx(action, st) {
    return {
      recovery: { action, source: 'test', model: null, status: 'starting', st: st || null, attempts: 0, fails: 0, repeats: 0, last: null, calledPlayer: false, endEpisode: false, lastDy: null, placeError: false },
      stuck: { goal: { x: 5, y: 64, z: 0 } },
    }
  }

  it('dig_through refuses a plank wall with failed:protected', () => {
    const bot = recBot(new Map([['1,64,0', 'oak_planks']]))
    const ctx = recCtx('dig_through')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:protected')
    assert.deepEqual(bot.digs, [], 'wall never touched')
  })

  it('dig_up refuses a plank ceiling with failed:protected', () => {
    const bot = recBot(new Map([['0,65,0', 'oak_planks']]))
    const ctx = recCtx('dig_up')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:protected')
    assert.deepEqual(bot.digs, [], 'ceiling never touched')
  })

  it('dig_step refuses protected above and cap cells', () => {
    const st = () => ({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 64 })
    const botA = recBot(new Map([['1,65,0', 'suspicious_sand']]))
    const ctxA = recCtx('dig_step', st())
    recover.run(botA, ctxA)
    assert.equal(ctxA.recovery.status, 'failed:protected')
    assert.deepEqual(botA.digs, [], 'above never dug')
    const botC = recBot(new Map([['1,66,0', 'suspicious_gravel']]))
    const ctxC = recCtx('dig_step', st())
    recover.run(botC, ctxC)
    assert.equal(ctxC.recovery.status, 'failed:protected')
    assert.deepEqual(botC.digs, [], 'cap never dug')
  })

  it('dig_through still digs natural dirt (guard passes through)', async () => {
    const bot = recBot(new Map([['1,64,0', 'dirt']]))
    const ctx = recCtx('dig_through')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dig starts')
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(bot.digs, ['dirt'], 'natural dirt dug')
  })
})

describe('self-trap rule (idkcraft-drq)', () => {
  function feetBot(cells, x = 0, y = 64, z = 0) {
    const bot = worldBot(cells)
    bot.entity = { position: new Vec3(x, y, z), onGround: true }
    return bot
  }
  // A 1-deep pit: the bot stands at y=63 with dirt walls at the feet plane.
  function pitBot() {
    const cells = new Map([
      ['1,63,0', 'dirt'], ['-1,63,0', 'dirt'], ['0,63,1', 'dirt'], ['0,63,-1', 'dirt'],
      ['1,62,0', 'dirt'], ['0,62,1', 'dirt'], ['-1,62,0', 'dirt'],
    ])
    return feetBot(cells, 0, 63.2, 0)
  }

  it('denyReason: open ground allows below-feet, a pit denies it', () => {
    const open = feetBot(new Map())
    const pit = pitBot()
    assert.equal(denyReason(open, blk('dirt', 0, 64, 0), {}), null, 'feet plane allowed')
    assert.equal(denyReason(open, blk('dirt', 0, 65, 0), {}), null, 'above allowed')
    assert.equal(denyReason(open, blk('dirt', 1, 63, 0), {}), null, 'open ground: single below-feet dig allowed')
    assert.equal(denyReason(pit, blk('dirt', 1, 62, 0), {}), 'below-feet', 'in a pit: deepening denied')
    assert.equal(denyReason(pit, blk('stone', 0, 60, 1), {}), 'below-feet', 'deep below denied')
    assert.equal(denyReason(pit, blk('dirt', 1, 63, 0), {}), null, 'pit wall at feet still diggable')
    assert.equal(denyReason(open, blk('oak_planks', 0, 64, 0), {}), 'protected', 'crafted at feet still protected')
    assert.equal(denyReason(pit, blk('oak_planks', 1, 62, 0), {}), 'below-feet', 'trap rule fires before type rules')
    assert.equal(denyReason(pit, blk('air', 0, 60, 0), {}), null, 'air always allowed')
    assert.equal(denyReason(pit, null, {}), 'protected', 'null denied')
    assert.equal(denyReason(pit, {}, {}), 'protected', 'nameless denied')
    // Own placed block below the feet plane in a pit is still a trap:
    // ownership does not buy a stairway down.
    const own = { placedByBot: new Set(['1,62,0']) }
    assert.equal(denyReason(pit, blk('dirt', 1, 62, 0), own), 'below-feet', 'own block below feet in pit denied')
    assert.equal(denyReason(pit, blk('oak_planks', 1, 63, 0), { placedByBot: new Set(['1,63,0']) }), null, 'own block at feet allowed')
    // Without a known position the rule cannot prove a trap and stays
    // out; the protection rules still fail closed.
    const ctx = {}
    assert.equal(denyReason(worldBot(new Map()), blk('dirt', 0, 0, 0), ctx), null, 'no position: dirt allowed')
    assert.equal(denyReason(worldBot(new Map()), blk('oak_planks', 0, 0, 0), ctx), 'protected', 'no position: planks denied')
    assert.equal(denyReason(null, blk('dirt', 0, 0, 0), ctx), null, 'null bot: dirt allowed')
    // Unknown neighbours never count as walls: the rule needs proof.
    const blind = feetBot(new Map())
    blind.blockAt = () => null
    assert.equal(denyReason(blind, blk('dirt', 0, 63, 0), ctx), null, 'blind bot: unproven, allowed')
    // Flora and water at the feet plane are not walls.
    const meadow = feetBot(new Map([['1,64,0', 'short_grass'], ['-1,64,0', 'water']]))
    assert.equal(denyReason(meadow, blk('dirt', 0, 63, 0), ctx), null, 'flora/water neighbours: open')
  })

  it('canBreak stays the boolean face of denyReason', () => {
    assert.equal(canBreak(pitBot(), blk('dirt', 1, 62, 0), {}), false)
    assert.equal(canBreak(feetBot(new Map()), blk('dirt', 1, 63, 0), {}), true)
    assert.equal(canBreak(feetBot(new Map()), blk('oak_planks', 0, 64, 0), {}), false)
  })

  it('equip refuses to deepen its own pit instead of digging down', () => {
    const equip = require('../src/behaviours/equip')
    let digs = 0
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(String(l))
    try {
      const bot = {
        // Standing in a 1-deep pit: the owner-session loop, one tick
        // before the old code dug level 2.
        entity: { position: new Vec3(0, 63.2, 0), onGround: true },
        inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }] },
        findBlocks: () => [new Vec3(1, 62, 0), new Vec3(0, 62, 1), new Vec3(-1, 62, 0)],
        blockAt: (p) => {
          const y = Math.floor(p.y)
          const n = y <= 63 ? 'dirt' : 'air'
          return { name: n, position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
        },
        dig: async () => { digs++ },
        pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
      }
      const ctx = { lastGoalKey: '', stepStatus: 'running', equip: {} }
      equip(bot, ctx)
      assert.equal(digs, 0, 'pit floor never dug')
      assert.ok(String(ctx.stepStatus).startsWith('failed:equip-blocks'), `fails loudly, got ${ctx.stepStatus}`)
      assert.ok(lines.some((l) => l.startsWith('selftrap:')), lines.join('\n'))
    } finally { console.log = orig }
  })

  it('forage forgets a below-feet ore in a pit instead of digging down', () => {
    const forage = require('../src/behaviours/forage')
    let digs = 0
    const bot = {
      entity: { position: new Vec3(0, 63, 0), onGround: true },
      inventory: { items: () => [] },
      blockAt: (p) => {
        const fx = Math.floor(p.x) === 0 && Math.floor(p.z) === 0
        const n = (Math.floor(p.y) === 63 && !fx) ? 'dirt' : 'coal_ore'
        return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
      },
      dig: async () => { digs++ },
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
    }
    const ctx = {
      lastGoalKey: '', stepStatus: 'running', resources: { items: new Map() },
      forage: { phase: 'dig', target: { kind: 'block', pos: { x: 2, y: 62, z: 0 }, name: 'coal_ore' } },
    }
    forage(bot, ctx, null, {})
    assert.equal(digs, 0, 'below-feet ore in a pit never dug')
  })
})
