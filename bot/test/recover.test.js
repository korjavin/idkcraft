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
    // 9sq F1 gates dig_up on blocked headroom: bury the head so dig_up stays
    // the FSM answer (the pin is the invalid-label fallback, not the menu).
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    solids.add(key(0, 63, 0))
    const bot = worldBot(solids, [{ name: 'iron_pickaxe', count: 1 }])
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
    const line = errLines.find((l) => l.includes('brain disagree'))
    assert.ok(line.includes('menu=') && line.includes('dig_up'), `asked menu logged, got: ${line}`)
    assert.ok(line.indexOf('menu=') < line.indexOf('facts='), `menu precedes facts, got: ${line}`)
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
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null, // FSM reserve picks
    }
    const first = []
    const stepBody = () => {
      // Direct drive (jsf.4: the mount sets no goal) plus the goal walk
      // other prims may issue.
      const bp = bot.entity.position
      const yaw = bot._yaw || 0
      if (bot.getControlState('forward')) {
        bot.entity.position = pos(bp.x - Math.sin(yaw) * 0.4, bp.y, bp.z - Math.cos(yaw) * 0.4)
      } else if (bot.getControlState('back')) {
        bot.entity.position = pos(bp.x + Math.sin(yaw) * 0.4, bp.y, bp.z + Math.cos(yaw) * 0.4)
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
      // Honest jump + gravity (jsf.4: the leap lands the body on the step
      // top — done must read grounded feet over the dug column, not a
      // mid-air sample beside the wall): a held jump impulses +1.0 from the
      // ground only; airborne ticks fall, and solid ground below snaps the
      // feet and grounds.
      const st = ctx.recovery && ctx.recovery.st
      const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      const jumping = bot.getControlState('jump')
      if (jumping && bot.entity.onGround && bot.entity.position.y < capY) bot.entity.position.y += 1.0
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if (below && below.boundingBox !== 'empty') {
        bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
        bot.entity.onGround = true
      } else if (!jumping || !bot.entity.onGround) {
        bot.entity.position.y -= 0.5
        bot.entity.onGround = false
        const land = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
        if (land && land.boundingBox !== 'empty') {
          bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
          bot.entity.onGround = true
        }
      } else {
        bot.entity.onGround = false
      }
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
    // Floor + one dirt wall with a stone cap, no pickaxe on hand: walls=1,
    // but no dig_step (the stone cap needs a pick since jsf.4), so the menu
    // is the 4jr case exactly. Headroom stays FREE on purpose (revmux-01
    // body-1): a head block would exclude pillar_up by itself and mask the
    // failed-action rules below. The dig_up fallback lives in its own
    // buried-head test instead.
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
  const kit = [{ name: 'dirt', count: 5 }] // no pickaxe: the 4jr pin is the exclusion, not the dig menu

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
    // Head free: pillar_up stays feasible, so only the 4jr ask-exclusion
    // removes it (revmux-01 body-1). dig_up is out (9sq F1: free headroom).
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
    assert.equal(r.action, 'sidestep', `falls past the failed prim, got ${r.action}`)
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
    assert.equal(r.action, 'sidestep', `escalated past the repeat, got ${r.action}`)
    assert.equal(r.source, 'stub-fallback')
  })

  it('a stubborn repeat is overruled to dig_up when headroom is blocked', async () => {
    // Buried-head companion (revmux-01 body-1): with solid headroom, dig_up
    // is legitimately offered (9sq F1) and stays the FSM fallback for a
    // high goal when the model repeats the failed prim.
    const w = levelWorld()
    w.solids.add(key(0, 62, 0))
    const bot = worldBot(w.solids, [...kit, { name: 'iron_pickaxe', count: 1 }]) // dig_up needs the pick
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === w.cap) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const seen = []
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return 'pillar_up' } },
      recovery: {
        action: 'pillar_up', source: 'stub', model: null, status: 'failed:place-error',
        st: null, attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.ok(seen[0].includes('dig_up'), `buried head offers dig_up, menu: ${seen[0]}`)
    assert.equal(r.action, 'dig_up', `escalated to the climb prim, got ${r.action}`)
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
    playerOnline: false, goalDy: 0, throughBlocked: false, ...over,
  })
  const C = (over) => ({ recovery: null, ...over })
  it('lava vetoes both dig primitives, head blocks pillar, walls box sidestep', () => {
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(F({ pickaxe: true, lavaNear: true })), false)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, lavaNear: true })), false)
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(F({ pickaxe: true, throughBlocked: true })), true)
    assert.equal(recover.RECOVER_MENU.dig_through.feasible(F({ pickaxe: true, throughBlocked: false })), false, '9sq F1: no tunnel with nothing toward the goal')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, headBlocked: true })), false)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, goalDy: 3 })), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, goalDy: 0 })), false, '4jr: no pillar to a level goal')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3, goalDy: 3, water: true })), false, '5vv: no pillar apex in water')
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(F({ scaffold: 3, goalDy: 3, water: true })), false, '5vv: no pillar repeat in water')
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(F({ scaffold: 3, goalDy: 3 })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, goalDy: 2, headBlocked: true })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, goalDy: 2, headBlocked: false })), false, '9sq F1: no dig-up into free headroom')
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(F({ pickaxe: true, goalDy: 0 })), false, '4jr: no dig-up to a level goal')
    assert.equal(recover.RECOVER_MENU.dig_up.repeatable(F({ pickaxe: true, goalDy: 2, headBlocked: true })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.repeatable(F({ pickaxe: true, goalDy: 2, headBlocked: false })), false, '9sq F1: no chain onto free headroom')
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

describe('recover menu shaping (y34)', () => {
  const facts = {
    goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false,
    headBlocked: false, walls: 4, freeSides: [], lavaNear: false,
    playerOnline: false, playerDist: null, playerName: null, stuckTicks: 12,
    resetsStuck: 0, resetsPlaceError: 0, last: 'none', by: 'follow',
  }
  it('shapeRecoverMenu drops dig_step only when hop_step shares a multi-menu', () => {
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'hop_step', 'wait']), ['hop_step', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait']), ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step']), ['dig_step'])
    assert.deepEqual(recover.shapeRecoverMenu(['hop_step', 'wait']), ['hop_step', 'wait'])
  })
  it('hop menu: the model is asked without dig_step', async () => {
    // Prod (603 stuck disagreements, 549 model=dig_step): laya digs where a
    // hop would do. Removing the shaping re-offers dig (asked includes it).
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'hop_step' } }
    const r = await recover.chooseRecovery(brain, facts, ['dig_step', 'hop_step', 'wait'])
    assert.deepEqual(asked, ['hop_step', 'wait'])
    assert.deepEqual(r, { action: 'hop_step', source: 'laya', fsm: 'hop_step', model: 'laya' })
  })
  it('dig-loving model on a hop menu: invalid dig falls back to FSM hop', async () => {
    // The exact prod case: laya answers dig_step against FSM hop_step. dig
    // is not on the asked menu, so it disagrees (menu= shaped) and the FSM
    // hop runs instead of the dig.
    const brain = { source: 'laya', ask: async () => 'dig_step' }
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    let r
    try {
      r = await recover.chooseRecovery(brain, facts, ['dig_step', 'hop_step', 'wait'])
    } finally {
      console.error = origErr
    }
    assert.deepEqual(r, { action: 'hop_step', source: 'stub-fallback', fsm: 'hop_step', model: 'laya' })
    const line = errLines.find((l) => l.includes('brain disagree'))
    const menu = line && /menu=([\w,]+)/.exec(line)
    assert.ok(menu && menu[1] === 'hop_step,wait', `shaped menu logged, got: ${line}`)
  })
  it('failed hop still escalates to digging: shaping is a no-op without hop', async () => {
    // 4jr exclusion removes the failed hop first; shaping must not hide the
    // dig it escalates to. Reversing the order (shape first) breaks this.
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'dig_step' } }
    const failed = { ...facts, last: 'hop_step:failed:no-apex' }
    const r = await recover.chooseRecovery(brain, failed, ['dig_step', 'hop_step', 'wait'])
    assert.deepEqual(asked, ['dig_step', 'wait'])
    assert.equal(r.action, 'dig_step')
    assert.equal(r.source, 'laya')
  })
  it('shaping shrinking the menu to one: only-option hop, brain never asked', async () => {
    const boom = { source: 'x', ask: async () => { throw new Error('must not ask') } }
    const r = await recover.chooseRecovery(boom, facts, ['dig_step', 'hop_step'])
    assert.deepEqual(r, { action: 'hop_step', source: 'only-option', fsm: 'hop_step', model: null })
  })
})

