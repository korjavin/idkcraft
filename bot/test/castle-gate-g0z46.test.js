'use strict'

// idkcraft-g0z.46: the castle gate in the fence-ring gap (dx 14..16, dz 0).
// Decor: posts at dx 14/16 (dy 0 + the dy 1 second row) and one fence gate
// at (15,0,0) faced along the walkway (+z), placed looking along it. The
// pathfinder crosses a gate (open or shut) through the doors.js edge and
// the reflex opens/shuts it like a door; mobs cannot open it.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const doors = require('../src/doors')
const { createTicker } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const settle = () => new Promise((r) => setImmediate(r))
const GAP = blueprint.DECOR[2].filter((c) => c.dz === 0 && c.dx >= 14 && c.dx <= 16)

describe('castle gate plan (g0z.46)', () => {
  it('the gap closes: 4 posts then one gate faced along z, appended last', () => {
    const tail = blueprint.DECOR[2].slice(-5)
    assert.deepEqual(tail, GAP)
    assert.deepEqual(tail.map((c) => `${c.kind}@${c.dx},${c.dy},${c.dz}`),
      ['fence@14,0,0', 'fence@16,0,0', 'fence@14,1,0', 'fence@16,1,0', 'gate@15,0,0'])
    assert.deepEqual(tail[4].face, { dx: 0, dz: 1 })
    assert.equal(blueprint.DECOR[3], blueprint.DECOR[2], 'v3 shares the decor')
    assert.ok(!blueprint.BLUEPRINTS[2].PLAN.some((c) => c.kind === 'gate'), 'PLAN stays frozen')
    // The ring now closes: every dz-0 column 0..30 holds a plan or decor fence/gate at dy 0.
    const ring = new Set(blueprint.BLUEPRINTS[2].PLAN.filter((c) => c.kind === 'fence' && c.dz === 0).map((c) => c.dx))
    for (const c of GAP) if (c.dy === 0) ring.add(c.dx)
    for (let x = 0; x < blueprint.BLUEPRINTS[2].W; x++) assert.ok(ring.has(x), `ring hole at dx ${x}`)
  })

  it('at all 4 rots the gate face runs across the ring (posts beside, walkway ahead/behind)', () => {
    for (let rot = 0; rot < 4; rot++) {
      const dp = blueprint.decorPlan(SITE, rot, 2)
      const plan = blueprint.absPlan(SITE, rot, 2)
      const gate = dp.cells.find((c) => c.kind === 'gate')
      assert.ok(gate && gate.face, `rot ${rot}: no faced gate`)
      const { dx, dz } = gate.face
      assert.equal(Math.abs(dx) + Math.abs(dz), 1)
      const fenceAt = (x, z) => {
        const k = k3(x, gate.y, z)
        const a = plan.at.get(k) || dp.at.get(k)
        return !!a && a.kind === 'fence'
      }
      // Lateral neighbours (perpendicular to the face) are the posts…
      assert.ok(fenceAt(gate.x + dz, gate.z + dx) && fenceAt(gate.x - dz, gate.z - dx), `rot ${rot}: posts not beside`)
      // …the walk-through cells along the face are not.
      assert.ok(!fenceAt(gate.x + dx, gate.z + dz) && !fenceAt(gate.x - dx, gate.z - dz), `rot ${rot}: walkway blocked`)
    }
  })

  it('matches and protects a laid gate', () => {
    assert.ok(blueprint.matches('gate', 'oak_fence_gate'))
    assert.ok(blueprint.matches('gate', 'birch_fence_gate'))
    assert.ok(!blueprint.matches('gate', 'oak_fence'))
    assert.ok(!blueprint.matches('fence', 'oak_fence_gate'))
    const st = { site: SITE, rot: 2, blueprintVersion: 2, phase: 'complete' }
    const g = blueprint.decorPlan(SITE, 2, 2).cells.find((c) => c.kind === 'gate')
    assert.equal(blueprint.protects(st, g, 'spruce_fence_gate'), true)
    assert.equal(blueprint.protects(st, g, 'dirt'), false)
    assert.equal(castleMod.kindOf('oak_fence_gate'), 'gate')
    assert.equal(castleMod.kindOf('oak_fence'), 'fence')
  })

})

