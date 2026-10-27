'use strict'

// idkcraft-pjsl: door/gate discipline — the bot dug castle floor/fence for
// transit instead of routing through doors/gates, and the holes stayed.
// 1. v1 break guard covers peer/known castles (laid cells + yard), not just
//    the own project — a castleless/swarm/visiting bot's A* no longer reads
//    a peer floor as empty ground.
// 2. Below-grade transit holes (no plan cell) are backfilled on a complete
//    castle with the prep-fill material; the menu words 'clear' for them
//    only while material is on hand (silent otherwise).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const own = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })
const peer = (extra) => ({ site: { x: 500, y: 64, z: 600 }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })
const block = (x, y, z, name) => ({ position: { x, y, z }, name })

function mov() { return { exclusionAreasBreak: [], exclusionAreasPlace: [] } }
function guardCtx(ctx) {
  const m = mov()
  castle.guardCastle({ pathfinder: { movements: m } }, ctx)
  return m.exclusionAreasBreak[0]
}

describe('pjsl peer break guard', () => {
  // a laid PLAN stone cell of the peer castle
  const laid = blueprint.absPlan(peer().site, 0, V).cells.find((c) => c.kind === 'stone')
  it('vetoes a peer laid floor cell with no own project', () => {
    const fn = guardCtx({ castle: null, knownCastles: [peer()] })
    assert.equal(fn(block(laid.x, laid.y, laid.z, 'cobblestone')), 100)
  })
  it('vetoes a peer laid fence cell', () => {
    const fence = blueprint.absPlan(peer().site, 0, V).cells.find((c) => c.kind === 'fence')
    const fn = guardCtx({ castle: null, knownCastles: [peer()] })
    assert.equal(fn(block(fence.x, fence.y, fence.z, 'oak_fence')), 100)
  })
  it('vetoes peer yard dirt, leaves far dirt open', () => {
    const p = peer().site
    const at = blueprint.absPlan(p, 0, V).at
    let yard = null
    for (let dy = 0; dy <= 3 && !yard; dy++) {
      for (let dx = 0; dx < 31 && !yard; dx++) {
        for (let dz = 0; dz < 27 && !yard; dz++) {
          const k = `${p.x + dx},${p.y + dy},${p.z + dz}`
          if (!at.has(k)) yard = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
        }
      }
    }
    assert.ok(yard, 'a non-plan yard cell exists')
    const fn = guardCtx({ castle: null, knownCastles: [peer()] })
    assert.equal(fn(block(yard.x, yard.y, yard.z, 'dirt')), 100, 'peer yard dig vetoed')
    assert.equal(fn(block(0, 64, 0, 'dirt')), 0, 'far dirt still diggable')
  })
  it('still vetoes peer laid cells for the own castle step (borrowed or not)', () => {
    const bot = { pathfinder: { goal: null, movements: mov() } }
    const m = bot.pathfinder.movements
    castle.guardCastle(bot, { castle: own(), step: 'castle', castleGoal: null, knownCastles: [own(), peer()] })
    const fn = m.exclusionAreasBreak[0]
    assert.equal(fn(block(laid.x, laid.y, laid.z, 'cobblestone')), 100, 'peer laid stays vetoed on the own step')
  })
  it('the own step keeps its own-walk dig freedom in the own yard', () => {
    const bot = { pathfinder: { goal: null, movements: mov() } }
    const m = bot.pathfinder.movements
    const st = own()
    castle.guardCastle(bot, { castle: st, step: 'castle', castleGoal: null, knownCastles: [st] })
    const fn = m.exclusionAreasBreak[0]
    const at = blueprint.absPlan(SITE, 0, V).at
    let yard = null
    for (let dy = 0; dy <= 3 && !yard; dy++) {
      for (let dx = 0; dx < 31 && !yard; dx++) {
        for (let dz = 0; dz < 27 && !yard; dz++) {
          const k = `${SITE.x + dx},${SITE.y + dy},${SITE.z + dz}`
          if (!at.has(k)) yard = { x: SITE.x + dx, y: SITE.y + dy, z: SITE.z + dz }
        }
      }
    }
    assert.ok(yard, 'a non-plan own-yard cell exists')
    assert.equal(fn(block(yard.x, yard.y, yard.z, 'dirt')), 0, 'own step still cuts its own yard')
  })
  it('control: the own laid floor stays vetoed', () => {
    const ownLaid = blueprint.absPlan(SITE, 0, V).cells.find((c) => c.kind === 'stone')
    const fn = guardCtx({ castle: own() })
    assert.equal(fn(block(ownLaid.x, ownLaid.y, ownLaid.z, 'cobblestone')), 100)
  })
})

