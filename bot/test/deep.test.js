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
  it('stairCells: step n stands one down-forward, digs feet/head/headroom/down', () => {
    const shaft = { x: 10, z: 20, topY: 64, dx: 1, dz: 0 }
    const s0 = deep.stairCells(shaft, 0)
    assert.deepEqual(s0.stand, { x: 11, y: 63, z: 20 })
    assert.deepEqual(s0.digs, [{ x: 11, y: 64, z: 20 }, { x: 11, y: 65, z: 20 }, { x: 11, y: 66, z: 20 }, { x: 11, y: 63, z: 20 }])
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

  it('pickDir refuses +X when lava sits at step-2 feet (rules-assay lava must inject mid-drive)', () => {
    // fsg/b20: the assay plants lava at step-2 feet to prove the descend-time
    // guard — but step 2 sits inside the pre-scan window, so pre-planted
    // lava refuses +X at pick time and the scenario direction is never
    // walked. Pin the mechanism: the harness must inject mid-drive, never a
    // tubeClean carve-out — in-window refusal is the safety invariant.
    const bot = mockBot()
    const mouth = { x: 0, z: -3, topY: 64 }
    const feet2 = deep.stairCells({ x: mouth.x, z: mouth.z, topY: mouth.topY, dx: 1, dz: 0 }, 2).digs[0]
    bot.blocks[`${feet2.x},${feet2.y},${feet2.z}`] = 'lava'
    const d = deep.pickDir(bot, mouth)
    assert.ok(d && (d.dx !== 1 || d.dz !== 0), 'step-2 lava must refuse +X')
  })

  it('pickDir starts into dirt past the pre-scan window (b20 K-window)', () => {
    const K = deep.PRESCAN_STEPS
    const bot = mockBot()
    const mouth = { x: 0, z: -3, topY: -30 }
    const shaft = { x: mouth.x, z: mouth.z, topY: mouth.topY, dx: 1, dz: 0 }
    const deepFeet = deep.stairCells(shaft, K + 2).digs[0]
    bot.blocks[`${deepFeet.x},${deepFeet.y},${deepFeet.z}`] = 'lava'
    assert.equal(deep.pickDir(bot, mouth).dx, 1, 'dirt past K must not refuse +X')
    const nearFeet = deep.stairCells(shaft, K - 1).digs[0]
    bot.blocks[`${nearFeet.x},${nearFeet.y},${nearFeet.z}`] = 'lava'
    const d2 = deep.pickDir(bot, mouth)
    assert.ok(d2 && (d2.dx !== 1 || d2.dz !== 0), 'dirt inside K must refuse +X')
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
    // Open the step (feet/head/headroom/down), void below the landing.
    bot.blocks['1,-43,0'] = 'air'
    bot.blocks['1,-42,0'] = 'air'
    bot.blocks['1,-41,0'] = 'air'
    bot.blocks['1,-40,0'] = 'air'
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

  // Mid-shaft descend state: body stands on the step n-1 crumb, working
  // step n. Crumbs include the current stand (lostCheck needs one near).
  function midShaftCtx(n) {
    const bot = mockBot()
    const shaft = { x: 0, z: 0, topY: -30, dx: 1, dz: 0 }
    const prev = n > 0 ? deep.stairCells(shaft, n - 1).stand : { x: 0, y: -30, z: 0 }
    bot.entity.position = pos(prev.x + 0.5, prev.y, prev.z + 0.5)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft, n,
      steps: [{ x: 0, y: -30, z: 0 }, { x: prev.x, y: prev.y, z: prev.z }],
      target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null,
      startDrops: { diamond: 0 }, cameFrom: null,
    }
    return { bot, ctx, shaft }
  }

  it('guard at the window edge (n=K-1) still fails in place', () => {
    const K = deep.PRESCAN_STEPS
    const { bot, ctx, shaft } = midShaftCtx(K - 1)
    const st = deep.stairCells(shaft, K - 1)
    bot.blocks[`${st.digs[0].x},${st.digs[0].y},${st.digs[0].z}`] = 'lava'
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava')
    assert.equal(ctx.deep, null, 'in-window guard fails, never retreats')
  })

  it('beyond-K guard retreats up the crumbs and fails honestly at the mouth', () => {
    const K = deep.PRESCAN_STEPS
    const { bot, ctx, shaft } = midShaftCtx(K)
    const st = deep.stairCells(shaft, K)
    // Lava 2 off the feet dig but 3 off the body: the dig guard (not the
    // body guard) must trip.
    bot.blocks[`${st.digs[0].x + 2},${st.digs[0].y},${st.digs[0].z}`] = 'lava'
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'return', 'beyond-K guard aborts to return')
    assert.equal(ctx.deep.retreatReason, 'lava')
    assert.equal(ctx.deep.steps.length, 2, 'breadcrumbs preserved for the climb')
    assert.equal(ctx.stepStatus, 'running', 'no terminal status mid-retreat')
    const spots = (ctx.danger && ctx.danger.spots) || []
    assert.ok(spots.some((s) => s.x === st.digs[0].x && s.z === 0), 'hazard marked')
    assert.ok(spots.some((s) => s.x === 0 && s.z === 0), 'mouth marked')
    assert.ok(bot.chats.some((m) => m.includes('lava in the shaft')))
    // Arrival at the mouth ends the leg failed:lava, honestly.
    bot.entity.position = pos(0.5, -30, 0.5)
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava')
    assert.equal(ctx.deep, null)
  })

  it('landing battery refuses lava below a pre-open step', () => {
    const { bot, ctx, shaft } = midShaftCtx(1)
    const st = deep.stairCells(shaft, 1)
    for (const c of st.digs) bot.blocks[`${c.x},${c.y},${c.z}`] = 'air'
    bot.blocks[`${st.stand.x},${st.stand.y - 1},${st.stand.z}`] = 'lava' // 3 off the body: battery, not body guard
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava', 'lava floor under open step must refuse')
  })

  it('landing battery refuses water below a pre-open step', () => {
    const { bot, ctx, shaft } = midShaftCtx(1)
    const st = deep.stairCells(shaft, 1)
    for (const c of st.digs) bot.blocks[`${c.x},${c.y},${c.z}`] = 'air'
    bot.blocks[`${st.stand.x},${st.stand.y - 1},${st.stand.z}`] = 'water' // 1-deep puddle over stone
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:water', '1-deep water under open step must refuse')
  })

  it('a dig completing after a retreat does not clobber the return phase', async () => {
    const K = deep.PRESCAN_STEPS
    const { bot, ctx, shaft } = midShaftCtx(K)
    let release = null
    bot.dig = (block) => new Promise((res) => {
      release = () => {
        bot.blocks[`${block.position.x},${block.position.y},${block.position.z}`] = 'air'
        res()
      }
    })
    deep(bot, ctx, null, {}) // tick 1: clean reads, the swing launches
    assert.equal(ctx.digInFlight, true)
    const st = deep.stairCells(shaft, K)
    bot.blocks[`${st.digs[0].x + 2},${st.digs[0].y},${st.digs[0].z}`] = 'lava' // flows in mid-swing
    deep(bot, ctx, null, {}) // tick 2: guard trips -> retreat
    assert.equal(ctx.deep.phase, 'return')
    release()
    await tick()
    await tick()
    assert.equal(ctx.deep.phase, 'return', 'late dig completion must not clobber return')
    assert.equal(ctx.digInFlight, false)
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

  it('tunnel strikes a pre-open next with lava below instead of walking in', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(3.5, -45, 0.5)
    const next = { x: 5, y: -45, z: 0 }
    bot.blocks['5,-45,0'] = 'air'
    bot.blocks['5,-44,0'] = 'air'
    bot.blocks['5,-43,0'] = 'air' // 3-high tube open (ssn-proof: ignored on 2-high)
    bot.blocks['5,-46,0'] = 'lava' // 3 off the head: battery, not body guard
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 3, y: -45, z: 0 }], target: { x: 50, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      tunnelDigs: 0, tunnelSteps: 0, tunnelSeen: new Set(['3,-45,0']), cameFrom: null,
      tunnelGoal: next,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan', 'lava landing strikes the target')
    assert.equal(ctx.deep.target, null)
    const spots = (ctx.danger && ctx.danger.spots) || []
    assert.ok(spots.some((s) => s.x === 5 && s.z === 0), 'refused landing marked')
  })

  it('tunnel drop strikes unmarked (deep voids must not steer surface sites)', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(3.5, -45, 0.5)
    bot.blocks['5,-45,0'] = 'air'
    bot.blocks['5,-44,0'] = 'air'
    bot.blocks['5,-43,0'] = 'air' // 3-high tube open (ssn-proof: ignored on 2-high)
    bot.blocks['5,-46,0'] = 'air'
    bot.blocks['5,-47,0'] = 'air' // 2-void under next, stone at -48
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 3, y: -45, z: 0 }], target: { x: 50, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      tunnelDigs: 0, tunnelSteps: 0, tunnelSeen: new Set(['3,-45,0']), cameFrom: null,
      tunnelGoal: { x: 5, y: -45, z: 0 },
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan', 'void landing strikes the target')
    const spots = (ctx.danger && ctx.danger.spots) || []
    assert.ok(!spots.some((s) => s.x === 5 && s.z === 0), 'drop strike leaves no mark')
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
    // dist 2 <= DIG_REACH over open ground: settles straight to digcell (no tunnel walk).
    for (const k of ['0,-45,0', '0,-44,0', '1,-45,0', '1,-44,0']) bot.blocks[k] = 'air'
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'digcell')
    // Force one real tunnel step: target 6 out, solid rock between.
    delete bot.blocks['1,-45,0']
    delete bot.blocks['1,-44,0']
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

describe('deep pickup chain + flat takeover', () => {
  function chainCtx() {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(5, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'pickup', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 5, y: -45, z: 0 }], target: { x: 10, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: { x: 5, y: -45, z: 0 }, issuedKey: null,
      startDrops: { diamond: 0 }, cameFrom: null, pickupSince: null,
    }
    return { bot, ctx }
  }

  it('pickup chains crumbs while walking, not while static', () => {
    const { bot, ctx } = chainCtx()
    deep(bot, ctx, null, {}) // static on the last crumb: no push
    assert.equal(ctx.deep.steps.length, 1)
    bot.entity.position = pos(7, -45, 0) // 2 out: chain it
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 2)
    assert.deepEqual(ctx.deep.steps[1], { x: 7, y: -45, z: 0 })
    bot.entity.position = pos(7.5, -45, 0) // 0.5 on: hold
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 2)
  })

  function flatCtx(bx) {
    const bot = mockBot()
    for (let x = 9; x <= 16; x++) { bot.blocks[`${x},-45,0`] = 'air'; bot.blocks[`${x},-44,0`] = 'air' }
    bot.entity.position = pos(bx, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 0, y: 64, z: 0 }, { x: 9, y: -45, z: 0 }], target: null, dug: 0, stalls: 4,
      lastPos: { x: bx, y: -45, z: 0 }, issuedKey: 'deep-back:2', startDrops: { diamond: 0 },
      cameFrom: null, retMode: 'flat',
    }
    ctx.lastGoalKey = 'deep-back:2'
    return { bot, ctx }
  }

  it('flat static pokes to resync at 8, keeps the executor (no manual takeover)', () => {
    const { bot, ctx } = flatCtx(12)
    const writes = []
    bot._client = { write: (name, data) => writes.push([name, data]) }
    ctx.deep.stalls = 7
    deep(bot, ctx, null, {}) // 8th still tick: unfreeze poke + forced replan, stays flat
    assert.ok(writes.length > 0)
    assert.equal(writes[0][0], 'block_dig')
    assert.equal(writes[0][1].status, 0)
    assert.equal(bot.calls.setGoal, 2) // null + goal: the planner replans (a mid-air issue idles)
    assert.ok(bot.calls.goals.includes('GoalBlock')) // exact arrival (a Near-1 arrives 1.7-out, deep disagrees)
    assert.equal(ctx.lastGoalKey, 'deep-back:2')
    assert.equal(ctx.deep.retMode, 'flat')
    assert.deepEqual(bot.controls, {})
  })

  it('flat fails honestly on budget over blocked ground', () => {
    const { bot, ctx } = flatCtx(12)
    for (let x = 9; x <= 12; x++) delete bot.blocks[`${x},-45,0`] // solid again: wall mid-path
    const keys = new Set()
    for (let i = 0; i < 20 && ctx.stepStatus === 'running'; i++) { deep(bot, ctx, null, {}); keys.add(ctx.lastGoalKey) }
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
    assert.ok(keys.has('deep-back:2'))
    assert.ok(!keys.has('deep-return-up'), 'never went manual')
  })
})