describe('recover side shaping (duc)', () => {
  const facts = {
    goalDy: 0, goalDist: 10, scaffold: 0, pickaxe: false, water: false,
    headBlocked: false, walls: 2, freeSides: [[1, 0]], lavaNear: false,
    playerOnline: false, playerDist: null, playerName: null, stuckTicks: 12,
    resetsStuck: 0, resetsPlaceError: 0, last: 'none', by: 'follow',
  }
  const high = { ...facts, goalDy: 5, goalDist: 12 }
  it('shapeRecoverMenu drops dig_step for sidestep only below a high goal', () => {
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait'], facts), ['sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait'], { ...facts, goalDy: -3 }), ['sidestep', 'wait'])
    // Boundary pin (revmux 01 minor x2): <1/<3/<=2 mutants must die here.
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait'], { ...facts, goalDy: 1 }), ['sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait'], { ...facts, goalDy: 2 }), ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait'], high), ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'sidestep', 'wait']), ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(recover.shapeRecoverMenu(['dig_step', 'wait'], facts), ['dig_step', 'wait'])
  })
  it('level side menu: the model is asked without dig_step', async () => {
    // y34 residual (prod 221, stand 0/9): laya digs a step upward where a
    // sidestep would do. Removing the goal gate re-offers dig.
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'sidestep' } }
    const r = await recover.chooseRecovery(brain, facts, ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(asked, ['sidestep', 'wait'])
    assert.deepEqual(r, { action: 'sidestep', source: 'laya', fsm: 'sidestep', model: 'laya' })
  })
  it('high side menu: dig_step stays, the FSM climber is askable', async () => {
    // Dropping the goalDy<2 gate would hide the only climber here and the
    // model would sidestep under a high goal.
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'dig_step' } }
    const r = await recover.chooseRecovery(brain, high, ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(asked, ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(r, { action: 'dig_step', source: 'laya', fsm: 'dig_step', model: 'laya' })
  })
  it('failed sidestep still escalates to digging', async () => {
    // 4jr exclusion removes the failed sidestep first; shaping must not
    // hide the dig it escalates to.
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'dig_step' } }
    const failed = { ...facts, last: 'sidestep:failed:no-gain' }
    const r = await recover.chooseRecovery(brain, failed, ['dig_step', 'sidestep', 'wait'])
    assert.deepEqual(asked, ['dig_step', 'wait'])
    assert.equal(r.action, 'dig_step')
    assert.equal(r.source, 'laya')
  })
  it('enclosed pit without escape: no shaping, digging out stays askable', async () => {
    // [dig,wait] with a level goal: shaping to only-option wait would stand
    // still forever in a diggable pit.
    let asked = null
    const brain = { source: 'laya', ask: async ({ criteria }) => { asked = Object.keys(criteria); return 'dig_step' } }
    const errLines = []
    const origErr = console.error
    console.error = (l) => { errLines.push(String(l)) }
    let r
    try {
      r = await recover.chooseRecovery(brain, facts, ['dig_step', 'wait'])
    } finally {
      console.error = origErr
    }
    assert.deepEqual(asked, ['dig_step', 'wait'])
    assert.equal(r.action, 'dig_step')
    const line = errLines.find((l) => l.includes('brain disagree'))
    const menu = line && /menu=([\w,]+)/.exec(line)
    assert.ok(menu && menu[1] === 'dig_step,wait', `unshaped menu logged, got: ${line}`)
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

describe('repeat gave-up pages the owner (rw4.9)', () => {
  function pageBot(at, players) {
    return {
      username: 'IdkBot', players: players || {},
      entity: { position: pos(at[0], at[1], at[2]) },
      pathfinder: { goal: null },
      chats: [], chat(m) { this.chats.push(String(m)) },
    }
  }
  it('first gave-up marks silently; second at the live mark pages once', () => {
    // Prod 2026-09-27: cross-step episodes re-ground the same pit for an
    // hour with nobody online to hear call_player. Different by/key per
    // episode mirrors the cross-step loop (the latch only holds one).
    const bot = pageBot([10, 64, 0])
    const ctx = {}
    recover.setStuck(ctx, 'explore', { x: 40, y: 64, z: 0 }, 'explore:40,0')
    ctx.recovery = { action: 'sidestep', source: 'laya' }
    recover.release(bot, ctx, 'gave-up')
    assert.deepEqual(bot.chats, [])
    assert.equal(danger.count(ctx), 1)
    recover.setStuck(ctx, 'roam', { x: -30, y: 64, z: 5 }, 'roam:back')
    ctx.recovery = { action: 'dig_step', source: 'laya' }
    recover.release(bot, ctx, 'gave-up')
    assert.equal(bot.chats.length, 1)
    assert.match(bot.chats[0], /I'm stuck at 10 64 0 again with nobody online/)
  })
  it('third gave-up at the same mark stays silent (latched)', () => {
    const bot = pageBot([10, 64, 0])
    const ctx = {}
    const detectors = [['explore', 'explore:40,0'], ['roam', 'roam:back'], ['gather', 'gather']]
    for (const [by, key] of detectors) {
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
    }
    assert.equal(bot.chats.length, 1)
  })
  it('no page with a player online (call_player owns it)', () => {
    const bot = pageBot([10, 64, 0], { Steve: {} })
    const ctx = {}
    for (const [by, key] of [['explore', 'explore:40,0'], ['roam', 'roam:back']]) {
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
    }
    assert.deepEqual(bot.chats, [])
  })
  it('ping-pong inside one pit pages once (revmux 01-review)', () => {
    const bot = pageBot([10, 64, 0])
    const ctx = {}
    const spots = [[10, 'explore', 'explore:40,0'], [13, 'roam', 'roam:back'], [10, 'gather', 'gather'], [13, 'follow', 'follow:Bob']]
    for (const [x, by, key] of spots) {
      bot.entity.position = pos(x, 64, 0)
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
    }
    assert.equal(bot.chats.length, 1)
  })
  it('expired page latch re-arms', () => {
    const bot = pageBot([10, 64, 0])
    const ctx = {}
    for (const [by, key] of [['explore', 'explore:40,0'], ['roam', 'roam:back']]) {
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
    }
    assert.equal(bot.chats.length, 1)
    ctx.repeatGaveUpPage.at = Date.now() - danger.TTL_MS - 1000
    recover.setStuck(ctx, 'gather', { x: 40, y: 64, z: 0 }, 'gather')
    ctx.recovery = { action: 'sidestep', source: 'laya' }
    recover.release(bot, ctx, 'gave-up')
    assert.equal(bot.chats.length, 2)
  })
  it('rest repeats stay silent (q0h owns rest paging)', () => {
    const bot = pageBot([10, 64, 0])
    const ctx = { work: true, step: 'rest', stepStatus: 'running' }
    for (const [by, key] of [['roam', 'roam:back'], ['roam', 'roam:back2']]) {
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
      ctx.stepStatus = 'running' // escalation may fail rest; keep looping
    }
    assert.deepEqual(bot.chats, [])
  })
  it('relocated repeat pages again', () => {
    const bot = pageBot([10, 64, 0])
    const ctx = {}
    for (const [by, key] of [['explore', 'explore:40,0'], ['roam', 'roam:back']]) {
      recover.setStuck(ctx, by, { x: 40, y: 64, z: 0 }, key)
      ctx.recovery = { action: 'sidestep', source: 'laya' }
      recover.release(bot, ctx, 'gave-up')
    }
    assert.equal(bot.chats.length, 1)
    bot.entity.position = pos(20, 64, 0) // 10 out: past the pit, needs its own mark+page
    recover.setStuck(ctx, 'gather', { x: 40, y: 64, z: 0 }, 'gather')
    ctx.recovery = { action: 'sidestep', source: 'laya' }
    recover.release(bot, ctx, 'gave-up') // first mark here: silent
    assert.equal(bot.chats.length, 1)
    recover.setStuck(ctx, 'follow', { x: 40, y: 64, z: 0 }, 'follow:Ann')
    ctx.recovery = { action: 'sidestep', source: 'laya' }
    recover.release(bot, ctx, 'gave-up') // repeat at the new pit: pages
    assert.equal(bot.chats.length, 2)
    assert.match(bot.chats[1], /I'm stuck at 20 64 0 again/)
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
  it('three place_error resets never start an episode (p4s)', async () => {
    // Contract change (idkcraft-p4s): the place_error ticker backstop is
    // gone — the streak stays the step's own signal, the body never goes
    // to recover on it.
    const bot = standBot()
    const brain = { decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }) }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setPathReset('place_error')
    ticker.setPathReset('place_error')
    ticker.setPathReset('place_error')
    await ticker.tick()
    assert.equal(bot._tickerCtx.stuck, null)
    assert.equal(bot._tickerCtx.recovery, null)
    ticker.destroy()
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
      const yaw = bot._yaw || 0
      if (bot.getControlState('forward')) {
        bot.entity.position = pos(bp.x - Math.sin(yaw) * 0.4, bp.y, bp.z - Math.cos(yaw) * 0.4)
      } else if (bot.getControlState('back')) {
        bot.entity.position = pos(bp.x + Math.sin(yaw) * 0.4, bp.y, bp.z + Math.cos(yaw) * 0.4)
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
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 0, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'airborne apex is not an escape')
  })

  it('hop pressed at entry backs to leap stance instead of leaping (wqt)', async () => {
    // Paper zeroes a leap from contact (rise 0.00, ~20 rejects/s), so the
    // first pressed tick backs off on a 100 ms timer and arms the standstill
    // leap — it must never hold jump into the face. Deleting the pressed
    // branch fails this test (jump held, back never asserted).
    const bot = stepBot()
    bot.entity.position = pos(0.7, 61, 0.5)
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 0, startFloor: 61, leapt: false, armed: false, stall: 0, settled: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(!bot.getControlState('jump'), 'no leap into the face')
    assert.ok(bot.getControlState('back'), 'short back-off held')
    assert.equal(ctx.recovery.st.armed, true, 'standstill leap armed')
    await new Promise((r) => setTimeout(r, 150))
    assert.ok(!bot.getControlState('back'), 'timer releases back')
  })

  it('hop leaves no control pressed after the mount', () => {
    // Round-1 major (dismissed as stated, pinned anyway): done must clear
    // forward as well as jump, or the body walks on after release.
    const bot = stepBot()
    bot.entity.position = pos(1.5, 62, 0.5)
    bot.entity.onGround = true
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 3, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.ok(!bot.getControlState('forward'), 'forward released')
    assert.ok(!bot.getControlState('jump'), 'jump released')
  })

  it('overhang above the step (step+2 solid): hop stays out', async () => {
    // Round-1 minor: the head ends two above the step base, so a cap there
    // makes the mount unstandable.
    const bot = stepBot()
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 63, 0)) {
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

  it('done wins under a ceiling; airborne over the top settles thrust', async () => {
    // Round-2 minor: the done-first reorder needs a pin — a mount into a
    // 2-high passage must report done, not head-blocked.
    const bot = stepBot()
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 64, 0)) {
        return { ...b, name: 'stone', boundingBox: 'block' }
      }
      return b
    }
    bot.entity.position = pos(1.5, 62, 0.5)
    bot.entity.onGround = true
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 3, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done', 'mount under ceiling is done')
    // Same column mid-air: cut thrust, keep running for the grounded sample.
    bot.entity.position = pos(1.5, 62.4, 0.5)
    bot.entity.onGround = false
    ctx.recovery.status = 'running'
    ctx.recovery.st.settled = false
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(!bot.getControlState('jump'), 'thrust cut over the top')
    assert.ok(!bot.getControlState('forward'), 'no walk-off while settling')
    assert.ok(ctx.recovery.st.settled, 'settle latched')
  })

  it('settled hop that falls back fails out instead of waiting forever', async () => {
    // Round-3 major: the settle has no episode timeout behind it, so a body
    // knocked off the top must fail inside the mount budget, not hang.
    const bot = stepBot()
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.onGround = true
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 0, startFloor: 61, leapt: true, armed: false, stall: 0, settled: true },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    let status = 'running'
    for (let t = 0; t < 16 && status === 'running'; t++) {
      recover.run(bot, ctx)
      status = ctx.recovery.status
      await flush()
    }
    assert.equal(status, 'failed:no-progress', `settled fell back, got ${status}`)
    assert.ok(!bot.getControlState('forward'), 'forward released on the way out')
    assert.ok(!bot.getControlState('jump'), 'jump released on the way out')
  })

  it('hop walks in, backs when pressed, leaps from leap stance', () => {
    const bot = stepBot()
    bot.entity.position = pos(-1.5, 61, 0.5)
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 0, startFloor: 61, leapt: false, armed: false, stall: 0, settled: false },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('forward'), 'walking to the edge')
    assert.ok(!bot.getControlState('jump'), 'no run-up leap from 3m out')
    bot.entity.position = pos(0.9, 61, 0.5) // pressed (dc 0.6)
    recover.run(bot, ctx)
    assert.ok(bot.getControlState('back'), 'backs instead of leaping pressed')
    assert.ok(!bot.getControlState('jump'), 'jump stays off')
    assert.equal(ctx.recovery.st.armed, true, 'standstill leap armed')
    bot.entity.position = pos(0.4, 61, 0.5) // backed to stance (dc 1.1)
    recover.run(bot, ctx)
    assert.ok(bot.getControlState('forward'), 'leap drives forward')
    assert.ok(bot.getControlState('jump'), 'standstill leap fires')
    assert.equal(ctx.recovery.st.armed, false, 'leap consumes the arm')
    assert.equal(ctx.recovery.st.leapt, true)
  })
})

