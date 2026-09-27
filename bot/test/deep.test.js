'use strict'

// Deep leg (idkcraft-ipn.2): staircase shaft to the diamond band, scan,
// tunnel to remembered diamonds, climb back. Safety rules R-lava/R-stand/
// R-up/R-drop/R-floor/R-tier, each proven here + in test/deep-assay.js.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const deep = require('../src/behaviours/deep')
const forage = require('../src/behaviours/forage')
const resources = require('../src/resources')
const danger = require('../src/danger')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset: (dx, dy, dz) => pos(x + dx, y + dy, z + dz),
  }
}

// Mock world: default solid stone; bot.blocks overrides per cell (air,
// lava, ores, bedrock). dig() opens the cell and drops diamonds.
function mockBot() {
  const inv = []
  const calls = { setGoal: 0, goals: [], digs: [], chats: [] }
  const bot = {
    calls, chats: calls.chats, inv,
    username: 'IdkBot', players: {}, entities: {},
    spawnPoint: pos(0, 64, 0),
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    blocks: {},
    registry: { blocksByName: { diamond_ore: { id: 1 }, stone: { id: 2 }, dirt: { id: 3 } }, itemsByName: {} },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => bot._moving,
      bestHarvestTool: () => null,
    },
    inventory: { items: () => inv },
    findBlocks: () => [],
    controls: {},
    lookAt: (v) => { calls.looks = calls.looks || []; calls.looks.push(`${v.x},${v.y},${v.z}`); return Promise.resolve() },
    setControlState: (k, v) => { bot.controls[k] = v },
    clearControlStates: () => { bot.controls = {} },
    blockAt: (p) => {
      const k = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
      const n = bot.blocks[k] || 'stone'
      return { name: n, position: pos(Math.round(p.x), Math.round(p.y), Math.round(p.z)) }
    },
    canDigBlock: () => true,
    dig: async (block) => {
      const p = block.position
      calls.digs.push(`${p.x},${p.y},${p.z}`)
      bot.blocks[`${p.x},${p.y},${p.z}`] = 'air'
      const before = bot.blockAt(p)
      void before
    },
    chat: (m) => { calls.chats.push(String(m)) },
  }
  return bot
}

function memCtx(cells) {
  const ctx = { lastGoalKey: '', stepStatus: 'running' }
  resources.noteSpots(ctx, cells, 1000)
  return ctx
}

const tick = () => new Promise((r) => setImmediate(r))

// Auto-walk driver: teleport the body NEAR each fresh walk goal (0.5 back
// toward the previous goal), so full legs run without a pathfinder. Exact
// teleports would skip arrival detection: the tunnel recomputes `next`
// from the current head, and arrival only fires while the key is stable.
function autoWalk(bot) {
  const g = bot.pathfinder.goal
  if (!g || typeof g.x !== 'number') return
  const from = bot._lastAuto || bot.entity.position
  const dx = g.x - from.x
  const dy = g.y - from.y
  const dz = g.z - from.z
  const d = Math.hypot(dx, dy, dz) || 1
  const back = Math.min(0.5, d)
  bot.entity.position = pos(g.x - (dx / d) * back, g.y - (dy / d) * back, g.z - (dz / d) * back)
  bot._lastAuto = { x: g.x, y: g.y, z: g.z }
}

async function runLeg(bot, ctx, maxTicks = 600) {
  for (let i = 0; i < maxTicks && !ctx.stepStatus.startsWith('done') && !ctx.stepStatus.startsWith('failed:'); i++) {
    deep(bot, ctx, null, {})
    autoWalk(bot)
    await tick()
  }
  return ctx.stepStatus
}

