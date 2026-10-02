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

  it('tree crown: low logs of tall trunks allowed, cabin pillars refused', () => {
    const birch = new Map()
    for (let y = 64; y <= 70; y++) birch.set(`0,${y},0`, 'birch_log')
    birch.set('1,70,0', 'birch_leaves')
    birch.set('0,71,0', 'birch_leaves')
    assert.equal(canBreak(worldBot(birch), blk('birch_log', 0, 64, 0), {}), true, 'low log, crown at top')
    assert.equal(canBreak(worldBot(birch), blk('birch_log', 0, 68, 0), {}), true, 'mid log, crown at top')
    const cabin = new Map()
    for (let y = 64; y <= 67; y++) cabin.set(`5,${y},5`, 'oak_log')
    cabin.set('5,68,5', 'oak_planks') // roof directly above the pillar top
    cabin.set('6,65,5', 'oak_leaves') // hedge beside the middle: not a crown
    cabin.set('6,66,5', 'oak_leaves')
    assert.equal(canBreak(worldBot(cabin), blk('oak_log', 5, 65, 5), {}), false, 'pillar with a roof vetoed')
    const bare = new Map()
    for (let y = 64; y <= 67; y++) bare.set(`9,${y},9`, 'oak_log')
    assert.equal(canBreak(worldBot(bare), blk('oak_log', 9, 65, 9), {}), false, 'leafless pillar refused')
  })

  it('tree remnant: the last log under its own crown stays breakable', () => {
    const remnant = new Map([['0,64,0', 'oak_log'], ['0,65,0', 'oak_leaves'], ['1,65,0', 'oak_leaves']])
    assert.equal(canBreak(worldBot(remnant), blk('oak_log', 0, 64, 0), {}), true, 'chopped trunk remnant')
    const firewood = new Map([['3,64,3', 'oak_log'], ['3,63,3', 'dirt'], ['4,64,3', 'oak_leaves']])
    assert.equal(canBreak(worldBot(firewood), blk('oak_log', 3, 64, 3), {}), false, 'lone log on dirt refused')
    const decor = new Map([['7,64,7', 'oak_log'], ['7,63,7', 'oak_planks'], ['7,65,7', 'oak_leaves'], ['8,65,7', 'oak_leaves']])
    assert.equal(canBreak(worldBot(decor), blk('oak_log', 7, 64, 7), {}), false, 'log on planks under leaves is decor')
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
      logDeny(blk('stone', -11, 58, 124), 'gravity')
    } finally { console.log = orig }
    assert.ok(lines.some((l) => l === 'selftrap: refused dig dirt at -10 56 124 (below-feet)'), lines.join('\n'))
    assert.ok(lines.some((l) => l === 'selftrap: refused dig stone at -11 58 124 (gravity)'), lines.join('\n'))
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

  it('bring skips a protected target and takes the next candidate (no re-find loop)', async () => {
    const bring = require('../src/behaviours/bring')
    let digs = 0
    const spots = [new Vec3(2, 64, 0), new Vec3(20, 64, 0)]
    const names = {
      '2,64,0': 'oak_log', // bare cabin log: protected
      '20,64,0': 'oak_log', '20,65,0': 'oak_log', '21,65,0': 'oak_leaves', // a tree
    }
    const bot = {
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      findBlocks: (opts) => {
        const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
        return spots.filter((q) => want.has(17) && names[`${q.x},${q.y},${q.z}`] === 'oak_log')
      },
      blockAt: (p) => {
        const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        return n ? { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
      },
      dig: async () => { digs++ },
      chat: () => {},
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
    }
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', name: 'oak_log', want: 2, have: 0, pos: { x: 2, y: 64, z: 0 }, block: 'oak_log' },
    }
    await bring(bot, ctx, null, {}) // dig: denied, skipped
    assert.equal(digs, 0, 'cabin log never dug')
    assert.ok(ctx.bring.skip.has('2,64,0'), 'denied target skipped')
    assert.equal(ctx.bring.phase, 'find', 'search continues')
    await bring(bot, ctx, null, {}) // find: the skipped cabin log loses, the tree wins
    assert.ok(ctx.bring, 'order alive')
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.z], [20, 0], 'next candidate picked')
  })

  it('bring skips protected candidates at find time, never walks to the build', async () => {
    const bring = require('../src/behaviours/bring')
    const spots = [new Vec3(2, 64, 0), new Vec3(20, 64, 0)]
    const names = {
      '2,64,0': 'oak_log',
      '20,64,0': 'oak_log', '20,65,0': 'oak_log', '21,65,0': 'oak_leaves',
    }
    const goals = []
    const bot = {
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      findBlocks: (opts) => {
        const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
        return spots.filter((q) => want.has(17) && names[`${q.x},${q.y},${q.z}`] === 'oak_log')
      },
      blockAt: (p) => {
        const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        return n ? { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
      },
      dig: async () => { throw new Error('must not dig') },
      chat: () => {},
      pathfinder: { goal: null, setGoal: (g) => goals.push(g), isMoving: () => false, stop() {} },
    }
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'find', kind: 'block', name: 'oak_log', want: 2, have: 0 },
    }
    await bring(bot, ctx, null, {})
    assert.deepEqual([ctx.bring.pos.x, ctx.bring.pos.z], [20, 0], 'tree committed without visiting the cabin')
    assert.ok(ctx.bring.skip.has('2,64,0'), 'cabin log skipped at find time')
    assert.equal(goals.length, 0, 'no walk goal issued yet (walk phase next tick)')
  })

  it('bring re-searches a trap denial 3 times, then refuses', async () => {
    const bring = require('../src/behaviours/bring')
    let digs = 0
    const lines = []
    const bot = {
      // 4-wall pit: the adjacent below-feet dirt is a trap denial.
      entity: { position: new Vec3(0, 63.2, 0), onGround: true },
      blockAt: (p) => {
        const y = Math.floor(p.y)
        // atl.20: air under the target — a real drop, so the strike path
        // still denies (solid below now digs instead of striking).
        const n = (y === 63 || y === 62) ? 'dirt' : 'air'
        return { name: n, position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
      },
      dig: async () => { digs++ },
      chat: (l) => lines.push(String(l)),
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
    }
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: { x: 1, y: 62, z: 0 }, block: 'dirt' },
    }
    for (let i = 0; i < 3; i++) {
      await bring(bot, ctx, null, {})
      assert.equal(ctx.bring.phase, 'find', `strike ${i + 1}: search again`)
      ctx.bring.phase = 'dig' // find re-picks the same nearest block
      ctx.bring.pos = { x: 1, y: 62, z: 0 }
    }
    await bring(bot, ctx, null, {})
    assert.equal(digs, 0, 'trap dirt never dug')
    assert.equal(ctx.bring, null, '4th denial refuses loudly')
    assert.ok(lines.some((l) => l.includes('could not reach dirt safely')), lines.join('\n'))
  })

  it('bring trap-refusal names the partial haul it keeps', async () => {
    const bring = require('../src/behaviours/bring')
    const lines = []
    const bot = {
      entity: { position: new Vec3(0, 63.2, 0), onGround: true },
      blockAt: (p) => {
        const y = Math.floor(p.y)
        // atl.20: air under the target — a real drop (solid below now digs).
        const n = (y === 63 || y === 62) ? 'dirt' : 'air'
        return { name: n, position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
      },
      dig: async () => {},
      chat: (l) => lines.push(String(l)),
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false, stop() {} },
    }
    const ctx = {
      lastGoalKey: '',
      bring: { phase: 'dig', kind: 'block', pos: { x: 1, y: 62, z: 0 }, block: 'dirt', drop: 'dirt', have: 5, denyStrikes: 3 },
    }
    await bring(bot, ctx, null, {})
    assert.equal(ctx.bring, null, 'order ends')
    assert.ok(lines.some((l) => l.includes('only got 5 dirt') && l.includes('could not reach dirt safely')), lines.join('\n'))
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

  it('dig_up refuses a stone ceiling under sand with failed:gravity', () => {
    // Owner session 2026-09-28: head1 already open, head2 stone with a
    // sand stack above — the old code dug it and suffocated 2s later.
    const bot = recBot(new Map([['0,66,0', 'stone'], ['0,67,0', 'sand']]))
    const ctx = recCtx('dig_up')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:gravity')
    assert.deepEqual(bot.digs, [], 'support never dug')
  })

  it('dig_up refuses sand at head2 under more sand (support, not rescue)', () => {
    const bot = recBot(new Map([['0,66,0', 'sand'], ['0,67,0', 'sand']]))
    const ctx = recCtx('dig_up')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:gravity')
    assert.deepEqual(bot.digs, [], 'sand support never dug')
  })

  it('dig_up still clears a sand ceiling directly (self-rescue allowed)', async () => {
    const bot = recBot(new Map([['0,65,0', 'sand'], ['0,66,0', 'sand']]))
    const ctx = recCtx('dig_up')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dig starts')
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(bot.digs, ['sand'], 'sand itself is dug')
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

  it('denyReason: below-feet needs 3+ walls and a near target', () => {
    const oneWall = feetBot(new Map([['1,64,0', 'dirt']]))
    assert.equal(denyReason(oneWall, blk('dirt', 0, 63, 0), {}), null, 'one wall (trunk, bump): jumpable, allowed')
    const twoWall = feetBot(new Map([['1,64,0', 'dirt'], ['0,64,1', 'dirt']]))
    assert.equal(denyReason(twoWall, blk('dirt', 0, 63, 0), {}), null, 'corner: escapable sideways, allowed')
    const threeWall = feetBot(new Map([['1,64,0', 'dirt'], ['-1,64,0', 'dirt'], ['0,64,1', 'dirt']]))
    assert.equal(denyReason(threeWall, blk('dirt', 0, 63, 0), {}), 'below-feet', 'alcove: denied')
    assert.equal(denyReason(threeWall, blk('dirt', 5, 60, -3), {}), null, 'far target: not your pit, allowed')
    // The flat-restock shape: walled stance, surface dirt far away.
    assert.equal(denyReason(pitBot(), blk('dirt', 20, 62, 0), {}), null, 'restock candidate far from the pit allowed')
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

  it('forage strikes (keeps memory of) a below-feet ore in a pit instead of digging down', () => {
    const forage = require('../src/behaviours/forage')
    let digs = 0
    const bot = {
      entity: { position: new Vec3(1, 63, 0), onGround: true },
      inventory: { items: () => [] },
      blockAt: (p) => {
        const fx = Math.floor(p.x) === 0 && Math.floor(p.z) === 0
        const n = (Math.floor(p.y) === 63 && !fx) ? 'dirt' : 'coal_ore'
        return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
      },
      dig: async () => { digs++ },
      pathfinder: { goal: null, setGoal() {}, isMoving: () => false },
    }
    const items = new Map([['2,62,0', { x: 2, y: 62, z: 0, name: 'coal_ore' }]])
    const ctx = {
      lastGoalKey: '', stepStatus: 'running', resources: { items },
      forage: { phase: 'dig', target: { kind: 'block', pos: { x: 2, y: 62, z: 0 }, name: 'coal_ore' } },
    }
    forage(bot, ctx, null, {})
    assert.equal(digs, 0, 'below-feet ore in a pit never dug')
    assert.equal(items.size, 1, 'transient stance: memory kept, not forgotten')
    assert.ok(ctx.forageSkip && ctx.forageSkip.has('2,62,0'), 'cell skipped')
  })

  it('denyReason: digging a support under sand/gravel in own column denies gravity', () => {
    // The fatal dig: feet y=64, head2 stone at y=66, sand at y=67.
    const under = (top) => feetBot(new Map([['0,66,0', 'stone'], ['0,67,0', top]]))
    assert.equal(denyReason(under('sand'), blk('stone', 0, 66, 0), {}), 'gravity', 'sand above')
    assert.equal(denyReason(under('red_sand'), blk('stone', 0, 66, 0), {}), 'gravity', 'red sand above')
    assert.equal(denyReason(under('gravel'), blk('stone', 0, 66, 0), {}), 'gravity', 'gravel above')
    assert.equal(denyReason(under('white_concrete_powder'), blk('stone', 0, 66, 0), {}), 'gravity', 'powder above')
    assert.equal(denyReason(under('sandstone'), blk('stone', 0, 66, 0), {}), null, 'solid cap: no fall')
    assert.equal(denyReason(under('air'), blk('stone', 0, 66, 0), {}), null, 'open sky: no fall')
    // Digging the gravity block itself is the escape only in body cells
    // (feet, head): higher up it is itself a support for the stack above.
    const buried = feetBot(new Map([['0,64,0', 'sand'], ['0,65,0', 'sand'], ['0,66,0', 'sand'], ['0,67,0', 'sand']]))
    assert.equal(denyReason(buried, blk('sand', 0, 64, 0), {}), null, 'sand at feet allowed (self-rescue)')
    assert.equal(denyReason(buried, blk('sand', 0, 65, 0), {}), null, 'sand at head allowed (self-rescue)')
    assert.equal(denyReason(buried, blk('sand', 0, 66, 0), {}), 'gravity', 'sand at head2 under sand denied')
    assert.equal(denyReason(under('gravel'), blk('gravel', 0, 66, 0), {}), 'gravity', 'gravel at head2 under gravel denied')
    const single = feetBot(new Map([['0,66,0', 'sand'], ['0,67,0', 'stone']]))
    assert.equal(denyReason(single, blk('sand', 0, 66, 0), {}), null, 'single sand layer, nothing above to fall')
    // Adjacent column: the stack falls beside the bot, not onto it.
    const side = feetBot(new Map([['1,66,0', 'stone'], ['1,67,0', 'sand']]))
    assert.equal(denyReason(side, blk('stone', 1, 66, 0), {}), null, 'neighbour column allowed')
    // Below-feet targets stay with the below-feet rule (open: allowed).
    assert.equal(denyReason(side, blk('stone', 0, 63, 0), {}), null, 'floor dig on open ground allowed')
    // No position, or an unknown block above: unproven, stays out.
    assert.equal(denyReason(worldBot(new Map()), blk('stone', 0, 66, 0), {}), null, 'no position: allowed')
    const blind = feetBot(new Map())
    blind.blockAt = () => null
    assert.equal(denyReason(blind, blk('stone', 0, 66, 0), {}), null, 'blind bot: unproven, allowed')
    assert.equal(canBreak(under('sand'), blk('stone', 0, 66, 0), {}), false, 'canBreak mirrors gravity')
  })
})

describe('house footprint (idkcraft-e5ba)', () => {
  const home = { v: 2, site: { x: 97, y: 71, z: -357 }, interior: { min: { x: 98, y: 71, z: -356 }, max: { x: 102, y: 72, z: -353 } } }
  const bot = worldBot(new Map())
  const d = (n, x, y, z) => denyReason(bot, blk(n, x, y, z), { home })
  it('protects floor under inside cell, door support and door-front', () => {
    assert.equal(d('grass_block', 100, 70, -356), 'protected')
    assert.equal(d('grass_block', 100, 70, -357), 'protected')
    assert.equal(d('dirt', 100, 70, -358), 'protected')
    assert.equal(d('dirt', 103, 70, -352), 'protected')
    assert.equal(d('dirt', 100, 69, -356), 'protected') // under the floor
  })
  it('placedByBot: floor patch stays protected, air-box dirt is diggable', () => {
    const c = { home, placedByBot: new Set(['100,70,-356', '100,71,-356']) }
    assert.equal(denyReason(bot, blk('dirt', 100, 70, -356), c), 'protected')
    assert.equal(denyReason(bot, blk('dirt', 100, 71, -356), c), null)
  })
  it('leaves distant ground, flora and snow alone', () => {
    assert.equal(d('grass_block', 100, 70, -349), null)
    assert.equal(d('dirt', 106, 70, -355), null)
    assert.equal(d('grass_block', 100, 70, -366), null)
    assert.equal(d('grass_block', 100, 73, -359), null, 'yard ground above the doorstep level')
    assert.equal(d('snow', 100, 71, -356), null)
    assert.equal(d('short_grass', 100, 71, -356), null)
  })
  it('apron (idkcraft-0mlh): porch, door approach and yard ring are protected', () => {
    assert.equal(d('grass_block', 100, 70, -358), 'protected') // under outsidePos
    assert.equal(d('grass_block', 98, 69, -360), 'protected') // two cells in front of it
    assert.equal(d('dirt', 101, 68, -359), 'protected') // pit bottom on the porch
    assert.equal(d('dirt', 105, 69, -355), 'protected') // east yard ring
    assert.equal(d('dirt', 95, 72, -350), 'protected') // doorstep level + 1
    assert.equal(d('stone', 100, 66, -361), null) // past the door-side apron
    const c = { home, placedByBot: new Set(['104,71,-355']) }
    assert.equal(denyReason(bot, blk('dirt', 104, 71, -355), c), null, 'our own patch on the yard stays diggable')
  })
  it('apron pit escape: a body in an old porch pit may stair out, never dig deeper (revmux 01 core-1)', () => {
    const pit = worldBot(new Map())
    pit.entity = { position: new Vec3(101.5, 69, -357.5), onGround: true } // feet cell 101 69 -358
    const p = (n, x, y, z) => denyReason(pit, blk(n, x, y, z), { home, recovery: {} })
    assert.equal(p('dirt', 102, 70, -358), null, 'step above the pit wall')
    assert.equal(p('dirt', 100, 69, -359), null, 'pit wall at feet height')
    assert.equal(p('dirt', 102, 68, -358), 'protected', 'never deeper')
    assert.equal(p('dirt', 104, 70, -358), 'protected', 'not beside the body')
    assert.equal(p('dirt', 101, 70, -357), 'protected', 'house wall ring is never an escape')
    assert.equal(denyReason(pit, blk('dirt', 102, 70, -358), { home }), 'protected', 'not recovering (equip in the pit): no exemption')
    const top = worldBot(new Map())
    top.entity = { position: new Vec3(101.5, 71, -357.5), onGround: true } // on the porch
    assert.equal(denyReason(top, blk('dirt', 102, 71, -358), { home, recovery: {} }), 'protected', 'standing on the porch: no exemption')
  })
  it('no home -> unchanged', () => assert.equal(denyReason(bot, blk('dirt', 100, 70, -356), {}), null))
})

describe('castle ground (idkcraft-g0z.14)', () => {
  const blueprint = require('../src/castle')
  const site = { x: 100, y: 64, z: 200 }
  const castle = { site, rot: 0, blueprintVersion: 2 }
  const bot = worldBot(new Map())
  const d = (n, x, y, z) => denyReason(bot, blk(n, x, y, z), { castle })
  const plan = blueprint.absPlan(site, 0, 2)
  const wall = plan.cells.find((c) => c.kind === 'stone' && c.dy === 0)
  const moat = plan.cells.find((c) => c.kind === 'dig' && c.dy === -1)
  it('natural ground under the site is protected, deep too', () => {
    assert.equal(d('stone', wall.x, site.y - 1, wall.z), 'protected')
    assert.equal(d('dirt', site.x + 15, site.y - 1, site.z + 13), 'protected') // hall floor
    assert.equal(d('deepslate', wall.x, site.y - 20, wall.z), 'protected')
  })
  it('moat dig cells, ground off the box, at site level and non-natural stay as before', () => {
    assert.equal(d('stone', moat.x, moat.y, moat.z), null)
    assert.equal(d('coal_ore', moat.x, moat.y, moat.z), null)
    assert.equal(d('stone', site.x - 1, site.y - 1, site.z), null)
    assert.equal(d('dirt', site.x + 15, site.y, site.z + 13), null)
    assert.equal(d('coal_ore', wall.x, site.y - 3, wall.z), null)
    assert.equal(d('snow', wall.x, site.y - 1, wall.z), null)
    assert.equal(denyReason(bot, blk('stone', wall.x, site.y - 1, wall.z), {}), null, 'no castle')
  })
})
