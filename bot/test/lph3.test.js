'use strict'

// Bead idkcraft-lph3: castle nights — the N2-N5 bed-loop cascade plus
// shelter death traps. After a night death the respawn lands in a swarm,
// fight wins every tick while hostiles stay adjacent, and the shelter
// (~30-60 s to close) never builds before the unarmored bot dies (~20 s).
// Fix: a post-respawn night grace holds fight preemption while the night
// step digs now (index.js divert + home.js stamp), the dig-in vetoes
// gravity floors/walls/digs, thin floors over voids and 1-thin walls next
// to wide air (recover.js), and a failed phantom descent unarms inShelter
// so the re-pillar runs (home.js core-2 from the #345 verify).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const recover = require('../src/behaviours/recover')
const goal = require('../src/goal')
const { createTicker, BEHAVIOURS, handleRespawn } = require('../src/index')

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
  const air = new Set((opts.air || []).map((c) => key(c[0], c[1], c[2])))
  const groundName = (x, y, z) => {
    if (y > 63) return 'dirt'
    if (opts.groundAt) {
      const g = opts.groundAt(x, y, z)
      if (g) return g
      if (g === null) return y === 63 ? 'grass_block' : 'dirt'
    }
    return opts.ground || (y === 63 ? 'grass_block' : 'dirt')
  }
  const solidAt = (x, y, z) => {
    if (air.has(key(x, y, z))) return false
    if (placed.has(key(x, y, z))) return true
    return y <= 63 && !dug.has(key(x, y, z))
  }
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

describe('lph3 nightGrace helper', () => {
  it('fresh respawn at night: true; stale, day, missing: false', () => {
    const night = { time: { timeOfDay: 15000, day: 5 } }
    const day = { time: { timeOfDay: 1000, day: 5 } }
    assert.equal(home.nightGrace(night, { lastRespawnAt: Date.now() }), true)
    assert.equal(home.nightGrace(night, { lastRespawnAt: Date.now() + 30000 }), true, 'future-dated stays fresh')
    assert.equal(home.nightGrace(night, { lastRespawnAt: Date.now() - home.NIGHT_GRACE_MS - 1000 }), false, 'stale')
    assert.equal(home.nightGrace(day, { lastRespawnAt: Date.now() }), false, 'day')
    assert.equal(home.nightGrace(night, {}), false, 'missing stamp')
    assert.equal(home.nightGrace(night, null), false, 'missing ctx')
  })
})

describe('lph3 handleRespawn stamps the grace', () => {
  it('respawn sets lastRespawnAt on the ticker ctx', () => {
    const bot = { _tickerCtx: {}, spawnPoint: pos(0, 64, 0), entity: { position: pos(0, 64, 0) } }
    const orig = console.log
    console.log = () => {}
    try { handleRespawn(bot, null) } finally { console.log = orig }
    assert.equal(typeof bot._tickerCtx.lastRespawnAt, 'number')
    assert.ok(Date.now() - bot._tickerCtx.lastRespawnAt < 5000)
  })
})