// --- the castle lays the gate looking along its face ---------------------

function castleBot(items) {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    set.set(k3(c.x, c.y, c.z), { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', stairs: 'cobblestone_stairs' }[c.kind] || 'air')
  }
  // Every decor cell laid except the gate.
  for (const c of blueprint.decorPlan(SITE, 0, 2).cells) if (c.kind !== 'gate') set.set(k3(c.x, c.y, c.z), c.kind === 'fence' ? 'oak_fence' : 'glass_pane')
  const name = (p) => set.has(k3(p.x, p.y, p.z)) ? set.get(k3(p.x, p.y, p.z)) : (Math.floor(p.y) < SITE.y ? 'dirt' : 'air')
  const calls = { places: [], looks: [] }
  const bot = {
    username: 'IdkBot',
    calls,
    set,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: new Vec3(SITE.x + 15.5, SITE.y, SITE.z + 2.5) },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 3 },
    players: {},
    entities: {},
    registry: { blocksByName: { chest: { id: 2 } }, itemsByName: { oak_fence_gate: {} } },
    world: { getBlock: () => null },
    blockAt(p) {
      const n = name(p)
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    equip: async (item) => { bot.held = item.name },
    look: async (yaw, pitch) => { calls.looks.push([yaw, pitch]) },
    _placeBlockWithOptions: async (ref, face) => {
      const p = ref.position.offset(face.x, face.y, face.z)
      calls.places.push(k3(p.x, p.y, p.z))
      set.set(k3(p.x, p.y, p.z), bot.held)
    },
    dig: async () => {},
    pathfinder: {
      goal: null,
      isMoving: () => false,
      setGoal(g) {
        bot.pathfinder.goal = g
        const p = g && (g.pos || (typeof g.x === 'number' ? g : null))
        if (p) bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + (g.pos ? 2.5 : 0.5))
      },
      stop() {},
      setMovements() {},
    },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

describe('castle gate placement (g0z.46)', () => {
  it('a held gate is the decor word and lands looking along +z', async () => {
    const bot = castleBot([{ name: 'oak_fence_gate', count: 1 }])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false } }
    assert.equal(castleMod.menuFact(bot, ctx), 'gate-batch')
    for (let i = 0; i < 50 && bot.calls.places.length < 1; i++) {
      castleMod(bot, ctx)
      await settle(); await settle()
    }
    assert.deepEqual(bot.calls.places, [k3(SITE.x + 15, SITE.y, SITE.z)])
    // placeStairs' yaw for face {0,+1}: atan2(-0, -1) = ±π (mineflayer: looking +z).
    assert.equal(bot.calls.looks.length, 1)
    assert.equal(Math.abs(bot.calls.looks[0][0]), Math.PI)
    assert.equal(ctx.castle.phase, 'complete')
  })

  it('no gate held: the word asks castlefetch for exactly one', () => {
    const bot = castleBot([])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false } }
    assert.equal(castleMod.menuFact(bot, ctx), 'gate-none')
    assert.deepEqual(fetch.demand(bot, ctx), { kind: 'gate', word: 'none', short: 1 })
  })
})

// --- doors.js: A* and the reflex through a gate ---------------------------

function stateIdFor(name, match) {
  const e = mcData.blocksByName[name]
  for (let s = e.minStateId; s <= e.maxStateId; s++) {
    const p = Block.fromStateId(s, 0).getProperties()
    if (Object.entries(match).every(([k, v]) => p[k] === v)) return s
  }
  throw new Error(`no state ${name}`)
}

// Sealed yard: 3x3 interior, bedrock walls 2 high, a fence gate at
// (0,64,-2) with air above it — the only way out (canDig off via bedrock).
function yardCells({ facing = 'south', open = false, head = 'air' } = {}) {
  const cells = new Map()
  const ring = (x, z) => Math.abs(x) === 2 || Math.abs(z) === 2
  for (let x = -2; x <= 2; x++) {
    for (let z = -8; z <= 2; z++) {
      for (let y = 60; y <= 63; y++) cells.set(`${x},${y},${z}`, { name: 'bedrock' })
      if (z >= -2 && ring(x, z)) {
        if (x === 0 && z === -2) {
          cells.set(`${x},64,${z}`, { state: stateIdFor('oak_fence_gate', { facing, open, in_wall: false, powered: false }) })
          cells.set(`${x},65,${z}`, { name: head })
        } else {
          for (let y = 64; y <= 65; y++) cells.set(`${x},${y},${z}`, { name: 'bedrock' })
        }
      }
    }
  }
  return cells
}

