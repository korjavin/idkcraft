'use strict'

// Reforest grove (idkcraft-44rl): one run's plantings cluster into a
// visible grove patch instead of scattering, one chat line names the
// grove per run, and the next run replants dead/missing spots first
// (bounded). Vetted ground, PLANT_* caps and day-only stay as today.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const reforest = require('../src/behaviours/reforest')

function plantWorld() {
  const names = {}
  for (let x = -40; x <= 40; x++) {
    for (let z = -40; z <= 40; z++) names[`${x},63,${z}`] = 'dirt'
  }
  return names
}

function groveBot({ names = plantWorld(), items = [] } = {}) {
  const goals = []
  const bot = {
    names,
    goals,
    placeCalls: 0,
    equipped: null,
    order: [],
    chats: [],
    _items: items,
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
    registry: { blocksByName: { oak_leaves: { id: 18 }, dirt: { id: 2 } } },
    pathfinder: {
      goal: null,
      setGoal: (g) => { goals.push(g && g.constructor && g.constructor.name); bot.pathfinder.goal = g },
      isMoving: () => !!bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks: () => [], // no leaves: the step starts in the plant tail
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = names[`${x},${y},${z}`] || 'air'
      return { name, position: { x, y, z }, getProperties: () => ({ persistent: false }) }
    },
    canDigBlock: () => true,
    dig: async () => {},
    equip: async (item) => { bot.equipped = item && item.name },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const want = bot.equipped
      const i = bot._items.findIndex((it) => it && it.name === want)
      if (i === -1) throw new Error(`no ${want}`)
      bot._items[i].count -= 1
      if (bot._items[i].count <= 0) bot._items.splice(i, 1)
      if (rp) {
        const cell = `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}`
        names[cell] = want
        bot.order.push(cell)
      }
    },
    chat: (l) => { bot.chats.push(l) },
  }
  return bot
}

function groveCtx(over = {}) {
  return { lastGoalKey: '', lastPathStatus: 'none', stepStatus: 'running', ...over }
}

const tick = () => new Promise((r) => setImmediate(r))

// Drive the tail; teleport along plant walks.
async function driveGrove(bot, ctx, maxTicks = 400) {
  const orig = console.log
  console.log = () => {}
  try {
    for (let i = 0; i < maxTicks; i++) {
      reforest(bot, ctx)
      await tick()
      await tick() // flush place flights
      if (ctx.stepStatus !== 'running') break
      const r = ctx.reforest
      if (r && r.phase === 'plant-walk' && r.spot) {
        bot.entity.position = { x: r.spot.x + 1, y: r.spot.y, z: r.spot.z }
        bot._moving = false
      }
    }
    await tick()
    await tick()
  } finally {
    console.log = orig
  }
}

function spread(cells) {
  const pts = cells.map((s) => s.split(',').map(Number))
  let m = 0
  for (const a of pts) for (const b of pts) m = Math.max(m, Math.hypot(a[0] - b[0], a[2] - b[2]))
  return m
}