describe('lph3 core-2: the phantom descent drives under the hold', () => {
  it('descent arm keeps the hold; a fight tick with a walker at the perch drives the dig, never pursues', async () => {
    // #345 core-2, revmux 02: the arm tick left inShelter=true with
    // digs=0 and fight ticks idled instead of driving. Unarming (round
    // 1) pursued walkers off the perch and starved the dig. The hold
    // stays and the drive gate covers descended: fight ticks drive.
    const phantom = { name: 'phantom', position: pos(5, 80, 0) }
    phantom.position.distanceTo = () => 20
    const bot = flatBot({ x: 0.5, y: 65, z: 0.5 }, { entities: { 9: phantom }, placed: [[0, 64, 0]] })
    const ctx = {
      home: v2home({ x: 200, y: 64, z: 200 }),
      step: 'shelter',
      stepStatus: 'running',
      inShelter: true, // the perched hold
      shelter: { pillared: true, perched: true, dugIn: false, descendTried: false, pillarAt: { x: 0.5, z: 0.5 } },
    }
    await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.shelter.descendTried, true, 'one shot consumed')
    assert.equal(ctx.shelter.descended, true)
    assert.equal(ctx.shelter.pillared, false, 'off the perch')
    assert.ok(ctx.shelter.dig && ctx.shelter.dig.extra === 1, 'descent dig armed')
    assert.equal(ctx.inShelter, true, 'hold kept: fight ticks drive, never pursue')
  })

  it('ticker: stone-stance descent walk + zombie + fight: walk goal survives, fight never runs', async () => {
    // Revmux 03: the drive gate drove the descent walk (digs 0) and then
    // stopOnce cleared the walk goal in the same tick — a cobble-pillar
    // (or stone-stance) descent with walkers at the perch never walked.
    // The walk now keeps its goal live across fight ticks.
    const phantom = { name: 'phantom', position: pos(5, 80, 0) }
    phantom.position.distanceTo = () => 20
    const zp = pos(2, 64, 0)
    zp.offset = (ox, oy, oz) => pos(zp.x + ox, zp.y + oy, zp.z + oz)
    const bot = flatBot({ x: 0.5, y: 65, z: 0.5 }, {
      entities: { 9: phantom },
      placed: [[0, 64, 0]],
      groundAt: (x, y, z) => (x === 3 && z === 0 ? null : 'stone'),
    })
    bot.players = { Steve: { username: 'Steve' } }
    bot.spawnPoint = pos(0, 64, 0)
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    const seq = [
      { action: 'idle', sprint: false, source: 'stub' },
      { action: 'fight', sprint: false, source: 'stub' },
      { action: 'fight', sprint: false, source: 'stub' },
    ]
    let i = 0
    const brain = { calls: 0, async decide() { this.calls++; return seq[Math.min(i++, seq.length - 1)] } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const origLog = console.log
    console.log = () => {}
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      ticker.work()
      const ctx = bot._tickerCtx
      ctx.home = v2home({ x: 200, y: 64, z: 200 })
      ctx.adoptDone = true
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      ctx.inShelter = true
      ctx.shelter = { pillared: true, perched: true, dugIn: false, descendTried: false, pillarAt: { x: 0.5, z: 0.5 } }
      ctx.goalText = 'seeded hold'
      await ticker.tick() // work: arms the descent
      await flush()
      assert.equal(ctx.shelter.descended, true, 'descent armed')
      bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', position: zp, height: 1.95 }
      for (let t = 0; t < 3; t++) {
        const r = await ticker.tick() // fight: drives the walk
        await flush()
        assert.equal(r.decision.action, 'idle', `tick ${t} holds`)
        assert.ok(ctx.shelter.dig && ctx.shelter.dig.walk, `tick ${t} still walking`)
        assert.ok(bot.pathfinder.goal, `tick ${t} walk goal live (not stopOnce-cleared)`)
        assert.equal(ctx.lastGoalKey, 'dig-in-walk', `tick ${t} walk key held`)
      }
      assert.equal(fightRan, 0, 'fight never dispatched')
    } finally {
      console.log = origLog
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('ticker: perched descent + phantom + zombie within 8 + fight: digs, fight never runs', async () => {
    const phantom = { name: 'phantom', position: pos(5, 80, 0) }
    phantom.position.distanceTo = () => 20
    const zp = pos(2, 64, 0)
    zp.offset = (ox, oy, oz) => pos(zp.x + ox, zp.y + oy, zp.z + oz)
    const bot = flatBot({ x: 0.5, y: 65, z: 0.5 }, { entities: { 9: phantom }, placed: [[0, 64, 0]] })
    bot.players = { Steve: { username: 'Steve' } } // rostered but unseen
    bot.spawnPoint = pos(0, 64, 0)
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    // Phase 1 (work): idle arms the descent. Phase 2 (fight): the drive
    // gate runs the dig under the hold.
    const seq = [
      { action: 'idle', sprint: false, source: 'stub' },
      { action: 'fight', sprint: false, source: 'stub' },
      { action: 'fight', sprint: false, source: 'stub' },
    ]
    let i = 0
    const brain = { calls: 0, async decide() { this.calls++; return seq[Math.min(i++, seq.length - 1)] } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const origLog = console.log
    const lines = []
    console.log = (l) => { lines.push(String(l)) }
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      ticker.work()
      const ctx = bot._tickerCtx
      ctx.home = v2home({ x: 200, y: 64, z: 200 })
      ctx.adoptDone = true
      // Perched hold, as a dusk pillar left it.
      ctx.step = 'shelter'
      ctx.stepStatus = 'running'
      ctx.inShelter = true
      ctx.shelter = { pillared: true, perched: true, dugIn: false, descendTried: false, pillarAt: { x: 0.5, z: 0.5 } }
      ctx.goalText = 'seeded hold'
      const r0 = await ticker.tick() // work: arms the descent
      await flush()
      assert.equal(ctx.shelter.descended, true, 'descent armed on the work tick')
      assert.equal(ctx.inShelter, true, 'hold kept')
      bot.entities[1] = { id: 1, name: 'zombie', type: 'mob', position: zp, height: 1.95 } // walker at the perch
      const r1 = await ticker.tick() // fight: drives the dig
      await flush()
      assert.equal(r1.decision.action, 'idle', 'hold returns idle')
      assert.equal(fightRan, 0, 'fight never dispatched off the perch')
      assert.ok(ctx.shelter.dig && (ctx.shelter.dig.digs | 0) > 0, 'dig driven on the fight tick')
    } finally {
      console.log = origLog
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })
})

describe('lph3 ticker: night grace holds fight, shelter digs', () => {
  let lines
  let origLog
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function zombie(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  function graceBot() {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, {
      entities: { 1: zombie(1, 2), 2: zombie(2, -2) }, // 2 adjacent hostiles
    })
    bot.players = { Steve: { username: 'Steve' } } // rostered but unseen: brain called, target null
    bot.spawnPoint = pos(0, 64, 0)
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    return bot
  }

  function fightBrain() {
    return { calls: 0, async decide() { this.calls++; return { action: 'fight', sprint: false, source: 'stub' } } }
  }

  it('fresh grace + brain fight + hostiles adjacent: shelters and digs, fight never runs (N ticks)', async () => {
    const bot = graceBot()
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home({ x: 200, y: 64, z: 200 }) // far: night-far owns shelter
    ctx.lastRespawnAt = Date.now() + 30000 // fresh (future-dated: suite stalls cannot flake the hold)
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      // Tick 0 diverts to work (shelter); once the dig commits (digs > 0,
      // inShelter armed) later fight ticks drive the dig under the
      // inShelter hold and return idle — both suppress fight.
      const r0 = await ticker.tick()
      await flush()
      assert.equal(r0.decision.action, 'shelter', 'tick 0 shelters')
      for (let i = 1; i < 5; i++) {
        const r = await ticker.tick()
        await flush()
        assert.ok(r.decision.action === 'shelter' || r.decision.action === 'idle', `tick ${i} holds (got ${r.decision.action})`)
        assert.notEqual(r.decision.action, 'fight', `tick ${i} never fights`)
      }
      assert.equal(fightRan, 0, 'fight never runs across a held grace')
      assert.ok(lines.some((l) => l.includes('night-grace: holding fight preemption')), `edge logged, got: ${lines.join(' | ')}`)
      assert.ok(ctx.shelter && (ctx.shelter.dig || ctx.shelter.dugIn || ctx.shelter.pillared), 'shelter ran (pillar/dig/pillared)')
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('shelter digs to done with hostiles adjacent (the grace lets it run)', async () => {
    const bot = graceBot()
    const ctx = { home: v2home({ x: 200, y: 64, z: 200 }), step: 'shelter', stepStatus: 'running' }
    for (let t = 0; t < 25; t++) {
      home.shelter(bot, ctx, null, null)
      await flush()
    }
    assert.ok(!String(ctx.stepStatus).startsWith('failed'), ctx.stepStatus)
    assert.equal(ctx.inShelter, true)
    assert.equal(ctx.shelter.dugIn, true, 'closed pit despite adjacent zombies')
  })

  it('stale grace resumes fight (a stalled shelter does not disarm the bot)', async () => {
    const bot = graceBot()
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home({ x: 200, y: 64, z: 200 })
    ctx.lastRespawnAt = Date.now() - home.NIGHT_GRACE_MS - 1000
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(fightRan, 1)
      assert.ok(!lines.some((l) => l.includes('night-grace:')), 'no edge log without a hold')
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('visible player keeps player protection fighting (grace is alone-only)', async () => {
    const bot = graceBot()
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(10, 64, 0), username: 'Steve' } } }
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home({ x: 200, y: 64, z: 200 })
    ctx.lastRespawnAt = Date.now()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(fightRan, 1)
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('fresh grace but work picks a day step (no home, no castle): fights instead of working the dark', async () => {
    const bot = graceBot()
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = null // no home, no castle: stay/gohome/shelter infeasible
    ctx.castle = null
    ctx.adoptDone = true // past the spawn-chunk adopt grace: goal decides now
    ctx.lastRespawnAt = Date.now()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight', 'falls back to fight')
      assert.equal(fightRan, 1)
      assert.ok(lines.some((l) => l.includes('night-grace:') && l.includes('fighting instead')), `fallback logged, got: ${lines.join(' | ')}`)
      assert.equal(ctx.step, null, 'pre-check never ran goal.decide (no step, no chat)')
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('fresh grace but work picks a day step (night steps held): fights instead (post-check)', async () => {
    const bot = graceBot()
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home({ x: 200, y: 64, z: 200 }) // far: shelter feasible, the pre-check passes
    ctx.adoptDone = true // past the spawn-chunk adopt grace: goal decides now
    ctx.lastRespawnAt = Date.now()
    // Hold the shelter (failed, same facts text, same pos): decide falls
    // through the night steps to a day step, and the post-check must catch it.
    const text = goal.goalText(goal.goalFacts(bot, ctx))
    const p = bot.entity.position
    ctx.stepFail = { shelter: { status: 'failed:no-scaffold', text, pos: { x: p.x, y: p.y, z: p.z } } }
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight', 'post-check falls back to fight')
      assert.equal(fightRan, 1)
      assert.ok(lines.some((l) => l.includes('night-grace:') && l.includes('work picked')), `post-check logged, got: ${lines.join(' | ')}`)
      assert.ok(ctx.step && ctx.step !== 'stay' && ctx.step !== 'gohome' && ctx.step !== 'shelter',
        `decide ran and picked a day step, got: ${ctx.step}`)
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('day respawn fights (grace is night-only)', async () => {
    const bot = graceBot()
    bot.time = { timeOfDay: 1000, day: 5 } // day
    const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.home = v2home({ x: 200, y: 64, z: 200 })
    ctx.lastRespawnAt = Date.now()
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(fightRan, 1)
    } finally {
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })
})

describe('lph3 dig-in vetoes: gravity, thin floors, thin walls', () => {
  it('sand column: gravity-dig, never a slumping pit', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { ground: 'sand' })
    const st = {}
    // No dirt anywhere in reach: the scan finds no column, the stance fails.
    assert.equal(recover.digInRun(bot, {}, st), 'failed:gravity-dig')
  })

  it('gravel floor over solid: gravity-floor', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, {
      groundAt: (x, y, z) => (y === 60 ? 'gravel' : null),
    })
    // Feet y64, dig cells y63-61 dirt, floor y60 gravel.
    assert.equal(recover.digInRun(bot, {}, {}), 'failed:gravity-floor')
  })

  it('thin dirt floor over a void: cave-below', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { air: [[0, 59, 0]] })
    // Floor y60 dirt, y59 air: one thin block over a cave. walked=true
    // pins the stance column (no walk to a safe neighbour).
    assert.equal(recover.digInRun(bot, {}, { walked: true }), 'failed:cave-below')
  })

  it('pit one block from a quarry wall: open-side (diagonals count)', () => {
    // East wall stands (1-thin), the diagonal beyond it is air: a 2-wide
    // in waiting, not a pit. walked=true pins the stance column.
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { air: [[1, 61, 1], [1, 62, 1]] })
    assert.equal(recover.digInRun(bot, {}, { walked: true }), 'failed:open-side')
  })

  it('sand walls: open-side, never a slumping ring', () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, {
      groundAt: (x, y, z) => ((x === 1 && z === 0 && y <= 62) ? 'sand' : null),
    })
    // walked=true pins the stance column (no walk to a safe neighbour).
    assert.equal(recover.digInRun(bot, {}, { walked: true }), 'failed:open-side')
  })

  it('dirt column still digs and caps (veto regression)', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    const st = {}
    let r = 'running'
    for (let t = 0; t < 15 && r === 'running'; t++) {
      r = recover.digInRun(bot, {}, st)
      await flush()
    }
    assert.equal(r, 'done')
  })
})
