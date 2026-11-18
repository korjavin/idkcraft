'use strict'

// A complete castle rendered from its plan + decor, planned with the
// production-wired Movements and the castle guard: the doorway/gate route
// out stays open, and a bot on its own scaffold pillar in the yard can dig
// down (the yard dig ban used to wall it in: prod noPath around castles).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const blueprint = require('../src/castle')
const castleB = require('../src/behaviours/castle')
const { noteNoPath } = require('../src/nopath-log')

const SITE = { x: 0, y: 64, z: 0 }
const V = blueprint.BLUEPRINT_VERSION
const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', torch: 'torch', stairs: 'cobblestone_stairs', chest: 'chest', pane: 'glass_pane' }
const st = (n) => Block.fromStateId(mcData.blocksByName[n].minStateId, 0)
function world(extra) {
  const m = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) m.set(`${c.x},${c.y},${c.z}`, c)
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) if (!m.has(`${c.x},${c.y},${c.z}`)) m.set(`${c.x},${c.y},${c.z}`, c)
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    if (extra && extra.has(k)) return st(extra.get(k))
    const c = m.get(k)
    if (c) {
      const door = (half) => Block.fromProperties('oak_door', { facing: 'north', half, open: false, hinge: 'left', powered: false }, 0)
      if (c.kind === 'door') return door('lower')
      if (c.kind === 'air') { const b = m.get(`${x},${y - 1},${z}`); return b && b.kind === 'door' ? door('upper') : st('air') }
      if (c.kind === 'dig') return st('water')
      if (c.kind === 'gate') return Block.fromProperties('oak_fence_gate', { facing: 'north', open: false, in_wall: false, powered: false }, 0)
      return st(NAME[c.kind] || 'cobblestone')
    }
    return st(y < 63 ? 'stone' : y === 63 ? 'grass_block' : 'air')
  }
}
function setup(start, extra, ctxExtra) {
  const at = world(extra)
  const bot = {
    registry: mcData, game: { minY: -64 }, time: { timeOfDay: 6000 },
    entity: { effects: [], position: new Vec3(start.x + 0.5, start.y, start.z + 0.5) },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    inventory: { items: () => [] }, setControlState() {}, clearControlStates() {},
    blockAt: (p) => { const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); const b = at(q.x, q.y, q.z); b.position = q; return b },
  }
  const ticker = createTicker({ bot, brain: { async decide() { return { action: 'idle' } } }, tickMs: 10, idleTickMs: 10 })
  const m = new Movements(bot)
  m.allowSprinting = false
  ticker.setMovements(m)
  bot.pathfinder.movements = m
  const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {} }, step: 'castlefetch', ...ctxExtra }
  castleB.guardCastle(bot, ctx)
  return { bot, ctx, m }
}
function plan(start, goal, extra, ctxExtra) {
  const { m } = setup(start, extra, ctxExtra)
  return new AStar(new Move(start.x, start.y, start.z, 0, 0), m, goal, 10000, 20000).compute()
}
const OUT = new goals.GoalNear(15, 64, -20, 1)

describe('complete castle: a walkable route out', () => {
  const D = blueprint.blueprintOf(V).DOOR
  it('from inside the gate hall, through door and gate', () => {
    assert.equal(plan({ x: D.dx, y: 64, z: D.dz + 2 }, OUT).status, 'success')
  })
  it('every ground-storey standable cell reaches outside', () => {
    const at = world()
    const fails = []
    for (let x = -1; x <= 31; x++) for (let z = -1; z <= 27; z++) {
      const f = at(x, 64, z), h = at(x, 65, z), b = at(x, 63, z)
      if (f.boundingBox !== 'empty' || h.boundingBox !== 'empty' || b.boundingBox !== 'block' || /water/.test(f.name)) continue
      const r = plan({ x, y: 64, z }, OUT)
      if (r.status !== 'success') fails.push(`${x},64,${z}`)
    }
    assert.deepEqual(fails, [])
  })
  it('yard dig ban spares own scaffold, keeps foreign yard ground', () => {
    const { m } = setup({ x: 0, y: 64, z: -20 }, null, { placedByBot: new Set(['3,65,13']) })
    const brk = m.exclusionAreasBreak.find((f) => f({ position: new Vec3(3, 65, 13), name: 'dirt' }) !== undefined)
    const fn = (x, y, z) => Math.max(...m.exclusionAreasBreak.map((f) => f({ position: new Vec3(x, y, z), name: 'dirt' }) || 0))
    assert.ok(brk)
    assert.equal(fn(3, 65, 13), 0, 'own scaffold diggable')
    assert.equal(fn(3, 66, 13), 100, 'foreign yard dirt banned')
  })
})

describe('noPath diagnostic line', () => {
  it('names the action, body and goal, rate-limited per goal', () => {
    const { bot, ctx } = setup({ x: 3, y: 64, z: 13 })
    bot.pathfinder.goal = new goals.GoalBlock(15, 64, -20)
    ctx.lastDecision = { action: 'castle' }
    const log = console.log
    console.log = () => {}
    try {
      const s = noteNoPath(bot, ctx, 1e6)
      assert.match(s, /^path noPath action=castle step=castlefetch from=3,64,13 goal=GoalBlock 15,64,-20 dist=\d+ inWater=false feetBlock=air goalBlock=air canDig=true scaffold=0/)
      assert.equal(noteNoPath(bot, ctx, 1e6 + 10000), null)
    } finally { console.log = log }
  })
})
