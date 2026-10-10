'use strict'

// Bead idkcraft-g0z.52: after an empty-kit respawn 225 blocks from a complete
// castle, the goal facts read beds=none although both beds stand — the beds
// step (the only claim writer) never ran, so no claims existed and the dark
// canonical cells scanned as missing. The facts read adopts visible beds on
// sight, so a later dark read trusts the claims instead of opening a
// spurious wool quest.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const goal = require('../src/goal')
const residence = require('../src/residence')

const SITE = { x: 10, y: 64, z: 20 }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

function mockBot({ cells = {}, dark = false } = {}) {
  const world = new Map(Object.entries(cells))
  return {
    username: 'IdkBot',
    health: 20,
    food: 20,
    entity: { position: new Vec3(SITE.x + 0.5, SITE.y, SITE.z + 0.5) },
    players: {},
    entities: {},
    time: { timeOfDay: 6000, day: 5 },
    inventory: { items: () => [] },
    blockAt: (p) => {
      if (dark) return null
      const k = key(p.x, p.y, p.z)
      const name = world.has(k) ? world.get(k) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    chat: () => {},
  }
}

function v2home(over = {}) {
  return { site: { ...SITE }, built: true, v: 2, ...over }
}

function castleHome() {
  return residence.castleHome({ site: { ...SITE }, rot: 0, blueprintVersion: 2 })
}

// Whole beds (foot + head) at the residence's canonical cells.
function paintBeds(home, n = 2) {
  const cells = {}
  for (const b of residence.of(home).beds(home).slice(0, n)) {
    for (const p of [b.foot, b.head]) cells[key(p.x, p.y, p.z)] = 'red_bed'
  }
  return cells
}

describe('g0z.52 post-respawn bed facts', () => {
  it('house: standing beds adopt on sight, the dark re-read trusts the claims', () => {
    const home = v2home()
    const ctx = { home }
    const seen = goal.goalFacts(mockBot({ cells: paintBeds(home) }), ctx)
    assert.equal(seen.beds, 'both')
    assert.deepEqual({ x: home.bedA.x, y: home.bedA.y, z: home.bedA.z }, { x: 11, y: 64, z: 24 })
    assert.deepEqual({ x: home.bedB.x, y: home.bedB.y, z: home.bedB.z }, { x: 14, y: 64, z: 24 })
    // The respawn 225 blocks out: canonical cells dark, claims trusted.
    const dark = goal.goalFacts(mockBot({ dark: true }), ctx)
    assert.equal(dark.beds, 'both')
    assert.equal(goal.MENU.beds.feasible(dark, mockBot({ dark: true }), ctx), false)
  })

  it('castle: seeded beds adopt on sight, the dark re-read stays both', () => {
    const home = castleHome()
    const ctx = { home }
    const seen = goal.goalFacts(mockBot({ cells: paintBeds(home) }), ctx)
    assert.equal(seen.beds, 'both')
    assert.ok(home.bedA && typeof home.bedA.x === 'number', 'bed A claimed')
    assert.ok(home.bedB && typeof home.bedB.x === 'number', 'bed B claimed')
    const dark = goal.goalFacts(mockBot({ dark: true }), ctx)
    assert.equal(dark.beds, 'both')
    assert.equal(goal.MENU.beds.feasible(dark, mockBot({ dark: true }), ctx), false)
  })

  it('one standing bed adopts; the dark re-read keeps one, not none', () => {
    const home = v2home()
    const ctx = { home }
    const seen = goal.goalFacts(mockBot({ cells: paintBeds(home, 1) }), ctx)
    assert.equal(seen.beds, 'one')
    assert.ok(home.bedA && !home.bedB, 'only the standing bed claims')
    assert.equal(goal.goalFacts(mockBot({ dark: true }), ctx).beds, 'one')
  })

  it('genuinely missing beds still read none, light or dark without a prior sight', () => {
    // Light and empty: the beds step runs (the normal bedless flow).
    const home = v2home()
    const ctx = { home }
    const facts = goal.goalFacts(mockBot({}), ctx)
    assert.equal(facts.beds, 'none')
    assert.equal(goal.MENU.beds.feasible(facts, mockBot({}), ctx), true)
    // Dark with no sight ever (a wool hunt ranging past chunk range): still
    // none, so a facts-changed re-decision never preempts the running hunt.
    const far = v2home()
    assert.equal(goal.goalFacts(mockBot({ dark: true }), { home: far }).beds, 'none')
    assert.ok(!far.bedA && !far.bedB, 'dark adopts nothing')
  })
})
