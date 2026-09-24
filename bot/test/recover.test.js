'use strict'

// Recovery menu (idkcraft-ef3): pit climb, invalid-label fallback, no-exit
// episode, feasibility veto, FSM table, choice sources, ticker routing.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const danger = require('../src/danger')
const { createTicker } = require('../src/index')
const metrics = require('../src/metrics')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// 1x1 shaft: solid floor at y=60, solid walls on all 4 sides from 61 up,
// air inside. Goal above the shaft mouth.
function pitWorld() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 60, z))
  }
  for (let y = 61; y <= 66; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  solids.delete(key(0, 61, 0)); solids.delete(key(0, 62, 0)); solids.delete(key(0, 63, 0))
  return solids
}

function worldBot(solids, items) {
  const pending = new Map() // cell key -> pending placements (yvi: never >1)
  const violations = []
  let inFlight = 0
  let maxInFlight = 0
  const queue = [] //placeresolves
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async placeBlock(ref, face) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const d = ref.position.plus(face)
      const k = key(d.x, d.y, d.z)
      if (pending.has(k)) violations.push(`parallel place into ${k}`)
      pending.set(k, (pending.get(k) || 0) + 1)
      // Slow server: the ack arrives 2 harness ticks later, so a buggy
      // every-tick placer would stack placements (the yvi loop).
      await new Promise((resolve) => queue.push(() => {
        pending.set(k, pending.get(k) - 1)
        if (pending.get(k) <= 0) pending.delete(k)
        inFlight--
        solids.add(k)
        const dirt = items.find((i) => i.name === 'dirt')
        if (dirt) dirt.count--
        resolve()
      }))
    },
    async dig(block) {
      await Promise.resolve()
      solids.delete(key(block.position.x, block.position.y, block.position.z))
    },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g; bot._goals = (bot._goals || 0) + 1 },
      stop() {},
      isMoving: () => false,
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    _pending: { queue, violations, get maxInFlight() { return maxInFlight } },
  }
  return bot
}

// Harness physics: jump lifts 0.5/tick, gravity settles onto solid ground,
// place acks resolve every other tick.
function harness(bot) {
  const q = bot._pending.queue
  let n = 0
  const step = () => {
    n++
    if (bot.getControlState('jump')) bot.entity.position.y += 0.5
    // Slow server: acks arrive every other step, so placements stay in
    // flight across ticks (the yvi condition). Acks still run before
    // gravity, like the real server tick ordering.
    const resolvers = n % 2 === 0 ? q.splice(0, q.length) : []
    for (const r of resolvers) r()
    const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
    if ((!below || below.boundingBox === 'empty') && !bot.getControlState('jump')) {
      bot.entity.position.y = Math.max(60.5, bot.entity.position.y - 0.5)
    }
  }
  return step
}

async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

async function metricText() {
  return metrics.client.register.metrics()
}

describe('recover pit climb (acceptance 1)', () => {
  it('stub-model pillar_up climbs 3 blocks with never-parallel placements', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const askCalls = []
    const brain = { source: 'stub', ask: async (q) => { askCalls.push(q); return 'pillar_up' } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 0, y: 64, z: 0 } }
    const step = harness(bot)
    let ticks = 0
    for (; ticks < 60 && Math.floor(bot.entity.position.y) < 64; ticks++) {
      await ticker.tick()
      await flush()
      step()
    }
    assert.equal(Math.floor(bot.entity.position.y), 64, `climbed out in ${ticks} ticks`)
    assert.equal(bot._pending.maxInFlight, 1, 'placeBlock never parallel')
    assert.deepEqual(bot._pending.violations, [], 'never two placements into one cell')
    assert.equal(askCalls.length, 1, 'one ask for the whole climb (chained, no re-ask)')
    const text = await metricText()
    assert.match(text, /idkcraft_bot_brain_routes_total\{route="hard",reason="stuck"\} [1-9]/)
    assert.match(text, /idkcraft_bot_recover_total\{action="pillar_up",source="stub",outcome="chosen"\} [1-9]/)
    assert.match(text, /idkcraft_bot_recover_total\{action="pillar_up",source="stub",outcome="done"\} [1-9]/)
  })
})

describe('pillar serial placement (yvi)', () => {
  it('never issues a second placement while one is in flight', () => {
    // A slow server holds the ack across ticks: the second tick must wait,
    // not stack another placeBlock into the same cell. Deleting the
    // placeInFlight guard fails this test (places === 2).
    const bot = worldBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62, 0.5) // apex for startFloor 61
    let places = 0
    bot.placeBlock = async () => { places++; await new Promise(() => {}) } // ack never arrives
    const ctx = {
      stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } },
      recovery: { action: 'pillar_up', status: 'running', st: { phase: 'place', startFloor: 61, waited: 0, placeInFlight: false, placed: false, placeError: false } },
    }
    recover.run(bot, ctx)
    assert.equal(places, 1)
    assert.equal(ctx.recovery.status, 'running')
    recover.run(bot, ctx)
    recover.run(bot, ctx)
    assert.equal(places, 1, 'one placement total while the ack is in flight')
    assert.equal(ctx.recovery.status, 'running')
  })
})

