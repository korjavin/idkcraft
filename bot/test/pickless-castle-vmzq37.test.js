'use strict'

// idkcraft-vmzq.37: prod 2026-10-07 the pick wore out in a forage tunnel
// (y~40); the castle-rule then walked the no-dig body (castle=stone-batch,
// pickaxe=no) and recover could only sidestep/wait — 17 min wedged at
// y=37. A pickless active castle now rearms first (equip crafts the pick,
// table included, through craftany), and a pack that cannot fund one
// leaves the bare-hand stone staircase (recover dig_step).

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

const craftanyPath = require.resolve('../src/behaviours/craftany')
const realCraftany = require(craftanyPath)
const goal = require('../src/goal')
const equip = require('../src/behaviours/equip')
const recover = require('../src/behaviours/recover')

let planOk = true
let craftResult = null
const crafted = []
const stub = Object.assign((bot, ctx, names, n) => {
  crafted.push([...names])
  return craftResult || { done: true, target: names[0] }
}, { planCraft: () => (planOk ? { ok: true } : { ok: false, fail: 'missing' }) })
require.cache[craftanyPath].exports = stub
after(() => { require.cache[craftanyPath].exports = realCraftany })

const CASTLE = { castle: { site: { x: 300, y: 64, z: 300 }, phase: 'build' } }
const R = { time: 'day', pickaxe: 0, rearm: true }

describe('pickless buried castle rearms first (vmzq.37)', () => {
  it('goalFsm puts equip ahead of the castle legs only on facts.rearm', () => {
    assert.equal(goal.goalFsm(R, ['castle', 'equip', 'rest']), 'equip')
    assert.equal(goal.goalFsm(R, ['castlefetch', 'equip', 'rest']), 'equip')
    assert.equal(goal.goalFsm({ ...R, rearm: false }, ['castle', 'equip', 'rest']), 'castle', 'vmzq.19: at the site the batch lays first')
    assert.equal(goal.goalFsm(R, ['castle', 'rest']), 'castle', 'no feasible equip: castle as before')
  })

  it('chooseStep makes the rearm a castle rule — the model is not asked', async () => {
    let asked = 0
    const brain = { source: 'laya', ask: async () => { asked++; return 'castle' } }
    const r = await goal.chooseStep(brain, R, ['castle', 'equip', 'rest'], null)
    assert.equal(r.step, 'equip')
    assert.equal(r.source, 'castle-rule')
    assert.equal(asked, 0)
  })

  it('pickRearmDue: pickless, castle active, underground, funded', () => {
    const at = (y, items = []) => ({ entity: { position: new Vec3(0, y, 0) }, inventory: { items: () => items } })
    planOk = true
    assert.equal(equip.pickRearmDue(at(37), { ...CASTLE }), true)
    assert.equal(equip.pickRearmDue(at(64), { ...CASTLE }), false, 'at the site floor: castle lays first')
    assert.equal(equip.pickRearmDue(at(37, [{ name: 'wooden_pickaxe', count: 1 }]), { ...CASTLE }), false)
    assert.equal(equip.pickRearmDue(at(37), {}), false, 'no castle')
    planOk = false
    assert.equal(equip.pickRearmDue(at(37), { ...CASTLE }), false, 'unfunded: the old table gate stands')
    planOk = true
    const facts = { time: 'day', pickaxe: 0, sword: 1, table: 0, tablePlaced: false, planks: 9, scaffold: 40 }
    assert.equal(goal.MENU.equip.feasible({ ...facts, rearm: true }, at(37), { ...CASTLE }), true)
  })

  it('equip crafts the pick through craftany when buried pickless', () => {
    crafted.length = 0
    planOk = true
    const bot = { entity: { position: new Vec3(0, 37, 0) }, inventory: { items: () => [{ name: 'oak_planks', count: 9 }] } }
    const ctx = { ...CASTLE, step: 'equip' }
    equip(bot, ctx)
    assert.deepEqual(crafted, [['stone_pickaxe', 'wooden_pickaxe']])
  })

  it('a failed rearm is a spot verdict, never the equip day latch', () => {
    planOk = true
    craftResult = { done: false, line: 'need a crafting table' }
    const bot = { entity: { position: new Vec3(0, 37, 0) }, time: { day: 1, timeOfDay: 6000 }, inventory: { items: () => [{ name: 'oak_planks', count: 9 }] } }
    const ctx = { ...CASTLE, step: 'equip' }
    try {
      for (let i = 0; i < 3; i++) {
        ctx.stepStatus = null
        equip(bot, ctx)
        assert.equal(ctx.stepStatus, 'failed:equip-pickaxe')
      }
      assert.equal(equip.equipLatched(ctx, bot), false)
    } finally { craftResult = null }
  })

  it('craftany under craftanyLocal ignores a standing table out of reach', () => {
    const table = { x: 0, y: 57, z: 0 }
    const bot = {
      entity: { position: new Vec3(0.5, 37, 0.5) },
      blockAt: (q) => ({ name: Math.floor(q.y) === 57 ? 'crafting_table' : 'stone', position: q }),
    }
    const ctx = { claimedTable: table }
    assert.ok(realCraftany.standingTable(bot, ctx), 'normal crafts walk to it')
    ctx.craftanyLocal = true
    assert.equal(realCraftany.standingTable(bot, ctx), null, 'the buried rearm places its own')
    bot.entity.position = new Vec3(0.5, 55, 0.5)
    assert.ok(realCraftany.standingTable(bot, ctx), 'in reach it still counts')
  })

  it('decide: buried pickless body rearms even over a castle plan pin; at the site the batch lays', async () => {
    planOk = true
    const p = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone() { return p(x, y, z) }, floored() { return p(Math.floor(x), Math.floor(y), Math.floor(z)) } })
    const SITE = { x: 100, y: 64, z: 200 }
    const mk = (y) => ({
      username: 'IdkBot', chats: [], chat() {},
      entity: { position: p(SITE.x - 12, y, SITE.z) },
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 16 }, { name: 'stone_sword', count: 1 }] },
      time: { timeOfDay: 6000, day: 1 }, spawnPoint: p(0, 64, 0), players: {},
      blockAt: (q) => ({ name: Math.floor(q.y) <= 63 ? 'stone' : 'air', position: q, boundingBox: Math.floor(q.y) <= 63 ? 'block' : 'empty' }),
      pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
      clearControlStates() {}, on() {}, once() {},
    })
    const castle = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false })
    assert.equal((await goal.decide(mk(39), { castle: castle() })).action, 'equip', 'buried: rearm first')
    assert.equal((await goal.decide(mk(39), { castle: castle(), taskPlanStep: 'castle' })).action, 'equip', 'a castle plan pin yields to the rearm')
    assert.equal((await goal.decide(mk(64), { castle: castle() })).action, 'castle', 'vmzq.19: at the site the batch lays first')
  })
})