describe('deep geometry', () => {
  it('stairCells: step n stands one down-forward, digs feet/head/down', () => {
    const shaft = { x: 10, z: 20, topY: 64, dx: 1, dz: 0 }
    const s0 = deep.stairCells(shaft, 0)
    assert.deepEqual(s0.stand, { x: 11, y: 63, z: 20 })
    assert.deepEqual(s0.digs, [{ x: 11, y: 64, z: 20 }, { x: 11, y: 65, z: 20 }, { x: 11, y: 63, z: 20 }])
    const s1 = deep.stairCells(shaft, 1)
    assert.deepEqual(s1.stand, { x: 12, y: 62, z: 20 })
  })

  it('R-stand: the block underfoot is never a dig cell (steps 0..9)', () => {
    const shaft = { x: 10, z: 20, topY: 64, dx: 1, dz: 0 }
    for (let n = 0; n < 10; n++) {
      const st = deep.stairCells(shaft, n)
      const under = `${shaft.x + n * shaft.dx},${shaft.topY - n - 1},${shaft.z + n * shaft.dz}`
      for (const c of st.digs) assert.notEqual(`${c.x},${c.y},${c.z}`, under, `step ${n}`)
    }
  })

  it('tunnelNext: greedy approach, same-Y preferred', () => {
    const head = { x: 0, y: -45, z: 0 }
    const n = deep.tunnelNext(head, { x: 5, y: -45, z: 0 }, { x: -1, y: -45, z: 0 })
    assert.deepEqual(n, { x: 1, y: -45, z: 0 })
  })

  it('R-up: tunnel never steps up, even chasing a cell above', () => {
    const head = { x: 0, y: -45, z: 0 }
    const n = deep.tunnelNext(head, { x: 0, y: -40, z: 0 }, null)
    assert.ok(n.y <= -45, `went up to ${n.y}`)
  })

  it('tunnelNext never revisits seen cells (U-cave loop breaker)', () => {
    const head = { x: 0, y: -45, z: 0 }
    const target = { x: 5, y: -45, z: 0 }
    // +X (the greedy pick) is visited: must go around, not back.
    const n = deep.tunnelNext(head, target, null, new Set(['1,-45,0']))
    assert.notDeepEqual(n, { x: 1, y: -45, z: 0 })
    assert.ok(n.y <= -45, 'still never up')
  })

  it('tunnelNext respects cameFrom and the dig floor', () => {
    const head = { x: 0, y: -55, z: 0 }
    const n = deep.tunnelNext(head, { x: 0, y: -60, z: 5 }, { x: 0, y: -55, z: -1 })
    assert.ok(n.y > deep.FLOOR_Y, `breached floor at ${n.y}`)
    assert.notDeepEqual(n, { x: 0, y: -55, z: -1 })
  })
})

describe('deep safety reads', () => {
  it('lavaNear fires on the target and on neighbours, null-safe', () => {
    const bot = mockBot()
    assert.equal(deep.lavaNear(bot, 0, 60, 0), false)
    bot.blocks['1,60,0'] = 'lava'
    assert.equal(deep.lavaNear(bot, 0, 60, 0), true)
    bot.blocks['1,60,0'] = 'stone'
    bot.blocks['0,60,0'] = 'flowing_lava'
    assert.equal(deep.lavaNear(bot, 0, 60, 0), true)
    const blind = mockBot()
    blind.blockAt = () => null
    assert.equal(deep.lavaNear(blind, 0, 60, 0), false)
    const bot2 = mockBot()
    bot2.blocks['2,60,0'] = 'lava' // manhattan 2: flow margin fires
    assert.equal(deep.lavaNear(bot2, 0, 60, 0), true)
    const bot3 = mockBot()
    bot3.blocks['3,60,0'] = 'lava' // manhattan 3: clear
    assert.equal(deep.lavaNear(bot3, 0, 60, 0), false)
  })

  it('dropBelow counts air to solid, null reads as solid', () => {
    const bot = mockBot()
    assert.equal(deep.dropBelow(bot, 0, 64, 0), 0)
    bot.blocks['0,63,0'] = 'air'
    bot.blocks['0,62,0'] = 'air'
    bot.blocks['0,61,0'] = 'air'
    assert.equal(deep.dropBelow(bot, 0, 64, 0), 3)
    const blind = mockBot()
    blind.blockAt = () => null
    assert.equal(deep.dropBelow(blind, 0, 64, 0), 0)
  })

  it('pickSite takes solid ground, skips danger and stations, null on void', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    // Surface at y=64 around the anchor: air above, stone below.
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) {
        bot.blocks[`${x},64,${z}`] = 'air'
        bot.blocks[`${x},65,${z}`] = 'air'
      }
    }
    const s = deep.pickSite(bot, ctx, { x: 0, z: 0 })
    assert.ok(s && typeof s.topY === 'number')
    danger.mark(ctx, { x: s.x, y: s.topY, z: s.z })
    const s2 = deep.pickSite(bot, ctx, { x: 0, z: 0 })
    assert.ok(s2 && (s2.x !== s.x || s2.z !== s.z), 'marked mouth skipped')
    const voidBot = mockBot()
    voidBot.blockAt = () => ({ name: 'air' })
    assert.equal(deep.pickSite(voidBot, memCtx([]), { x: 0, z: 0 }), null)
  })

  it('pickDir walks +X when clear, routes around lava, null when boxed', () => {
    const bot = mockBot()
    const mouth = { x: 0, z: -3, topY: 64 }
    assert.equal(deep.pickDir(bot, mouth).dx, 1)
    bot.blocks['2,64,-3'] = 'lava' // step-1 feet: +X refused, others clear
    const d2 = deep.pickDir(bot, mouth)
    assert.ok(d2 && (d2.dx !== 1 || d2.dz !== 0), 'lava +X refused')
    for (const [x, z] of [[2, -3], [-2, -3], [0, -1], [0, -5]]) bot.blocks[`${x},64,${z}`] = 'lava'
    assert.equal(deep.pickDir(bot, mouth), null)
  })

  it('pickDir refuses a tube with lava deep down the line', () => {
    const bot = mockBot()
    const mouth = { x: 0, z: -3, topY: -30 }
    assert.equal(deep.pickDir(bot, mouth).dx, 1)
    bot.blocks['5,-34,-3'] = 'lava' // step-4 +X neighbours
    const d2 = deep.pickDir(bot, mouth)
    assert.ok(d2 && (d2.dx !== 1 || d2.dz !== 0), 'deep lava refuses +X')
  })
})