describe('recover invalid label (acceptance 2)', () => {
  it('infeasible pillar_up falls back to FSM dig_up with disagree + stub-fallback', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const brain = { source: 'testmodel', ask: async () => 'pillar_up' } // scaffold=0: not on the menu
    const ctx = { stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } }, brain }
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    let decision
    try {
      decision = await recover.decide(bot, ctx, {}, null)
    } finally {
      console.error = origErr
    }
    assert.equal(decision.action, 'dig_up')
    assert.equal(decision.source, 'stub-fallback')
    assert.ok(errLines.some((l) => l.includes('brain disagree') && l.includes('reason=stuck') && l.includes('model=pillar_up') && l.includes('fsm=dig_up')),
      `disagree logged, got: ${errLines.join(' | ')}`)
    const text = await metricText()
    assert.match(text, /idkcraft_bot_recover_total\{action="dig_up",source="stub-fallback",outcome="chosen"\} [1-9]/)
    assert.match(text, /idkcraft_bot_escalation_total\{from="testmodel",to="fsm",reason="invalid"\} [1-9]/)
  })
})

describe('recover sidestep in a pit is not done (fja)', () => {
  // Session 2026-09-24: a 0.9-block shuffle on the pit floor counted as an
  // escape, fails never grew, call_player never came. Pit 1x3, floor y=60,
  // no scaffold/pickaxe, player online: walking the floor must fail, and
  // after 3 fails the bot must chat /tp.
  function pitSolids() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    return solids
  }

  it('floor shuffling fails, 3 fails -> /tp chat, done counted once', async () => {
    const bot = worldBot(pitSolids(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const ctx = {
      stuck: { by: 'no-displacement', goal: null, key: 'pit' },
      brain: { source: 'stub', ask: async () => 'sidestep' },
    }
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.4, d) / d
      bot.entity.position = pos(bp.x + dx * s, 61, bp.z + dz * s)
    }
    for (let t = 0; t < 120 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
    }
    assert.equal(ctx.stuck, null, 'episode over')
    assert.equal(ctx.recovery, null, 'episode over')
    const calls = bot.chats.filter((m) => m.startsWith("I'm stuck at"))
    assert.equal(calls.length, 1, `exactly one /tp chat, got: ${bot.chats.join(' | ')}`)
    assert.match(calls[0], /\/tp IdkBot Steve/)
  })

  it('high-goal pit shuffling is not done either, /tp after 3 fails', async () => {
    // Bead episode two: gather-raised sidestep in the pit with the log goal
    // above — 1.2 blocks of floor shuffle counted as done. The high-goal
    // arm of the strict rule must fail it instead.
    const bot = worldBot(pitSolids(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 65, z: 0 }, key: 'gather' },
      brain: { source: 'stub', ask: async () => 'sidestep' },
    }
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.4, d) / d
      bot.entity.position = pos(bp.x + dx * s, 61, bp.z + dz * s)
    }
    for (let t = 0; t < 120 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
    }
    assert.equal(ctx.stuck, null, 'episode over')
    const calls = bot.chats.filter((m) => m.startsWith("I'm stuck at"))
    assert.equal(calls.length, 1, `exactly one /tp chat, got: ${bot.chats.join(' | ')}`)
    assert.match(calls[0], /\/tp IdkBot Steve/)
  })

  it('level-goal sidestep that walks free reports done, no call_player', async () => {
    // Flat wedge (follow at the same height): walking 2 blocks sideways is
    // a genuine escape — failing it would burn strikes toward dig/call.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 10, y: 61, z: 0 }, key: 'follow:Steve' },
      brain: { source: 'stub', ask: async () => 'sidestep' },
    }
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.4, d) / d
      bot.entity.position = pos(bp.x + dx * s, 61, bp.z + dz * s)
    }
    for (let t = 0; t < 30 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
    }
    assert.equal(ctx.stuck, null, 'episode done, mode resumed')
    assert.equal(ctx.recovery, null, 'episode done, mode resumed')
    assert.deepEqual(bot.chats.filter((m) => m.startsWith("I'm stuck at")), [], 'no call_player')
  })

  it('one sidestep done episode counts outcome=done exactly once', async () => {
    const bot = worldBot(pitSolids(), [])
    const before = (await metricText()).match(/idkcraft_bot_recover_total\{action="sidestep",source="fsm",outcome="done"\} ([0-9.]+)/)
    const ctx = {
      stuck: { by: 'no-displacement', goal: null, key: 'pit' },
      recovery: {
        action: 'sidestep', source: 'fsm', model: null, status: 'done',
        st: null, attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    await recover.decide(bot, ctx, null, null)
    assert.equal(ctx.recovery, null, 'released')
    const after = (await metricText()).match(/idkcraft_bot_recover_total\{action="sidestep",source="fsm",outcome="done"\} ([0-9.]+)/)
    const delta = Number(after && after[1] || 0) - Number(before && before[1] || 0)
    assert.equal(delta, 1, 'done counted once per episode')
  })

  it("chosen line carries facts= and feet=", async () => {
    const bot = worldBot(pitSolids(), [])
    const ctx = {
      stuck: { by: 'no-displacement', goal: null, key: 'pit' },
      brain: { source: 'stub', ask: async () => 'sidestep' },
    }
    const lines = []
    const orig = console.log
    console.log = (m) => lines.push(String(m))
    try {
      await recover.decide(bot, ctx, null, null)
    } finally {
      console.log = orig
    }
    const chosen = lines.filter((l) => l.includes('outcome=chosen'))
    assert.equal(chosen.length, 1)
    assert.ok(chosen[0].includes('facts='), chosen[0])
    assert.ok(chosen[0].includes('feet='), chosen[0])
  })
})