describe('pillar_up place-error at runtime (idkcraft-p4s)', () => {
  it('a rejected placement takes pillar off the menu for the episode', async () => {
    // Not by construction: a real failed:place-error outcome must flip the
    // episode flag (revmux 02 minor: the 4jr last-exclusion already covers
    // the FIRST choice after a failure, so only the second post-failure
    // choice proves the flag). Open ground by a tall crag, high goal: pillar
    // stays feasible at any jump drift. dig_step is picked second (column
    // beside the feet) and fails fast without a dig function, so the third
    // choice is the first one the 4jr last-exclusion does not cover —
    // without the flag it re-picks pillar (places 2).
    const solids = new Set()
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) solids.add(`${x},60,${z}`)
    for (let y = 61; y <= 70; y++) solids.add(`1,${y},0`)
    const bot = worldBot(solids, [{ name: 'dirt', count: 10 }])
    bot.dig = undefined
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    let asks = 0
    const brain = {
      source: 'stub',
      ask: async () => { asks++; return 'pillar_up' },
      decide: async () => ({ action: 'follow', sprint: false, source: 'stub' }),
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    let places = 0
    bot.placeBlock = async () => { places++; throw new Error('placement rejected') }
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 0, y: 70, z: 0 } }
    const step = harness(bot)
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    const chosen = () => lines.filter((l) => l.includes('outcome=chosen'))
      .map((l) => (l.match(/action=(\w+)/) || [])[1]).filter(Boolean)
    try {
      for (let i = 0; i < 150 && !(places >= 1 && asks >= 3 && chosen().length >= 3); i++) {
        await ticker.tick()
        await flush()
        step()
      }
      const actions = chosen()
      assert.equal(actions[0], 'pillar_up', 'first choice climbs')
      assert.ok(places >= 1, 'pillar placed once and failed')
      assert.ok(asks >= 3, 'menu re-asked past both failures')
      assert.ok(actions.length >= 3, 'third choice happened: ' + actions.join(','))
      assert.notEqual(actions[2], 'pillar_up', 'flag keeps pillar off the later choice: ' + actions.join(','))
    } finally {
      console.log = origLog
      ticker.destroy()
    }
  })
})

