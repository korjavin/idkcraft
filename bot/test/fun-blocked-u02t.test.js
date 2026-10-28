'use strict'

// Blocked-bypass (idkcraft-u02t): fun runs on the idle pins alone when the
// menu holds no runnable productive step — every work step held, parked,
// latched or failed — even with owed work on the books. While any
// productive step could run, the owed vetoes stand (no cannibalization),
// and the safety pins (night, threat, paused, orders) never lift.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fun = require('../src/behaviours/fun')
const goal = require('../src/goal')
const consts = require('../src/plan-consts')
fun.registerInto(goal, consts)

function botWith(items, extra = {}) {
  const inv = items.map((i) => ({ type: 1, ...i }))
  return {
    inv,
    inventory: { items: () => inv },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 } },
    entities: {},
    players: {},
    blockAt: (p) => {
      const y = Math.floor(p.y)
      if (y <= 63) return { name: 'dirt', position: { x: Math.floor(p.x), y, z: Math.floor(p.z) } }
      return { name: 'air', position: { x: Math.floor(p.x), y, z: Math.floor(p.z) } }
    },
    ...extra,
  }
}

const facts = (over = {}) => ({
  time: 'day', castle: 'none', player: 'none', home: 'built', known: 'none',
  haul: 'none', surplus: 'no', pinned: 'none', beds: 'both', gear: 'done',
  sword: 1, pickaxe: 1, logs: 0, unlit: 0, torches: 0, rearm: false,
  maxPlanks: 0, table: 0, door: 0, scaffold: 16,
  chest: 'yes', chestTodo: 'none', gearHandover: 'none',
  coal: 0, charcoal: 0, sticks: 0,
  ...over,
})
const kit = [{ name: 'dirt', count: 20 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }]

function idleCtx(over = {}) {
  return { step: 'rest', funIdleSince: Date.now() - fun.FUN_IDLE_MS - 60000, ...over }
}

// Owed on the books: beds missing, gear ladder open, table owed — while
// the steps that would do that work cannot run (beds wool-latched, craft
// parked out, the gear plan stubbed done).
const owedFacts = (over = {}) => facts({ beds: 'none', gear: 'ready', maxPlanks: 8, tableOwed: true, ...over })
const blockedCtx = (over = {}) => idleCtx({
  beds: { noWool: { at: Date.now(), fails: 99 } },
  home: { parked: true },
  ...over,
})

describe('fun blocked-bypass (u02t)', () => {
  it('rest-only menu with owed beds/gear/table stays feasible', () => {
    const f = owedFacts()
    const c = blockedCtx()
    const b = botWith(kit)
    const names = Object.keys(goal.MENU).filter((n) => {
      try { return goal.MENU[n].feasible(f, b, c) } catch (_) { return false }
    })
    assert.deepEqual(names.filter((n) => n !== 'fun'), ['rest'], `menu=${names.join(',')}`)
    assert.equal(fun.menuBlocked(f, b, c), true)
    assert.equal(goal.MENU.fun.feasible(f, b, c), true)
  })
  it('a runnable productive step with owed work stays infeasible (no cannibalization)', () => {
    // Same owed books, free menu: beds and craft can run.
    const f = owedFacts()
    const c = idleCtx()
    const b = botWith(kit)
    const names = Object.keys(goal.MENU).filter((n) => {
      try { return goal.MENU[n].feasible(f, b, c) } catch (_) { return false }
    })
    assert.ok(names.includes('beds') || names.includes('craft'), `menu=${names.join(',')}`)
    assert.equal(fun.menuBlocked(f, b, c), false)
    assert.equal(goal.MENU.fun.feasible(f, b, c), false)
  })
  it('night and threat still veto even when blocked', () => {
    assert.equal(
      goal.MENU.fun.feasible(owedFacts({ time: 'night' }), botWith(kit), blockedCtx()),
      false)
    const threat = botWith(kit)
    threat.entities = { 7: { type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 }, isValid: true } }
    threat.entity.position.distanceTo = () => 3
    assert.equal(goal.MENU.fun.feasible(owedFacts(), threat, blockedCtx()), false)
  })
})