describe('recover dig_step climbs a dirt pit by hand (9sh)', () => {
  // Bead 9sh: scaffold=0, pickaxe=no after death — no climb primitive, yet
  // dirt walls dig by hand. dig_step must be in the menu and climb out.
  function dirtPit() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    // Natural notch: without one irregularity a uniform 4-pit is
    // hand-inescapable by physics (no headroom above any second step).
    solids.delete(key(0, 64, 1))
    return solids
  }

  it('offline dirt pit: dig_step chosen first, bot climbs out itself', async () => {
    const bot = worldBot(dirtPit(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {} // autonomous: call_player infeasible, self-exit only
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null, // FSM reserve picks
    }
    const first = []
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (g && typeof g.x === 'number') {
        const bp = bot.entity.position
        const dx = g.x - bp.x
        const dz = g.z - bp.z
        const d = Math.hypot(dx, dz)
        if (d >= 0.05) {
          const s = Math.min(0.4, d) / d
          bot.entity.position = pos(bp.x + dx * s, bp.y, bp.z + dz * s)
        }
      }
      // Honest jump: at most one block above the cycle start floor — each
      // new height needs a freshly dug step, not a free elevator.
      const st = ctx.recovery && ctx.recovery.st
      const cap = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      if (bot.getControlState('jump') && bot.entity.position.y < cap) bot.entity.position.y += 0.5
    }
    for (let t = 0; t < 200 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
        if (ctx.recovery && ctx.recovery.action && first.length === 0) first.push(ctx.recovery.action)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
      await flush()
    }
    assert.equal(first[0], 'dig_step', `first choice, got ${first}`)
    assert.ok(Math.floor(bot.entity.position.y) >= 65, `climbed out, y=${bot.entity.position.y}`)
    assert.equal(ctx.stuck, null, 'episode over')
    assert.deepEqual(bot.chats.filter((m) => m.startsWith("I'm stuck at")), [], 'no call_player needed')
  })

  it('enclosed stone shaft, player online, high goal: call_player beats sidestep', async () => {
    // 1-wide shaft open to the east only: sidestep is feasible (one free
    // side) but futile, stone digs by hand nowhere. Help goes first.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      solids.add(key(-1, y, 0)); solids.add(key(0, y, -1)); solids.add(key(0, y, 1))
    }
    // Stone walls under a prod-shaped bot (canDigBlock always true):
    // nothing digs by hand, so dig_step must stay out of the menu.
    const bot = worldBot(solids, [])
    bot.canDigBlock = () => true
    bot.blockAt = ((raw) => (p) => {
      const b = raw(p)
      if (b && b.name === 'dirt' && Math.floor(p.y) >= 61) return { ...b, name: 'stone' }
      return b
    })(bot.blockAt)
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null,
    }
    await recover.decide(bot, ctx, null, null)
    assert.equal(ctx.recovery.action, 'call_player', 'help before sideways shuffle')
    for (let t = 0; t < 10 && ctx.recovery; t++) {
      recover.run(bot, ctx)
      if (ctx.recovery && ctx.recovery.status !== 'running') await recover.decide(bot, ctx, null, null)
      await flush()
    }
    assert.ok(bot.chats.some((m) => m.startsWith("I'm stuck at")), `chats: ${bot.chats}`)
    assert.ok(!bot.chats.some((m) => m.includes('sidestepping')), 'sidestep never tried first')
  })
})