describe('pillar_up after place-error (idkcraft-p4s)', () => {
  const recover = require('../src/behaviours/recover')
  function facts(over) {
    return Object.assign({
      goalDy: 3, scaffold: 5, headBlocked: false, pickaxe: false, lavaNear: false,
      digStep: null, hopStep: null, walls: 1, playerOnline: false, playerDist: null,
      stuckTicks: 0, resetsStuck: 0, resetsPlaceError: 0, last: null, water: false,
    }, over)
  }
  it('pillar_up infeasible once the episode placed and failed', () => {
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(facts({})), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(facts({ placeError: true })), false)
  })
  it('pillar_up not repeatable once the episode placed and failed', () => {
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(facts({})), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(facts({ placeError: true })), false)
  })
})

describe('sidestep apex is not done (idkcraft-ak4)', () => {
  it('airborne floor rise stays running, grounded rise reports done', () => {
    // Prod 2026-09-24: 13/13 sidestep dones read at y=62.1-62.2 from a y=61
    // start — the 1 Hz tick sampling the sidestep jump apex. Deleting the
    // onGround guard fails this test (the apex reads done).
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.onGround = true
    const ctx = {
      stuck: { by: 'follow', goal: { x: 10, y: 61, z: 0 }, key: 'follow:P' },
      recovery: { action: 'sidestep', status: 'running', st: null },
    }
    recover.run(bot, ctx) // issues the sidestep goal + one-tick jump
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(0.5, 62.2, 0.5) // jump apex sample
    bot.entity.onGround = false
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'apex sample is not an escape')
    bot.entity.onGround = true // same rise, feet on the ground
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })
})

describe('hop_step airborne stall backs off (idkcraft-ak4)', () => {
  it('hangs at the face, backs until ground, then mounts', () => {
    // Prod 2026-09-24: hop_step 16 chosen, 0 done — pressed to the step face
    // with vel.y=0 and onGround=false the held jump never fires. Deleting the
    // unwedge fails this test (back is never held).
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    solids.add(key(1, 61, 0)) // the +1 step east of the body
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.onGround = false // hanging at the face from the first sample
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: { action: 'hop_step', status: 'running', st: null },
    }
    let sawBack = false
    for (let t = 0; t < 12 && !sawBack; t++) {
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'running')
      if (bot.controls.back) sawBack = true
    }
    assert.ok(sawBack, 'stall backs off the face')
    // Feet touch after the back-off: the body resumes the run-up, leaps at
    // the edge and lands on the step top.
    bot.entity.onGround = true
    recover.run(bot, ctx)
    assert.equal(bot.controls.back || false, false, 'back released on the ground')
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(1.2, 61.5, 0.5) // rising past the edge
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0.4, z: 0 }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(1.4, 62.2, 0.5) // over the top
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(1.4, 62, 0.5) // landed on the step
    bot.entity.onGround = true
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })
})

