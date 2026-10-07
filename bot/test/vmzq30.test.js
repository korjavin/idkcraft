'use strict'

// Bead idkcraft-vmzq.30: the bot stops dying during the castle work.
// Run6 (prod 2026-10-07): a dusk shelter pillar failed place-error with
// scaffold on hand, the bot held on open ground with fight suppressed and
// a phantom killed it; the 500-block respawn walk then wedged (castle
// step + stone in hand planned GoalPlaceBlock into an unloaded chunk with
// an empty scaffold set) and the unloaded site read 0/1722, parking the
// castle. keep_inventory is on, so death loses position and time, not gear.
// Fixes: shelter digs in on ANY pillar failure (not just no-scaffold) and
// comes down off a dusk pillar when phantoms circle; the castle step
// far-walks with GoalNearXZ regardless of item (.29C), keeps cobble as
// scaffold when no dirt is held (.29B), and never recounts progress off
// site (.29A).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const castle = require('../src/behaviours/castle')
const body = require('../src/body')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function key(x, y, z) { return `${x},${y},${z}` }

// Flat grass world (ed88 shape): ground y<=63, air above. dig breaks the
// cell, banks one dirt and drops the body to the next solid floor.
function flatBot(at, opts = {}) {
  const dug = new Set()
  const placed = new Set()
  const items = opts.items ? opts.items.map((i) => ({ ...i })) : []
  const solidAt = (x, y, z) => placed.has(key(x, y, z)) || (y <= 63 && !dug.has(key(x, y, z)))
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: opts.entities || {},
    health: 20,
    food: 20,
    time: { timeOfDay: opts.timeOfDay === undefined ? 15000 : opts.timeOfDay, day: 5 },
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    controls: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop: () => {} },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const s = solidAt(x, y, z)
      const name = s ? (y === 63 ? 'grass_block' : 'dirt') : 'air'
      return { name, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    async dig(b) {
      dug.add(key(b.position.x, b.position.y, b.position.z))
      const d = items.find((i) => i.name === 'dirt')
      if (d) d.count++
      else items.push({ name: 'dirt', count: 1 })
      const e = bot.entity.position
      let y = Math.floor(e.y)
      while (!solidAt(Math.floor(e.x), y - 1, Math.floor(e.z))) y--
      bot.entity.position = pos(e.x, y, e.z)
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) {
      if (!bot.heldItem || bot.heldItem.count < 1) throw new Error('no block')
      const d = ref.position.plus(face)
      placed.add(key(d.x, d.y, d.z))
      bot.heldItem.count--
    },
  }
  bot.solidAt = solidAt
  return bot
}

