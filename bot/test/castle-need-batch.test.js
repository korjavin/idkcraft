'use strict'

// Prod bot3 76c57f1b (2026-11-17): 1 cell missing, torch-batch x87,
// castle<->gocastle, torches placed 0, floor holes flat at 2096. The batch
// word is capped by the cells' need (reserve included), a step that cannot
// lay fills the floor, and dark cells stay inside the gocastle leash.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const plan = blueprint.absPlan(SITE, 0, V)

function painted(missing) {
  const cells = new Map()
  for (const c of plan.cells) cells.set(key(c.x, c.y, c.z), blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  if (missing) cells.set(key(missing.x, missing.y, missing.z), 'air')
  return cells
}
function hole(cells) {
  for (let dx = 0; dx < 31; dx++) for (let dz = 0; dz < 27; dz++) {
    const k = key(SITE.x + dx, SITE.y - 1, SITE.z + dz)
    if (!plan.at.has(k)) { cells.set(k, 'air'); return }
  }
}
function worldBot(cells, items) {
  return {
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      const name = cells.has(k) ? cells.get(k) : (p.y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' || name === 'torch' ? 'empty' : 'block', light: 15 }
    },
  }
}
const own = () => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'body', blocked: {} })
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn() } finally { console.log = o } }

describe('castle batch capped by need', () => {
  it('1 torch cell missing with 4 torches: the word is a batch and the step lays it', () => {
    const torch = plan.cells.find((c) => c.kind === 'torch')
    const bot = worldBot(painted(torch), [{ name: 'torch', count: 4 }])
    const ctx = { castle: own() }
    assert.equal(quiet(() => castle.menuFact(bot, ctx, Date.now())), 'torch-batch')
    assert.equal(ctx.castleWord.left, 1)
    quiet(() => castle(bot, ctx))
    assert.equal(ctx.castle.status, 'building')
  })
  it('a reserve never blocks the last cells: 1 plank for 1 planks cell lays', () => {
    const pl = plan.cells.find((c) => c.kind === 'planks')
    const bot = worldBot(painted(pl), [{ name: 'oak_planks', count: 1 }])
    const ctx = { castle: own() }
    assert.equal(quiet(() => castle.menuFact(bot, ctx, Date.now())), 'planks-batch')
    assert.ok(castle.usable(bot, 'planks', ctx) < 1, 'below the reserve without need')
  })
  it('a batch wait runs the floor fill instead of failing', () => {
    const planks = plan.cells.find((c) => c.kind === 'planks')
    const cells = painted(planks)
    hole(cells)
    const bot = worldBot(cells, [{ name: 'dirt', count: 64 }])
    const ctx = { castle: own() }
    assert.equal(quiet(() => castle.menuFact(bot, ctx, Date.now())), 'planks-none', 'none keeps the fetch')
    quiet(() => castle(bot, ctx))
    assert.equal(ctx.castle.status, 'filling a floor hole')
    assert.notEqual(ctx.stepStatus, 'failed:no-planks')
  })
  it('dark cells past the gocastle leash are not targets', () => {
    const bot = { blockAt: (p) => ({ name: p.y === 63 ? 'stone' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty', light: 0 }) }
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blocked: {} }
    const ctx = { danger: { spots: [{ x: 15 + 80, y: 64, z: 13, at: Date.now(), r: 16 }] } }
    const list = quiet(() => castle.darkTargets(bot, ctx, st, Date.now()))
    assert.ok(list.length > 0)
    assert.ok(list.every((c) => Math.hypot(c.x - 15, c.z - 13) <= 60), 'every target inside the leash')
  })
})