describe('reforest grove planting (44rl)', () => {
  it('clusters one run into a patch and chats one line naming it', async () => {
    const bot = groveBot({ items: [{ name: 'oak_sapling', count: 20 }] })
    const ctx = groveCtx()
    await driveGrove(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.order.length, reforest.PLANT_MAX)
    assert.ok(spread(bot.order) <= reforest.GROVE_RADIUS * 2,
      `grove spread ${spread(bot.order)} stays inside the patch`)
    assert.equal(bot.chats.length, 1)
    assert.match(bot.chats[0], /^planted 8 oak around -?\d+,64,-?\d+$/)
  })

  it('anchors the patch at the beaten stand, not at a random disc', () => {
    const bot = groveBot()
    const ctx = groveCtx()
    // The cluster scan ran 20 out: the anchor is the stand, not the body.
    const r = { beatCache: { at: { x: 20, y: 64, z: 0 }, cells: [] } }
    assert.deepEqual(reforest.groveAnchor(bot, ctx, r), { x: 20, z: 0 })
  })

  it('reuses the previous grove centre while the body is still beside it', () => {
    const bot = groveBot()
    bot.entity.position = { x: 2, y: 64, z: 1 }
    const ctx = groveCtx({ grove: { center: { x: 0, y: 64, z: 0 }, spots: [] } })
    assert.deepEqual(reforest.groveAnchor(bot, ctx, {}), { x: 0, z: 0 })
    // Wandered far: a fresh patch starts at the body, not a doomed walk back.
    bot.entity.position = { x: 100, y: 64, z: 100 }
    assert.deepEqual(reforest.groveAnchor(bot, ctx, {}), { x: 100, z: 100 })
  })

  it('replugs dead spots first and never touches grown or living ones', async () => {
    const names = plantWorld()
    // Last run's grove: two holes (air), one grown trunk, one living sapling.
    names['2,64,1'] = 'air'
    names['-3,64,2'] = 'air'
    names['4,64,-1'] = 'oak_log'
    names['1,64,3'] = 'oak_sapling'
    const bot = groveBot({ names, items: [{ name: 'oak_sapling', count: 20 }] })
    const ctx = groveCtx({
      grove: {
        center: { x: 0, y: 64, z: 0 },
        spots: [
          { x: 2, y: 64, z: 1 }, { x: -3, y: 64, z: 2 },
          { x: 4, y: 64, z: -1 }, { x: 1, y: 64, z: 3 },
        ],
      },
    })
    await driveGrove(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    const firstTwo = bot.order.slice(0, 2).sort()
    assert.deepEqual(firstTwo, ['-3,64,2', '2,64,1'], 'the holes replant before fresh ground')
    assert.equal(names['4,64,-1'], 'oak_log', 'grown trunk untouched')
    assert.equal(bot.order.filter((c) => c === '1,64,3').length, 0, 'living sapling never doubled')
    // The chat still names one grove for the whole run.
    assert.equal(bot.chats.length, 1)
    assert.match(bot.chats[0], /^planted 8 oak around -?\d+,\d+,-?\d+$/)
  })

  it('bounds the growth check at the planting cap', () => {
    const bot = groveBot()
    const spots = []
    for (let i = 0; i < 20; i++) spots.push({ x: i - 10, y: 64, z: 0 })
    const ctx = groveCtx({ grove: { center: { x: 0, y: 64, z: 0 }, spots } })
    const dead = reforest.deadGroveSpots(bot, ctx, { triedPlant: new Set() })
    assert.ok(dead.length <= reforest.PLANT_MAX, `replant pass capped: ${dead.length}`)
  })

  it('bounds the remembered grove across runs', async () => {
    const prev = []
    for (let i = 0; i < reforest.GROVE_SPOTS_MAX; i++) prev.push({ x: i - 12, y: 64, z: 20 })
    const bot = groveBot({ items: [{ name: 'oak_sapling', count: 20 }] })
    // Old grove far away: this run plants a fresh patch at the body.
    const ctx = groveCtx({ grove: { center: { x: 0, y: 64, z: 20 }, spots: prev } })
    await driveGrove(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(ctx.grove.spots.length <= reforest.GROVE_SPOTS_MAX,
      `memory bounded: ${ctx.grove.spots.length}`)
  })

  it('chats nothing when nothing was planted', async () => {
    const bot = groveBot({ items: [] })
    const ctx = groveCtx()
    await driveGrove(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-leaves')
    assert.equal(bot.chats.length, 0, 'no grove, no line')
    assert.equal(ctx.grove, undefined, 'no grove remembered')
  })

  it('keeps the per-run planting cap inside the patch', async () => {
    const bot = groveBot({ items: [{ name: 'oak_sapling', count: 40 }] })
    const ctx = groveCtx()
    await driveGrove(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, reforest.PLANT_MAX)
  })

  it('sampled grove spots stay inside the patch', () => {
    const bot = groveBot()
    for (let i = 0; i < 100; i++) {
      const spot = reforest.pickPlantSpot(bot, groveCtx(), new Set(), undefined, { x: 0, z: 0 })
      assert.ok(spot, `sample ${i} finds a spot on open dirt`)
      // +2 slack: a continuous sample inside the radius floors to a cell
      // up to one diagonal out (e.g. radius 8 -> cell hypot 8.5).
      assert.ok(Math.hypot(spot.x - 0, spot.z - 0) <= reforest.GROVE_RADIUS + 2,
        `sample ${i} inside the patch: ${spot.x},${spot.z}`)
    }
  })
})