function v2home(site) {
  return {
    site: { ...site },
    built: true,
    v: 2,
    interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
    door: { x: site.x + 3, y: site.y, z: site.z },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

async function quiet(fn) {
  const orig = console.log
  const logs = []
  console.log = (m) => { logs.push(String(m)) }
  try { await fn() } finally { console.log = orig }
  return logs
}

describe('vmzq.30 shelter digs in on any pillar failure', () => {
  it('place-error with scaffold on hand (run6): digs in, sheltered, no ground hold', async () => {
    const bot = flatBot({ x: 291.5, y: 64, z: 185.5 }, { items: [{ name: 'dirt', count: 12 }] })
    const ctx = {
      home: v2home({ x: -48, y: 65, z: -208 }),
      step: 'shelter',
      stepStatus: 'running',
      // A finished pillar episode that failed placing (prim path covered
      // by recover-pillar tests): the verdict below is the changed code.
      recovery: { action: 'pillar_up', status: 'failed:place-error', st: { placeErr: 'refused' } },
    }
    const logs = await quiet(async () => {
      for (let t = 0; t < 20; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.ok(!String(ctx.stepStatus).startsWith('failed'), ctx.stepStatus)
    assert.equal(ctx.inShelter, true)
    assert.equal(ctx.shelter.dugIn, true)
    assert.ok(!ctx.shelter.perched, 'a failed pillar never marks perched')
    assert.equal(Math.floor(bot.entity.position.y), 61, 'three deep')
    assert.ok(logs.some((m) => m.includes('shelter pillar failed:place-error err=refused, digging in')), JSON.stringify(logs))
    assert.ok(logs.includes('shelter dig-in done'), JSON.stringify(logs))
    assert.ok(!logs.some((m) => m.includes('holding on the ground')), 'no open-ground hold')
  })
})

describe('vmzq.30 phantomNear', () => {
  const bp = { x: 0, y: 68, z: 0 }
  const botWith = (entities) => ({ entity: { position: pos(bp.x, bp.y, bp.z) }, entities })
  it('false with no entities, a zombie, an invalid or a far phantom', () => {
    assert.equal(home.phantomNear(botWith({})), false)
    assert.equal(home.phantomNear(botWith({ 1: { name: 'zombie', position: pos(1, 64, 0) } })), false)
    assert.equal(home.phantomNear(botWith({ 1: { name: 'phantom', position: pos(5, 70, 0), isValid: false } })), false)
    assert.equal(home.phantomNear(botWith({ 1: { name: 'phantom', position: pos(33, 68, 0) } })), false)
    assert.equal(home.phantomNear({}), false)
  })
  it('true for a live phantom at circling height', () => {
    assert.equal(home.phantomNear(botWith({ 7: { name: 'phantom', position: pos(10, 80, 5) } })), true)
    assert.equal(home.PHANTOM_R, 32)
  })
})

describe('vmzq.30 phantom descent off a dusk pillar', () => {
  function perchedCtx() {
    return {
      home: v2home({ x: -48, y: 65, z: -208 }),
      step: 'shelter',
      stepStatus: 'running',
      lastGoalKey: 'stay',
      inShelter: true,
      // Logically perched (the marker drives the logic; the mock ground
      // stands in for the pillar top so the dig runs without a walk).
      shelter: { pillared: true, perched: true, pillarAt: { x: 0.5, z: 0.5 } },
    }
  }
  it('perched + phantom overhead: digs in and closes', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, {
      entities: { 7: { name: 'phantom', position: pos(10, 80, 5) } },
    })
    const ctx = perchedCtx()
    const logs = await quiet(async () => {
      for (let t = 0; t < 25; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.ok(logs.includes('shelter phantom overhead, digging in'), JSON.stringify(logs))
    assert.ok(logs.includes('shelter dig-in done'), JSON.stringify(logs))
    assert.equal(ctx.shelter.dugIn, true)
    assert.equal(ctx.shelter.perched, false)
    assert.equal(ctx.inShelter, true)
    assert.equal(logs.filter((m) => m.includes('phantom overhead')).length, 1, 'one shot, no loop')
  })
  it('perched + no phantom: holds the pillar', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = perchedCtx()
    const logs = await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.shelter.pillared, true)
    assert.equal(ctx.shelter.perched, true)
    assert.ok(!ctx.shelter.dig, 'no dig armed')
    assert.ok(!logs.some((m) => m.includes('phantom overhead')), JSON.stringify(logs))
  })
  it('dug in + phantom overhead: holds (already covered)', async () => {
    const bot = flatBot({ x: 0.5, y: 61, z: 0.5 }, {
      entities: { 7: { name: 'phantom', position: pos(2, 70, 1) } },
    })
    const ctx = perchedCtx()
    ctx.shelter = { pillared: true, perched: false, dugIn: true, pillarAt: { x: 0.5, z: 0.5 } }
    const logs = await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.shelter.pillared, true)
    assert.ok(!ctx.shelter.dig, 'no re-dig')
    assert.ok(!logs.some((m) => m.includes('phantom overhead')), JSON.stringify(logs))
  })
})

describe('vmzq.30 castle return walk (.29B/.29C)', () => {
  const SITE = { x: 276, y: 64, z: 180 }
  function castleBot(at, items) {
    const goals = []
    return {
      goals,
      entity: { position: { ...at } },
      players: {},
      inventory: { items: () => items },
      // Loaded site on air: every cell reads undone, corners read.
      blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }),
      pathfinder: {
        goal: null,
        movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
        isMoving: () => false,
        setGoal(g) { goals.push(g); this.goal = g },
      },
      chat: () => {},
    }
  }
  it('far cell with stone in hand: GoalNearXZ, not GoalPlaceBlock', async () => {
    const bot = castleBot({ x: -48, y: 65, z: -208 }, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body' } }
    await quiet(() => castle(bot, ctx))
    assert.equal(bot.goals.length, 1)
    assert.equal(bot.goals[0] && bot.goals[0].constructor.name, 'GoalNearXZ', JSON.stringify(bot.goals[0]))
    assert.equal(ctx.castle.status, 'walking to the site')
    assert.ok(!String(ctx.stepStatus).startsWith('failed'), ctx.stepStatus)
  })
  it('far cell with an empty kit: still GoalNearXZ (vmzq.17 preserved)', async () => {
    const bot = castleBot({ x: -48, y: 65, z: -208 }, [])
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body' } }
    await quiet(() => castle(bot, ctx))
    assert.equal(bot.goals.length, 1)
    assert.equal(bot.goals[0] && bot.goals[0].constructor.name, 'GoalNearXZ')
  })
  it('castle step + cobble over reserve + no dirt: cobble stays scaffold', () => {
    const DIRT = 9
    const COBBLE = 14
    const bot = {
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { dirt: { id: DIRT }, cobblestone: { id: COBBLE } } },
      inventory: { items: () => [{ name: 'cobblestone', count: 40 }] },
    }
    const ctx = {
      work: true,
      step: 'castle',
      castle: { site: { x: 0, y: 64, z: 0 } },
      movements: { canDig: true, allowSprinting: false, allowParkour: true, scafoldingBlocks: [DIRT, COBBLE] },
      lastGoalKey: '',
      lastPathNodes: null,
    }
    body.movementsFor('work', bot, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT, COBBLE], 'no dirt: cobble scaffolds')
  })
  it('castle step + cobble over reserve + dirt: dirt only (g0z.18 preserved)', () => {
    const DIRT = 9
    const COBBLE = 14
    const bot = {
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { dirt: { id: DIRT }, cobblestone: { id: COBBLE } } },
      inventory: { items: () => [{ name: 'cobblestone', count: 40 }, { name: 'dirt', count: 5 }] },
    }
    const ctx = {
      work: true,
      step: 'castle',
      castle: { site: { x: 0, y: 64, z: 0 } },
      movements: { canDig: true, allowSprinting: false, allowParkour: true, scafoldingBlocks: [DIRT, COBBLE] },
      lastGoalKey: '',
      lastPathNodes: null,
    }
    body.movementsFor('work', bot, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT])
  })
})