describe('deep unfreeze', () => {
  function clientBot() {
    const bot = mockBot()
    bot.entity.position = pos(5.2, -45, 0)
    const writes = []
    bot._client = { write: (name, data) => writes.push([name, data]) }
    bot.writes = writes
    return bot
  }

  it('unfreeze sends START now, CANCEL shortly after (the START must live)', async () => {
    const bot = clientBot()
    assert.equal(deep.unfreeze(bot), true)
    assert.equal(bot.writes.length, 1) // START only: a same-tick CANCEL is ignored server-side
    assert.equal(bot.writes[0][0], 'block_dig')
    assert.equal(bot.writes[0][1].status, 0)
    assert.deepEqual(
      [bot.writes[0][1].location.x, bot.writes[0][1].location.y, bot.writes[0][1].location.z],
      [5, -46, 0]
    )
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(bot.writes.length, 2)
    assert.equal(bot.writes[1][0], 'block_dig')
    assert.equal(bot.writes[1][1].status, 1)
  })

  it('unfreeze CANCEL stands down when a real dig starts meanwhile', async () => {
    const bot = clientBot()
    assert.equal(deep.unfreeze(bot), true)
    bot.targetDigBlock = {} // executor/real dig claimed the channel
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(bot.writes.length, 1) // START only: never steal a live dig's abort
  })

  it('ssn: the ghost START+CANCEL escalation is gone (inch/wedged pins write no dig packets)', () => {
    const bot = mockBot()
    const writes = []
    bot._client = { write: (n, d) => writes.push([n, d]) }
    bot.entity.position = pos(10.05, -45, 0) // contact + solid behind: wedged every tick
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.05, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    for (let i = 0; i < 7 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(writes.length, 0) // the old code ghost-dug on the 3rd wedged tick; now nothing writes before the 8th-tick unfreeze
    assert.equal(deep.ghostDig, undefined)
  })

  it('unfreeze refuses air, live digs, and clientless bots', () => {
    const bot = clientBot()
    bot.blocks['5,-46,0'] = 'air'
    assert.equal(deep.unfreeze(bot), false)
    bot.blocks['5,-46,0'] = 'stone'
    bot.targetDigBlock = {}
    assert.equal(deep.unfreeze(bot), false)
    delete bot.targetDigBlock
    delete bot._client
    assert.equal(deep.unfreeze(bot), false)
    assert.equal(deep.unfreeze(null), false)
  })

  it('manual fires one unfreeze per crumb mid-budget (cooldown, no off-by-one double-fire)', async () => {
    const bot = mockBot()
    const writes = []
    bot._client = { write: (n, d) => writes.push([n, d]) }
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    for (let i = 0; i < 7; i++) deep(bot, ctx, null, {})
    assert.equal(writes.length, 0) // 7 static ticks: not yet
    deep(bot, ctx, null, {}) // 8th: unfreeze STARTs (CANCELs land +150ms)
    assert.equal(writes.length, 5) // underfoot + feet/head + ahead feet/head
    assert.deepEqual(
      writes.map((w) => [w[1].location.x, w[1].location.y, w[1].location.z]),
      [[10, -46, 0], [10, -45, 0], [10, -44, 0], [9, -45, 0], [9, -44, 0]]
    )
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(writes.length, 10)
    for (let i = 0; i < 7 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(writes.length, 10) // once per crumb, then the budget fails
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
  })

  it('jiggle without net progress still unfreezes (stalls reset, progress does not)', () => {
    const bot = mockBot()
    const writes = []
    bot._client = { write: (n) => writes.push(n) }
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    for (let i = 0; i < 12; i++) {
      bot.entity.position = pos(i % 2 === 0 ? 10.2 : 10.3, -45, 0) // displaces every tick, never closes
      deep(bot, ctx, null, {})
    }
    assert.equal(writes.length, 5) // progress drought fired it; displacement alone never would
  })

  it('jiggle-pin re-pokes every 8 progress ticks (cooldown, not a latch)', () => {
    const bot = mockBot()
    const writes = []
    bot._client = { write: (n) => writes.push(n) }
    bot.entity.position = pos(10.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    for (let i = 0; i < 20; i++) {
      bot.entity.position = pos(i % 2 === 0 ? 10.2 : 10.3, -45, 0) // displaces every tick, never closes
      deep(bot, ctx, null, {})
    }
    assert.equal(writes.length, 10) // prog 8 + prog 16; stalls reset every tick, budget never trips
    assert.equal(ctx.stepStatus, 'running')
  })

  it('unfreeze re-arms on a new crumb', () => {
    const bot = mockBot()
    const writes = []
    bot._client = { write: (n) => writes.push(n) }
    bot.entity.position = pos(9.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 8, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.2, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null, unfrozeKey: '9,-44,0',
    }
    for (let i = 0; i < 8; i++) deep(bot, ctx, null, {})
    assert.equal(writes.length, 5) // STARTs fired: a stale key never suppresses a new crumb
  })
})

describe('deep exact arrivals', () => {
  it('descend does not arrive from the previous stand (1.41 theater)', () => {
    const bot = mockBot()
    for (const k of ['2,-29,0', '2,-28,0', '2,-30,0']) bot.blocks[k] = 'air' // step-1 cells open
    bot.entity.position = pos(1.2, -29, 0) // on step 0, 1.41 from the step-1 stand
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -28, z: 0 }, { x: 1, y: -29, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    deep(bot, ctx, null, {}) // static at 1.41: a radius arrival would push without visiting
    assert.equal(ctx.deep.n, 1)
    assert.equal(ctx.deep.steps.length, 2)
    assert.ok(bot.calls.goals.includes('GoalBlock')) // the executor must enter the cell too
    bot.entity.position = pos(2.3, -30, 0) // walked in: floors match the stand
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.n, 2)
    assert.equal(ctx.deep.steps.length, 3)
  })

  it('tunnel does not arrive from the adjacent head (1.0 theater)', () => {
    const bot = mockBot()
    bot.blocks['1,-45,0'] = 'air'
    bot.blocks['1,-44,0'] = 'air' // two-high tube ahead
    bot.entity.position = pos(0.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 17,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 10, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null, tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']),
    }
    deep(bot, ctx, null, {})
    deep(bot, ctx, null, {}) // static 1.0 out: a radius arrival would crumb unvisited rock
    assert.equal(ctx.deep.steps.length, 1)
    assert.ok(bot.calls.goals.includes('GoalBlock'))
    bot.entity.position = pos(1.2, -45, 0) // walked in: floors match
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 2)
  })

  it('tunnel latches its step until arrival (no retarget ping-pong)', () => {
    const bot = mockBot()
    bot.blocks['1,-45,0'] = 'air'
    bot.blocks['1,-44,0'] = 'air'
    bot.entity.position = pos(0.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 17,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 10, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null, tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']),
    }
    deep(bot, ctx, null, {}) // latches (1,-45,0)
    assert.deepEqual(ctx.deep.tunnelGoal, { x: 1, y: -45, z: 0 })
    bot.entity.position = pos(-0.8, -45, 0) // knocked back: head moved, goal must not
    deep(bot, ctx, null, {})
    assert.deepEqual(ctx.deep.tunnelGoal, { x: 1, y: -45, z: 0 })
    assert.equal(ctx.lastGoalKey, 'deep-tunnel:1,-45,0')
  })
})

describe('deep no-dig round', () => {
  function tunnelCtx(target) {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(0.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 17,
      steps: [{ x: 0, y: -45, z: 0 }], target, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null, tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']),
    }
    return { bot, ctx }
  }

  it('rock-between tunnels instead of digging direct', () => {
    const { bot, ctx } = tunnelCtx({ x: 3, y: -45, z: 0, name: 'diamond_ore' })
    bot.blocks['3,-45,0'] = 'diamond_ore'
    deep(bot, ctx, null, {}) // dist 3 <= reach but solid between: tunnel, never direct
    assert.equal(ctx.deep.phase, 'tunnel')
    assert.deepEqual(ctx.deep.tunnelGoal, { x: 1, y: -45, z: 0 })
  })

  it('deep-below tunnels instead of digging direct', () => {
    const { bot, ctx } = tunnelCtx({ x: 3, y: -47, z: 0, name: 'diamond_ore' })
    bot.blocks['3,-47,0'] = 'diamond_ore'
    for (const k of ['0,-45,0', '0,-44,0', '1,-45,0', '1,-44,0', '2,-45,0', '2,-44,0', '3,-45,0', '3,-44,0']) bot.blocks[k] = 'air' // open line: |dy| alone blocks direct
    deep(bot, ctx, null, {}) // dist 3.6 <= reach but 2 down: tunnel (guarded descent)
    assert.equal(ctx.deep.phase, 'tunnel')
    assert.deepEqual(ctx.deep.tunnelGoal, { x: 1, y: -45, z: 0 })
  })

  it('water/loose policy cells strike at once (no doomed tunnel)', () => {
    const wet = tunnelCtx({ x: 3, y: -45, z: 0, name: 'diamond_ore' })
    wet.bot.blocks['3,-45,0'] = 'diamond_ore'
    wet.bot.blocks['3,-45,1'] = 'water'
    deep(wet.bot, wet.ctx, null, {})
    assert.equal(wet.ctx.deep.phase, 'plan')
    assert.equal(wet.ctx.deep.target, null)
    const loose = tunnelCtx({ x: 4, y: -45, z: 0, name: 'diamond_ore' })
    loose.bot.blocks['4,-45,0'] = 'diamond_ore'
    loose.bot.blocks['4,-44,0'] = 'gravel'
    deep(loose.bot, loose.ctx, null, {})
    assert.equal(loose.ctx.deep.phase, 'plan')
    assert.equal(loose.ctx.deep.target, null)
  })

  it('digcell hands off to pickup when the cell is already gone (tunneled ore)', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(5.5, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'digcell', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 17,
      steps: [{ x: 5, y: -45, z: 0 }], target: { x: 5, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null,
    }
    bot.blocks['5,-45,0'] = 'air' // the tunnel broke it first
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'pickup') // magnet sweep, never a bare plan
  })

  it('deep borrows canDig=false every tick (prod + assay shapes)', () => {
    const bot = mockBot()
    const ctx = memCtx([])
    ctx.movements = { canDig: true }
    deep(bot, ctx, null, {})
    assert.equal(ctx.movements.canDig, false)
    delete ctx.movements
    bot.pathfinder.movements = { canDig: true }
    deep(bot, ctx, null, {})
    assert.equal(bot.pathfinder.movements.canDig, false)
  })

  it('descend arrival waits for touchdown (no fall-through theater)', () => {
    const bot = mockBot()
    for (const k of ['2,-29,0', '2,-28,0', '2,-30,0']) bot.blocks[k] = 'air'
    bot.entity.position = pos(2.3, -29.9, 0) // inside the stand cell, mid-fall
    bot.entity.onGround = false
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -28, z: 0 }, { x: 1, y: -29, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.n, 1) // falling through never pushes
    assert.equal(ctx.deep.steps.length, 2)
    bot.entity.onGround = true // landed: arrival
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.n, 2)
    assert.equal(ctx.deep.steps.length, 3)
  })

  it('tunnel arrival waits for touchdown', () => {
    const bot = mockBot()
    bot.blocks['1,-45,0'] = 'air'
    bot.blocks['1,-44,0'] = 'air'
    bot.entity.position = pos(0.2, -45, 0)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -28, dx: 1, dz: 0 }, n: 17,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 10, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null, tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']),
    }
    deep(bot, ctx, null, {}) // latch (1,-45,0)
    bot.entity.position = pos(1.2, -44.9, 0) // inside the latched cell, mid-fall
    bot.entity.onGround = false
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
    bot.entity.onGround = true
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 2)
  })

  it('inCell pops mid-air (unstandable stands cannot wait for touchdown)', () => {
    const bot = mockBot()
    bot.blocks['9,-45,0'] = 'air' // undermined: no floor (the honest setup for a fly-through)
    bot.entity.position = pos(9.3, -43.8, 0) // inside the crumb cell, airborne
    bot.entity.onGround = false
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -43.8, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0) // flew through: counts, never spins
  })

  it('inCell over a standable cell waits for touchdown (no pop-lie)', () => {
    const bot = mockBot()
    bot.entity.position = pos(9.3, -43.8, 0) // inside the crumb cell, airborne — floor solid below
    bot.entity.onGround = false
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -43.8, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1) // overflown standable: NO pop (the next step assumes standing)
    bot.entity.onGround = true // landed in the cell: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
  })

  it('manual pops brake and sneak (arrival momentum must not exit the step)', () => {
    const bot = mockBot()
    bot.entity.position = pos(9.3, -44, 0) // inside the crumb cell, grounded, mid-slide
    bot.entity.velocity = { x: 0.3, y: 0, z: 0 }
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -44, z: 0 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      cameFrom: null, retMode: 'up', retUpKey: '9,-44,0',
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(bot.controls.sneak, true)
  })
})

