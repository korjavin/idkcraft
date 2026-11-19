'use strict'

// idkcraft-qphv.1: the farm structure (barn, pen, field) laid by the house
// builder on a farm-kind home — blueprint shape, site, an end-to-end build
// on a flat fake world, the house state left alone, and the menu wiring.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const fp = require('../src/farm-blueprint')
const farmbuild = require('../src/behaviours/farmbuild')
const { BEHAVIOURS } = require('../src/behaviours')
const { MENU, STEP_ORDER, STEP_CRITERIA } = require('../src/goal')

function world() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    cells,
    set(x, y, z, n) { cells.set(key(x, y, z), n) },
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      const fy = Math.floor(p.y)
      const name = cells.has(k) ? cells.get(k) : (fy === 63 ? 'grass_block' : fy < 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block', position: new Vec3(Math.floor(p.x), fy, Math.floor(p.z)) }
    },
  }
}

function mockBot(w) {
  const items = ['oak_planks', 'oak_fence', 'oak_fence_gate', 'oak_door', 'chest', 'wooden_hoe', 'water_bucket'].map((name) => ({ name, count: 64 }))
  let look = null
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    world: { getBlock: () => null },
    inventory: { items: () => items },
    blockAt: (p) => w.blockAt(p),
    held: null,
    chats: [],
    chat: (m) => bot.chats.push(m),
    pathfinder: {
      isMoving: () => false,
      // Teleport next to the goal: the fake has no walking.
      setGoal: (g) => {
        const t = g && (g.pos || (typeof g.x === 'number' ? g : null))
        if (t) bot.entity.position = new Vec3(t.x + 0.5, (typeof t.y === 'number' ? t.y : 64), (t.z || 0) - 1)
      },
    },
    equip: async (it) => { bot.held = it.name },
    dig: async (b) => w.set(b.position.x, b.position.y, b.position.z, 'air'),
    placeBlock: async (ref, face) => w.set(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z, bot.held),
    activateBlock: async (b) => { if (bot.held.endsWith('_hoe') && (b.name === 'dirt' || b.name === 'grass_block')) w.set(b.position.x, b.position.y, b.position.z, 'farmland') },
    lookAt: async (p) => { look = p },
    activateItem: async () => { if (bot.held === 'water_bucket' && look) w.set(look.x, look.y, look.z, 'water') },
  }
  return bot
}

const tick = () => new Promise((r) => setImmediate(r))

describe('farm blueprint (qphv.1)', () => {
  it('has a barn with door and chest, a fenced pen with one gate, and a 9x9 field around water', () => {
    const n = (k) => fp.PLAN.filter((c) => c.kind === k).length
    assert.equal(n('door'), 1)
    assert.equal(n('chest'), 1)
    assert.equal(n('gate'), 1)
    assert.equal(n('fence'), 31) // 9x9 ring minus the gate
    assert.equal(n('water'), 1)
    assert.equal(n('farmland'), 80)
    assert.equal(n('planks'), 21 * 2 + 42) // two wall rings + the roof
    const w = fp.PLAN.findIndex((c) => c.kind === 'water')
    assert.ok(w < fp.PLAN.findIndex((c) => c.kind === 'farmland'), 'water before farmland (hydration)')
  })

  it('finds a flat site clear of the castle box', () => {
    const w = world()
    const bot = mockBot(w)
    const s = fp.siteFor(bot, { x: 0, y: 64, z: 0 }, [{ x0: -10, z0: -10, x1: 10, z1: 10 }])
    assert.ok(s)
    assert.equal(s.y, 64)
    assert.ok(s.x + fp.W - 1 < -13 || s.x > 13 || s.z + fp.D - 1 < -13 || s.z > 13)
  })

  it('refuses a field on sand', () => {
    const w = world()
    for (let x = -60; x <= 60; x++) for (let z = -60; z <= 60; z++) w.set(x, 63, z, 'sand')
    assert.equal(fp.siteFor(mockBot(w), { x: 0, y: 64, z: 0 }), null)
  })
})

describe('farmbuild step (qphv.1)', () => {
  it('lays the whole farm through the house builder and leaves the house state alone', async () => {
    const w = world()
    const bot = mockBot(w)
    const house = { site: { x: 100, y: 64, z: 100 }, v: 2, built: true }
    const ctx = { step: 'farmbuild', stepStatus: 'running', home: house, buildSkip: [7], castle: null }
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      for (let t = 0; t < 4000 && ctx.stepStatus === 'running'; t++) {
        farmbuild(bot, ctx)
        await tick()
      }
    } finally { console.log = orig }
    assert.equal(ctx.stepStatus, 'done', logs.slice(-5).join('\n'))
    const fb = ctx.farmBuild
    assert.equal(fb.built, true)
    assert.ok(logs.some((l) => /^farm site=-?\d+,64,-?\d+$/.test(l)))
    assert.ok(logs.some((l) => /^farm progress built=\d+\/199 phase=barn$/.test(l)))
    const s = fb.site
    const at = (dx, dy, dz) => w.blockAt({ x: s.x + dx, y: s.y + dy, z: s.z + dz }).name
    assert.equal(at(fp.WATER.dx, -1, fp.WATER.dz), 'water')
    assert.equal(at(fp.GATE.dx, 0, fp.GATE.dz), 'oak_fence_gate')
    assert.equal(at(fp.DOOR.dx, 0, fp.DOOR.dz), 'oak_door')
    assert.equal(at(18, -1, 0), 'farmland')
    assert.equal(ctx.home, house)
    assert.deepEqual(ctx.buildSkip, [7])
    assert.ok(bot.chats.some((m) => m.startsWith('farm done at')))
  })

  it('is feasible by day for an ordered farm or a complete castle, never once built', () => {
    const day = { time: 'day' }
    assert.equal(farmbuild.feasible(day, null, {}), false)
    assert.equal(farmbuild.feasible(day, null, { castle: { phase: 'complete' } }), true) // e.g. bot5's complete castle
    assert.equal(farmbuild.feasible({ time: 'night' }, null, { farmBuild: { ordered: true } }), false)
    assert.equal(farmbuild.feasible(day, null, { farmBuild: { ordered: true } }), true)
    assert.equal(farmbuild.feasible(day, null, { farmBuild: { ordered: true, built: true } }), false)
  })

  it('registers as a work step', () => {
    assert.equal(typeof BEHAVIOURS.farmbuild, 'function')
    assert.ok(STEP_ORDER.includes('farmbuild'))
    assert.equal(typeof MENU.farmbuild.feasible, 'function')
    assert.equal(typeof STEP_CRITERIA.farmbuild, 'string')
  })
})