describe('bestDiamondCell', () => {
  it('nearest diamond wins, emerald excluded, struck skipped', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    const ctx = memCtx([
      { x: 90, y: -45, z: 0, name: 'diamond_ore' },
      { x: 3, y: -45, z: 0, name: 'emerald_ore' },
      { x: 5, y: -45, z: 0, name: 'deepslate_diamond_ore' },
    ])
    const bp = pos(0, -45, 0)
    assert.equal(forage.bestDiamondCell(bot, ctx, bp).x, 5)
    ctx.forageSkip = new Set(['5,-45,0'])
    assert.equal(forage.bestDiamondCell(bot, ctx, bp).x, 90)
  })

  it('grounded cells sort before ungrounded (drops stay put)', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.blocks['3,-46,0'] = 'air' // near cell hangs over a void
    const ctx = memCtx([
      { x: 3, y: -45, z: 0, name: 'diamond_ore' },
      { x: 9, y: -45, z: 0, name: 'diamond_ore' },
    ])
    const bp = pos(0, -45, 0)
    assert.equal(forage.bestDiamondCell(bot, ctx, bp).x, 9)
  })

  it('stone pickaxe gates diamonds out (R-tier)', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    const ctx = memCtx([{ x: 5, y: -45, z: 0, name: 'diamond_ore' }])
    assert.equal(forage.bestDiamondCell(bot, ctx, pos(0, -45, 0)), null)
  })
})

