'use strict'

// idkcraft-u04q: the 8hx3 escalation for a v2 step stuck on noPath.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const unstick = require('../src/behaviours/unstick')

const env = { BOT_BODY: process.env.BOT_BODY, LLM_ESCALATION: process.env.LLM_ESCALATION }
beforeEach(() => { process.env.BOT_BODY = 'baritone'; process.env.LLM_ESCALATION = '1' })
afterEach(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }

// Flat dirt floor at y=63, a 2-high dirt wall at x=2 between the bot (0,64,0) and the farm goal (4,64,0).
function fixture(plans, wall = 'dirt') {
  const map = new Map(), key = (p) => `${p.x},${p.y},${p.z}`
  const set = (p, n) => map.set(key(p), n)
  for (let dz = -3; dz <= 3; dz++) { set({ x: 2, y: 64, z: dz }, wall); set({ x: 2, y: 65, z: dz }, wall) }
  const calls = { esc: [], digs: [], places: [], chat: [] }
  const shovel = { name: 'stone_shovel', type: 273, count: 1 }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [shovel, { name: 'dirt', type: 3, count: 32 }] }, heldItem: shovel, players: {}, world: {},
    blockAt: (p) => {
      const name = map.get(key(p)) || (p.y < 64 ? 'dirt' : 'air')
      return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: {
      goal: null, isMoving: () => false,
      movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
      setGoal(g) {
        this.goal = g
        // the fake pathfinder walks only when x=2 is open
        if (g instanceof goals.GoalBlock && bot.blockAt({ x: 2, y: 64, z: 0 }).name === 'air') bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5)
      },
      bestHarvestTool: () => shovel,
    },
    equip: async (it) => { bot.heldItem = it },
    dig: async (b) => { calls.digs.push(key(b.position)); set(b.position, 'air') },
    placeBlock: async (ref, face) => { calls.places.push(key(ref.position.plus(face))) },
    chat: (t) => calls.chat.push(t),
  }
  const ctx = { work: true, step: 'farm', stepStatus: 'running', lastPathStatus: 'noPath',
    brain: { escalate: async (obs) => { calls.esc.push(obs); return plans(obs, calls.esc.length) } } }
  bot.pathfinder.goal = new goals.GoalNear(4, 64, 0, 1)
  return { bot, ctx, calls, set }
}
async function ticks(f, n, fight = false) {
  let owned = false
  for (let i = 0; i < n; i++) { owned = unstick.tick(f.bot, f.ctx, fight); await settle() }
  return owned
}

describe('unstick: LLM escalation for a stuck v2 step (u04q)', () => {
  it('off by default: no flag, no call', async () => {
    delete process.env.LLM_ESCALATION
    const f = fixture(() => ({ plan: [] }))
    assert.equal(await ticks(f, 15), false)
    assert.equal(f.calls.esc.length, 0)
  })

  it('(a) goal behind a 1-block wall with noPath: dig + walk_to, the bot arrives and the step continues', async () => {
    const f = fixture(() => ({ plan: [{ op: 'dig', x: 2, y: 64, z: 0 }, { op: 'dig', x: 2, y: 65, z: 0 }, { op: 'walk_to', x: 4, y: 64, z: 0 }] }))
    assert.equal(await ticks(f, unstick.NOPATH_TICKS - 1), false, 'a short noPath streak never escalates')
    await ticks(f, 8)
    assert.equal(f.calls.esc.length, 1)
    assert.deepEqual(f.calls.esc[0].target, { x: 4, y: 64, z: 0 })
    assert.equal(f.calls.esc[0].trigger, 'nopath')
    assert.ok(Array.isArray(f.calls.esc[0].bot_grid))
    assert.deepEqual(f.calls.digs, ['2,64,0', '2,65,0'])
    assert.equal(Math.floor(f.bot.entity.position.x), 4)
    assert.equal(f.ctx.step, 'farm')
    assert.equal(f.ctx.stepStatus, 'running')
    assert.equal(unstick.tick(f.bot, f.ctx), false, 'episode over: the step owns the body again')
  })

  it('(a2) a step that failed:unreachable is lifted back to running once reached', async () => {
    const f = fixture(() => ({ plan: [{ op: 'dig', x: 2, y: 64, z: 0 }, { op: 'dig', x: 2, y: 65, z: 0 }, { op: 'walk_to', x: 4, y: 64, z: 0 }] }))
    f.ctx.lastPathStatus = 'success'
    await ticks(f, 1) // remembers the goal
    f.bot.pathfinder.goal = null
    f.ctx.stepStatus = 'failed:unreachable'
    await ticks(f, 8)
    assert.equal(f.calls.esc[0].trigger, 'unreachable')
    assert.equal(f.ctx.stepStatus, 'running')
  })

  it('(b) a refused primitive (protected block) is reported back to the model', async () => {
    const f = fixture(() => ({ plan: [{ op: 'dig', x: 2, y: 64, z: 0 }] }), 'chest')
    await ticks(f, unstick.NOPATH_TICKS + 6)
    assert.equal(f.calls.digs.length, 0)
    assert.ok(f.calls.esc.length >= 2)
    assert.ok(f.calls.esc[1].history.some((h) => /dig\(2,64,0\) -> refused:/.test(h)), JSON.stringify(f.calls.esc[1].history))
  })

  it('(c) cap and cooldown: never a 4th call, then ask_owner', async () => {
    const f = fixture(() => ({ plan: [{ op: 'wait', s: 0 }] }))
    const clock = Date.now
    let now = clock()
    try {
      Date.now = () => now
      for (let i = 0; i < 40; i++) { await ticks(f, 1); now += 1500 }
    } finally { Date.now = clock }
    assert.equal(f.calls.esc.length, unstick.MAX_CALLS)
    assert.ok(f.calls.chat.some((t) => /please help/.test(t)), f.calls.chat.join('|'))
  })

  it('(d) fight preempts mid-plan: nothing runs after it', async () => {
    const f = fixture(() => ({ plan: [{ op: 'wait', s: 5 }, { op: 'dig', x: 2, y: 64, z: 0 }] }))
    await ticks(f, unstick.NOPATH_TICKS + 2)
    assert.equal(f.calls.esc.length, 1)
    assert.equal(await ticks(f, 1, true), false)
    await new Promise((r) => setTimeout(r, 10))
    await ticks(f, 3)
    assert.equal(f.calls.digs.length, 0)
  })

  it('(e) castle step escalates only once the bot has not moved for BOXED_MS', async () => {
    const f = fixture(() => ({ plan: [{ op: 'wait', s: 0 }] }))
    f.ctx.step = 'castle'
    const clock = Date.now
    let now = clock()
    try {
      Date.now = () => now
      await ticks(f, unstick.NOPATH_TICKS + 2)
      assert.equal(f.calls.esc.length, 0, 'castle owns its own cells until boxed')
      now += 121000
      await ticks(f, 2)
    } finally { Date.now = clock }
    assert.equal(f.calls.esc.length, 1)
  })
})

describe('unstick: no build protection for a stuck episode (owner 2026-11-09)', () => {
  it('digs a default-deny block (wool), the protection yields', async () => {
    const f = fixture(() => ({ plan: [{ op: 'dig', x: 2, y: 64, z: 0 }, { op: 'dig', x: 2, y: 65, z: 0 }, { op: 'walk_to', x: 4, y: 64, z: 0 }] }), 'white_wool')
    await ticks(f, unstick.NOPATH_TICKS + 8)
    assert.deepEqual(f.calls.digs, ['2,64,0', '2,65,0'])
  })
})
