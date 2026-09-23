'use strict'

// Recovery menu (idkcraft-ef3): pit climb, invalid-label fallback, no-exit
// episode, feasibility veto, FSM table, choice sources, ticker routing.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
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

describe('recover no-exit episode (acceptance 3)', () => {
  it('3 sidestep fails -> exactly one call_player chat, goal dropped', async () => {
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
    assert.match(text, /idkcraft_bot_recover_total\{action="call_player",source="fsm",outcome="chosen"\} [1-9]/)
    assert.match(text, /idkcraft_bot_recover_total\{action="call_player",source="fsm",outcome="gave-up"\} [1-9]/)
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
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(F({ scaffold: 3 })), true)
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
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 10, y: 64, z: 0 } }
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
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
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