describe('hop_step standstill leap on Paper (idkcraft-wqt)', () => {
  // Paper 26.1.2 zeroes a leap from wall contact (rise 0.00, ~20 silent
  // server teleports/s); a run-up leap cannot be timed on 1 Hz ticks. Hop
  // backs 100 ms to leap stance (gap 0.25-0.5) and leaps from the
  // standstill instead. Deleting the pressed branch fails the first two
  // tests (jump held into the face); deleting the past-step done fails the
  // overflow test (running instead of done).
  function hopCtx(st) {
    return {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', source: 'fsm', model: null, status: 'running', st,
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
  }
  function hopBot() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    solids.add(key(1, 61, 0)) // the +1 step east of the body
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    return bot
  }
  it('landed-short leap re-backs and re-arms the veto', () => {
    const bot = hopBot()
    bot.entity.position = pos(0.9, 61, 0.5) // pressed after a short landing
    bot.entity.onGround = true
    const ctx = hopCtx({ dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 2, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('back'), 're-backs to leap stance')
    assert.ok(!bot.getControlState('jump'), 'no re-leap from contact')
    assert.equal(ctx.recovery.st.armed, true, 'next tick leaps')
    assert.equal(ctx.recovery.st.leapt, false, 'veto re-armed')
  })
  it('in-flight arc coasts with thrust held, never backs mid-air', () => {
    const bot = hopBot()
    bot.entity.position = pos(1.0, 61.5, 0.5) // rising past the face
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: 0.4, z: 0 }
    const ctx = hopCtx({ dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 2, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('forward'), 'carry continues')
    assert.ok(bot.getControlState('jump'), 'thrust held through the arc')
    assert.ok(!bot.getControlState('back'), 'no mid-air back-off')
  })
  it('grounded past the step is done (overflowed arc escapes)', () => {
    const bot = hopBot()
    bot.entity.position = pos(2.6, 61, 0.5) // landed beyond the narrow top
    bot.entity.onGround = true
    const ctx = hopCtx({ dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 3, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false })
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.ok(!bot.getControlState('forward'), 'forward released')
    assert.ok(!bot.getControlState('jump'), 'jump released')
  })
  it('airborne past the step is not done', () => {
    const bot = hopBot()
    bot.entity.position = pos(2.6, 61.5, 0.5) // sailing over, not landed
    bot.entity.onGround = false
    bot.entity.velocity = { x: 0, y: -0.1, z: 0 }
    const ctx = hopCtx({ dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 3, startFloor: 61, leapt: true, armed: false, stall: 0, settled: false })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'apex guard covers the overflow done')
  })
  it('walk-in holds no jump after a long back-off (ak4 resume)', () => {
    // The 250 ms airborne unwedge leaves too long a runway for a
    // standstill leap, so the resume walks back in and re-presses first.
    const bot = hopBot()
    bot.entity.position = pos(0.0, 61, 0.5) // dc 1.5, unwedged stance
    bot.entity.onGround = true
    const ctx = hopCtx({ dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 4, startFloor: 61, leapt: false, armed: false, stall: 0, settled: false })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('forward'), 'walks back in')
    assert.ok(!bot.getControlState('jump'), 'no leap from the long stance')
  })
  it('decide transition drops a stale executor goal (idkcraft-7gt)', async () => {
    // dig_step/sidestep return failed with their GoalNear still live; the
    // next primitive's direct drive would fight the lib at 20 Hz. decide()
    // is the one choke point between primitives, so the stale goal dies on
    // the transition. Deleting the setGoal(null) fails this test.
    const bot = hopBot()
    bot.entity.onGround = true
    bot.pathfinder.setGoal({ x: 9, y: 61, z: 9, isEnd: () => false, isValid: () => true, heuristic: () => 0 })
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: null,
      recovery: {
        action: 'sidestep', source: 'fsm', model: null, status: 'failed:no-progress',
        st: { start: { x: 0.5, y: 61, z: 0.5 } }, attempts: 1, fails: 0, repeats: 0,
        last: null, calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(bot.pathfinder.goal, null, 'stale goal dropped on transition')
    assert.equal(r.action, 'hop_step', `FSM re-picks past the failure, got ${r.action}`)
    assert.equal(ctx.recovery.status, 'running')
  })
  it('head veto re-arms on the back-off', () => {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    solids.add(key(1, 61, 0))
    solids.add(key(0, 62, 0)) // head blocked over the body
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.9, 61, 0.5)
    bot.entity.onGround = true
    const st = { dir: [1, 0], stepPos: { x: 1, y: 61, z: 0 }, waited: 1, startFloor: 61, leapt: false, armed: true, stall: 0, settled: false }
    const ctx = hopCtx(st)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:head-blocked', 'fresh leap checks headroom')
    st.leapt = true // same sample mid-leap: the veto stays out of the arc
    ctx.recovery.status = 'running'
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'mid-leap veto disarmed')
  })
})

describe('backstop sidestep stays strict on level goals (idkcraft-q0h round 2)', () => {
  it('floor shuffle under a level backstop goal fails, never done', () => {
    // Round-1 body-1: the backstop now carries the live walk goal, but a
    // level goal must not switch sidestep to the displacement rule — the fja
    // pit loop otherwise returns and the rest counter never fills.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = {
      stuck: { by: 'no-displacement', goal: { x: 5, y: 61, z: 0 }, key: 'ticker' },
      recovery: { action: 'sidestep', status: 'running', st: null },
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
    for (let t = 0; t < 12 && ctx.recovery.status === 'running'; t++) {
      recover.run(bot, ctx)
      stepBody()
    }
    assert.equal(ctx.recovery.status, 'failed:no-progress')
  })
})

describe('recover dig_up run body (idkcraft-rcv)', () => {
  const pick = () => [{ name: 'iron_pickaxe', count: 1 }]
  const rec = (over) => ({
    stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' },
    recovery: { action: 'dig_up', status: 'running', st: null, ...over },
  })

  it('clear headroom with a frozen body runs out the verify budget, then fails', () => {
    // 9sq F2: air above is the precondition, not the escape — the EP1 loop
    // was dig_up reporting done here with zero displacement. Deleting the
    // displaced() gate fails this test (done on the first tick).
    const bot = worldBot(pitWorld(), pick())
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'clear but still: verify, never instant-done')
    for (let i = 0; i < recover.DISPLACE_TIMEOUT_TICKS + 2; i++) recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-progress')
  })

  it('clear headroom with sideways drift reports done', () => {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    const bot = worldBot(solids, pick())
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(1.2, 61, 0.5) // 0.7 sideways: the wedge released
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('clear headroom with a grounded climb reports done, airborne does not', () => {
    const bot = worldBot(pitWorld(), pick())
    const ctx = rec()
    recover.run(bot, ctx)
    bot.entity.position = pos(0.5, 62, 0.5)
    bot.entity.onGround = false
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'apex sample is not an escape')
    bot.entity.onGround = true
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done', 'grounded rise is')
  })

  it('failed:no-pos without a position', () => {
    const bot = worldBot(pitWorld(), pick())
    bot.entity = null
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-pos')
  })

  it('failed:no-pickaxe without a pickaxe', () => {
    const bot = worldBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-pickaxe')
  })

  it('failed:lava vetoes the dig with lava next to the head', () => {
    const bot = worldBot(pitWorld(), pick())
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      if (key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 61, 0)) {
        return { name: 'lava', position: new Vec3(1, 61, 0), boundingBox: 'block' }
      }
      return raw(p)
    }
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:lava')
  })

  it('digs the ceiling head-first, then done', async () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    solids.add(key(0, 63, 0))
    const bot = worldBot(solids, pick())
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'head2 still solid')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dug open but the body never moved (9sq F2)')
    bot.entity.position = pos(0.5, 62, 0.5) // the climb the dug headroom earns
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.deepEqual(dug, [key(0, 62, 0), key(0, 63, 0)], 'head1 first, then head2')
  })

  it('digs head2 alone when head1 is already air', async () => {
    const solids = pitWorld()
    solids.add(key(0, 63, 0))
    const bot = worldBot(solids, pick())
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dug open but the body never moved (9sq F2)')
    bot.entity.position = pos(0.5, 62, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.deepEqual(dug, [key(0, 63, 0)])
  })

  it('failed:dig-error when the dig throws', async () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    const bot = worldBot(solids, pick())
    bot.dig = async () => { throw new Error('gone') }
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-error')
  })

  it('failed:dig-timeout when the ack never arrives', () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    const bot = worldBot(solids, pick())
    const ctx = rec({ st: { waited: 1000, digInFlight: true, digError: false } })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-timeout')
  })

  it('failed:no-dig when bot.dig is missing', () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    const bot = worldBot(solids, pick())
    delete bot.dig
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-dig')
  })
})