describe('bare-hand stone staircase (vmzq.37)', () => {
  // A 1x2 stone pocket 30 below a far level goal: no scaffold, no pickaxe.
  function pocketBot() {
    const air = new Set(['0,37,0', '0,38,0'])
    return {
      username: 'IdkBot',
      players: {},
      entity: { position: new Vec3(0.5, 37, 0.5), onGround: true },
      inventory: { items: () => [] },
      blockAt(p) {
        const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
        const open = air.has(`${x},${y},${z}`)
        return { name: open ? 'air' : 'stone', position: new Vec3(x, y, z), boundingBox: open ? 'empty' : 'block' }
      },
    }
  }

  it('a buried pickless body digs a stone step by hand toward the surface', () => {
    const bot = pocketBot()
    const f = recover.recoverFacts(bot, { stuck: { by: 'castle', goal: { x: 300, y: 37, z: 0 } } }, null, null)
    assert.equal(f.pickaxe, false)
    assert.equal(f.walls, 4)
    assert.ok(f.digStep, 'stone side reads as a hand staircase')
    const names = Object.keys(recover.RECOVER_MENU).filter((n) => recover.RECOVER_MENU[n].feasible(f, {}))
    assert.ok(names.includes('dig_step'))
    assert.equal(recover.recoverFsm(f, names), 'dig_step')
    assert.equal(recover.RECOVER_MENU.dig_step.repeatable(f), true, 'the climb chains to the mouth')
  })
})

describe('buried pocket run (vmzq.37)', () => {
  it('the first staircase dig opens the jump head, then the side', async () => {
    // Body at y=37 in a sealed stone mass, 1x2 air: (0,39,0) is the head.
    const air = new Set(['0,37,0', '0,38,0'])
    const dug = []
    const bot = {
      username: 'IdkBot', players: {}, entities: {}, health: 20, food: 20,
      entity: { position: new Vec3(0.5, 37, 0.5), onGround: true },
      inventory: { items: () => [] },
      controls: {},
      setControlState(c, v) { this.controls[c] = !!v },
      getControlState(c) { return !!this.controls[c] },
      clearControlStates() { this.controls = {} },
      blockAt(q) {
        const x = Math.floor(q.x); const y = Math.floor(q.y); const z = Math.floor(q.z)
        const open = air.has(`${x},${y},${z}`)
        return { name: open ? 'air' : 'stone', position: new Vec3(x, y, z), boundingBox: open ? 'empty' : 'block' }
      },
      async dig(b) { await Promise.resolve(); dug.push(`${b.position.x},${b.position.y},${b.position.z}`); air.add(`${b.position.x},${b.position.y},${b.position.z}`) },
      pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
      chats: [], chat(m) { this.chats.push(String(m)) },
    }
    const ctx = { stuck: { by: 'castle', goal: { x: 300, y: 37, z: 0 }, key: 'castle' }, brain: null }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'dig_step')
    for (let t = 0; t < 6 && dug.length < 2; t++) {
      recover.run(bot, ctx)
      for (let i = 0; i < 3; i++) await new Promise((res) => setImmediate(res))
    }
    assert.equal(dug[0], '0,39,0', `head first, dug ${dug}`)
    assert.ok(dug.length >= 2 && dug[1] !== '0,39,0', `then the side, dug ${dug}`)
  })
})