describe('vmzq.30 no unloaded progress reads (.29A)', () => {
  const SITE = { x: 276, y: 64, z: 180 }
  it('siteLoaded: corners decide', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2 }
    const block = (missing) => (p) => {
      const x = Math.floor(p.x); const z = Math.floor(p.z)
      if (missing && x === SITE.x && z === SITE.z) return null
      return { name: 'air', boundingBox: 'empty', position: p }
    }
    assert.equal(castle.siteLoaded({ blockAt: block(false) }, st), true)
    assert.equal(castle.siteLoaded({ blockAt: block(true) }, st), false)
    assert.equal(castle.siteLoaded({ blockAt: () => null }, st), false)
    assert.equal(castle.siteLoaded({ blockAt: block(false) }, null), false)
  })
  it('full-scan tick off site: st.progress keeps its value, no 0/1722 line', async () => {
    const goals = []
    const bot = {
      entity: { position: { x: -48, y: 65, z: -208 } },
      players: {},
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
      blockAt: () => null, // unloaded site
      pathfinder: {
        goal: null,
        movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
        isMoving: () => false,
        setGoal(g) { goals.push(g); this.goal = g },
      },
      chat: () => {},
    }
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', progress: { done: 328, total: 1722 } } }
    const logs = await quiet(() => castle(bot, ctx))
    assert.deepEqual(ctx.castle.progress, { done: 328, total: 1722 })
    assert.ok(!logs.some((m) => /^castle 0\/\d+$/.test(m)), JSON.stringify(logs))
  })
  it('full-scan tick on a loaded site: still recounts', async () => {
    const bot = {
      entity: { position: { x: SITE.x + 2, y: 65, z: SITE.z + 2 } },
      players: {},
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
      blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }),
      pathfinder: {
        goal: null,
        movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
        isMoving: () => false,
        setGoal() {},
      },
      chat: () => {},
      // placeCell path needs these when near with stone; the recount
      // assertion runs before any placement settles.
      world: { getBlock: () => null },
      heldItem: null,
      equip: async () => {},
      lookAt: async () => {},
      placeBlock: async () => {},
      dig: async () => {},
    }
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', progress: { done: 328, total: 1722 } } }
    const logs = await quiet(() => castle(bot, ctx))
    assert.equal(ctx.castle.progress.done, 0, 'all-air site recounts to 0')
    assert.ok(ctx.castle.progress.total > 0)
    assert.ok(logs.some((m) => /^castle 0\/\d+$/.test(m)), JSON.stringify(logs))
  })
})