describe('recover dig_through run body (idkcraft-rcv)', () => {
  const pick = () => [{ name: 'iron_pickaxe', count: 1 }]
  function flatWorld() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    return solids
  }
  const rec = (goal, over) => ({
    stuck: { by: 'follow', goal, key: 'follow:P' },
    recovery: { action: 'dig_through', status: 'running', st: null, ...over },
  })

  it('failed:no-pos without a position', () => {
    const bot = worldBot(flatWorld(), pick())
    bot.entity = null
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-pos')
  })

  it('failed:no-pickaxe without a pickaxe', () => {
    const bot = worldBot(flatWorld(), [])
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-pickaxe')
  })

  it('failed:no-direction without a goal', () => {
    const bot = worldBot(flatWorld(), pick())
    const ctx = { stuck: { by: 'follow', key: 'follow:P' }, recovery: { action: 'dig_through', status: 'running', st: null } }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-direction')
  })

  it('failed:lava when the feet cell is lava', () => {
    const bot = worldBot(flatWorld(), pick())
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      if (key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 61, 0)) {
        return { name: 'lava', position: new Vec3(1, 61, 0), boundingBox: 'block' }
      }
      return raw(p)
    }
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:lava')
  })

  it('failed:lava when only the head cell is lava', () => {
    const bot = worldBot(flatWorld(), pick())
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      if (key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 62, 0)) {
        return { name: 'lava', position: new Vec3(1, 62, 0), boundingBox: 'block' }
      }
      return raw(p)
    }
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:lava')
  })

  it('open tunnel with a frozen body runs out the verify budget, then fails', () => {
    // 9sq F2: the EP1 loop was dig_through reporting done here with zero
    // displacement. Deleting the displaced() gate fails this test.
    const bot = worldBot(flatWorld(), pick())
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'open but still: verify, never instant-done')
    for (let i = 0; i < recover.DISPLACE_TIMEOUT_TICKS + 2; i++) recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-progress')
  })

  it('open tunnel with goalward drift reports done', () => {
    const bot = worldBot(flatWorld(), pick())
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(1.2, 61, 0.5) // 0.7 toward the goal: walking the tunnel
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('digs feet-first, then head, then done', async () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    solids.add(key(1, 62, 0))
    const bot = worldBot(solids, pick())
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'head still solid')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dug open but the body never moved (9sq F2)')
    bot.entity.position = pos(1.2, 61, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.deepEqual(dug, [key(1, 61, 0), key(1, 62, 0)], 'feet cell first, then head')
  })

  it('a z-dominant goal tunnels along z', async () => {
    const solids = flatWorld()
    solids.add(key(0, 61, 1))
    const bot = worldBot(solids, pick())
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    const ctx = rec({ x: 0.5, y: 61, z: 5 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dug open but the body never moved (9sq F2)')
    bot.entity.position = pos(0.5, 61, 1.2)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
    assert.deepEqual(dug, [key(0, 61, 1)])
  })

  it('failed:dig-error when the dig throws', async () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    const bot = worldBot(solids, pick())
    bot.dig = async () => { throw new Error('gone') }
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-error')
  })

  it('failed:dig-timeout when the ack never arrives', () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    const bot = worldBot(solids, pick())
    const ctx = rec({ x: 5, y: 61, z: 0 }, { st: { waited: 1000, digInFlight: true, digError: false } })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-timeout')
  })

  it('failed:no-dig when bot.dig is missing', () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    const bot = worldBot(solids, pick())
    delete bot.dig
    const ctx = rec({ x: 5, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-dig')
  })
})

describe('dig_step owns the mount head (idkcraft-adv)', () => {
  // The 1.8 body stands the mount with its head in (dx,2,dz): dig_step
  // digs a hand-diggable solid there like above instead of relying on the
  // executor's canDig. Deleting the cap dig fails the climb test (head
  // refuses the mount); deleting the find skip fails the menu test.
  function digCtx(st) {
    return {
      stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'dig_step', source: 'fsm', model: null, status: 'running', st,
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
  }
  it('digs the mount head after above, then mounts', async () => {
    const bot = worldBot(pitWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    // Pre-dug above: reach the cap branch on the first tick.
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    await bot.dig(bot.blockAt({ x: 1, y: 62, z: 0 }))
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.digInFlight, true, 'cap dig issued')
    await flush()
    assert.ok(dug.includes(key(1, 63, 0)), `cap dug, got ${dug}`)
    recover.run(bot, ctx)
    assert.equal(bot.pathfinder.goal, null, 'mount sets no executor goal (jsf.4 direct leap)')
    assert.ok(bot.getControlState('forward'), 'mount walks in from open floor')
    assert.ok(!bot.getControlState('jump'), 'no run-up leap from a metre out')
  })
  it('stone-capped side re-scans to a diggable side', async () => {
    const bot = worldBot(pitWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 63, 0)) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    await bot.dig(bot.blockAt({ x: 1, y: 62, z: 0 })) // above pre-dug: cap branch next
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.dir, null, 'stone cap drops the side')
    recover.run(bot, ctx)
    assert.deepEqual(ctx.recovery.st.dir, [-1, 0], 're-scan skips the capped side, picks west')
  })
  it('stone cap over the only step keeps dig_step out of the menu', async () => {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    solids.add(key(1, 61, 0))
    solids.add(key(1, 62, 0))
    solids.add(key(1, 63, 0))
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 63, 0)) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    bot.players = {}
    const ctx = { stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' }, brain: null }
    const r = await recover.decide(bot, ctx, null, null)
    assert.notEqual(r.action, 'dig_step', `capped step unmountable, got ${r.action}`)
  })
  it('lava in the mount head re-scans to a clean side', () => {
    const bot = worldBot(pitWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 63, 0)) {
        return { ...b, name: 'lava' }
      }
      return b
    }
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.dir, null, 'lava head drops the side before digging')
    recover.run(bot, ctx)
    assert.deepEqual(ctx.recovery.st.dir, [-1, 0], 're-scan skips the lava side')
  })
  it('failed:lava when lava crowds the cap dig', () => {
    const solids = pitWorld()
    solids.delete(key(1, 62, 0)) // above pre-dug: cap branch next
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(0, 61, 1)) {
        return { ...b, name: 'lava' }
      }
      return b
    }
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:lava')
  })
  it('failed:dig-error when the cap dig throws', async () => {
    const solids = pitWorld()
    solids.delete(key(1, 62, 0))
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.dig = async () => { throw new Error('gone') }
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-error')
  })
  it('failed:dig-timeout when the cap ack never arrives', () => {
    const solids = pitWorld()
    solids.delete(key(1, 62, 0))
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 1000, digInFlight: true, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-timeout')
  })
  it('failed:no-dig when bot.dig is missing', () => {
    const solids = pitWorld()
    solids.delete(key(1, 62, 0))
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    delete bot.dig
    const ctx = digCtx({ dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-dig')
  })
})