describe('recover menu: no climb prims on level goals, no failed repeats (4jr)', () => {
  // Prod 2026-09-24: laya always took the first menu item (pillar_up) on
  // level goals and repeated it after place-error fails. 29 pillar_ups in
  // 16 min, ~20 s standing per attempt.
  function levelWorld() {
    // Floor + one dirt wall with a stone cap: walls=1, but no dig_step
    // (the cap never digs by hand), so the menu is the 4jr case exactly.
    const solids = new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0)])
    return { solids, cap: key(1, 62, 0) }
  }
  function levelBot(cap) {
    const w = levelWorld()
    const bot = worldBot(w.solids, kit)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === cap) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    return bot
  }
  const kit = [{ name: 'dirt', count: 5 }, { name: 'iron_pickaxe', count: 1 }]

  it('level goal: ask menu lacks pillar_up/dig_up, first label gets sidestep', async () => {
    const bot = levelBot(levelWorld().cap)
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const seen = []
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return seen[0][0] } },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.ok(seen.length === 1, 'asked once')
    assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
    assert.ok(!seen[0].includes('dig_up'), `menu: ${seen[0]}`)
    assert.equal(r.action, 'sidestep')
  })

  it('after pillar_up failed:place-error the next ask lacks pillar_up', async () => {
    const bot = levelBot(levelWorld().cap)
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const seen = []
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return seen[0][0] } },
      recovery: {
        action: 'pillar_up', source: 'stub', model: null, status: 'failed:place-error',
        st: null, attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.ok(seen.length === 1, 'asked once')
    assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
    assert.equal(r.action, 'dig_up', `falls to the next climb prim, got ${r.action}`)
  })
  it('a stubborn model repeating the failed prim is overruled to the FSM pick', async () => {
    // 4jr prod case: laya answered pillar_up after pillar_up:failed. The
    // excluded label must read invalid and fall back to FSM escalation.
    const bot = levelBot(levelWorld().cap)
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: { source: 'stub', ask: async () => 'pillar_up' },
      recovery: {
        action: 'pillar_up', source: 'stub', model: null, status: 'failed:place-error',
        st: null, attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'dig_up', `escalated past the repeat, got ${r.action}`)
    assert.equal(r.source, 'stub-fallback')
  })
})

describe('recover BEHAVIOURS wiring (round-1 finding 3)', () => {
  it('every RECOVER_ORDER name dispatches through the ticker', () => {
    // dig_step chose fine but froze live: BEHAVIOURS had no entry, so
    // applyDecision stopOnce()d every tick and digStepRun never ran.
    const { BEHAVIOURS } = require('../src/index')
    for (const n of recover.RECOVER_ORDER) {
      assert.equal(typeof BEHAVIOURS[n], 'function', n)
    }
  })

  it('dig_step mid-air above the step is not done', () => {
    // Jump apex samples y+1 while airborne: done needs ground, not rise.
    const bot = worldBot(new Set([key(0, 60, 0)]), [])
    bot.entity.position = pos(0.5, 62.0, 1.0)
    bot.entity.onGround = false
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      recovery: {
        action: 'dig_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [0, 1], phase: 'step', waited: 0, digInFlight: false, digError: false, startFloor: 61 },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'airborne apex is not an escape')
    bot.entity.onGround = true
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done', 'grounded on the step is')
  })
})

describe('recover no-exit episode (acceptance 3)', () => {
  it('stubborn stub overruled -> exactly one call_player chat, goal dropped', async () => {
    // 4jr: the stub repeats the failed sidestep, so the ask menu excludes it
    // and the invalid answer falls back to FSM escalation (source
    // stub-fallback, not fsm) — same single chat, dropped goal, gave-up.
    const bot = worldBot(new Set([key(0, 60, 0)]), [])
    // Wedged executor: still "moving" at release, so only the release's own
    // setGoal(null) drops the goal (stopOnce would merely stop). Deleting it
    // fails this test (goal stays a live GoalNear).
    bot.pathfinder.isMoving = () => true
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const brain = { source: 'stub', ask: async () => 'sidestep' }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 50, y: 64, z: 0 } }
    const step = harness(bot)
    for (let t = 0; t < 60 && (bot._tickerCtx.stuck || bot._tickerCtx.recovery); t++) {
      await ticker.tick()
      await flush()
      step()
    }
    assert.equal(bot._tickerCtx.stuck, null)
    assert.equal(bot._tickerCtx.recovery, null)
    const calls = bot.chats.filter((m) => m.startsWith("I'm stuck at"))
    assert.equal(calls.length, 1, `exactly one call_player chat, got: ${bot.chats.join(' | ')}`)
    assert.match(calls[0], /\/tp IdkBot Steve/)
    assert.equal(bot.pathfinder.goal, null, 'goal dropped after the episode')
    const text = await metricText()
    assert.match(text, /idkcraft_bot_recover_total\{action="call_player",source="stub-fallback",outcome="chosen"\} [1-9]/)
    assert.match(text, /idkcraft_bot_recover_total\{action="call_player",source="stub-fallback",outcome="gave-up"\} [1-9]/)
  })
})