function wired(cells) {
  const blockAt = (p) => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const c = cells.get(`${x},${y},${z}`)
    const b = c && c.state !== undefined ? Block.fromStateId(c.state, 0) : Block.fromStateId(mcData.blocksByName[(c && c.name) || 'air'].minStateId, 0)
    b.position = new Vec3(x, y, z)
    return b
  }
  const bot = {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt,
  }
  const ticker = createTicker({ bot, brain: { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }, tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return movements
}

function plan(movements) {
  return new AStar(new Move(0, 64, 0, 0, 0), movements, new goals.GoalBlock(0, 64, -4), 10000, 9000).compute()
}

describe('doors: fence gates (g0z.46)', () => {
  for (const [facing, open] of [['south', false], ['south', true], ['east', false]]) {
    it(`A* crosses a ${open ? 'open' : 'shut'} ${facing} gate with no dig`, () => {
      const r = plan(wired(yardCells({ facing, open })))
      assert.equal(r.status, 'success')
      assert.ok(r.path.some((m) => m.x === 0 && m.y === 64 && m.z === -2), 'path avoids the gate')
      for (const m of r.path) assert.deepEqual(m.toBreak || [], [], 'path digs')
    })
  }

  it('every wood gate reads openable, the lib list misses the newer woods (revmux 01)', () => {
    const m = wired(yardCells())
    for (const n of ['oak_fence_gate', 'cherry_fence_gate', 'mangrove_fence_gate', 'bamboo_fence_gate', 'crimson_fence_gate', 'warped_fence_gate']) {
      assert.ok(m.openable.has(mcData.blocksByName[n].id), `${n} not openable`)
    }
  })

  it('a gate under a solid head cell is no passage', () => {
    assert.notEqual(plan(wired(yardCells({ head: 'bedrock' }))).status, 'success')
  })

  it('the reflex opens a plan gate in reach and shuts it once past', () => {
    const st = { open: false }
    const bot = {
      entity: { position: new Vec3(0.5, 64, -0.5) },
      toggles: 0,
      pathfinder: { isMoving: () => true },
      blockAt: (p) => {
        const at = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
        if (at.x === 0 && at.y === 64 && at.z === -2) return { name: 'oak_fence_gate', position: at, getProperties: () => ({ open: st.open, facing: 'south' }) }
        return { name: 'air', position: at, getProperties: () => ({}) }
      },
      activateBlock: async () => { bot.toggles++; st.open = !st.open },
    }
    const ctx = { lastPathNodes: [{ x: 0.5, y: 64, z: -0.5 }, { x: 0.5, y: 64, z: -1.5 }, { x: 0.5, y: 64, z: -2.5 }, { x: 0.5, y: 64, z: -3.5 }] }
    const log = console.log
    console.log = () => {}
    try {
      doors.doorReflex(bot, ctx)
      assert.equal(st.open, true, 'gate not opened')
      doors.doorReflex(bot, ctx) // observed open
      bot.entity.position = new Vec3(0.5, 64, -4.5)
      ctx.lastPathNodes = [{ x: 0.5, y: 64, z: -4.5 }, { x: 0.5, y: 64, z: -5.5 }]
      ctx.doorShutAt = {}
      doors.doorReflex(bot, ctx)
      assert.equal(st.open, false, 'gate left open behind')
      assert.equal(bot.toggles, 2)
    } finally {
      console.log = log
    }
  })

  it('isPassage: hand doors and gates, never iron', () => {
    assert.ok(doors.isPassage('oak_fence_gate'))
    assert.ok(doors.isPassage('oak_door'))
    assert.ok(!doors.isPassage('iron_door'))
    assert.ok(!doors.isPassage('oak_fence'))
  })
})