describe('recover run-body edges (idkcraft-rcv)', () => {
  it('dig_step dig-timeout fails with jump released', () => {
    // pitWorld walls are dirt (hand-diggable): the dig above the side step
    // hangs, the budget spend fails the primitive instead of wedging the
    // episode forever.
    const bot = worldBot(pitWorld(), [])
    const ctx = {
      stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'dig_step', status: 'running',
        st: { dir: [1, 0], phase: 'dig', waited: 1000, digInFlight: true, digError: false, startFloor: 61 },
      },
    }
    bot.setControlState('jump', true) // held by an earlier phase: the timeout must release it
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:dig-timeout')
    assert.equal(bot.getControlState('jump'), false)
  })

  it('hop anchor collapse re-scans instead of mounting air', () => {
    // The step block is gone (dug by another tick, ghost): hop_step drops
    // the stale anchor and leap state, then re-scans.
    const bot = worldBot(pitWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'hop_step', status: 'running',
        st: {
          dir: [1, 0], stepPos: { x: 5, y: 61, z: 0 },
          waited: 0, startFloor: 61, leapt: true, armed: true, stall: 0, settled: false,
        },
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.dir, null)
    assert.equal(ctx.recovery.st.stepPos, null)
    assert.equal(ctx.recovery.st.leapt, false)
    assert.equal(ctx.recovery.st.armed, false)
  })

  it('run() catches a throwing primitive as failed:error', () => {
    // A bug inside any run body must fail the primitive, never kill the tick.
    const bot = worldBot(pitWorld(), [])
    const ctx = { stuck: { by: 'follow', key: 'follow:P' }, recovery: { action: 'wait', status: 'running', st: null } }
    const orig = recover.RECOVER_MENU.wait.run
    recover.RECOVER_MENU.wait.run = () => { throw new Error('boom') }
    try {
      recover.run(bot, ctx)
    } finally {
      recover.RECOVER_MENU.wait.run = orig
    }
    assert.equal(ctx.recovery.status, 'failed:error')
  })

  it('release done clears the gather skip set, gave-up keeps the final', () => {
    // An escape may have moved the body somewhere reachable: done re-arms
    // the gather scan, while gave-up leaves the failed:* final standing.
    const bot = worldBot(pitWorld(), [])
    const ctx = {
      stuck: { by: 'gather', goal: { x: 5, y: 61, z: 0 }, key: 'gather' },
      recovery: { action: 'dig_through', status: 'done' },
      gather: { skip: new Set([key(1, 61, 0)]), streak: 2 },
    }
    recover.release(bot, ctx, 'done')
    assert.equal(ctx.gather.skip.size, 0)
    assert.equal(ctx.gather.streak, 0)
    const ctx2 = {
      stuck: { by: 'gather', goal: { x: 5, y: 61, z: 0 }, key: 'gather' },
      recovery: { action: 'dig_through', status: 'done' },
      gather: { skip: new Set([key(1, 61, 0)]), streak: 2 },
    }
    recover.release(bot, ctx2, 'gave-up')
    assert.equal(ctx2.gather.skip.size, 1, 'gave-up keeps the strikes')
    assert.equal(ctx2.gather.streak, 2)
  })

  it('chooseRecovery generic error counts escalation reason=error', async () => {
    const facts = {
      goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false,
      headBlocked: false, walls: 0, freeSides: [[1, 0]], lavaNear: false,
      playerOnline: true, playerDist: 5, playerName: 'Steve', stuckTicks: 12,
      resetsStuck: 0, resetsPlaceError: 0, last: 'none', by: 'follow',
    }
    const brain = { source: 'laya', ask: async () => { throw new Error('boom') } }
    const r = await recover.chooseRecovery(brain, facts, ['sidestep', 'wait', 'call_player'])
    assert.deepEqual(r, { action: 'sidestep', source: 'stub-fallback', fsm: 'sidestep', model: 'laya' })
    const text = await metricText()
    assert.match(text, /idkcraft_bot_escalation_total\{from="laya",to="fsm",reason="error"\} [1-9]/)
  })

  it('chooseRecovery jev-missing error counts escalation reason=invalid', async () => {
    const facts = {
      goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false,
      headBlocked: false, walls: 0, freeSides: [[1, 0]], lavaNear: false,
      playerOnline: true, playerDist: 5, playerName: 'Steve', stuckTicks: 12,
      resetsStuck: 0, resetsPlaceError: 0, last: 'none', by: 'follow',
    }
    const brain = { source: 'jev', ask: async () => { throw new Error('jev missing api key') } }
    const r = await recover.chooseRecovery(brain, facts, ['sidestep', 'wait', 'call_player'])
    assert.deepEqual(r, { action: 'sidestep', source: 'stub-fallback', fsm: 'sidestep', model: 'jev' })
    const text = await metricText()
    assert.match(text, /idkcraft_bot_escalation_total\{from="jev",to="fsm",reason="invalid"\} [1-9]/)
  })
})

