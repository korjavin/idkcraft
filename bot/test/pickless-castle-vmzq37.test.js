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
const crafted = []
const stub = Object.assign((bot, ctx, names, n) => {
  crafted.push([...names])
  return { done: true, target: names[0] }
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