describe('recover feasibility veto', () => {
  const F = (over) => ({
    scaffold: 0, pickaxe: false, headBlocked: false, walls: 0, lavaNear: false,
    playerOnline: false, goalDy: 0, ...over,
  })
  const C = (over) => ({ recovery: null, ...over })
  it('lava vetoes both dig primitives, head blocks pillar, walls box sidestep', () => {
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(F({ pickaxe: true, lavaNear: true })), false)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, lavaNear: true })), false)
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(F({ pickaxe: true })), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, headBlocked: true })), false)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, goalDy: 3 })), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, goalDy: 0 })), false, '4jr: no pillar to a level goal')
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, goalDy: 2 })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, goalDy: 0 })), false, '4jr: no dig-up to a level goal')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({})), false) // no scaffold
    assert.equal(recover.RECOVER_MENU.sidestep.feasible(F({ walls: 4 })), false)
    assert.equal(recover.RECOVER_MENU.sidestep.feasible(F({ walls: 3 })), true)
    assert.equal(recover.RECOVER_MENU.wait.feasible(F({})), true)
  })
  it('call_player needs a player online and fires once per episode', () => {
    assert.equal(recover.RECOVER_MENU.call_player.feasible(F({}), C({})), false)
    assert.equal(recover.RECOVER_MENU.call_player.feasible(F({ playerOnline: true }), C({})), true)
    assert.equal(recover.RECOVER_MENU.call_player.feasible(
      F({ playerOnline: true }), C({ recovery: { calledPlayer: true } })), false)
  })
})

describe('recover FSM table (bead order)', () => {
  const names = (list) => list
  it('climbs when the goal is above, sidesteps, digs, calls, waits', () => {
    const F = (over) => ({ goalDy: 0, ...over })
    assert.equal(recover.recoverFsm(F({ goalDy: 3 }), names(['pillar_up', 'sidestep', 'wait'])), 'pillar_up')
    assert.equal(recover.recoverFsm(F({ goalDy: 3 }), names(['dig_up', 'sidestep', 'wait'])), 'dig_up')
    assert.equal(recover.recoverFsm(F({ goalDy: 0 }), names(['sidestep', 'dig_through', 'wait'])), 'sidestep')
    assert.equal(recover.recoverFsm(F({ goalDy: 0 }), names(['dig_through', 'wait'])), 'dig_through')
    assert.equal(recover.recoverFsm(F({ goalDy: 0 }), names(['call_player', 'wait'])), 'call_player')
    assert.equal(recover.recoverFsm(F({ goalDy: 0 }), names(['wait'])), 'wait')
  })
})

describe('recover choice sources', () => {
  const facts = {
    goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false,
    headBlocked: false, walls: 0, freeSides: [[1, 0]], lavaNear: false,
    playerOnline: true, playerDist: 5, playerName: 'Steve', stuckTicks: 12,
    resetsStuck: 0, resetsPlaceError: 0, last: 'none', by: 'follow',
  }
  const feasible = ['sidestep', 'wait', 'call_player'] // fsm: sidestep
  it('single feasible action: only-option, brain never asked', async () => {
    const boom = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    const r = await recover.chooseRecovery(boom, facts, ['wait'])
    assert.deepEqual(r, { action: 'wait', source: 'only-option', fsm: 'wait', model: null })
  })
  it('failed exclusion shrinking the menu to one: only-option, brain never asked', async () => {
    // Round-2 minors: asking a one-answer question wastes a brain call and
    // up to BRAIN_TIMEOUT_MS on the tick path, up to MAX_FAILS-1 times.
    const boom = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    const failed = { ...facts, last: 'sidestep:failed:no-progress' }
    const r = await recover.chooseRecovery(boom, failed, ['sidestep', 'wait'])
    assert.deepEqual(r, { action: 'wait', source: 'only-option', fsm: 'wait', model: null })
  })
  it('brain without ask: FSM directly, source fsm', async () => {
    const r = await recover.chooseRecovery({ source: 'stub' }, facts, feasible)
    assert.deepEqual(r, { action: 'sidestep', source: 'fsm', fsm: 'sidestep', model: null })
  })
  it('model answer flows through with its source', async () => {
    const brain = { source: 'laya', ask: async () => 'wait' }
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    let r
    try {
      r = await recover.chooseRecovery(brain, facts, feasible)
    } finally {
      console.error = origErr
    }
    assert.equal(r.action, 'wait')
    assert.equal(r.source, 'laya')
    assert.ok(errLines.some((l) => l.includes('brain disagree') && l.includes('reason=stuck')))
  })
  it('model error: stub-fallback + escalation counted', async () => {
    const brain = { source: 'laya', ask: async () => { const e = new Error('down'); e.name = 'TimeoutError'; throw e } }
    const r = await recover.chooseRecovery(brain, facts, feasible)
    assert.deepEqual(r, { action: 'sidestep', source: 'stub-fallback', fsm: 'sidestep', model: 'laya' })
    const text = await metricText()
    assert.match(text, /idkcraft_bot_escalation_total\{from="laya",to="fsm",reason="timeout"\} [1-9]/)
  })
})