describe('deep behaviour aborts', () => {
  function shaftCtx() {
    // Bot already deep: mouth behind, one step from the band.
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null,
    }
    return { bot, ctx }
  }

  it('R-lava: lava in the shaft fails + marks + chats', () => {
    const { bot, ctx } = shaftCtx()
    bot.blocks['2,-42,0'] = 'lava' // manhattan 1 off the step-0 feet dig, 3 off the body
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava')
    const spots = (ctx.danger && ctx.danger.spots) || []
    assert.ok(spots.some((s) => s.x === 1 && s.z === 0), 'lava cell marked')
    assert.ok(spots.some((s) => s.x === 0 && s.z === 0), 'mouth marked (retry steers away)')
    assert.ok(bot.chats.some((m) => m.includes('lava')), `chats: ${bot.chats}`)
  })

  it('lava at the body fails fast even with clean dig cells', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.blocks['0,-43,1'] = 'lava' // beside the body, off the dig line
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava')
    assert.ok(bot.chats.some((m) => m.includes('lava closing in')))
  })

  it('water in the shaft fails water + marks cell and mouth', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.blocks['1,-42,0'] = 'water' // step-0 feet dig
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:water')
    const spotsW = (ctx.danger && ctx.danger.spots) || []
    assert.ok(spotsW.some((s) => s.x === 1 && s.z === 0), 'hazard marked')
    assert.ok(spotsW.some((s) => s.x === 0 && s.z === 0), 'mouth marked (retry steers away)')
    assert.ok(bot.chats.some((m) => m.includes('water in the shaft')))
  })

  it('aquifer next to the tube fails water before the breach', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.blocks['2,-42,0'] = 'water' // manhattan 1 from the feet dig
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:water')
  })

  it('loose rock above the dig fails loose + marks mouth', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.blocks['1,-41,0'] = 'gravel' // above the step-0 feet dig
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:loose')
    const spots = (ctx.danger && ctx.danger.spots) || []
    assert.ok(spots.some((s) => s.x === 0 && s.z === 0), 'mouth marked')
    assert.ok(bot.chats.some((m) => m.includes('loose rock')))
  })

  it('tube scan refuses gravel columns', () => {
    const bot = mockBot()
    const mouth = { x: 0, z: -3, topY: -30 }
    assert.equal(deep.pickDir(bot, mouth).dx, 1)
    bot.blocks['3,-32,-3'] = 'gravel' // above the step-2 +X feet dig
    const d2 = deep.pickDir(bot, mouth)
    assert.ok(d2 && (d2.dx !== 1 || d2.dz !== 0), 'gravel tube refuses +X')
  })

  it('R-drop: void under the next step fails + marks', () => {
    const { bot, ctx } = shaftCtx()
    // Open the step, void below the landing.
    bot.blocks['1,-43,0'] = 'air'
    bot.blocks['1,-42,0'] = 'air'
    bot.blocks['1,-41,0'] = 'air'
    bot.blocks['1,-44,0'] = 'air'
    bot.blocks['1,-45,0'] = 'air'
    bot.blocks['1,-46,0'] = 'air'
    bot.blocks['1,-47,0'] = 'air'
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:drop')
    assert.ok(danger.near(ctx, { x: 1, z: 0 }), 'void marked')
  })

  it('unbreakable shaft rock fails + marks', () => {
    const { bot, ctx } = shaftCtx()
    bot.blocks['1,-42,0'] = 'bedrock'
    bot.canDigBlock = (b) => b.name !== 'bedrock'
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:bedrock')
    assert.ok(danger.near(ctx, { x: 1, z: 0 }), 'bedrock marked')
  })

  it('R-tier: stone pick at depth fails need-iron-pick', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'stone_pickaxe', count: 1 })
    bot.entity.position = pos(0, -45, 0)
    const ctx = memCtx([{ x: 5, y: -45, z: 0, name: 'diamond_ore' }])
    ctx.deep = {
      phase: 'plan', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [], target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null,
      startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:need-iron-pick')
    assert.ok(bot.chats.some((m) => m.includes('iron pickaxe')))
  })

  it('no diamond remembered: fail empty-handed, return with gains', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(0, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'plan', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [], target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null,
      startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:no-diamond')
    // ...but gains on hand return instead of failing.
    const ctx2 = memCtx([])
    ctx2.deep = {
      phase: 'plan', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [], target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null,
      startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null,
    }
    bot.inv.push({ name: 'diamond', count: 1 })
    deep(bot, ctx2, null, {})
    assert.equal(ctx2.deep.phase, 'return')
  })
})

