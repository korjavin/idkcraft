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
const goal = require('../src/goal')
const { fleeReflex } = require('../src/reflexes')

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
  for (const c of opts.placed || []) placed.add(key(c[0], c[1], c[2]))
  const items = opts.items ? opts.items.map((i) => ({ ...i })) : []
  // stoneStance: the stance column is hand-undiggable stone, everything
  // else dirt — the dig walks to a nearby dirt column first.
  // ground: 'stone': all ground is stone — every dig refuses.
  const groundName = (x, y, z) => {
    if (y > 63) return 'dirt'
    if (opts.ground === 'stone') return 'stone'
    if (opts.stoneStance && Math.floor(x) === 0 && Math.floor(z) === 0) return 'stone'
    return y === 63 ? 'grass_block' : 'dirt'
  }
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
      const name = !s ? 'air' : (placed.has(key(x, y, z)) ? 'dirt' : groundName(x, y, z))
      return { name, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    async dig(b) {
      dug.add(key(b.position.x, b.position.y, b.position.z))
      placed.delete(key(b.position.x, b.position.y, b.position.z))
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

describe('vmzq.30 dig commits once the descent starts', () => {
  it('walk to the pit fights; the descent shelters under melee cover', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { stoneStance: true, items: [{ name: 'dirt', count: 12 }] })
    const ctx = {
      home: v2home({ x: -48, y: 65, z: -208 }),
      step: 'shelter',
      stepStatus: 'running',
      recovery: { action: 'pillar_up', status: 'failed:place-error', st: {} },
    }
    await quiet(async () => {
      home.shelter(bot, ctx, null, null) // verdict: stone stance refuses, walk to dirt starts
      await flush()
    })
    assert.ok(ctx.shelter.dig, 'dig armed')
    assert.ok(ctx.shelter.dig.walk, 'walking to a dirt column')
    assert.equal(ctx.shelter.dig.digs || 0, 0)
    assert.equal(ctx.inShelter, false, 'exposed on the walk: fight runs')
    assert.equal(bot.pathfinder.goal && bot.pathfinder.goal.constructor.name, 'GoalBlock')
    // Arrive at the column: the walk completes, then the first descent
    // dig issues and shelter arms.
    const w = ctx.shelter.dig.walk
    bot.entity.position = pos(w.x + 0.5, w.y, w.z + 0.5)
    await quiet(async () => {
      for (let t = 0; t < 3 && !(ctx.shelter.dig && ctx.shelter.dig.digs > 0); t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.equal(ctx.shelter.dig.digs, 1, 'descent issued')
    assert.equal(ctx.inShelter, true, 'descent started: fight suppresses, melee covers')
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
    await quiet(async () => {
      for (let t = 0; t < 25; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.equal(ctx.shelter.dugIn, true)
    assert.equal(ctx.shelter.perched, false)
    assert.equal(ctx.shelter.descendTried, true, 'descent consumed')
    assert.equal(ctx.shelter.descended, false, 'no re-arm pending after success')
    assert.equal(ctx.inShelter, true)
    // One shot, no loop: ten more ticks with the phantom still up arm
    // no second dig.
    await quiet(async () => {
      for (let t = 0; t < 10; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.ok(!ctx.shelter.dig, 'no second dig armed')
    assert.equal(ctx.shelter.dugIn, true)
  })
  it('true perch geometry (y65, pillar placed): the descent digs one deeper and caps at ground level', async () => {
    // Revmux 02 core-1: the earlier descent test stood the body on flat
    // ground, where 3-deep caps fine. Perched a cell above normal the
    // cap lands in the open pillar cell (no-cap-ref) unless the descent
    // takes an extra cell — then it lands at ground level (y63, dirt
    // walls) and the pit closes first try.
    const bot = flatBot({ x: 0.5, y: 65, z: 0.5 }, {
      items: [{ name: 'dirt', count: 12 }],
      placed: [[0, 64, 0]],
      entities: { 7: { name: 'phantom', position: pos(10, 80, 5) } },
    })
    const ctx = perchedCtx()
    const logs = await quiet(async () => {
      for (let t = 0; t < 25; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.equal(ctx.shelter.dugIn, true)
    assert.equal(ctx.shelter.perched, false)
    assert.equal(ctx.shelter.descendTried, true, 'descent consumed')
    assert.equal(ctx.shelter.descended, false, 'no re-arm pending after success')
    assert.equal(Math.floor(bot.entity.position.y), 61, 'four deep off the perch')
    assert.ok(!logs.some((m) => m.includes('re-pillaring')), 'first-try close, no re-pillar')
    assert.equal(ctx.inShelter, true)
  })
  it('perched + no phantom: holds the pillar', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const ctx = perchedCtx()
    await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.shelter.pillared, true)
    assert.equal(ctx.shelter.perched, true)
    assert.ok(!ctx.shelter.dig, 'no dig armed')
    assert.ok(!ctx.shelter.descendTried, 'no descent without a phantom')
  })
  it('failed descent re-pillars once, then holds (no pillar-dig loop)', async () => {
    // All stone: the descent dig refuses, the re-pillar has no scaffold
    // (empty kit) so its dig refuses too — one re-arm, then a hold.
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, {
      ground: 'stone',
      entities: { 7: { name: 'phantom', position: pos(2, 70, 1) } },
    })
    const ctx = perchedCtx()
    // Per-tick logs: the unsheltered re-pillar tick is transient (the new
    // top shelters again once it stands), so its flag is pinned here. The
    // clear comes from the climb gate (unpillared ticks unshelter before
    // the dig runs), not the fail branch — the pin guards that order.
    const logs = []
    let atRearm = 'unset'
    for (let t = 0; t < 30; t++) {
      const tickLogs = await quiet(async () => {
        home.shelter(bot, ctx, null, null)
        await flush()
      })
      logs.push(...tickLogs)
      if (atRearm === 'unset' && tickLogs.some((m) => m.includes('re-pillaring'))) atRearm = ctx.inShelter
    }
    // The re-arm is a one-time transition (no ctx residue by design —
    // the marker is consumed), so its firing is pinned on the log.
    assert.equal(logs.filter((m) => m.includes('re-pillaring')).length, 1, 'exactly one re-arm')
    assert.equal(atRearm, false, 'the failed descent unshelters so the re-pillar runs under fight')
    assert.equal(ctx.shelter.descendTried, true)
    assert.equal(ctx.shelter.descended, false, 're-arm consumed')
    assert.equal(ctx.shelter.pillared, true, 'ends holding, not looping')
    assert.equal(ctx.inShelter, true)
  })
  it('dug in + phantom overhead: holds (already covered)', async () => {
    const bot = flatBot({ x: 0.5, y: 61, z: 0.5 }, {
      entities: { 7: { name: 'phantom', position: pos(2, 70, 1) } },
    })
    const ctx = perchedCtx()
    ctx.shelter = { pillared: true, perched: false, dugIn: true, pillarAt: { x: 0.5, z: 0.5 } }
    await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.shelter.pillared, true)
    assert.ok(!ctx.shelter.dig, 'no re-dig')
    assert.ok(!ctx.shelter.descendTried, 'covered pit never descends')
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

describe('vmzq.30 flee holds in a pit or on a pillar', () => {
  function creeperBot() {
    const goals = []
    return {
      goals,
      entity: { position: pos(0, 64, 0) },
      entities: { 9: { name: 'creeper', position: pos(4, 64, 0), isValid: true } },
      pathfinder: { isMoving: () => false, setGoal(g) { goals.push(g) } },
    }
  }
  it('dug in or perched: no flee goal (rig: flee excavated the pit)', () => {
    for (const shelter of [{ pillared: true, dugIn: true }, { pillared: true, perched: true }]) {
      const bot = creeperBot()
      assert.equal(fleeReflex(bot, { inShelter: true, home: {}, shelter }), false)
      assert.equal(bot.goals.length, 0)
    }
  })
  it('unmarked hold: still flees (exposure is worse)', () => {
    const bot = creeperBot()
    assert.ok(fleeReflex(bot, { inShelter: true, home: {}, shelter: { pillared: true } }))
    assert.equal(bot.goals.length, 1)
    assert.equal(bot.goals[0].constructor.name, 'GoalNear')
  })
  it('descending dig: holds; pre-descent dig: still flees', () => {
    const digging = creeperBot()
    assert.equal(fleeReflex(digging, { inShelter: true, home: {}, shelter: { dig: { digs: 1 } } }), false)
    assert.equal(digging.goals.length, 0)
    const walking = creeperBot()
    assert.ok(fleeReflex(walking, { inShelter: true, home: {}, shelter: { dig: { digs: 0 } } }))
    assert.equal(walking.goals.length, 1)
  })
})

describe('vmzq.30 shelter near a sited-but-unbuilt home', () => {
  const SITE = { x: 200, y: 64, z: 200 }
  const FAR_CASTLE = { x: 70, y: 64, z: 190 }
  const NEAR = { x: 195, y: 64, z: 198 }
  const FSH = goal.MENU.shelter.feasible
  const FGO = goal.MENU.gohome.feasible
  const facts = (time, home = 'site') => ({ time, home, inside: 'no' })
  const botAt = (at) => ({ entity: { position: pos(at.x, at.y, at.z) } })
  const unbuiltHome = () => ({ site: { ...SITE }, built: false, v: 1 })
  const builtHome = () => ({ site: { ...SITE }, built: true, v: 2 })
  const ctxWith = (home, castle) => ({ home, castle, step: 'gather', stepStatus: 'done' })
  const activeCastle = (site) => ({ site: { ...site }, rot: 0, phase: 'body' })

  it('castle + unbuilt home + near it at dusk/night: shelter in place', () => {
    for (const t of ['dusk', 'night']) {
      const ctx = ctxWith(unbuiltHome(), activeCastle(FAR_CASTLE))
      assert.equal(FSH(facts(t), botAt(NEAR), ctx), true, t)
      assert.equal(FGO(facts(t), botAt(NEAR), ctx), false, `${t}: nothing to walk into`)
    }
    assert.equal(FSH(facts('day'), botAt(NEAR), ctxWith(unbuiltHome(), activeCastle(FAR_CASTLE))), false, 'day works')
  })
  it('castle next to the unbuilt house: still shelters (no walk-in exists)', () => {
    const ctx = ctxWith(unbuiltHome(), activeCastle({ x: SITE.x + 10, y: 64, z: SITE.z + 10 }))
    assert.equal(FSH(facts('night'), botAt(NEAR), ctx), true)
  })
  it('no castle or built home: as before; no home at all shelters (vmzq.32)', () => {
    assert.equal(FSH(facts('night'), botAt(NEAR), ctxWith(unbuiltHome(), null)), false, 'house flow untouched')
    assert.equal(FSH(facts('night', 'built'), botAt(NEAR), ctxWith(builtHome(), activeCastle(FAR_CASTLE))), false, 'near a built house: walk in')
    assert.equal(FGO(facts('night', 'built'), botAt(NEAR), ctxWith(builtHome(), activeCastle(FAR_CASTLE))), true)
    // vmzq.32: no siter runs under a castle and the spawn may hold no flat
    // site, so a homeless active castle shelters anywhere.
    assert.equal(FSH(facts('night', 'none'), botAt(NEAR), ctxWith(null, activeCastle(FAR_CASTLE))), true, 'truly homeless: shelters (vmzq.32)')
    assert.equal(goal.stepWhy('gohome', facts('night'), botAt(NEAR), ctxWith(unbuiltHome(), activeCastle(FAR_CASTLE)), ''), 'gohome: home not built')
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
    // vmzq.55: the 326 moat 'dig' cells join the gauge, and on an all-air
    // site they already read dug — the place cells still recount to 0.
    assert.equal(ctx.castle.progress.done, 326, 'all-air site recounts to the dug moat only')
    assert.equal(ctx.castle.progress.total, 1722 + 326)
    assert.ok(logs.some((m) => m === 'castle 326/2048'), JSON.stringify(logs))
  })
})