describe('gave-up marks danger (mnx)', () => {
  it('release gave-up marks the spot; release done leaves no mark', () => {
    // Acceptance: the gave-up point itself is what later steps avoid.
    const bot = { pathfinder: { goal: null }, entity: { position: pos(10, 64, 0) }, username: 'IdkBot' }
    const ctx = {}
    recover.setStuck(ctx, 'follow', { x: 10, y: 64, z: 0 }, 'follow:Steve')
    ctx.recovery = { action: 'sidestep', status: 'done' }
    recover.release(bot, ctx, 'gave-up')
    assert.equal(danger.near(ctx, { x: 10, y: 64, z: 0 }), true)
    assert.equal(danger.near(ctx, { x: 100, y: 64, z: 100 }), false)
    const ctx2 = {}
    recover.setStuck(ctx2, 'follow', { x: 10, y: 64, z: 0 }, 'follow:Steve')
    ctx2.recovery = { action: 'sidestep', status: 'done' }
    recover.release(bot, ctx2, 'done')
    assert.equal(danger.count(ctx2), 0)
  })
})

describe('setStuck transition', () => {
  it('latch blocks the same situation, a moved goal re-raises', () => {
    // M4: after an episode the same detector must stay quiet until the
    // situation changes — otherwise ask+chat every few seconds.
    const ctx = {}
    assert.equal(recover.setStuck(ctx, 'follow', { x: 10, y: 64, z: 0 }, 'follow:Steve'), true)
    ctx.recovery = { action: 'sidestep', status: 'done' }
    recover.release({ pathfinder: { goal: null }, entity: { position: pos(0, 64, 0) }, username: 'IdkBot' }, ctx, 'done')
    assert.deepEqual(ctx.recoverLatch, { by: 'follow', key: 'follow:Steve', goal: { x: 10, y: 64, z: 0 } })
    // Same situation: quiet.
    assert.equal(recover.setStuck(ctx, 'follow', { x: 10, y: 64, z: 0 }, 'follow:Steve'), false)
    assert.equal(ctx.stuck, null)
    // Player walked off: latch clears, fact raises.
    assert.equal(recover.setStuck(ctx, 'follow', { x: 20, y: 64, z: 0 }, 'follow:Steve'), true)
    assert.equal(ctx.recoverLatch, null)
    assert.deepEqual(ctx.stuck.goal, { x: 20, y: 64, z: 0 })
  })
  it('true on raise, false while set or while an episode runs', () => {
    const ctx = {}
    assert.equal(recover.setStuck(ctx, 'follow', { x: 1, y: 2, z: 3 }), true)
    assert.deepEqual(ctx.stuck, { by: 'follow', goal: { x: 1, y: 2, z: 3 }, key: 'follow' })
    assert.equal(recover.setStuck(ctx, 'roam', null), false)
    assert.deepEqual(ctx.stuck.by, 'follow')
    ctx.recovery = { action: 'wait', status: 'running' }
    ctx.stuck = null
    assert.equal(recover.setStuck(ctx, 'lead', null), false)
    assert.equal(ctx.stuck, null)
  })
})