describe('deep tunnel caps', () => {
  it('step cap strikes a cell the tunnel cannot reach in budget', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(0, -45, 0)
    // Open hall: walks are free, the cell is 40 out — the step cap (24),
    // not the dig cap, must end it.
    for (let x = -2; x <= 42; x++) {
      bot.blocks[`${x},-45,0`] = 'air'
      bot.blocks[`${x},-44,0`] = 'air'
    }
    const ctx = memCtx([{ x: 40, y: -45, z: 0, name: 'diamond_ore' }])
    bot.blocks['40,-45,0'] = 'diamond_ore'
    // Seed the tunnel directly (plan covered elsewhere).
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 40, y: -45, z: 0, name: 'diamond_ore' }, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, tunnelDigs: 0,
      tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']), cameFrom: null,
    }
    for (let i = 0; i < 300 && ctx.stepStatus === 'running' && ctx.deep && ctx.deep.phase === 'tunnel'; i++) {
      deep(bot, ctx, null, {})
      autoWalk(bot)
      await tick()
    }
    assert.ok(!ctx.deep || ctx.deep.phase !== 'tunnel', 'tunnel terminates')
    assert.ok(!ctx.forageSkip || ctx.forageSkip.has('40,-45,0'), 'far cell struck')
  })
})

  it('tunnel opens feet+head (two-high tube stays walkable)', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(0, -45, 0)
    const ctx = memCtx([{ x: 2, y: -45, z: 0, name: 'diamond_ore' }])
    bot.blocks['2,-45,0'] = 'diamond_ore'
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 2, y: -45, z: 0, name: 'diamond_ore' }, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']), cameFrom: null,
    }
    // dist 2 <= DIG_REACH: settles straight to digcell (no tunnel walk).
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'digcell')
    // Force one real tunnel step: target 6 out, solid rock between.
    ctx.deep.phase = 'tunnel'
    ctx.deep.target = { x: 6, y: -45, z: 0, name: 'diamond_ore' }
    bot.blocks['6,-45,0'] = 'diamond_ore'
    for (let i = 0; i < 40 && ctx.deep && ctx.deep.phase === 'tunnel' && !bot.calls.digs.includes('1,-44,0'); i++) {
      deep(bot, ctx, null, {})
      autoWalk(bot)
      await tick()
    }
    assert.ok(bot.calls.digs.includes('1,-45,0'), `feet dug: ${bot.calls.digs}`)
    assert.ok(bot.calls.digs.includes('1,-44,0'), `head dug: ${bot.calls.digs}`)
  })

describe('deep displacement', () => {
  function midShaft(y) {
    const bot = mockBot()
    bot.entity.position = pos(0, y, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    return { bot, ctx }
  }

  it('body 100 out fails died honestly (death, not bedrock)', () => {
    const { bot, ctx } = midShaft(70) // respawned at the surface
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:died')
    assert.ok(bot.chats.some((m) => m.includes('died down there')))
  })

  it('body 20 out walks back to the shaft and resumes', () => {
    const { bot, ctx } = midShaft(-22) // preempted nearby
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.lastGoalKey, 'deep-back')
    assert.equal(ctx.deep.phase, 'descend')
  })
})

describe('deep dig watchdog', () => {
  it('6 refused cycles on one cell fail dig-stuck + mark', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.dig = async () => {} // server refuses: the cell stays solid
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    for (let i = 0; i < 10 && ctx.stepStatus === 'running'; i++) {
      deep(bot, ctx, null, {})
      ctx.digInFlight = false // each cycle completes, cell unchanged
    }
    assert.equal(ctx.stepStatus, 'failed:dig-stuck')
    assert.ok(danger.near(ctx, { x: 1, z: 0 }), 'stuck cell marked')
  })

  it('a dig that never settles fails after 120s wall clock', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
      digSince: Date.now() - 121000,
    }
    ctx.digInFlight = true
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:dig-stuck')
  })
})

describe('deep pickup collection', () => {
  function pickupCtx() {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(5, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'pickup', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [], target: { x: 5, y: -45, z: 0, name: 'diamond_ore' }, dug: 0, stalls: 0,
      lastPos: { x: 5, y: -45, z: 0 }, issuedKey: 'deep-pickup:5,-45,0', startDrops: { diamond: 0 },
      cameFrom: null, pickupSince: null,
    }
    ctx.lastGoalKey = 'deep-pickup:5,-45,0'
    return { bot, ctx }
  }

  it('waits for the drop after arrival, moves on when it lands', () => {
    const { bot, ctx } = pickupCtx()
    deep(bot, ctx, null, {}) // arrived (dist 0), count flat: waits
    assert.equal(ctx.deep.phase, 'pickup')
    assert.ok(ctx.deep.pickupSince, 'wait started')
    bot.inv.push({ name: 'diamond', count: 1 }) // magnet delivers
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan')
    assert.equal(ctx.deep.dug, 1)
  })

  it('gives up on a lost drop after the wait', () => {
    const { bot, ctx } = pickupCtx()
    ctx.deep.pickupSince = Date.now() - 5000 // wait already spent
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan')
    assert.equal(ctx.deep.dug, 0)
  })
})