const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const DECOR_LAID = { pane: 'glass_pane', banner: 'white_wall_banner', gate: 'oak_fence_gate', bookshelf: 'bookshelf', enchanting_table: 'enchanting_table', blast_furnace: 'blast_furnace', fence: 'oak_fence' }
function painted() {
  const cells = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) {
    cells.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) {
    if (DECOR_LAID[c.kind]) cells.set(`${c.x},${c.y},${c.z}`, DECOR_LAID[c.kind])
  }
  return cells
}
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
function worldBot(cells, items = [{ name: 'dirt', count: 64 }]) {
  return {
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
// a below-grade non-plan air pocket (a transit underpassage)
function holed() {
  const cells = painted()
  const at = blueprint.absPlan(SITE, 0, V).at
  let hole = null
  for (let dx = 0; dx < 31 && !hole; dx++) {
    for (let dz = 0; dz < 27 && !hole; dz++) {
      for (let dd = 1; dd <= 4 && !hole; dd++) {
        const k = `${SITE.x + dx},${SITE.y - dd},${SITE.z + dz}`
        if (!at.has(k)) hole = { x: SITE.x + dx, y: SITE.y - dd, z: SITE.z + dz }
      }
    }
  }
  assert.ok(hole, 'a below-grade non-plan cell exists')
  cells.set(key(hole.x, hole.y, hole.z), 'air')
  return { cells, hole }
}

describe('pjsl transit backfill', () => {
  it('lists a below-grade non-plan air cell, skips plan cells and the sill', () => {
    const { cells, hole } = holed()
    const bot = worldBot(cells)
    const ctx = { castle: own() }
    const list = castle.fillTargets(bot, ctx, ctx.castle, Date.now())
    assert.ok(list.some((c) => c.x === hole.x && c.y === hole.y && c.z === hole.z), 'the hole is listed')
    assert.ok(list.every((c) => !blueprint.absPlan(SITE, 0, V).at.has(`${c.x},${c.y},${c.z}`)), 'no plan cell listed')
    for (const c of list) assert.ok(c.idx >= castle.FILL_BASE && c.idx < 3000000, 'fill idx space')
  })
  it('a laid world lists nothing; moat dig cells never list', () => {
    const bot = worldBot(painted())
    const ctx = { castle: own() }
    assert.equal(castle.fillTargets(bot, ctx, ctx.castle, Date.now()).length, 0)
  })
  it('nextFill skips backing-off and retired cells', () => {
    const { cells } = holed()
    const bot = worldBot(cells)
    const now = Date.now()
    const ctx = { castle: own() }
    const list = castle.fillTargets(bot, ctx, ctx.castle, now)
    assert.ok(list.length > 0)
    const first = castle.nextFill(ctx.castle, list, now)
    assert.ok(first, 'a workable cell')
    ctx.castle.blocked = { [`2:${first.idx}`]: { tries: 1, until: now + 60000 } }
    const second = castle.nextFill(ctx.castle, list, now)
    assert.ok(!second || second.idx !== first.idx, 'backing-off cell skipped')
  })
  it("menuFact words 'clear' with fill material, stays silent without", () => {
    const { cells } = holed()
    const now = Date.now()
    const st = own({ visitedAt: now })
    assert.equal(castle.menuFact(worldBot(cells), { castle: st }, now), 'clear', 'worded with dirt on hand')
    const st2 = own({ visitedAt: now })
    assert.equal(castle.menuFact(worldBot(cells, []), { castle: st2 }, now), 'done', 'silent with an empty pack')
  })
})