describe('deep climb air + touchdown', () => {
  function climbCtx() {
    const bot = mockBot()
    for (const k of ['9,-45,0', '9,-44,0', '10,-45,0', '10,-44,0', '11,-45,0', '11,-44,0', '10,-46,0']) bot.blocks[k] = 'air'
    bot.entity.position = pos(10.2, -45, 0.5)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    return { bot, ctx }
  }

  it('airborne hang backs off until ground, apex still coasts', () => {
    const { bot, ctx } = climbCtx()
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 } // hung: no ground, no rise
    deep(bot, ctx, null, {}) // 1st hung sample: coast (an apex looks like this once)
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false) // forward only — a held jump auto-fires on touchdown
    deep(bot, ctx, null, {}) // 2nd: hung — back off the face
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.forward, false)
    bot.entity.onGround = true // landed: prime in place (settled), open face — rim-leap; hang count reset
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, true)
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 } // hung again: ONE sample coasts (the count was reset)
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
    bot.entity.velocity = { x: 0, y: -2, z: 0 } // falling fast: coast, never back off mid-arc
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
  })

  it('climb fails on the mount budget despite displacement', () => {
    const { bot, ctx } = climbCtx()
    for (let i = 0; i < 16; i++) {
      bot.entity.position = pos(i % 2 === 0 ? 10.2 : 10.3, -45, 0) // jiggle: stalls never trip
      deep(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'running')
    for (let i = 0; i < 10 && ctx.stepStatus === 'running'; i++) {
      bot.entity.position = pos(i % 2 === 0 ? 10.2 : 10.3, -45, 0)
      deep(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'failed:lost-shaft') // 20 climb ticks: hang cycles cannot spin forever
  })

  it('pop waits for touchdown', () => {
    const bot = mockBot()
    bot.entity.position = pos(9.3, -44.2, 0) // inside radius + height gate, below the cell...
    bot.entity.onGround = false // ...but mid-air: no pop
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -43.8, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
    bot.entity.onGround = true // landed: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
  })

  it('coast hover over a standable crumb pops (no walkoff)', () => {
    const bot = mockBot()
    bot.blocks['9,-44,0'] = 'air' // crumb cell open; floor below stays stone
    bot.entity.position = pos(9.3, -44, 0.2) // latched mid-climb (level crumb, leap in flight) // inside the crumb, hovering at step level
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -44, z: 0.2 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      retMode: 'up', retUpKey: '9,-44,0',
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // 1st still sample: brake over the crumb (an apex looks like this once)
    assert.equal(ctx.deep.steps.length, 1)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    deep(bot, ctx, null, {}) // 2nd: hover arrival — pop + brake, never drift off
    assert.equal(ctx.deep.steps.length, 0)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(bot.controls.sprint, false)
    assert.equal(bot.controls.sneak, true)
  })

  it('coast arc over a standable crumb never pops (no pop-lie)', () => {
    const bot = mockBot()
    bot.blocks['9,-44,0'] = 'air'
    bot.entity.position = pos(9.3, -44, 0.2) // latched mid-climb (level crumb, leap in flight)
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: -2, z: 0 } // falling through, not hovering
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -44, z: 0.2 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      retMode: 'up', retUpKey: '9,-44,0',
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
    assert.equal(bot.controls.forward, true)
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
    assert.ok(!bot.controls.sneak) // flat pop: the executor owns its keys
  })

  it('return mounts 1-up steps: prime, settle, leap from the zone with thrust', () => {
    const bot = mockBot()
    for (const k of ['9,-45,0', '9,-44,0', '10,-45,0', '10,-44,0', '11,-45,0', '11,-44,0']) bot.blocks[k] = 'air' // carved shaft tube
    bot.entity.position = pos(10.2, -45, 0.5)
    bot.entity.velocity = { x: 0.2, y: 0, z: 0 } // walk momentum still carrying
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 0, y: 64, z: 0 }, { x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {}) // first touch gliding: prime-back (kill momentum), never a run-up leap
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
    const look = bot.calls.looks[0].split(',')
    assert.equal(look[0], '8.2') // axis-locked (ssn): 2m down -x from 10.2, zero z-drift into the tube wall
    assert.equal(look[2], '0.5')
    bot.entity.position = pos(10.8, -45, 0.5) // zone gap 0.5, still gliding: settle, never leap
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
    bot.entity.velocity = { x: 0.01, y: 0, z: 0 } // settled: leap WITH thrust
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, true)
    bot.entity.onGround = false // airborne: coast on forward only, jump released
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
    bot.entity.onGround = true
    bot.entity.position = pos(9.3, -44, 0) // mounted: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
  })

  it('primed climbs walk in from afar, inch out of contact, leap from the zone', () => {
    const bot = mockBot()
    for (const k of ['10,-45,0', '10,-44,0', '11,-45,0', '11,-44,0', '12,-45,0']) bot.blocks[k] = 'air'
    bot.entity.position = pos(10.5, -45, 0.5) // 1.0 out, gliding: prime-back first, never leap
    bot.entity.velocity = { x: 0.2, y: 0, z: 0 }
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.5, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.jump, false)
    bot.entity.position = pos(11.2, -45, 0.5) // drifted past the zone (latched): walk, never leap
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
    bot.entity.position = pos(10.0, -45, 0.5) // contact: prime again (the walk spent it)
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.back, true)
    bot.entity.velocity = { x: 0.01, y: 0, z: 0 } // glide decayed
    deep(bot, ctx, null, {}) // primed at the face: inch out, never leap from contact
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
    bot.entity.position = pos(10.8, -45, 0.5) // back in the zone, primed: leap
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, true)
    bot.entity.position = pos(10.3, -45, 0.5) // TRUE gap 0.0 is contact (corner-dist 0.39 says zone)
    deep(bot, ctx, null, {}) // the leap spent primed but settled: prime in place, inch right away
    assert.equal(bot.controls.back, true)
    deep(bot, ctx, null, {}) // still contact: inch again
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
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
    bot.entity.position = pos(10.2, -45, 0) // walked under the step: manual
    deep(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
    bot.entity.position = pos(11.5, -45, 0) // backed past flat range: latched, still manual
    deep(bot, ctx, null, {})
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
    bot.entity.position = pos(9.3, -44, 0) // mounted: pop
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
  })

  it('manual climb gates on the cell center, not the corner', () => {
    const bot = mockBot()
    bot.entity.position = pos(10.5, -45, 0.5) // lane center: corner-dist 1.58, center-dist 1.0
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.5, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // -x side from the lane center: manual, never the pathfinder
    assert.equal(ctx.lastGoalKey, 'deep-return-up')
  })

  it('below-zone leaps the rim when no feet-level riser stands ahead', () => {
    const bot = mockBot()
    bot.blocks['9,-45,0'] = 'air' // dug pocket: tread above, no face at feet level
    bot.entity.position = pos(10.0, -45, 0) // settled in contact: prime in place, rim-leap at once
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.0, y: -45, z: 0 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // open face: leap from contact — inching would back into the wall
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, true)
    assert.equal(ctx.deep.primed, false)
  })

  it('below-zone inches into a riser even from high fractions (0.75 face sample)', () => {
    const bot = mockBot()
    bot.blocks['10,-45,0'] = 'air' // own cell open; the riser at 9,-45,0 stays stone
    bot.blocks['10,-44,0'] = 'air'
    bot.blocks['11,-45,0'] = 'air' // back-room open (1.0 back-sample), floor below (default stone)
    bot.blocks['11,-44,0'] = 'air'
    bot.entity.position = pos(10.45, -45, 0.3) // fgap 0.17: a 0.4 sample reads the own cell
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // first touch: prime
    assert.equal(bot.controls.back, true)
    deep(bot, ctx, null, {}) // primed, solid face ahead: inch — never a rim-leap into the riser
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
  })

  it('pocket with wall at 1.0 but room at 0.5 inches (0.5-vision, not wedged)', () => {
    const bot = mockBot()
    bot.blocks['10,-45,0'] = 'air' // 0.5-behind open (the zone sits here); 1.0-behind stays
    bot.blocks['10,-44,0'] = 'air' // default stone (the pocket wall the old 1.0 sample wedged on)
    bot.entity.position = pos(10.45, -45, 0.3) // fgap 0.17: contact, riser solid ahead
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // settled: inch out — a 1.0 sample would wedge on the pocket wall
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.sneak, true)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
  })

  it('prime sneak-backs 400ms (lag-proof, zone-capped, edge-safe)', async () => {
    const bot = mockBot()
    bot.blocks['10,-45,0'] = 'air'
    bot.blocks['10,-44,0'] = 'air'
    bot.blocks['11,-45,0'] = 'air'
    bot.blocks['11,-44,0'] = 'air'
    bot.entity.position = pos(10.45, -45, 0.3)
    bot.entity.velocity = { x: 0.5, y: 0, z: 0 } // moving: first touch primes with a back-off (settled would inch)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // prime: sneak-back on ...
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.sneak, true)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(bot.controls.back, true) // ... still held at 200ms (a 50ms hold would be gone)
    assert.equal(bot.controls.sneak, true)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(bot.controls.back, false) // ... released at 400ms (a cross-tick hold would leak)
    assert.equal(bot.controls.sneak, false)
  })

  it('inch sneak-backs 400ms (lag-proof, zone-capped, edge-safe)', async () => {
    const bot = mockBot()
    bot.blocks['10,-45,0'] = 'air'
    bot.blocks['10,-44,0'] = 'air'
    bot.blocks['11,-45,0'] = 'air'
    bot.blocks['11,-44,0'] = 'air'
    bot.entity.position = pos(10.45, -45, 0.3)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // prime
    deep(bot, ctx, null, {}) // inch: sneak-back on ...
    assert.equal(bot.controls.back, true)
    assert.equal(bot.controls.sneak, true)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(bot.controls.back, true) // ... still held at 200ms
    assert.equal(bot.controls.sneak, true)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(bot.controls.back, false) // ... released at 400ms
    assert.equal(bot.controls.sneak, false)
  })

  it('ssn: static inch pins write no dig packets (the ghost escalation is gone)', () => {
    const bot = mockBot()
    bot.blocks['10,-45,0'] = 'air'
    bot.blocks['10,-44,0'] = 'air'
    bot.blocks['11,-45,0'] = 'air' // back-room open, floor below (default stone)
    bot.blocks['11,-44,0'] = 'air'
    const writes = []
    bot._client = { write: (name, data) => writes.push([name, data]) }
    bot.entity.position = pos(10.45, -45, 0.3) // fgap 0.17: contact, riser solid, backs rejected
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    for (let i = 0; i < 7 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(writes.length, 0) // the old code blind-dug on the 4th and ghost-broke on the 7th
  })

  it('primed leaps wait for momentum to settle, then fire', () => {
    const bot = mockBot()
    for (const k of ['9,-45,0', '9,-44,0', '10,-45,0', '10,-44,0', '11,-45,0']) bot.blocks[k] = 'air'
    bot.entity.position = pos(10.5, -45, 0) // zone gap 0.32
    bot.entity.velocity = { x: 0.2, y: 0, z: 0 } // prime back-glide still carrying
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.5, y: -45, z: 0 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      cameFrom: null, retMode: 'up', retUpKey: '9,-44,0', primed: true,
    }
    ctx.lastGoalKey = 'deep-return-up'
    deep(bot, ctx, null, {}) // gliding: settle (all released), stay primed, never leap
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
    bot.entity.velocity = { x: 0.01, y: 0, z: 0 } // settled: fire
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, true)
  })

  it('unwedge holds still when a wall stands behind, backs when open', () => {
    const bot = mockBot() // default stone everywhere: wall behind at 11,-45,0
    bot.blocks['10,-46,0'] = 'air' // pit below feet (a hang, not a ghost)
    bot.entity.position = pos(10.2, -45, 0.5) // lane center: the behind-ray stays in-lane
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 } // hung: no ground, no rise
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // 1st hung sample: coast
    assert.equal(bot.controls.forward, true)
    deep(bot, ctx, null, {}) // 2nd: wall behind — still, never back into it
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.jump, false)
    bot.blocks['10,-45,0'] = 'air' // behind open now (feet+head at the 0.5 sample): back off the face
    bot.blocks['10,-44,0'] = 'air'
    deep(bot, ctx, null, {})
    assert.equal(bot.controls.back, true)
  })

  it('hang over a pit backs off, hang over floor holds the arc (ghost/apex)', () => {
    const bot = mockBot()
    for (const k of ['9,-45,0', '9,-44,0', '10,-45,0', '10,-44,0', '10,-46,0', '11,-45,0', '11,-44,0']) bot.blocks[k] = 'air' // tube + pit below + open behind
    bot.entity.position = pos(10.2, -45, 0.5)
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 } // hung: no ground, no rise
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // 1st hung sample: coast (an apex looks like this once)
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
    deep(bot, ctx, null, {}) // 2nd over the pit: unwedge-back off the face
    assert.equal(bot.controls.back, true)
    bot.blocks['10,-46,0'] = 'stone' // floor below now: pressed hover, not a hang
    deep(bot, ctx, null, {}) // 3rd still-band, outside the crumb: brake (an apex never stills twice)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.stepStatus, 'running') // the stall budget decides, not the brake
  })

  it('hover pressed to a face backs off even over floor (pin, not ghost)', () => {
    const bot = mockBot()
    for (const k of ['10,-45,0', '10,-44,0', '11,-45,0', '11,-44,0']) bot.blocks[k] = 'air' // tube + open behind; face at 9,-45 and floor below default stone
    bot.entity.position = pos(10.2, -45, 0.5)
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 } // pinned: no ground, no rise, face at the nose
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.2, y: -45, z: 0.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // 1st: coast
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.jump, false)
    deep(bot, ctx, null, {}) // 2nd: face-press (riser solid) over floor — ghost contact, inch via the zone
    assert.equal(bot.controls.back, true)
    assert.equal(ctx.deep.primed, true) // in-place prime (an unwedge would leave this false)
  })

  it('far above-crumbs walk in without priming (no prime-back spiral)', () => {
    const bot = mockBot()
    bot.entity.position = pos(11.5, -45, 0.5) // fgap 1.2, gliding: walk anyway, never prime-back
    bot.entity.velocity = { x: 0.2, y: 0, z: 0 }
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 11.5, y: -45, z: 0.5 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      cameFrom: null, retMode: 'up', retUpKey: '9,-44,0',
    }
    ctx.lastGoalKey = 'deep-return-up'
    deep(bot, ctx, null, {}) // far: walk (momentum irrelevant — the zone primes later)
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, false)
    deep(bot, ctx, null, {}) // still far, still unprimed: walk again (no interleave)
    assert.equal(bot.controls.forward, true)
    assert.equal(bot.controls.back, false)
  })

  it('no back-room waits the glide out, wedges fail early at 8 with no fact', () => {
    const bot = mockBot()
    for (const k of ['10,-45,0', '10,-44,0', '10,-46,0', '10,-47,0']) bot.blocks[k] = 'air' // void behind at the 0.5 sample (drop 2)
    const writes = []
    bot._client = { write: (name, data) => writes.push([name, data]) }
    bot.entity.position = pos(10.45, -45, 0.3) // fgap 0.17 (contact), riser solid ahead
    bot.entity.velocity = { x: 0.2, y: 0, z: 0 } // gliding
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 10.45, y: -45, z: 0.3 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // gliding over air: wait (all released), stay unprimed
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.ok(!ctx.deep.primed)
    bot.entity.velocity = { x: 0.01, y: 0, z: 0 } // settled
    deep(bot, ctx, null, {}) // contact + riser + void behind: wedged (all released, budget decides)
    assert.equal(bot.controls.forward, false)
    assert.equal(bot.controls.back, false)
    assert.equal(bot.controls.jump, false)
    assert.equal(ctx.deep.primed, true)
    for (let i = 0; i < 6 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running') // 7 wedged ticks: still holding
    deep(bot, ctx, null, {}) // 8th wedged + static: one unfreeze poke, then fail early (no fact: 6x7.2)
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
    assert.equal(writes.length, 4) // the poke-then-fail unfreeze STARTs (feet/head + ahead; underfoot is air here)
    assert.ok(!ctx.stuck, 'target give-up claims no body')
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

  it('ssn: contact hover inside the crumb pops (no ghostContact shadow)', () => {
    const bot = mockBot() // default stone: floor below + riser ahead of the hover
    bot.entity.position = pos(9.3, -44, 0.5) // inside the crumb cell, airborne hover
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 9.3, y: -44, z: 0.5 }, issuedKey: 'deep-return-up', startDrops: { diamond: 0 },
      cameFrom: null, retMode: 'up', retUpKey: '9,-44,0', retAirStall: 0,
    }
    ctx.lastGoalKey = 'deep-return-up'
    deep(bot, ctx, null, {}) // 1st still sample: brake over the crumb (an apex looks like this once)
    assert.equal(ctx.deep.steps.length, 1)
    deep(bot, ctx, null, {}) // 2nd: hover arrival pops (the old code held still via ghostContact)
    assert.equal(ctx.deep.steps.length, 0)
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

describe('deep ssn return', () => {
  it('aimDir locks drift-free axes, keeps true diagonals on the ray', () => {
    assert.deepEqual(deep.aimDir({ x: 55.6, z: -201.7 }, { x: 56, z: -202 }), { dx: 1, dz: 0 }) // the ssn pin: 0.2 z-drift locked out
    assert.deepEqual(deep.aimDir({ x: 10.5, z: 0.5 }, { x: 10, z: 5 }), { dx: 0, dz: 1 })
    assert.deepEqual(deep.aimDir({ x: 10.2, z: 0.5 }, { x: 9, z: 0 }), { dx: -1, dz: 0 })
    const diag = deep.aimDir({ x: 10.2, z: 0 }, { x: 9, z: 0 }) // 0.7 x 0.5: true diagonal
    assert.equal(diag.dx.toFixed(3), '-0.814')
    assert.equal(diag.dz.toFixed(3), '0.581')
    assert.equal(deep.aimDir({ x: 9.52, z: 0.51 }, { x: 9, z: 0 }), null) // directly under: no direction
  })

  it('pickup chains grounded cells, never airborne ones', () => {
    const bot = mockBot()
    bot.inv.push({ name: 'iron_pickaxe', count: 1 })
    bot.entity.position = pos(7, -45, 0) // 2 out from the last crumb
    bot.entity.onGround = false // mid-air (magnet fall): refuse
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'pickup', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 5, y: -45, z: 0 }], target: { x: 10, y: -45, z: 0, name: 'diamond_ore' },
      dug: 0, stalls: 0, lastPos: { x: 5, y: -45, z: 0 }, issuedKey: null,
      startDrops: { diamond: 0 }, cameFrom: null, pickupSince: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1)
    bot.entity.onGround = true // landed: chain it
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 2)
    assert.deepEqual(ctx.deep.steps[1], { x: 7, y: -45, z: 0 })
  })

  it('return fills one standable mid under a multi-up crumb', () => {
    const bot = mockBot()
    bot.blocks['56,-50,-202'] = 'air' // mid feet+head air, floor (56,-51) default stone
    bot.blocks['56,-49,-202'] = 'air'
    bot.entity.position = pos(55.6, -51, -201.7) // the ssn leg1 pocket, 3 below (56,-48)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 33, z: -202, topY: -28, dx: 1, dz: 0 }, n: 22,
      steps: [{ x: 55, y: -51, z: -202 }, { x: 56, y: -48, z: -202 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 55.6, y: -51, z: -201.7 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.deep.steps.length, 3)
    assert.deepEqual(ctx.deep.steps[2], { x: 56, y: -50, z: -202, fill: true })
  })

  it('filled mids pop by arrival only, never by radius', () => {
    const bot = mockBot()
    bot.entity.position = pos(56.7, -50.2, -201.5) // radius-close + gate-passing, not in-cell
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 33, z: -202, topY: -28, dx: 1, dz: 0 }, n: 22,
      steps: [{ x: 56, y: -50, z: -202, fill: true }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 56.7, y: -50.2, z: -201.5 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 1) // the old radius gate would pop here and re-fill forever
    bot.entity.position = pos(56.3, -50, -201.5) // entered the cell: arrival pops
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.steps.length, 0)
  })

  it('ssn: third fill for the same crumb fails (fall-loop cap)', () => {
    const bot = mockBot()
    bot.blocks['56,-50,-202'] = 'air' // a standable mid EXISTS; the cap still fails
    bot.blocks['56,-49,-202'] = 'air'
    bot.entity.position = pos(55.6, -51, -201.7)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 33, z: -202, topY: -28, dx: 1, dz: 0 }, n: 22,
      steps: [{ x: 55, y: -51, z: -202 }, { x: 56, y: -48, z: -202 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 55.6, y: -51, z: -201.7 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null, fillSeen: { '56,-48,-202': 2 },
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
    assert.equal(ctx.deep, null)
    assert.ok(!ctx.stuck, 'no fact from the step itself')
  })

  it('ssn: second fill for the same crumb is allowed (one fall retry)', () => {
    const bot = mockBot()
    bot.blocks['56,-50,-202'] = 'air'
    bot.blocks['56,-49,-202'] = 'air'
    bot.entity.position = pos(55.6, -51, -201.7)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 33, z: -202, topY: -28, dx: 1, dz: 0 }, n: 22,
      steps: [{ x: 55, y: -51, z: -202 }, { x: 56, y: -48, z: -202 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 55.6, y: -51, z: -201.7 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null, fillSeen: { '56,-48,-202': 1 },
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.deep.steps.length, 3)
    assert.equal(ctx.deep.fillSeen['56,-48,-202'], 2)
  })

  it('ssn: jiggling wedged body rides past 8, fails once static', () => {
    const bot = mockBot() // default stone: contact + riser + blocked behind at both spots
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 0, z: 0, topY: 64, dx: 1, dz: 0 }, n: 109,
      steps: [{ x: 9, y: -44, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: 'x', startDrops: { diamond: 0 }, cameFrom: null,
    }
    for (let i = 0; i < 10; i++) { // jiggle 0.1 (resets stalls) while wedged
      bot.entity.position = pos(i % 2 === 0 ? 10.05 : 10.15, -45, 0)
      deep(bot, ctx, null, {})
    }
    assert.equal(ctx.stepStatus, 'running') // the stalls gate blocks the early fail
    assert.ok((ctx.deep.wedgedTicks || 0) >= 10)
    bot.entity.position = pos(10.15, -45, 0) // hold still: stalls climb, the fail lands
    for (let i = 0; i < 8 && ctx.stepStatus === 'running'; i++) deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
    assert.ok(!ctx.stuck, 'no fact from the step itself')
  })

  it('multi-up with no standable mid fails early with no fact', () => {
    const bot = mockBot() // default stone everywhere: no air mid at -50
    bot.entity.position = pos(55.6, -51, -201.7)
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'return', shaft: { x: 33, z: -202, topY: -28, dx: 1, dz: 0 }, n: 22,
      steps: [{ x: 55, y: -51, z: -202 }, { x: 56, y: -48, z: -202 }], target: null, dug: 0, stalls: 0,
      lastPos: { x: 55.6, y: -51, z: -201.7 }, issuedKey: 'x', startDrops: { diamond: 0 },
      cameFrom: null,
    }
    deep(bot, ctx, null, {}) // one tick: no 20-tick futile climb
    assert.equal(ctx.stepStatus, 'failed:lost-shaft')
    assert.ok(!ctx.stuck, 'no fact from the step itself')
  })

  it('ssn: tunnel digs feet, head, and headroom (3-high tube)', async () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -45, 0)
    bot.blocks['6,-45,0'] = 'diamond_ore'
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 6, y: -45, z: 0, name: 'diamond_ore' }, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']), cameFrom: null,
    }
    for (let i = 0; i < 60 && ctx.deep && ctx.deep.phase === 'tunnel' && !bot.calls.digs.includes('1,-43,0'); i++) {
      deep(bot, ctx, null, {})
      autoWalk(bot)
      await tick()
    }
    assert.ok(bot.calls.digs.includes('1,-45,0'), `feet dug: ${bot.calls.digs}`)
    assert.ok(bot.calls.digs.includes('1,-44,0'), `head dug: ${bot.calls.digs}`)
    assert.ok(bot.calls.digs.includes('1,-43,0'), `headroom dug: ${bot.calls.digs}`)
  })

  it('ssn: lava at the stair headroom fails the descend (guarded R-up)', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -43, 0)
    bot.blocks['1,-42,0'] = 'air' // feet+head already open; the headroom is next
    bot.blocks['1,-41,0'] = 'air'
    bot.blocks['1,-38,0'] = 'lava' // 2 off the headroom (1,-40), 3+ off feet/head/down
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'descend', shaft: { x: 0, z: 0, topY: -42, dx: 1, dz: 0 }, n: 0,
      steps: [{ x: 0, y: -42, z: 0 }], target: null, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null,
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.stepStatus, 'failed:lava')
  })

  it('ssn: lava at the tunnel headroom strikes and replans', () => {
    const bot = mockBot()
    bot.entity.position = pos(0, -45, 0)
    bot.blocks['1,-45,0'] = 'air' // feet+head already open; the headroom is next
    bot.blocks['1,-44,0'] = 'air'
    bot.blocks['1,-41,0'] = 'lava' // 2 off the headroom (1,-43), 3+ off feet/head
    const ctx = memCtx([])
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 0, y: -45, z: 0 }], target: { x: 20, y: -45, z: 0, name: 'diamond_ore' }, dug: 0, stalls: 0,
      lastPos: null, issuedKey: null, startDrops: { diamond: 0 },
      tunnelSteps: 0, tunnelSeen: new Set(['0,-45,0']), cameFrom: null,
      tunnelGoal: { x: 1, y: -45, z: 0 },
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan')
    assert.equal(ctx.deep.target, null)
    assert.ok(!ctx.digInFlight)
  })

  it('tunnel refuses straight-down underfoot digs (R-stand)', () => {
    const bot = mockBot()
    bot.entity.position = pos(5, -45, 0)
    const ctx = memCtx([])
    const t = { x: 20, y: -45, z: 0, name: 'diamond_ore' }
    ctx.deep = {
      phase: 'tunnel', shaft: { x: 0, z: 0, topY: -44, dx: 1, dz: 0 }, n: 1,
      steps: [{ x: 5, y: -45, z: 0 }], target: t, dug: 0, stalls: 0,
      lastPos: { x: 5, y: -45, z: 0 }, issuedKey: null, startDrops: { diamond: 0 },
      cameFrom: null, tunnelGoal: { x: 5, y: -46, z: 0 }, tunnelSteps: 0,
      tunnelSeen: new Set(['5,-45,0']),
    }
    deep(bot, ctx, null, {})
    assert.equal(ctx.deep.phase, 'plan') // struck, never dug the floor out from under the crumb
    assert.equal(ctx.deep.target, null)
    assert.ok(!ctx.digInFlight)
  })
})
