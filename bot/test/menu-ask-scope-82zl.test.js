'use strict'

// Prod menu-ask scoping (idkcraft-82zl fix, revmux 01-review major): the
// opt-in prod brain carries menuAsk() for chooseStep only. Retreat, recover
// and bring read brain.ask — which the prod brain leaves off — so they keep
// the FSM even when the classifier ask is on. call_player never fires from
// a model path: chooseRecovery filters it from the sync ask menu (the
// askMenu plan-path rule) unless the FSM picks it.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBrain, JEV_ENDPOINT } = require('../src/brain')
const { feasibleRetreat, chooseRetreat } = require('../src/behaviours/retreat')
const recover = require('../src/behaviours/recover')
const bring = require('../src/behaviours/bring')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

function zombie(id, x, y, z) {
  return { id, name: 'zombie', type: 'mob', position: pos(x, y, z), isValid: true }
}

// Open field: solid floor y<=63, air above (retreat.test.js fixture, minimal).
function fieldBot({ items = [], entities = {} } = {}) {
  const ground = new Set()
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) ground.add(key(x, 63, z))
  }
  const calls = { chats: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities,
    health: 3,
    food: 20,
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => items },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = ground.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
    setControlState: () => {},
    clearControlStates: () => {},
    getControlState: () => false,
    chat: (l) => { calls.chats.push(String(l)) },
  }
  return bot
}

const RETREAT_STATE = { bot_health: 3, hostile_distance: 1.5, nearby_hostiles: 3 }

let origFetch = null
let fetchCalls = 0
beforeEach(() => {
  fetchCalls = 0
  origFetch = global.fetch
  global.fetch = async () => { fetchCalls++; throw new Error('model must not be consulted') }
})
afterEach(() => {
  global.fetch = origFetch
})

function prodBrainOff() {
  // Switch off (default): stub + planner, no ask, no menuAsk.
  return makeBrain({ TYPESAFE_API_KEY: 'k' })
}

function prodBrainOn() {
  // Switch on: classifier menuAsk wired, shared ask still off.
  return makeBrain({ TYPESAFE_API_KEY: 'k', BOT_MENU_ASK: '1' })
}

describe('prod menu-ask scope (82zl fix)', () => {
  it('retreat never consults a model, switch off or on', async () => {
    for (const brain of [prodBrainOff(), prodBrainOn()]) {
      assert.equal(brain.ask, undefined, 'prod brain carries no shared ask')
      const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
      assert.deepEqual(feasibleRetreat(bot, {}, RETREAT_STATE), ['retreat', 'pillar'])
      const ctx = { lastGoalKey: '', stepStatus: null, goalText: null, home: null, brain: null }
      const r = await chooseRetreat(brain, bot, ctx, RETREAT_STATE)
      assert.equal(r.action, 'retreat')
      assert.equal(r.source, 'fsm', 'two-option menu falls back to the FSM rank')
      assert.equal(r.model, null, 'no model consulted')
    }
    assert.equal(fetchCalls, 0, 'no model call on either switch position')
  })

  it('recover never consults a model, switch off or on', async () => {
    const facts = {
      goalDy: 3, goalDist: 3, scaffold: 0, pickaxe: false, bucket: 2, water: false,
      headBlocked: false, walls: 4, pit: true, playerOnline: false, playerDist: null,
      stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'water_up:failed',
    }
    for (const brain of [prodBrainOff(), prodBrainOn()]) {
      const r = await recover.chooseRecovery(brain, facts, ['water_up', 'sidestep', 'wait'])
      assert.equal(r.action, 'sidestep', 'FSM answer survives')
      assert.ok(r.source === 'fsm' || r.source === 'only-option', `FSM source, got ${r.source}`)
      assert.equal(r.model, null, 'no model consulted')
    }
    assert.equal(fetchCalls, 0, 'no model call on either switch position')
  })

  it('bring search and source never consult a model, switch off or on', async () => {
    const exposed = { kind: 'memory', name: 'iron_ore', pos: pos(0, 64, 0), distH: 30, dist: 30, cost: 11.25, ageMs: null }
    const buried = { kind: 'buried', name: 'iron_ore', pos: pos(0, 64, 0), distH: 0, dist: 0, cost: 6, ageMs: null, depthBelow: 3 }
    for (const brain of [prodBrainOff(), prodBrainOn()]) {
      const s = await bring.chooseBringSearch(brain, 'search=food legs=1/4 last=empty', 3)
      assert.equal(s.action, 'search_more')
      assert.equal(s.source, 'fsm')
      assert.equal(s.model, null, 'no model consulted')
      const o = await bring.chooseBringSource(brain, 'source=iron walk:11.2s dig:6.0s', exposed, buried, {})
      assert.equal(o.action, 'walk_exposed')
      assert.equal(o.source, 'fsm', `no ask method: FSM reserve, got ${o.source}`)
      assert.equal(o.model, null, 'no model consulted')
    }
    assert.equal(fetchCalls, 0, 'no model call on either switch position')
  })

  it('call_player never fires from a model path: filtered from the ask menu unless the FSM picks it', async () => {
    // Player online and call_player feasible, but the FSM climbs: the ask
    // menu must not offer the page, so even a model answering call_player
    // falls back to the FSM pick.
    const facts = {
      goalDy: 3, goalDist: 3, scaffold: 0, pickaxe: false, bucket: 2, water: false,
      headBlocked: false, walls: 4, pit: true, playerOnline: true, playerDist: 40,
      stuckTicks: 12, resetsStuck: 0, resetsPlaceError: 0, last: 'water_up:failed',
    }
    assert.notEqual(recover.recoverFsm(facts, ['water_up', 'sidestep', 'call_player', 'wait']), 'call_player')
    let seen = null
    const paging = { source: 'testmodel', ask: async (q) => { seen = Object.keys(q.criteria); return 'call_player' } }
    const r = await recover.chooseRecovery(paging, facts, ['water_up', 'sidestep', 'call_player', 'wait'])
    assert.ok(!seen.includes('call_player'), `model menu never offers the page: ${seen}`)
    assert.notEqual(r.action, 'call_player', 'model cannot page the owner')
    assert.equal(r.source, 'stub-fallback')
  })

  it('call_player stays askable when it is the FSM pick', async () => {
    // The filter keeps the page on the menu when the FSM itself pages
    // (high goal, enclosed pit, player online, no climb primitive): the A/B
    // page regression is about the model paging first, not the FSM last.
    const facts = {
      goalDy: 8, goalDist: 2, scaffold: 0, pickaxe: false, bucket: 0, water: false,
      headBlocked: true, walls: 4, pit: true, playerOnline: true, playerDist: 40,
      stuckTicks: 40, resetsStuck: 3, resetsPlaceError: 0, last: 'none',
    }
    const names = ['sidestep', 'wait', 'call_player']
    assert.equal(recover.recoverFsm(facts, names), 'call_player')
    let seen = null
    const brain = { source: 'testmodel', ask: async (q) => { seen = Object.keys(q.criteria); return 'call_player' } }
    const r = await recover.chooseRecovery(brain, facts, names)
    assert.ok(seen.includes('call_player'), 'FSM-picked page stays on the menu')
    assert.equal(r.action, 'call_player')
    assert.equal(r.source, 'testmodel')
  })
})