describe('ticker stuck routing', () => {
  function followBot() {
    const bot = worldBot(new Set([key(0, 60, 0)]), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    return bot
  }
  it('stuck routes hard reason=stuck and skips the brain call', async () => {
    const bot = followBot()
    let decides = 0
    const brain = { async decide() { decides++; return { action: 'follow', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    // Level goal: 9sh puts call_player before sidestep on high goals with
    // no climb primitive, so this routing test stays level to keep sidestep.
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 10, y: 61, z: 0 } }
    const r = await ticker.tick()
    assert.equal(decides, 0, 'no brain call on the stuck tick')
    assert.equal(r.calledBrain, false)
    assert.equal(r.decision.action, 'sidestep') // fsm on the ask-less brain
    const text = await metricText()
    assert.match(text, /idkcraft_bot_brain_routes_total\{route="hard",reason="stuck"\} [1-9]/)
  })
  it('a hostile in swing reach preempts recovery (urgent fight)', async () => {
    const bot = followBot()
    bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(2, 61, 0) } } // ~1.6 blocks: inside swing reach
    let decides = 0
    const brain = { async decide() { decides++; return { action: 'follow', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 10, y: 64, z: 0 } }
    const r = await ticker.tick()
    assert.equal(decides, 1, 'brain runs when a fight is urgent')
    assert.equal(r.decision.action, 'follow')
    assert.equal(bot._tickerCtx.stuck.by, 'follow', 'fact waits for the next tick')
  })
})

describe('ticker backstops (minor)', () => {
  function standBot() {
    const bot = worldBot(new Set([key(0, 60, 0)]), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    // Level player: 9sh puts call_player before sidestep on high goals with
    // no climb primitive, and these backstop tests pin the sidestep start.
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 61, 0) } } }
    return bot
  }
  it('three place_error resets raise by=place_error and start an episode', async () => {
    // Deleting the backstop line fails this test (stuck stays null).
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      const bot = standBot()
      const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
      const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
      ticker.setPathReset('place_error')
      ticker.setPathReset('place_error')
      ticker.setPathReset('place_error')
      await ticker.tick()
      assert.equal(bot._tickerCtx.stuck.by, 'place_error')
      assert.ok(lines.some((l) => l.includes('recover action=sidestep') && l.includes('outcome=chosen')),
        `episode started, got: ${lines.join(' | ')}`)
    } finally {
      console.log = origLog
    }
  })
  it('gather owning the step suppresses the place_error backstop (yvi gate)', async () => {
    const bot = standBot()
    const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.work = true
    bot._tickerCtx.step = 'gather'
    bot._tickerCtx.gather = { pos: null, skip: new Set(), streak: 0 }
    ticker.setPathReset('place_error')
    ticker.setPathReset('place_error')
    ticker.setPathReset('place_error')
    await ticker.tick()
    assert.equal(bot._tickerCtx.stuck, null, 'gather skips the column itself; no episode')
  })
  it('thirty still ticks with a moving executor raise by=no-displacement', async () => {
    // Inverting the moving check fails this (fires while parked); deleting
    // the line fails the first half (never fires).
    const bot = standBot()
    bot.pathfinder.isMoving = () => true
    const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    // 1 anchor tick + 30 still ticks to trip STUCK_TICKS_ENTRY.
    for (let t = 0; t < 31; t++) await ticker.tick()
    assert.equal(bot._tickerCtx.stuck && bot._tickerCtx.stuck.by, 'no-displacement')
  })
  it('no backstop while parked (executor idle)', async () => {
    const bot = standBot()
    bot.pathfinder.isMoving = () => false
    const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    for (let t = 0; t < 35; t++) await ticker.tick()
    assert.equal(bot._tickerCtx.stuck, null)
  })
})

describe('episode entry drops the stale goal (M2)', () => {
  it('a live goal is nulled before the primitive runs', async () => {
    // Without the entry drop the old GoalFollow keeps driving the executor
    // against the primitive. Deleting the drop fails this test.
    const bot = worldBot(new Set([key(0, 60, 0)]), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    bot.pathfinder.goal = { live: 'GoalFollow' }
    const brain = { ask: async () => 'wait' }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 10, y: 64, z: 0 }, key: 'follow:7' }
    await ticker.tick()
    assert.equal(bot.pathfinder.goal, null, 'stale goal dropped on entry (wait sets none)')
  })
})

describe('recover FSM escalation (prod wedges)', () => {
  it('a just-failed primitive yields to the next feasible one', () => {
    // 28 of 35 repeat wedges at the same spot: after a failure the FSM must
    // escalate, not repeat. Removing the exclusion fails this test.
    const F = (over) => ({ goalDy: 0, ...over })
    assert.equal(
      recover.recoverFsm(F({ last: 'sidestep:failed:no-progress' }), ['sidestep', 'dig_through', 'wait']),
      'dig_through')
    assert.equal(
      recover.recoverFsm(F({ last: 'sidestep:failed:no-progress' }), ['sidestep', 'wait']),
      'wait')
    assert.equal(
      recover.recoverFsm(F({ goalDy: 3, last: 'pillar_up:failed:no-apex' }), ['pillar_up', 'dig_up', 'wait']),
      'dig_up')
    // No failure (or a single feasible action): order unchanged.
    assert.equal(
      recover.recoverFsm(F({ last: 'none' }), ['sidestep', 'dig_through', 'wait']),
      'sidestep')
    assert.equal(
      recover.recoverFsm(F({ last: 'sidestep:done' }), ['sidestep', 'wait']),
      'sidestep')
    assert.equal(
      recover.recoverFsm(F({ last: 'sidestep:failed:no-progress' }), ['sidestep']),
      'sidestep')
  })
})