describe('deep behaviour legs', () => {
  it('return drives level crumbs via the pathfinder and pops them', () => {
    const bot = mockBot()
    bot.entity.position = pos(10.7, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 0, y: 64, z: 0 }, { x: 9, y: -45, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.7, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {}) // level crumb: flat mode, no manual keys
    assert.equal(ctx.lastGoalKey, 'deep-back:2')
    assert.deepEqual(bot.controls, {})
    bot.entity.position = pos(9.2, -45, 0) // walked in: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
  })

  it('return climbs 1-up steps with the manual wedge-jump', () => {
    const bot = mockBot()
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 0, y: 64, z: 0 }, { x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {}) // crumb above: manual mode, riser solid -> wedge
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
    assert.equal(bot.controls.forward, true) // walking at the riser first
    assert.ok(ctx.deep.retWedge)
    deep(bot, ctx, null, {}) // wedged: jump straight, forward released
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.jump, true)
    bot.entity.position = pos(11.5, -43.8, 0) // rose 1.2 out of pop range: clear exit
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.retWedge, null)
    assert.equal(ctx.lastGoalKey, 'deep-back:2') // now level: flat mode walks in
    bot.entity.position = pos(9.3, -44, 0) // mounted: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
  })

  it('return wedge fires on 3 still ticks when the riser test misses', () => {
    const bot = mockBot()
    bot.blocks['9,-45,0'] = 'air' // riser test blind
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.retWedge, null)
    deep(bot, ctx, null, {})
    deep(bot, ctx, null, {})
    assert.ok(ctx.deep.retWedge) // frozen body detected without the riser
  })

  it('return walks far above-crumbs via the pathfinder, climbs when adjacent', () => {
    const bot = mockBot()
    bot.entity.position = pos(14, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 14, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {}) // 5 out through the tunnel: pathfinder, not manual
    assert.equal(ctx.lastGoalKey, 'deep-back:1')
    assert.equal(ctx.deep.retWedge, null)
    bot.entity.position = pos(10.2, -45, 0) // walked under the step: manual
    deep(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
  })

  it('return never pops a step from the floor below', () => {
    const bot = mockBot()
    bot.entity.position = pos(9.5, -45, 0) // within radius, a full step down
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.5, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1) // height gate holds the pop
    bot.entity.position = pos(9.3, -44, 0) // climbed: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
  })

  it('a wedged statue fails lost-shaft after the budget', () => {
    const bot = mockBot()
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    for (let i = 0; i < 20 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
  })

  it('lost shaft fails honestly and raises the stuck fact', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [], target: null, dug: 0, stalls: 0,
      lastPos: { x: 0, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
  })

  it('full leg: site, descend, tunnel, 3 diamonds, return, haul banked', async () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(0, -43, 0)
    // Mouth air at the r=3 pick (a=0: x=0, z=-3), stone floor under it;
    // the scan window sits near the body (y -41..-30).
    for (let y = -42; y <= -28; y++) bot.blocks[`0,${y},-3`] = 'air'
    bot.blocks['0,-43,-3'] = 'stone'
    // Diamond row east of the shaft bottom (y -45).
    for (const x of [5, 8, 11]) bot.blocks[`${x},-45,-3`] = 'diamond_ore'
    const cells = [5, 8, 11].map((x) => ({ x, y: -45, z: -3, name: 'diamond_ore' }))
    const ctx = memCtx(cells)
    const origDig = bot.dig
    bot.dig = async (block) => {
      await origDig(block)
      if (block.name && block.name.includes('diamond')) bot.inv.push({ name: 'diamond', count: 1 })
    }
    const status = await runLeg(bot, ctx, 800)
    assert.equal(status, 'done')
    assert.deepEqual(ctx.haul, { diamond: 3 })
    assert.ok(bot.chats.some((m) => m.includes('digging down for diamonds')))
    assert.ok(bot.chats.some((m) => m.includes('got diamond 3/3')))
  }, { timeout: 30000 })
})