describe('recover dig in-flight wait (idkcraft-rcv)', () => {
  it('dig_up waits while the dig is in flight within budget', () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    const bot = worldBot(solids, [{ name: 'iron_pickaxe', count: 1 }])
    let digs = 0
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { digs++; return rawDig(b) }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' },
      recovery: { action: 'dig_up', status: 'running', st: { waited: 0, digInFlight: true, digError: false } },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(digs, 0, 'no second dig while one is in flight (yvi class)')
    assert.equal(ctx.recovery.st.waited, 1)
  })

  it('dig_through waits while the dig is in flight within budget', () => {
    const solids = new Set([key(0, 60, 0), key(1, 61, 0)])
    const bot = worldBot(solids, [{ name: 'iron_pickaxe', count: 1 }])
    bot.entity.position = pos(0.5, 61, 0.5)
    let digs = 0
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { digs++; return rawDig(b) }
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      recovery: { action: 'dig_through', status: 'running', st: { waited: 0, digInFlight: true, digError: false } },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(digs, 0, 'no second dig while one is in flight (yvi class)')
    assert.equal(ctx.recovery.st.waited, 1)
  })

  it('dig_step waits while the hand dig is in flight within budget', () => {
    const bot = worldBot(pitWorld(), [])
    const ctx = {
      stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 }, key: 'follow:P' },
      recovery: {
        action: 'dig_step', status: 'running',
        st: { dir: [1, 0], phase: 'dig', waited: 0, digInFlight: true, digError: false, startFloor: 61 },
      },
    }
    let digs = 0
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { digs++; return rawDig(b) }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(digs, 0, 'no second dig while one is in flight (yvi class)')
    assert.equal(ctx.recovery.st.waited, 1)
  })
})

describe('quiet repeat stuck-chats (rw4.9.1)', () => {
  const stuckCtx = () => ({ stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } }, brain: { source: 'stub' } })
  const stuckLines = (bot) => bot.chats.filter((m) => m.startsWith('stuck, trying'))

  it('first episode in a fresh pit narrates the choice', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const d = await recover.decide(bot, stuckCtx(), {}, null)
    assert.equal(stuckLines(bot).length, 1, bot.chats.join(' | '))
    assert.match(stuckLines(bot)[0], /stuck, trying .+ \(fsm\)/)
    assert.notEqual(d.action, 'call_player')
  })

  it('repeat at a live mark stays silent but chooses the same escape', async () => {
    const bot1 = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const d1 = await recover.decide(bot1, stuckCtx(), {}, null)
    const bot2 = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const ctx2 = stuckCtx()
    danger.mark(ctx2, { x: 0.5, y: 61, z: 0.5 }) // gave-up laid this
    const d2 = await recover.decide(bot2, ctx2, {}, null)
    assert.deepEqual(stuckLines(bot2), [], 'no narration under a live mark')
    assert.equal(d2.action, d1.action, 'episodes run as before, only the chat gates')
  })

  it('stale mark narrates again: a new pit after TTL', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const ctx = stuckCtx()
    danger.mark(ctx, { x: 0.5, y: 61, z: 0.5 }, Date.now() - danger.TTL_MS - 1000)
    await recover.decide(bot, ctx, {}, null)
    assert.equal(stuckLines(bot).length, 1, bot.chats.join(' | '))
  })

  it('distant mark narrates: only the pit underfoot gates', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    const ctx = stuckCtx()
    danger.mark(ctx, { x: 100, y: 64, z: 100 })
    await recover.decide(bot, ctx, {}, null)
    assert.equal(stuckLines(bot).length, 1, bot.chats.join(' | '))
  })
})

describe('recover wait verifies displacement (9sq F2)', () => {
  const rec = (over) => ({
    stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
    recovery: { action: 'wait', status: 'running', st: null, ...over },
  })
  function flatWorld() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    return solids
  }
  it('a frozen full wait fails, burning budget toward call_player', () => {
    // 9sq F2: wait used to end the episode done after WAIT_TICKS with zero
    // displacement — the loop then re-fired the same situation. Deleting the
    // failed verdict fails this test.
    const bot = worldBot(flatWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = rec()
    for (let i = 0; i < recover.WAIT_TICKS - 1; i++) {
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'running')
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-progress')
  })
  it('displacement mid-wait reports done at once', () => {
    const bot = worldBot(flatWorld(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = rec()
    recover.run(bot, ctx)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(2.5, 61, 0.5) // teleported out mid-wait
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })
  it('failed:no-pos without a position', () => {
    const bot = worldBot(flatWorld(), [])
    bot.entity = null
    const ctx = rec()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-pos')
  })
})

describe('recover throughBlocked reads the goalward 1x2 (9sq F1, revmux-01 core-1)', () => {
  // The F1 gate's own logic: direction from the stuck goal, axis-dominant
  // step, feet-or-head solidity, no target fallback. The feasibility veto
  // tests stub the fact; these build it from a world.
  function flatWorld() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    return solids
  }
  const factsFor = (solids, goal, target = null) => {
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    return recover.recoverFacts(bot, { stuck: { by: 'test', goal } }, {}, target)
  }
  it('open toward an x-goal reads false; a solid feet cell reads true', () => {
    const goal = { x: 5, y: 61, z: 0 }
    assert.equal(factsFor(flatWorld(), goal).throughBlocked, false)
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    assert.equal(factsFor(solids, goal).throughBlocked, true)
  })
  it('a solid head cell alone reads true', () => {
    const solids = flatWorld()
    solids.add(key(1, 62, 0))
    assert.equal(factsFor(solids, { x: 5, y: 61, z: 0 }).throughBlocked, true)
  })
  it('z-dominant goals step along z; the x side is ignored', () => {
    const goal = { x: 0.5, y: 61, z: 5 }
    assert.equal(factsFor(flatWorld(), goal).throughBlocked, false)
    const zWall = flatWorld()
    zWall.add(key(0, 61, 1))
    assert.equal(factsFor(zWall, goal).throughBlocked, true)
    const xWall = flatWorld()
    xWall.add(key(1, 61, 0))
    assert.equal(factsFor(xWall, goal).throughBlocked, false, 'off-axis solid is not toward the goal')
  })
  it('a goal straight above has no direction, even with solid sides', () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    assert.equal(factsFor(solids, { x: 0.5, y: 64, z: 0.5 }).throughBlocked, false)
  })
  it('no stuck goal never falls back to the follow target', () => {
    const solids = flatWorld()
    solids.add(key(1, 61, 0))
    const target = { position: pos(5, 61, 0) }
    assert.equal(factsFor(solids, null, target).throughBlocked, false, 'run body has no target fallback either')
  })
  it('decide asks dig_through only when the goalward 1x2 is solid', async () => {
    const pick = [{ name: 'iron_pickaxe', count: 1 }]
    async function askedMenu(solids) {
      const bot = worldBot(solids, pick)
      bot.entity.position = pos(0.5, 61, 0.5)
      bot.players = {}
      const seen = []
      const ctx = {
        stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
        brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return seen[0][0] } },
      }
      const r = await recover.decide(bot, ctx, null, null)
      return { seen: seen[0], action: r.action }
    }
    const open = await askedMenu(flatWorld())
    assert.ok(!open.seen.includes('dig_through'), `open menu: ${open.seen}`)
    assert.equal(open.action, 'sidestep')
    const headed = flatWorld()
    headed.add(key(1, 62, 0)) // head cell: blocks the tunnel, keeps hop_step out
    const shut = await askedMenu(headed)
    assert.ok(shut.seen.includes('dig_through'), `shut menu: ${shut.seen}`)
    assert.equal(shut.action, 'sidestep')
  })
})