describe('recover hop_step mounts a +1 step on a level goal (cjq)', () => {
  // Prod 2026-09-24: executor wedges on a straight cardinal +1 (path=success,
  // reset=stuck x8) with a level follow goal; the menu offers sidestep/wait
  // but no plain mount, so the +1 never gets climbed. hop_step hops it.
  function stepWorld() {
    // Floor + one STONE step east with air above: no dig_step (above is air
    // but the stone never digs by hand — findDigStepDir still fires, so the
    // FSM must prefer the no-dig hop on a level goal).
    return new Set([key(0, 60, 0), key(1, 61, 0)])
  }
  function stepBot() {
    const bot = worldBot(stepWorld(), [])
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 61, 0)) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    return bot
  }

  it('level goal, stone +1 east, air above: hop_step in the menu, FSM picks it', async () => {
    const bot = stepBot()
    const seen = []
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return 'hop_step' } },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.ok(seen.length === 1, 'asked once')
    assert.ok(seen[0].includes('hop_step'), `menu: ${seen[0]}`)
    assert.equal(r.action, 'hop_step', `got ${r.action}`)
    // FSM reserve, no model: the hop line fires before sidestep.
    const bot2 = stepBot()
    const ctx2 = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: null,
    }
    const r2 = await recover.decide(bot2, ctx2, null, null)
    assert.equal(r2.action, 'hop_step', `fsm got ${r2.action}`)
  })

  it('hop_step run mounts the step and ends the episode', async () => {
    const bot = stepBot()
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: null,
    }
    const first = []
    const stepBody = () => {
      const bp = bot.entity.position
      if (bot.getControlState('forward')) {
        const yaw = bot._yaw || 0
        bot.entity.position = pos(bp.x - Math.sin(yaw) * 0.4, bp.y, bp.z - Math.cos(yaw) * 0.4)
      } else {
        const g = bot.pathfinder.goal
        if (g && typeof g.x === 'number') {
          const dx = g.x - bp.x
          const dz = g.z - bp.z
          const d = Math.hypot(dx, dz)
          if (d >= 0.05) {
            const s = Math.min(0.4, d) / d
            bot.entity.position = pos(bp.x + dx * s, bp.y, bp.z + dz * s)
          }
        }
      }
      const st = ctx.recovery && ctx.recovery.st
      const cap = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      if (bot.getControlState('jump') && bot.entity.position.y < cap) bot.entity.position.y += 0.5
    }
    for (let t = 0; t < 60 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
        if (ctx.recovery && ctx.recovery.action && first.length === 0) first.push(ctx.recovery.action)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
      await flush()
    }
    assert.equal(first[0], 'hop_step', `first choice, got ${first}`)
    assert.ok(Math.floor(bot.entity.position.y) >= 62, `mounted, y=${bot.entity.position.y}`)
    assert.equal(ctx.stuck, null, 'episode over')
  })

  it('stone cap above the step: hop stays out, sidestep keeps its turn', async () => {
    // The 4jr pin: hop must not steal the menu where no mount exists.
    const bot = stepBot()
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 62, 0)) {
        return { ...b, name: 'stone', boundingBox: 'block' }
      }
      return b
    }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: null,
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'sidestep', `got ${r.action}`)
  })

  it('lava above the step vetoes the hop', async () => {
    const bot = stepBot()
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 62, 0)) {
        return { ...b, name: 'lava', boundingBox: 'block' }
      }
      return b
    }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: null,
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.notEqual(r.action, 'hop_step', `got ${r.action}`)
  })

  it('hop mid-air above the step is not done', () => {
    const bot = stepBot()
    bot.entity.position = pos(1.0, 62.0, 0.5)
    bot.entity.onGround = false
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, phase: 'hop', waited: 0, startFloor: 61, jumping: true },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'airborne apex is not an escape')
  })

  it('hop walks to the edge first, leaps inside jump range', () => {
    const bot = stepBot()
    bot.entity.position = pos(-1.5, 61, 0.5)
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, phase: 'hop', waited: 0, startFloor: 61, jumping: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('forward'), 'walking to the edge')
    assert.ok(!bot.getControlState('jump'), 'no early leap from 3m out')
    bot.entity.position = pos(0.9, 61, 0.5)
    recover.run(bot, ctx)
    assert.ok(bot.getControlState('jump'), 'leap latches at the edge')
    assert.ok(ctx.recovery.st.jumping, 'latch sticks')
  })
})
