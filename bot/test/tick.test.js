'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const { stateKey } = require('../src/perception')
const follow = require('../src/behaviours/follow')
const buildMod = require('../src/behaviours/build')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, jump: 0, goals: [] }
  const controls = {}
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0) },
    pathfinder: {
      goal: null,
      setGoal: (g) => {
        calls.setGoal++
        calls.goals.push(g)
        bot.pathfinder.goal = g
        bot.clearControlStates()
      },
      stop: () => { calls.stop++ },
      isMoving: () => false,
      setMovements: (m) => { calls.movements = m }
    },
    setControlState: (control, val) => {
      controls[control] = !!val
      if (control === 'jump') calls.jump = val ? 1 : 0
    },
    clearControlStates: () => {
      for (const k in controls) controls[k] = false
      calls.jump = 0
    },
    getControlState: (control) => !!controls[control],
    chat: () => {}
  }
  return bot
}

function mockBrain(decision) {
  return {
    calls: 0,
    async decide() {
      this.calls++
      return decision || { action: 'follow', sprint: false, source: 'jev' }
    }
  }
}

function playerEntity(x) {
  return { id: 7, position: pos(x, 64, 0) }
}

describe('ticker with no target', () => {
  it('never calls the brain, decides local-idle, stops once', async () => {
    const bot = mockBot()
    // stop-once needs a real path: an empty path must not stop (see guard test)
    bot.pathfinder.isMoving = () => true
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r1 = await ticker.tick()
    const r2 = await ticker.tick()
    assert.equal(brain.calls, 0)
    assert.equal(r1.calledBrain, false)
    assert.deepEqual(r1.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.deepEqual(r2.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.equal(bot.calls.stop, 1)
  })
})

describe('stop guard', () => {
  it('idle after a stationary goal does not latch stop; the next follow still goals', async () => {
    // latch mock: mirrors mineflayer-pathfinder — stop() only sets a flag
    // that the next setGoal consumes along with the new goal.
    const calls = { setGoal: 0, stop: 0, effectiveGoals: 0 }
    let latched = false
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.pathfinder.setGoal = () => {
      calls.setGoal++
      if (latched) { latched = false; return } // swallowed by a latched stop
      calls.effectiveGoals++
    }
    bot.pathfinder.stop = () => { calls.stop++; latched = true }
    bot.pathfinder.isMoving = () => false // goal never produced a path
    const seq = [
      { action: 'follow', sprint: false, source: 'stub-fallback' },
      { action: 'idle', sprint: false, source: 'stub-fallback' },
      { action: 'follow', sprint: false, source: 'stub-fallback' },
    ]
    let i = 0
    const brain = { calls: 0, async decide() { this.calls++; return seq[Math.min(i++, seq.length - 1)] } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    await ticker.tick() // follow: goal issued but never starts moving
    assert.equal(calls.effectiveGoals, 1)
    await ticker.tick() // idle on an empty path: must not stop
    assert.equal(calls.stop, 0)
    await ticker.tick() // follow again: must not be swallowed
    assert.equal(calls.setGoal, 2)
    assert.equal(calls.effectiveGoals, 2)
  })

  it('chat stop cancels a stationary live goal without latching; follow resumes', async () => {
    // goal-tracking mock: setGoal installs/clears, a latched stop swallows it
    let liveGoal = null
    let latched = false
    const calls = { setGoal: 0, stop: 0 }
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.pathfinder.goal = null
    bot.pathfinder.isMoving = () => false // resting in range: live goal, empty path
    bot.pathfinder.setGoal = (g) => {
      calls.setGoal++
      if (latched) { latched = false; liveGoal = null; bot.pathfinder.goal = null; return }
      liveGoal = g || null
      bot.pathfinder.goal = liveGoal
    }
    bot.pathfinder.stop = () => { calls.stop++; latched = true }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'stub-fallback' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    await ticker.tick() // follow installs the live goal
    assert.ok(liveGoal)
    ticker.setFollow('')
    ticker.stop() // chat stop while stationary: cancel, do not latch
    assert.equal(calls.stop, 0)
    assert.equal(liveGoal, null)
    ticker.setFollow('Steve')
    await ticker.tick() // follow resumes on the first tick, nothing swallowed
    assert.ok(liveGoal)
    assert.equal(calls.stop, 0)
  })
})

describe('ticker movements', () => {
  it('registers movements with the pathfinder', async () => {
    const bot = mockBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const m = { allowSprinting: false }
    ticker.setMovements(m)
    assert.equal(bot.calls.movements, m)
  })

  it('holds allowSprinting false whatever decision.sprint says', async () => {
    // sprint-jump wedges the bot flush against a 1-block step: without a
    // flat pursuit (no level plan head) the body must not sprint on the
    // brain's opinion alone (5vv: far level follow toggles it instead).
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain({ action: 'follow', sprint: true, source: 'laya' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const m = { allowSprinting: true }
    ticker.setMovements(m)
    assert.equal(m.allowSprinting, false)
    const r = await ticker.tick()
    assert.equal(r.decision.sprint, true) // wire/log keeps the brain's opinion
    assert.equal(m.allowSprinting, false)
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    bot.players.Steve.entity.position = pos(25, 64, 0) // fresh state: re-decide
    await ticker.tick()
    assert.equal(m.allowSprinting, false)
  })

  it('a non-follow tick restores the shared movement defaults', async () => {
    // Pins the runTick reset (5vv): a sprint window must not leak into
    // fight, bring or work ticks that follow does not own.
    const bot = mockBot()
    const brain = mockBrain({ action: 'idle', sprint: false, source: 'stub' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const m = { allowSprinting: false, allowParkour: true }
    ticker.setMovements(m) // forces sprint off: re-arm the leak after
    m.allowSprinting = true
    m.allowParkour = false
    await ticker.tick()
    assert.equal(m.allowSprinting, false)
    assert.equal(m.allowParkour, true)
  })
})

describe('ticker with a target', () => {
  it('calls the brain once per distinct state, reuses on identical state', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setMovements({ allowSprinting: false })
    const r1 = await ticker.tick()
    assert.equal(r1.calledBrain, true)
    assert.equal(brain.calls, 1)
    const r2 = await ticker.tick()
    assert.equal(r2.calledBrain, false)
    assert.equal(brain.calls, 1)
    assert.deepEqual(r2.decision, r1.decision)
    bot.players.Steve.entity.position = pos(25, 64, 0) // rounded distance 10 -> 25
    const r3 = await ticker.tick()
    assert.equal(r3.calledBrain, true)
    assert.equal(brain.calls, 2)
  })

  it('retries the brain after a stub-fallback on identical state', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'stub-fallback' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await ticker.tick()
    assert.equal(brain.calls, 2)
  })

  it('uses fast cadence with a target, slow cadence without', async () => {
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = mockBot()
      const brain = mockBrain()
      const ticker = createTicker({ bot, brain, tickMs: 111, idleTickMs: 222 })
      try {
        await ticker.tick(true) // scheduled tick, no target -> slow
        bot.players = { Steve: { username: 'Steve', entity: playerEntity(5) } }
        await ticker.tick(true) // scheduled tick, target -> fast
        assert.deepEqual(delays, [222, 111])
      } finally {
        // Scheduled ticks arm a background timer: destroy it, or it logs
        // follow/5.0 every 111 ms into later tests' captures (9ldm flake).
        ticker.destroy()
      }
    } finally {
      global.setTimeout = orig
    }
  })
})

describe('pathfinder status on the decision line', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  it('appends moving/path/reset; a fed noPath shows on the next line; reset clears after one log', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: true, source: 'laya' }), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.ok(lines.length > 0)
    assert.match(lines[lines.length - 1], /decision source=laya action=follow sprint=true dist=10\.0 moving=false path=none reset=none/)
    ticker.setPathStatus('noPath')
    ticker.setPathReset('stuck')
    // fresh state so the brain re-decides: the suffix must survive a
    // re-decide, not just ride the cached-decision path (the line logs
    // every tick either way)
    bot.players.Steve.entity.position = pos(25, 64, 0)
    await ticker.tick()
    assert.match(lines[lines.length - 1], /moving=false path=noPath reset=stuck/)
    bot.players.Steve.entity.position = pos(40, 64, 0)
    await ticker.tick()
    // reset= logged once: stale reason does not repeat, path= persists
    assert.match(lines[lines.length - 1], /moving=false path=noPath reset=none/)
  })
})

describe('follow behaviour and unstuck reflex', () => {
  it('does not re-issue setGoal while status is partial within 6 s; re-issues after 6 s', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    const realNow = Date.now
    let now = 100000
    Date.now = () => now
    try {
      await ticker.tick() // initial setGoal (t = 0)
      assert.equal(bot.calls.setGoal, 1)

      ticker.setPathStatus('partial')
      now += 1000 // 1 s later: search still in progress
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 1)

      now += 4000 // 5 s later (total 5 s elapsed)
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 1)

      now += 1001 // 6.001 s elapsed (>= 6000 ms)
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 2)
    } finally {
      Date.now = realNow
    }
  })

  it('re-arms 6 s search protection window while moving', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    const realNow = Date.now
    let now = 100000
    Date.now = () => now
    try {
      await ticker.tick() // initial setGoal (t = 0)
      assert.equal(bot.calls.setGoal, 1)

      // Move for 10 s
      bot.pathfinder.isMoving = () => true
      ticker.setPathStatus('partial')
      for (let i = 0; i < 10; i++) {
        now += 1000
        await ticker.tick()
      }
      assert.equal(bot.calls.setGoal, 1)

      // Bot stops moving; status still partial. Should not immediately re-issue
      bot.pathfinder.isMoving = () => false
      now += 1000 // 1 s after stopping (11 s since initial setGoal, but 1 s since moving)
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 1)

      // After 6 s stationary with partial status, it re-issues
      now += 5001 // 6.001 s after stopping
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 2)
    } finally {
      Date.now = realNow
    }
  })

  it('stale noPath plans keep re-issuing GoalFollow, never stuck (idkcraft-5vv)', async () => {
    // Owner decision: follow never gives up. Every terminal tick replans
    // to the player — no stuck fact, no recover episode, no sidestep.
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal (GoalFollow)
      assert.equal(bot.calls.setGoal, 1)
      ticker.setPathStatus('noPath')
      await ticker.tick() // stale plan 1: replan
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.goals[1].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      await ticker.tick() // stale plan 2: replan again, still no fact
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.goals[2].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      assert.equal(bot._tickerCtx.stuck, null)
      assert.equal(lines.filter((l) => l.includes('stuck reason=')).length, 0)
      assert.equal(bot.calls.goals.filter((g) => g === null).length, 0)
      assert.equal(lines.filter((l) => l.includes('recover action=')).length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('movement keeps the replan stream on the player (idkcraft-5vv)', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial setGoal
    ticker.setPathStatus('noPath')
    await ticker.tick() // stale plan: replan
    assert.equal(bot.calls.setGoal, 2)
    bot.entity.position = pos(1, 64, 0) // progress: still replans, never stuck
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 3)
    assert.equal(bot.calls.goals[2].constructor.name, 'GoalFollow')
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 4)
    assert.equal(bot.calls.jump, 0)
    assert.equal(bot._tickerCtx.stuck, null)
  })

  it('goal key change resets the stall counter and nudge state', async () => {
    const bot = mockBot()
    bot.players = {
      Steve: { username: 'Steve', entity: playerEntity(10) },
      Alex: { username: 'Alex', entity: playerEntity(15) }
    }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // follow Steve
    ticker.setPathStatus('noPath')
    await ticker.tick() // stall 1 for Steve

    ticker.setFollow('Alex') // switch target
    await ticker.tick() // fresh follow Alex
    assert.equal(bot.calls.jump, 0)

    // First stall for Alex: must NOT escalate (counter was reset)
    await ticker.tick()
    assert.equal(bot.calls.jump, 0)
  })

  it('jitter below tolerance still replans every tick, never stuck (idkcraft-5vv)', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial setGoal
    ticker.setPathStatus('noPath')
    await ticker.tick()
    assert.equal(bot.calls.jump, 0)
    bot.entity.position = pos(0.3, 64, 0) // 0.3 jitter: replan, no fact
    await ticker.tick()
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 4)
    assert.equal(bot.calls.jump, 0)
    assert.equal(bot._tickerCtx.stuck, null)
    assert.equal(bot.calls.goals.filter((g) => g && g.constructor.name === 'GoalNear').length, 0)
  })

  it('active movement suppresses re-issue and clears stall counter if moved >0.5 block', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial setGoal
    ticker.setPathStatus('noPath')
    await ticker.tick() // stall 1

    // Bot starts moving along path and advances > 0.5 block
    bot.pathfinder.isMoving = () => true
    bot.entity.position = pos(2, 64, 0)
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 2) // no new setGoal while moving
    assert.equal(bot.calls.jump, 0)

    // Bot stops again
    bot.pathfinder.isMoving = () => false
    await ticker.tick() // stall 1 from new pos (counter was reset while moving)
    assert.equal(bot.calls.setGoal, 3)
    assert.equal(bot.calls.jump, 0)
  })

  it('timeout statuses replan every tick, never escalate (idkcraft-5vv)', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal
      ticker.setPathStatus('timeout')
      await ticker.tick() // timeout 1: replan
      assert.equal(bot.calls.setGoal, 2)
      await ticker.tick() // timeout 2: replan, no fact, no episode
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.jump, 0)
      assert.equal(lines.filter((l) => l.includes('stuck reason=timeout')).length, 0)
      assert.equal(bot.calls.goals.filter((g) => g === null).length, 0)
      assert.equal(bot.calls.goals.filter((g) => g && g.constructor.name === 'GoalNear').length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('success with empty path replans, never escalates (idkcraft-5vv)', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick()
    ticker.setPathStatus('success')
    bot.pathfinder.isMoving = () => false // success but empty path
    await ticker.tick() // replan
    assert.equal(bot.calls.setGoal, 2)
    await ticker.tick() // replan again: no fact, no episode
    assert.equal(bot.calls.setGoal, 3)
    assert.equal(bot.calls.jump, 0)
    assert.equal(bot._tickerCtx.stuck, null)
    assert.equal(bot.calls.goals.filter((g) => g === null).length, 0)
    assert.equal(bot.calls.goals.filter((g) => g && g.constructor.name === 'GoalNear').length, 0)
  })

  it('resting within follow range does not count as stalled across ticks', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }

    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal
      ticker.setPathStatus('success')

      // Sits in range across multiple ticks
      await ticker.tick()
      await ticker.tick()
      await ticker.tick()

      assert.equal(bot.calls.setGoal, 1) // no re-issues while resting in range
      assert.equal(bot.calls.jump, 0)
      assert.equal(lines.filter((l) => l.includes('stuck')).length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('resting at floored follow range with fractional offset does not false-stuck', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }

    try {
      const bot = mockBot()
      bot.entity.position = pos(10.5, 64, 0.5)
      bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(13.9, 64, 0.9) } } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal installs GoalFollow(Steve, 3)
      ticker.setPathStatus('success')

      // Sits in floored follow range across multiple ticks
      await ticker.tick()
      await ticker.tick()
      await ticker.tick()

      assert.equal(bot.calls.setGoal, 1) // no false re-issue
      assert.equal(bot.calls.jump, 0)
      assert.equal(lines.filter((l) => l.includes('stuck')).length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('re-issues setGoal when player moves out of resting range', async () => {
    const bot = mockBot()
    bot.entity.position = pos(0, 64, 0)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(2, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial setGoal (calls.setGoal = 1)
    ticker.setPathStatus('success')

    // Resting at 2 blocks (satisfied)
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 1)

    // Player moves out of follow range
    bot.players.Steve.entity.position = pos(6, 64, 0)
    ticker.setPathStatus('noPath')
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 2)
  })

  it('first stuck while moving replans, second wedged one opens the menu (idkcraft-5vv)', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial GoalFollow
      assert.equal(bot.calls.setGoal, 1)
      bot.pathfinder.isMoving = () => true // wedged executor: still "moving"
      ticker.setPathReset('stuck')
      await ticker.tick() // 1st stuck: passing knock, replan to the player
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.goals[1].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      assert.equal(bot._tickerCtx.stuck, null)
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 0)

      ticker.setPathReset('stuck')
      await ticker.tick() // 2nd stuck, no displacement: the real wedge, menu same tick
      assert.deepEqual(bot._tickerCtx.stuck, { by: 'follow', goal: { x: 10, y: 64, z: 0 }, key: 'follow:7' })
      const stuckLines = lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(stuckLines.length, 1)
      assert.match(stuckLines[0], /^stuck reason=wedge pos=0,64,0 dist=10\.0 feet=\? head=\? next=\?:\?$/)

      // 6x7.2: the central raise lands before the routing check, so the
      // episode opens on the wedge tick itself (was: dispatch-time raise,
      // routed next tick): null + menu sidestep + one-tick jump at once.
      assert.equal(bot.calls.setGoal, 4)
      assert.equal(bot.calls.goals[2], null)
      assert.equal(bot.calls.goals[3].constructor.name, 'GoalNear')
      assert.equal(bot.calls.jump, 1)
      assert.ok(lines.some((l) => l.includes('recover action=sidestep source=fsm outcome=chosen')))
      const r = await ticker.tick() // running tick: the episode holds the body
      assert.equal(r.decision.action, 'sidestep')
      assert.equal(r.calledBrain, false)
    } finally {
      console.log = origLog
    }
  })

  it('three place_error under follow raise the attributed wedge, not the ticker backstop', async () => {
    // 2oe end-to-end: the streak belongs to follow, so the ticker backstop
    // must not preempt it with a goal-less fact — the wedge line names the
    // relief and the fact carries the goal for the menu.
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial GoalFollow
      assert.equal(bot.calls.setGoal, 1)
      bot.pathfinder.isMoving = () => true // wedged executor: still "moving"
      ticker.setPathReset('place_error')
      await ticker.tick() // 1st: blind, no wedge
      ticker.setPathReset('place_error')
      await ticker.tick() // 2nd: blind, no wedge
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 0)
      ticker.setPathReset('place_error')
      await ticker.tick() // 3rd: follow wedge with relief names, menu same tick
      assert.deepEqual(bot._tickerCtx.stuck, { by: 'follow', goal: { x: 10, y: 64, z: 0 }, key: 'follow:7' })
      const stuckLines = lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(stuckLines.length, 1)
      assert.match(stuckLines[0], /^stuck reason=wedge pos=0,64,0 dist=10\.0 feet=\? head=\? next=\?:\?$/)

      // 6x7.2: same-tick routing (see above): null + menu sidestep + jump.
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.goals[1], null)
      assert.equal(bot.calls.goals[2].constructor.name, 'GoalNear')
      assert.equal(bot.calls.jump, 1)
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
      assert.ok(lines.some((l) => l.includes('recover action=sidestep source=fsm outcome=chosen')))
      const r = await ticker.tick() // running tick: the episode holds the body
      assert.equal(r.decision.action, 'sidestep')
      assert.equal(r.calledBrain, false)
    } finally {
      console.log = origLog
    }
  })

  it('displacement between two path_reset stuck clears the wedge counter: no nudge', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial GoalFollow
      bot.pathfinder.isMoving = () => true
      ticker.setPathReset('stuck')
      bot.entity.position = pos(1, 64, 0) // progress before the next tick
      await ticker.tick() // moved > 0.5: counter reset, no nudge
      assert.equal(bot.calls.setGoal, 1)
      assert.equal(bot.calls.jump, 0)
      ticker.setPathReset('stuck')
      await ticker.tick() // only 1 since progress: replan, still no nudge
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.goals[1].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      assert.equal(bot.calls.goals.filter((g) => g && g.constructor.name === 'GoalNear').length, 0)
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 0)
    } finally {
      console.log = origLog
    }
  })

  it('non-stuck path_reset reasons do not feed the wedge counter', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial GoalFollow
    bot.pathfinder.isMoving = () => true
    ticker.setPathReset('goal_moved')
    await ticker.tick()
    ticker.setPathReset('goal_moved')
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 1) // never reached 2 stuck: no nudge
    assert.equal(bot.calls.jump, 0)
  })
})

describe('work mode (epic rw4)', () => {
  const { handleChat } = require('../src/index')
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function workBot() {
    const bot = mockBot()
    bot.spawnPoint = pos(0, 64, 0)
    bot.chats = []
    bot.chat = (m) => { bot.chats.push(String(m)) }
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    bot._items = []
    bot.inventory = { items: () => bot._items }
    bot.equip = async () => {}
    return bot
  }

  function zombie(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  it('(a) work + player nearby: build step, follow never runs', async () => {
    const bot = workBot()
    bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }] // geared (atl.6): gather and craft infeasible, build defaults the site (rw4.4)
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const origFollow = BEHAVIOURS.follow
    let followRan = 0
    BEHAVIOURS.follow = () => { followRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'build')
      assert.equal(r.decision.source, 'goal-fsm')
      assert.equal(followRan, 0)
      assert.ok(bot.chats.some((m) => m === 'next: building the house (goal-fsm)'))
      assert.ok(lines.some((l) => l.includes('goal step=build')))
    } finally {
      BEHAVIOURS.follow = origFollow
      ticker.destroy()
    }
  })

  it('(a2) work + spawn chunks missing: waits, no adopt, proceeds after 60 ticks', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.blockAt = () => null // world hook present, spawn cell not visible yet
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'idle')
      assert.equal(r1.decision.source, 'local-idle')
      assert.ok(lines.some((l) => l.includes('waiting for spawn chunks')), 'waiting evidence')
      for (let i = 0; i < 61; i++) await ticker.tick()
      assert.ok(brain.calls > 0 || lines.some((l) => l.includes('goal step=')), 'work proceeds after the cap')
    } finally {
      ticker.destroy()
    }
  })

  it('(a3) work + door streams late: adopt retries and claims it (im4)', async () => {
    // The old adopt-once missed forever when door chunks trailed the
    // spawn block (2/5 live-assay bots). Retry while streaming.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const cells = new Map([['0,64,0', 'grass_block']])
    bot.blockAt = (pt) => {
      const n = cells.get(`${Math.floor(pt.x)},${Math.floor(pt.y)},${Math.floor(pt.z)}`)
      return n ? { name: n } : null
    }
    bot.findBlocks = (opts) => {
      const out = []
      const test = typeof opts.matching === 'function' ? opts.matching : () => false
      for (const [k, name] of cells) {
        if (!test({ name })) continue
        const [x, y, z] = k.split(',').map(Number)
        out.push({ x, y, z })
        if (out.length >= (opts.count || 1)) break
      }
      return out
    }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'idle', 'tick 1 waits on the door')
      assert.ok(lines.some((l) => l.includes('waiting for home chunks')), 'waiting evidence')
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'idle', 'tick 2 still waits')
      assert.equal(ctx.home, undefined, 'nothing adopted yet')
      cells.set('9,64,8', 'oak_door') // the door streams in
      // Loaded air around it (the mock reads missing cells as unknown, but
      // the real blockAt returns air): the v2 corner probe must read air,
      // not unknown, to settle on v1 instead of waiting for chunks.
      for (const k of ['6,64,8', '6,65,8', '12,64,8', '12,65,8', '6,64,13', '6,65,13', '12,64,13', '12,65,13']) {
        cells.set(k, 'air')
      }
      // The streamed house carries its ground ring (6bl: a lone door is
      // foreign and no longer adopts): table + v1 ring0 around the door.
      cells.set('12,64,9', 'crafting_table')
      for (const k of ['8,64,8', '10,64,8', '11,64,8', '8,64,11', '9,64,11', '10,64,11', '11,64,11', '8,64,9', '11,64,9', '8,64,10', '11,64,10']) {
        cells.set(k, 'oak_planks')
      }
      const r3 = await ticker.tick()
      assert.ok(ctx.home, 'adopted on the retry')
      assert.deepEqual([ctx.home.site.x, ctx.home.site.y, ctx.home.site.z], [8, 64, 8])
      assert.equal(ctx.adoptDone, true)
      assert.ok(bot.chats.some((m) => m === 'my home is at 8 64 8'), 'adopt announces')
      assert.notEqual(r3.decision.source, 'local-idle', 'work proceeds after adopt')
    } finally {
      ticker.destroy()
    }
  })

  it('(a4) work + no door ever: grace exhausts, build proceeds (im4)', async () => {
    // Bounded wait: a fresh world must not idle forever (5 grace ticks).
    const bot = workBot()
    bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }] // geared: build runs once adopt gives up
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.blockAt = () => ({ name: 'grass_block' }) // ready, but nothing streams
    bot.findBlocks = () => []
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    try {
      for (let i = 0; i < 5; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'idle', `grace tick ${i + 1} waits`)
      }
      assert.equal(ctx.adoptDone, undefined, 'not done during grace')
      const r6 = await ticker.tick()
      assert.equal(ctx.adoptDone, true, 'grace exhausted')
      assert.equal(r6.decision.action, 'build', 'build proceeds on the 6th tick')
    } finally {
      ticker.destroy()
    }
  })

  it('(a2b) spawn never visible, prod hooks: give-up right after the 60-tick cap (im4)', async () => {
    // The !ready give-up clause only matters with all three hooks (prod);
    // workBot lacks findBlocks, so (a2) cannot pin it (revmux 01 minor).
    // Deleting `!ready ||` stalls 5 grace ticks here instead of proceeding.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.blockAt = () => null // spawn cell never visible
    bot.findBlocks = () => []
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    try {
      for (let i = 0; i < 60; i++) {
        const r = await ticker.tick()
        assert.equal(r.decision.source, 'local-idle', `cap tick ${i + 1} waits`)
      }
      assert.equal(ctx.adoptDone, undefined, 'not done during the cap')
      const r61 = await ticker.tick()
      assert.equal(ctx.adoptDone, true, 'give-up on patience-out')
      assert.notEqual(r61.decision.source, 'local-idle', 'work proceeds right after the cap')
    } finally {
      ticker.destroy()
    }
  })

  it('(a5) work + complete house with a stale built=false: revalidation flips it (hlf)', async () => {
    // Adopt ran while one cell read missing, then the house completed
    // without build ever running (empty remainder = build infeasible, so
    // the build done-branch is unreachable). The post-dispatch recheck
    // flips the flag with the build done-branch effects: table claim,
    // save, announce. buildRan stays 0: nothing else could have flipped it.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }] // geared: rest is the only feasible step
    const cells = new Map()
    const paint = (x, y, z, name) => cells.set(`${x},${y},${z}`, name)
    paint(12, 64, 9, 'crafting_table') // v1 table at site+(4,0,1)
    for (const [x, z] of [[8, 8], [10, 8], [11, 8], [8, 11], [9, 11], [10, 11], [11, 11], [8, 9], [11, 9], [8, 10], [11, 10]]) {
      paint(x, 64, z, 'oak_planks') // ring0
      paint(x, 65, z, 'oak_planks') // ring1
    }
    paint(9, 64, 8, 'oak_door')
    for (let dx = 0; dx < 4; dx++) {
      for (let dz = 0; dz < 4; dz++) paint(8 + dx, 66, 8 + dz, 'oak_planks') // roof
    }
    bot.blockAt = (pt) => {
      const n = cells.get(`${Math.floor(pt.x)},${Math.floor(pt.y)},${Math.floor(pt.z)}`)
      return n ? { name: n } : null
    }
    bot.findBlocks = () => []
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.adoptDone = true
    ctx.buildSkip = []
    ctx.home = { site: { x: 8, y: 64, z: 8 }, v: 1, built: false, table: null }
    const origRest = BEHAVIOURS.rest
    const origBuild = BEHAVIOURS.build
    let restRan = 0
    let buildRan = 0
    BEHAVIOURS.rest = () => { restRan++ }
    BEHAVIOURS.build = () => { buildRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'rest', 'build infeasible on the empty remainder')
      assert.equal(restRan, 1)
      assert.equal(buildRan, 0, 'build never runs, yet the flag flips')
      assert.equal(ctx.home.built, true, 'stale flag flips on the recheck')
      assert.deepEqual({ x: ctx.home.table.x, y: ctx.home.table.y, z: ctx.home.table.z }, { x: 12, y: 64, z: 9 }, 'standing table claimed')
      assert.ok(bot.chats.some((m) => m === 'home done at 8 64 8'), 'completion announced')
    } finally {
      BEHAVIOURS.rest = origRest
      BEHAVIOURS.build = origBuild
      ticker.destroy()
    }
  })

  it('(a6) work + one cell still missing: no flip, no announce (hlf)', async () => {
    // The recheck is exact: a genuinely unfinished house keeps its flag.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }]
    const cells = new Map()
    const paint = (x, y, z, name) => cells.set(`${x},${y},${z}`, name)
    paint(12, 64, 9, 'crafting_table')
    for (const [x, z] of [[8, 8], [10, 8], [11, 8], [8, 11], [9, 11], [10, 11], [11, 11], [8, 9], [11, 9], [8, 10], [11, 10]]) {
      paint(x, 64, z, 'oak_planks')
      paint(x, 65, z, 'oak_planks')
    }
    paint(9, 64, 8, 'oak_door')
    for (let dx = 0; dx < 4; dx++) {
      for (let dz = 0; dz < 4; dz++) {
        if (dx === 0 && dz === 0) continue // one roof cell genuinely missing
        paint(8 + dx, 66, 8 + dz, 'oak_planks')
      }
    }
    bot.blockAt = (pt) => {
      const n = cells.get(`${Math.floor(pt.x)},${Math.floor(pt.y)},${Math.floor(pt.z)}`)
      return n ? { name: n } : null
    }
    bot.findBlocks = () => []
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.adoptDone = true
    ctx.buildSkip = []
    ctx.home = { site: { x: 8, y: 64, z: 8 }, v: 1, built: false, table: null }
    const origRest = BEHAVIOURS.rest
    const origBuild = BEHAVIOURS.build
    let buildRan = 0
    BEHAVIOURS.rest = () => {}
    BEHAVIOURS.build = () => { buildRan++ }
    try {
      await ticker.tick()
      assert.equal(ctx.home.built, false, 'unfinished house keeps its flag')
      assert.ok(!bot.chats.some((m) => m === 'home done at 8 64 8'), 'no premature announce')
      assert.equal(buildRan, 1, 'the missing cell goes through build, not the recheck')
    } finally {
      BEHAVIOURS.rest = origRest
      BEHAVIOURS.build = origBuild
      ticker.destroy()
    }
  })

  it('(a7) work + skipped hole with a stale built=false: revalidation never flips (vmzq.10)', async () => {
    // Prod (site -40 63 -215): 30 given-up cells read as done and the house
    // announced `home done` over the holes. The post-dispatch recheck must
    // demand a physically complete house — a skipped-but-missing cell keeps
    // built=false with no announce, and build stays infeasible on the empty
    // remainder (the 1h skip retry re-probes; structural cells re-skip).
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }]
    const cells = new Map()
    const paint = (x, y, z, name) => cells.set(`${x},${y},${z}`, name)
    paint(12, 64, 9, 'crafting_table')
    for (const [x, z] of [[8, 8], [10, 8], [11, 8], [8, 11], [9, 11], [10, 11], [11, 11], [8, 9], [11, 9], [8, 10], [11, 10]]) {
      paint(x, 64, z, 'oak_planks')
      paint(x, 65, z, 'oak_planks')
    }
    paint(9, 64, 8, 'oak_door')
    for (let dx = 0; dx < 4; dx++) {
      for (let dz = 0; dz < 4; dz++) {
        if (dx === 0 && dz === 0) continue // the hole: given up, still missing
        paint(8 + dx, 66, 8 + dz, 'oak_planks')
      }
    }
    bot.blockAt = (pt) => {
      const n = cells.get(`${Math.floor(pt.x)},${Math.floor(pt.y)},${Math.floor(pt.z)}`)
      return n ? { name: n } : null
    }
    bot.findBlocks = () => []
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.adoptDone = true
    const doorIdx = buildMod.BLUEPRINT.findIndex((c) => c.kind === 'door')
    ctx.buildSkip = [doorIdx + 12] // first roof cell (8,66,8): skipped, still air
    ctx.home = { site: { x: 8, y: 64, z: 8 }, v: 1, built: false, table: null }
    const origRest = BEHAVIOURS.rest
    const origBuild = BEHAVIOURS.build
    let buildRan = 0
    BEHAVIOURS.rest = () => {}
    BEHAVIOURS.build = () => { buildRan++ }
    try {
      await ticker.tick()
      assert.equal(ctx.home.built, false, 'a skipped hole is not a finished house')
      assert.ok(!bot.chats.some((m) => m === 'home done at 8 64 8'), 'no announce over holes')
      assert.equal(buildRan, 0, 'empty remainder minus skips: build infeasible, no repair tick')
    } finally {
      BEHAVIOURS.rest = origRest
      BEHAVIOURS.build = origBuild
      ticker.destroy()
    }
  })

  it('(b) work + hostile at 5 blocks: fight preempts as before', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'fight')
    assert.ok(bot.calls.setGoal >= 1) // pursuit goal, not a rest stroll
    assert.equal(bot.attackCalls, 0) // 5 blocks: walking in, out of swing range
    ticker.destroy()
  })

  it('(c) work + no visible target but roster non-empty: working path, fast cadence', async () => {
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = workBot()
      bot._items = [{ name: 'oak_planks', count: 58 }, { name: 'crafting_table', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }] // geared (atl.6): gather and craft infeasible, build runs
      // Roster player WITHOUT an entity: findTarget is null (nothing
      // visible), but Steve is on the server, so the workAlone path runs.
      // (An entity would make him visible and take the normal path instead.)
      bot.players = { Steve: { username: 'Steve' } }
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 111, idleTickMs: 222, followName: 'Nobody' })
      ticker.work()
      const r = await ticker.tick(true) // scheduled tick
      assert.equal(r.decision.action, 'build') // without workAlone this would be idle
      assert.deepEqual(delays, [111]) // fast ticks while working, not idle cadence
      ticker.destroy()
    } finally {
      global.setTimeout = orig
    }
  })

  it('(e) stationary gohome approach never raises the ticker stuck fact', async () => {
    // rw4.5/recover: the ef3 no-displacement backstop must not hijack a slow
    // night approach — walkTo owns the stall (cannot-reach-home) and the
    // arrival. 45 still ticks with the executor claiming motion: no episode.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.time = { timeOfDay: 15000 }
    bot.pathfinder.isMoving = () => true // executor claims motion, body still
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    // Near home (ipn.12): a night-far gohome now shelters instead of walking.
    ctx.home = { site: { x: 10, y: 64, z: 10 }, built: true, interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 12, y: 65, z: 12 } } }
    ctx.step = 'gohome'
    ctx.stepStatus = 'running'
    ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
    try {
      for (let i = 0; i < 45; i++) await ticker.tick()
      // 8kc: the re-armed walk replans once (fail ~31, re-issue ~32); no
      // churn mid-episode while the executor claims motion.
      assert.equal(bot.calls.goals.length, 2, 'one replan on re-arm, no churn after')
      assert.equal(ctx.stuck, null, 'no ticker backstop episode during gohome')
      assert.equal(ctx.recovery, null, 'no recovery owns the body during gohome')
      assert.equal(ctx.step, 'gohome', 'walkTo failure re-picks gohome silently at night')
      assert.ok((ctx.gohome.fails || 0) < 3, 'walkTo failure re-arms a fresh record instead of stranding')
    } finally {
      ticker.destroy()
    }
  })

  it('(e2) work/stop clear a stale night step so the next decide re-arms', () => {
    // Revmux 01-review loop+goal-4: follow->work, stop and fresh work must
    // not inherit a stale gohome/stay record or shelter flag.
    const bot = workBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    const stale = () => {
      ctx.step = 'stay'
      ctx.stepStatus = 'running'
      ctx.inShelter = true
      ctx.stay = { phase: 'hold', stalls: 0, fails: 0, lastPos: null, lastToggle: 0 }
      ctx.gohome = { phase: 'walk', stalls: 0, fails: 2, lastPos: null, lastToggle: 0 }
    }
    try {
      stale()
      ticker.work()
      assert.equal(ctx.step, null)
      assert.equal(ctx.stay, null)
      assert.equal(ctx.gohome, null)
      assert.equal(ctx.inShelter, false)
      stale()
      ticker.stop()
      assert.equal(ctx.step, null)
      assert.equal(ctx.stay, null)
      assert.equal(ctx.inShelter, false)
    } finally {
      ticker.destroy()
    }
  })

  it('(e3) order during gohome walk gives digging back', async () => {
    // Revmux 8kc: the walk borrows canDig=false on the shared Movements; an
    // order that ends the walk mid-phase must restore it.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.time = { timeOfDay: 15000 }
    const movements = { canDig: true }
    bot.pathfinder.movements = movements
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.movements = movements
    // Near home (ipn.12): a night-far gohome now shelters instead of walking.
    ctx.home = { site: { x: 10, y: 64, z: 10 }, built: true, interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 12, y: 65, z: 12 } } }
    ctx.step = 'gohome'
    ctx.stepStatus = 'running'
    ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 }
    try {
      await ticker.tick()
      assert.equal(ctx.gohome.phase, 'walk')
      assert.equal(movements.canDig, false, 'walk borrows no-dig')
      ticker.stop()
      assert.equal(movements.canDig, true, 'stop during walk restores digging')
    } finally {
      ticker.destroy()
    }
  })

  it('(e4) follow takeover mid-walk gives digging back at once', async () => {
    // Revmux 8kc round 2: a pending 'follow me' with the player unseen keeps
    // work; the walk borrows canDig=false; the sighting must restore it on
    // the takeover tick itself.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve' } } // rostered but unseen
    bot.time = { timeOfDay: 15000 }
    const movements = { canDig: true }
    bot.pathfinder.movements = movements
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.movements = movements
    // Near home (ipn.12): a night-far gohome now shelters instead of walking.
    ctx.home = { site: { x: 10, y: 64, z: 10 }, built: true, interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 12, y: 65, z: 12 } } }
    ctx.step = 'gohome'
    ctx.stepStatus = 'running'
    ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 }
    try {
      await ticker.tick() // work runs, walk borrows no-dig
      assert.equal(movements.canDig, false)
      ticker.setFollow('Steve') // pending order, player still unseen: work continues
      await ticker.tick()
      assert.equal(ctx.work, true)
      assert.equal(movements.canDig, false)
      bot.players.Steve.entity = playerEntity(10) // walks into view
      await ticker.tick() // takeover: follow owns the body, dig restored
      assert.equal(ctx.work, false)
      assert.equal(movements.canDig, true)
    } finally {
      ticker.destroy()
    }
  })

  it('(e5) homing takeover mid-walk gives digging back', async () => {
    // Revmux 8kc round 3: pending follow + unseen player -> after
    // UNSEEN_HOME_TICKS the homing walk owns the body; the night step must
    // end there so the borrowed canDig=false does not leak into it.
    const bot = workBot()
    bot.entity.position = pos(200, 64, 200) // far from spawn: homing walks
    bot.players = { Steve: { username: 'Steve' } } // rostered but unseen
    bot.time = { timeOfDay: 15000 }
    const movements = { canDig: true }
    bot.pathfinder.movements = movements
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.movements = movements
    // Near the bot (ipn.12): a night-far gohome now shelters instead of
    // walking. The bot stays far from spawn, so homing still takes over.
    ctx.home = { site: { x: 190, y: 64, z: 190 }, built: true, interior: { min: { x: 191, y: 64, z: 191 }, max: { x: 192, y: 65, z: 192 } } }
    ctx.step = 'gohome'
    ctx.stepStatus = 'running'
    ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 }
    try {
      await ticker.tick() // work runs, walk borrows no-dig
      assert.equal(movements.canDig, false)
      ticker.setFollow('Steve') // pending order, player still unseen
      for (let i = 0; i < 10; i++) await ticker.tick() // unseen accrues
      assert.match(ctx.lastGoalKey, /^return-spawn:/, 'homing walks to spawn')
      assert.equal(movements.canDig, true, 'homing takeover restores digging')
      assert.equal(ctx.step, null, 'night step ended at takeover')
    } finally {
      ticker.destroy()
    }
  })

  describe('atl.12 night shelter-run holds fight preemption', () => {
    // rw4.10 split: gohome stamps ctx.shelterRun on every night walk tick;
    // dispatch (this half) walks instead of fighting while it is fresh.
    // The export lands with rw4.10 — until then pin the contract value.
    const homeMod = require('../src/behaviours/home')
    const hadFresh = Object.prototype.hasOwnProperty.call(homeMod, 'SHELTER_RUN_FRESH_MS')
    const origFresh = homeMod.SHELTER_RUN_FRESH_MS
    beforeEach(() => { homeMod.SHELTER_RUN_FRESH_MS = 2500 })
    afterEach(() => {
      if (hadFresh) homeMod.SHELTER_RUN_FRESH_MS = origFresh
      else delete homeMod.SHELTER_RUN_FRESH_MS
    })

    function nightWalkBot() {
      const bot = workBot()
      bot.players = { Steve: { username: 'Steve' } } // rostered but unseen: brain called, target null
      bot.time = { timeOfDay: 15000 } // night
      return bot
    }
    function nightWalkCtx(bot) {
      const ctx = bot._tickerCtx
      // Near home (ipn.12): a night-far gohome now shelters instead of walking.
      ctx.home = { site: { x: 10, y: 64, z: 10 }, built: true, interior: { min: { x: 11, y: 64, z: 11 }, max: { x: 12, y: 65, z: 12 } } }
      ctx.step = 'gohome'
      ctx.stepStatus = 'running'
      ctx.gohome = { phase: 'walk', stalls: 0, fails: 0, lastPos: null, lastToggle: 0, legIdx: 0, legTicks: 0, legPos: null, legStall: 0, backing: 0 }
      return ctx
    }
    function fightBrain() {
      return mockBrain({ action: 'fight', sprint: false, source: 'stub' })
    }

    it('fresh stamp + brain fight + nobody visible: walks home, fight never runs', async () => {
      const bot = nightWalkBot()
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.shelterRun = Date.now() + 30000 // fresh (future-dated: suite stalls cannot flake the hold)
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'gohome')
        assert.equal(fightRan, 0, 'fight must not run during a live shelter-run')
        assert.ok(lines.some((l) => l.includes('shelter-run: holding fight preemption')), `edge logged, got: ${lines.join(' | ')}`)
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('stale stamp resumes fight (a stalled walk does not disarm the bot)', async () => {
      const bot = nightWalkBot()
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.shelterRun = Date.now() - 10000
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'fight')
        assert.equal(fightRan, 1)
        assert.ok(!lines.some((l) => l.includes('shelter-run:')), 'no edge log without a hold')
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('visible player keeps player protection fighting (shelter hold is alone-only)', async () => {
      const bot = nightWalkBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.shelterRun = Date.now()
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

    it('holds across ticks while the walk re-stamps; logs the edge once', async () => {
      const bot = nightWalkBot()
      bot.entities = { 1: zombie(1, 2), 2: zombie(2, -2), 3: zombie(3, 0) } // 3 adjacent hostiles, brain still says fight
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        for (let i = 0; i < 5; i++) {
          ctx.shelterRun = Date.now() + 30000 // the live walk re-stamps every tick (future-dated)
          const r = await ticker.tick()
          assert.equal(r.decision.action, 'gohome', `tick ${i} walks`)
        }
        assert.equal(fightRan, 0, 'fight never runs across a held walk')
        assert.equal(lines.filter((l) => l.includes('shelter-run: holding')).length, 1, 'edge logged once per walk')
        ctx.shelterRun = Date.now() - 10000 // walk stalls: stamp goes stale
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'fight', 'fail-safe: stale stamp resumes fight')
        assert.equal(fightRan, 1)
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('active lead order keeps fight ticks (orders beat the shelter hold)', async () => {
      // Revmux atl.12 round 1 (major): without the order gate a fresh stamp
      // diverted fight ticks into goal.decide under an unseen-player lead,
      // starving the order and leaking the walk no-dig into lead pathing.
      const bot = nightWalkBot()
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.lead = { name: 'Steve' } // explicit order, player unseen
      ctx.shelterRun = Date.now()
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'fight')
        assert.equal(fightRan, 1)
        assert.ok(!lines.some((l) => l.includes('shelter-run:')), 'no hold line when the order owns the tick')
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('active bring order keeps fight ticks', async () => {
      const bot = nightWalkBot()
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.bring = { name: 'coal', want: 3, by: 'P', phase: 'find', have: 0, announced: false }
      ctx.shelterRun = Date.now()
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'fight')
        assert.equal(fightRan, 1)
        assert.ok(!lines.some((l) => l.includes('shelter-run:')), 'no hold line when the order owns the tick')
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('fight/idle flap mid-walk logs the edge once (latch resets on stale stamp only)', async () => {
      // Revmux atl.12 round 1 (minor): resetting the latch on every
      // non-hold tick re-logged whenever a mob hovered at the 8-block edge.
      const bot = nightWalkBot()
      const script = [
        { action: 'fight', sprint: false, source: 'stub' },
        { action: 'idle', sprint: false, source: 'stub' },
        { action: 'fight', sprint: false, source: 'stub' },
      ]
      let i = 0
      const ticker = createTicker({ bot, brain: { decide: async () => script[i++] }, tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        for (let t = 0; t < 3; t++) {
          ctx.shelterRun = Date.now() + 30000 // future-dated: flap timing cannot flake freshness
          bot.health = 20 - t // round 2: bust the decision cache (stateKey covers health) so the idle tick really runs
          const r = await ticker.tick()
          assert.equal(r.decision.action, 'gohome', `tick ${t} walks`)
        }
        assert.equal(i, 3, 'all three scripted decisions ran (idle was not cached away)')
        assert.equal(fightRan, 0)
        assert.equal(lines.filter((l) => l.includes('shelter-run: holding')).length, 1, 'one edge log per walk')
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })

    it('climbing shelter fights instead of idling (inShelter arms only on the pillar)', async () => {
      // Revmux ipn 01 core-1: arming inShelter before the pillar stands turns
      // every fight tick idle at the ticker gate, and stopOnce kills the
      // pillar jump — freezing the climb on the first hostile. The climb
      // state comes from the real first shelter tick, not hand-set: pre-fix
      // it armed inShelter and this fight tick idled.
      const bot = nightWalkBot()
      bot.entities = { 1: zombie(1, 2) }
      bot._items = [{ name: 'cobblestone', count: 64 }] // scaffold: the climb stays running
      const ticker = createTicker({ bot, brain: fightBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = nightWalkCtx(bot)
      ctx.step = 'shelter'
      ctx.shelter = {}
      homeMod.shelter(bot, ctx, null, null) // the real first climb tick
      assert.equal(ctx.recovery && ctx.recovery.status, 'running', 'mid-climb state')
      assert.equal(ctx.inShelter || false, false, 'unsheltered until the pillar stands')
      const origFight = BEHAVIOURS.fight
      let fightRan = 0
      BEHAVIOURS.fight = () => { fightRan++ }
      try {
        const r = await ticker.tick()
        assert.equal(r.decision.action, 'fight')
        assert.equal(fightRan, 1, 'the climb does not idle fight ticks')
        assert.equal(ctx.recovery && ctx.recovery.action, 'pillar_up', 'the climb episode survives the fight tick')
      } finally {
        BEHAVIOURS.fight = origFight
        ticker.destroy()
      }
    })
  })

  it('(d) follow me in chat resets work: next tick follows', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    handleChat(bot, ticker, 'Steve', 'follow me')
    assert.ok(bot.chats.some((m) => m.includes('Following Steve')))
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalFollow')
    ticker.destroy()
  })

  it('follow me wakes a sleeping body (night orders obey)', async () => {
    const bot = workBot()
    bot.isSleeping = true
    let wakes = 0
    bot.wake = async () => { wakes++; bot.isSleeping = false }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'follow me')
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    assert.equal(wakes, 1, 'the order leaves the bed')
    ticker.destroy()
  })

  describe('follow me from an unseen player (3a7)', () => {
    function unseenBot() {
      const bot = workBot()
      bot.players = { P: { username: 'P', entity: null } }
      return bot
    }

    it("answers honestly with coordinates, not 'Following'", () => {
      const bot = unseenBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      handleChat(bot, ticker, 'P', 'follow me')
      assert.ok(!bot.chats.some((l) => l.includes('Following P')))
      assert.ok(bot.chats.some((l) => l.includes("I can't see you")))
      assert.ok(bot.chats.some((l) => l.includes('0 64 0')))
      assert.ok(bot.chats.some((l) => l.includes('/tp IdkBot P')))
    })

    it('keeps working instead of local-idle while the follower is unseen', async () => {
      const bot = unseenBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      handleChat(bot, ticker, 'P', 'follow me')
      const r = await ticker.tick()
      assert.equal(r.decision.source, 'goal-fsm') // work step continues
      assert.notEqual(r.decision.action, 'idle')
      ticker.destroy() // background chain would rotate a failing step (atl.4)
    })

    it('follows the first tick the player becomes visible', async () => {
      const bot = unseenBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      handleChat(bot, ticker, 'P', 'follow me')
      bot.players.P = { username: 'P', entity: playerEntity(10) }
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'follow')
      ticker.destroy() // no background tail past the test
    })
  })

  describe('return home to an unseen follower (06v)', () => {
    function farBot() {
      const bot = workBot()
      bot.entity.position = pos(-205, 39, -35)
      bot.spawnPoint = pos(-48, 65, -208)
      bot.players = { P: { username: 'P', entity: null } }
      return bot
    }

    it('walks to spawn after N unseen ticks instead of stopOnce', async () => {
      const bot = farBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      handleChat(bot, ticker, 'P', 'follow me') // follow order, honest chat (3a7)
      for (let i = 0; i < 10; i++) await ticker.tick()
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:-48,65,-208$/)
      assert.equal(bot.calls.goals[bot.calls.goals.length - 1].constructor.name, 'GoalNear')
      const stops = bot.calls.stop
      await ticker.tick()
      await ticker.tick()
      assert.equal(bot.calls.stop, stops) // homing: no more stopOnce
    })

    it('a pending follow order beats working alone', async () => {
      // 3a7 keeps work for an unseen follower; reunion still outranks
      // cave work, so after N ticks the bot walks instead of working.
      const bot = farBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      handleChat(bot, ticker, 'P', 'follow me')
      for (let i = 0; i < 10; i++) await ticker.tick()
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:-48,65,-208$/)
      assert.equal(bot.calls.goals[bot.calls.goals.length - 1].constructor.name, 'GoalNear')
    })

    it('follow+work at spawn stands (no work/home oscillation)', async () => {
      // 3a7 keeps work for an unseen follower; homing walked it back. Past
      // arrival the latch must hold: no work step may overwrite the spawn
      // goal, or the bot ping-pongs work-vs-home every ~10 ticks.
      const bot = farBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      handleChat(bot, ticker, 'P', 'follow me')
      for (let i = 0; i < 10; i++) await ticker.tick()
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:/)
      bot.entity.position = pos(-48, 65, -208) // arrived
      const lines = []
      const actions = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 15; i++) actions.push((await ticker.tick()).decision.action)
      } finally {
        console.log = origLog
      }
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:/)
      assert.ok(!lines.some((l) => l.includes('goal step=')), 'no work step past arrival')
      assert.ok(!lines.some((l) => l.includes('returning to spawn')), 'no re-walk past arrival')
      // The latch holds the body idle: without it the ticks fall through to
      // the work FSM (gather decisions) while the goal key still reads
      // return-spawn, so the assertions above cannot see the oscillation.
      assert.ok(actions.every((a) => a === 'idle'), `stood idle past arrival, got ${actions.join(',')}`)
    })

    it('sighting mid-walk resumes skipped work', async () => {
      // No follow order (default deploy): the spawn handler skipped work()
      // and armed the walk. A player sighted mid-walk ends homing by
      // resuming work, not by following forever.
      const bot = farBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      bot._tickerCtx.resumeWork = true // as the spawn handler sets it
      for (let i = 0; i < 10; i++) await ticker.tick()
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:/)
      bot.players.P = { username: 'P', entity: playerEntity(10) } // sighted mid-walk
      await ticker.tick()
      assert.equal(bot._tickerCtx.work, true)
      ticker.destroy() // manual ticks arm background chains; a failing step
      // would otherwise rotate (atl.4) and spray goal lines into later tests
    })

    it('lone bot still stops (no roster, no walk)', async () => {
      const bot = farBot()
      bot.players = {}
      bot.pathfinder.isMoving = () => true // stop latch needs a real path
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      for (let i = 0; i < 12; i++) await ticker.tick()
      assert.ok(!/^return-spawn:/.test(bot._tickerCtx.lastGoalKey))
      assert.ok(bot.calls.stop >= 1)
    })

    it('spawn far from home skips work and walks (default deploy)', async () => {
      const { runOnce } = require('../src/index')
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      let bot
      try {
        const { EventEmitter } = require('node:events')
        bot = new EventEmitter()
        bot.username = 'IdkBot'
        bot.players = { P: { username: 'P', entity: null } }
        bot.entities = {}
        bot.health = 20
        bot.food = 20
        bot.entity = { position: pos(-205, 39, -35) }
        bot.spawnPoint = pos(-48, 65, -208)
        bot.registry = require('minecraft-data')('1.21.1')
        bot.goals = []
        bot.pathfinder = {
          isMoving: () => false,
          stop: () => {},
          setGoal: (goal) => { bot.goals.push(goal) },
          setMovements: (m) => { bot.movements = m },
        }
        bot.loadPlugin = () => {}
        bot.quit = () => {}
        bot.chat = () => {}
        // No followName: default deploy. The far, unseen start must walk
        // home INSTEAD of entering work mode (no 'goal step=' lines).
        runOnce({
          host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
          brain: mockBrain(), leaveAfterMs: 60000, followName: '',
          createBot: () => bot, pingFn: async () => ({ players: { online: 1 } }),
        }).then(() => {}, () => {})
        bot.emit('spawn')
        await new Promise((r) => setTimeout(r, 60))
        assert.ok(bot.goals.some((g) => g.constructor.name === 'GoalNear'), 'GoalNear issued')
        assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:/)
        assert.ok(!lines.some((l) => l.includes('goal step=')), 'work mode not entered')
        // Arrival resumes the skipped work mode (one-shot). Edge stop: the
        // executor ends on the floored block centre, 2.55 out — still home.
        bot.entity.position = pos(-47.5, 65, -205.5)
        lines.length = 0
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(bot._tickerCtx.work, true)
        assert.ok(lines.some((l) => l.includes('goal step=')), 'work resumed on arrival')
      } finally {
        console.log = origLog
      }
    })

    it('a home walk going nowhere raises stuck reason=wedge once, arrival clears it', async () => {
      // 2oe acceptance: walkHomeTick with a motionless body fires the wedge
      // line + home fact for the menu; standing at spawn is arrival, not a
      // stall, and clears a stale home fact.
      const bot = farBot()
      bot.pathfinder.isMoving = () => true // executor claims motion, body stands still
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 35; i++) await ticker.tick() // wedge at 31 (unified slow entry), routed same tick
      const wedge = lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(wedge.length, 1)
      assert.match(wedge[0], /^stuck reason=wedge pos=-205,39,-35 dist=/)
      assert.equal(bot._tickerCtx.stuck.by, 'home')
      assert.deepEqual(bot._tickerCtx.stuck.goal, { x: -48, y: 65, z: -208 })
      // The idle branch routes the fact to the menu: an episode runs while
      // homing, then gives up boundedly (latch admits one episode per
      // situation — no re-fire while the body keeps standing still).
      for (let i = 0; i < 40; i++) await ticker.tick()
      } finally {
        console.log = origLog
      }
      assert.ok(lines.some((l) => l.includes('recover action=sidestep source=fsm outcome=chosen')), 'episode ran while homing')
      assert.ok(lines.some((l) => l.includes('outcome=gave-up')), 'episode gave up instead of looping')
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
      assert.equal(bot._tickerCtx.stuck, null)
      assert.equal(bot._tickerCtx.recoverLatch.by, 'home')
      bot.entity.position = pos(-48, 65, -208) // arrived
      for (let i = 0; i < 5; i++) await ticker.tick()
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
      assert.equal(bot._tickerCtx.stuck, null)
    })

    it('a sidestep that moves the body releases the episode instead of orphaning it', async () => {
      // The successful-escape path: displacement during a running episode
      // must keep the fact (it drives the routing) until release clears it.
      // Clearing it in walkHomeTick would orphan ctx.recovery: no routing,
      // no release, every detector off.
      const bot = farBot()
      bot.pathfinder.isMoving = () => true // executor claims motion, body stands still
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 32; i++) await ticker.tick() // wedge at 31, routed same tick
        assert.ok(lines.some((l) => l.includes('recover action=sidestep source=fsm outcome=chosen')))
        bot.entity.position = pos(-203, 39, -35) // the sidestep moved the body
        for (let i = 0; i < 8; i++) await ticker.tick()
      } finally {
        console.log = origLog
      }
      assert.ok(lines.some((l) => l.includes('outcome=done')), 'sidestep done released the episode')
      assert.equal(bot._tickerCtx.recovery, null)
      assert.equal(bot._tickerCtx.stuck, null)
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
    })

    it('a non-home fact does not open an episode while nobody is online', async () => {
      // Idle-branch cost guard: a pre-existing follow/gather episode pauses
      // while alone (no brain calls) and resumes on sighting; only the home
      // fact routes here.
      const bot = farBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      bot._tickerCtx.stuck = { by: 'follow', goal: { x: 1, y: 64, z: 0 }, key: 'follow:P' }
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 3; i++) await ticker.tick()
      } finally {
        console.log = origLog
      }
      assert.ok(!lines.some((l) => l.includes('recover action=')), 'no episode while alone')
      assert.equal(bot._tickerCtx.stuck.by, 'follow', 'fact waits for sighting')
    })

    it('walking back into the same wedge does not open a second episode', async () => {
      // Latch semantics: the release anchors its point, so re-wedging next
      // to it stays blocked — otherwise the walk chats+asks every ~15 ticks
      // for as long as homing lasts.
      const bot = farBot()
      bot.pathfinder.isMoving = () => true // executor claims motion, body stands still
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 32; i++) await ticker.tick() // wedge at 31, routed same tick
        bot.entity.position = pos(-203, 39, -35) // the sidestep moved the body
        for (let i = 0; i < 8; i++) await ticker.tick() // release done
        assert.ok(lines.some((l) => l.includes('outcome=done')))
        bot.entity.position = pos(-205, 39, -35) // walked back into the wedge cell
        for (let i = 0; i < 65; i++) await ticker.tick() // re-issue + two full stall cycles
      } finally {
        console.log = origLog
      }
      assert.equal(lines.filter((l) => l.includes('stuck reason=wedge')).length, 1)
      assert.equal(lines.filter((l) => l.includes('outcome=chosen')).length, 1)
      assert.equal(bot._tickerCtx.stuck, null)
    })

    it('sighting drops a moot home fact instead of opening a spawn episode', async () => {
      // A hostile on the bot holds the episode off (urgent fight wins), so
      // the fact is still set when the player appears: homing is over, the
      // spawn goal is moot, follow/work detectors take over from here.
      const bot = farBot()
      bot.pathfinder.isMoving = () => true // executor claims motion, body stands still
      const zp = pos(-205, 39, -35) // on the bot: urgent fight wins
      bot.entities = { 9: { id: 9, name: 'zombie', type: 'mob', position: zp, height: 1.95 } }
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      const lines = []
      const origLog = console.log
      console.log = (l) => { lines.push(String(l)) }
      try {
        for (let i = 0; i < 32; i++) await ticker.tick() // homing walk wedges at 31
      } finally {
        console.log = origLog
      }
      assert.equal(bot._tickerCtx.stuck.by, 'home')
      assert.ok(!lines.some((l) => l.includes('recover action=')), 'no episode while fight is urgent')
      bot.players.P = { username: 'P', entity: playerEntity(10) } // sighted
      await ticker.tick()
      assert.equal(bot._tickerCtx.stuck, null)
      assert.ok(!lines.some((l) => l.includes('recover action=')), 'no spawn episode with player on screen')
    })

    it('spawn far from home pre-arms the walk', async () => {
      const { runOnce } = require('../src/index')
      const bot = (function connLike() {
        const { EventEmitter } = require('node:events')
        const b = new EventEmitter()
        b.username = 'IdkBot'
        b.players = { P: { username: 'P', entity: null } }
        b.entities = {}
        b.health = 20
        b.food = 20
        b.entity = { position: pos(-205, 39, -35) }
        b.spawnPoint = pos(-48, 65, -208)
        b.registry = require('minecraft-data')('1.21.1')
        b.goals = []
        b.pathfinder = {
          isMoving: () => false,
          stop: () => {},
          setGoal: (goal) => { b.goals.push(goal) },
          setMovements: (m) => { b.movements = m },
        }
        b.loadPlugin = () => {}
        b.quit = () => {}
        b.chat = () => {}
        return b
      })()
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 60000, followName: 'P',
        createBot: () => bot, pingFn: async () => ({ players: { online: 1 } }),
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 60))
      assert.ok(bot._tickerCtx.unseenTicks >= 10, `pre-armed at spawn (unseenTicks=${bot._tickerCtx.unseenTicks})`)
      assert.ok(bot.goals.some((g) => g.constructor.name === 'GoalNear'), 'GoalNear issued on first ticks')
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:/)
    })

    // 9ldm: an autonomous restart with nobody online works where it stands;
    // with a player online but unseen the 3a7 pre-arm walk stays.
    async function autonomousRestart(players) {
      const { runOnce } = require('../src/index')
      const { EventEmitter } = require('node:events')
      const b = new EventEmitter()
      b.username = 'IdkBot'
      b.players = players
      b.entities = {}
      b.health = 20
      b.food = 20
      b.entity = { position: pos(-13, 80, -150), onGround: true }
      b.spawnPoint = pos(-48, 65, -350)
      b.registry = require('minecraft-data')('1.21.1')
      b.inventory = { items: () => [] }
      b.goals = []
      b.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: (goal) => { b.goals.push(goal) }, setMovements: (m) => { b.movements = m } }
      b.setControlState = () => {}
      b.clearControlStates = () => {}
      b.loadPlugin = () => {}
      b.quit = () => {}
      b.chat = () => {}
      const logs = []
      const origLog = console.log
      console.log = (m) => logs.push(String(m))
      try {
        runOnce({
          host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
          brain: mockBrain(), leaveAfterMs: 0, followName: '', autonomous: true,
          createBot: () => b, pingFn: async () => ({ players: { online: 0 } }),
        }).then(() => {}, () => {})
        b.emit('spawn')
        await new Promise((r) => setTimeout(r, 60))
      } finally {
        console.log = origLog
        b._ticker && b._ticker.destroy && b._ticker.destroy()
      }
      return { b, logs }
    }

    it('autonomous restart on an empty server works at once, no spawn walk (9ldm)', async () => {
      const { b, logs } = await autonomousRestart({})
      const c = b._tickerCtx
      assert.ok((c.unseenTicks || 0) < 10, `not pre-armed (unseenTicks=${c.unseenTicks})`)
      assert.equal(c.work, true, 'work mode started at spawn')
      assert.ok(!logs.some((l) => l.includes('returning to spawn')), `no homing walk: ${logs.join(' | ')}`)
      assert.ok(!/^return-spawn:/.test(c.lastGoalKey || ''), `goal key ${c.lastGoalKey}`)
      const first = logs.find((l) => l.includes('decision source='))
      assert.ok(first && first.includes("source=goal-fsm"), `first decision: ${first} logs: ${logs.join(" | ")}`)
    })

    it('autonomous restart with a player online but unseen still walks to spawn (3a7)', async () => {
      const { b } = await autonomousRestart({ P: { username: 'P', entity: null } })
      assert.ok(b._tickerCtx.unseenTicks >= 10, `pre-armed (unseenTicks=${b._tickerCtx.unseenTicks})`)
      assert.match(b._tickerCtx.lastGoalKey, /^return-spawn:/)
    })
  })

  it('(e2) go work clears the menu-wide hold for the ordered retry', async () => {
    // Round-1 major/minor: startWork resets stale skips/finals but left
    // ctx.stepFail, so the atl.4 hold vetoed the fresh episode.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stepFail = { gather: { status: 'failed:unreachable', text: 't', pos: { x: 0, y: 64, z: 0 } } }
    ticker.stop()
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.deepEqual(bot._tickerCtx.stepFail, {})
    ticker.destroy()
  })
  it('(e) go work after stop unpauses into work', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.stop()
    handleChat(bot, ticker, 'Steve', 'go work')
    assert.ok(bot.chats.some((m) => m.includes('on my own')))
    const r = await ticker.tick()
    assert.notDeepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.equal(r.decision.action, 'gather') // empty hands: gather is the correct first step
    ticker.destroy()
  })

  it('stop during the goal await discards the stale work step', async () => {
    // Mirrors 'stop during the brain await discards the stale follow': the
    // goal await can span a LAYA yes/no chain, and a stop that lands inside
    // must not get applyDecision(gather) when it resolves.
    const bot = workBot() // empty hands: gather and rest feasible, model asked
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    let resolveAsk
    const brain = {
      // hg8: jev source — a [gather, rest] pair is shaped (unasked) for laya.
      source: 'jev',
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      ask: () => new Promise((resolve) => { resolveAsk = resolve }),
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const pending = ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    // 'stop' lands while chooseStep awaits the model
    ticker.stop()
    bot.chats.length = 0
    resolveAsk('gather')
    const r = await pending
    assert.equal(bot.calls.setGoal, 0)
    assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.ok(bot.chats.every((m) => !m.includes('next:')), 'no step chat after mid-await stop')
  })

  it('follow me during the goal await discards the stale work step quietly', async () => {
    // setFollow switches work off without pausing: same stale-step shape.
    const bot = workBot() // empty hands: gather and rest feasible, model asked
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    let resolveAsk
    const brain = {
      // hg8: jev source — a [gather, rest] pair is shaped (unasked) for laya.
      source: 'jev',
      decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }),
      ask: () => new Promise((resolve) => { resolveAsk = resolve }),
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const pending = ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    // 'follow me' lands while chooseStep awaits the model
    ticker.setFollow('Steve')
    bot.chats.length = 0
    resolveAsk('gather')
    const r = await pending
    assert.equal(bot.calls.setGoal, 0)
    assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.ok(bot.chats.every((m) => !m.includes('next:')), 'no step chat after mid-await follow')
  })

  it('(g) work + empty or self-only roster: idle path, no brain call, slow cadence', async () => {
    // The workAlone roster guard (anyone but the bot itself) keeps a lone
    // working bot on the cheap idle path: no brain call, slow ticks, leave
    // streak ages. Without the self-exclusion it would burn model calls.
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      for (const players of [{}, { IdkBot: { username: 'IdkBot', entity: playerEntity(0) } }]) {
        const bot = workBot()
        bot.players = players
        const brain = mockBrain()
        const ticker = createTicker({ bot, brain, tickMs: 111, idleTickMs: 222 })
        ticker.work()
        const r = await ticker.tick(true) // scheduled tick
        assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
        assert.equal(brain.calls, 0)
        assert.ok(!lines.some((l) => l.includes('goal step=')), 'no goal decision while alone')
        ticker.destroy()
      }
      assert.ok(delays.every((d) => d === 222), `slow cadence while alone (delays=${delays})`)
    } finally {
      global.setTimeout = orig
    }
  })

  it('(f) status chats what the bot does, who chose it and why (gwvg A1)', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const origGather = BEHAVIOURS.gather
    BEHAVIOURS.gather = () => {} // the step stays running; gather's own tests cover the failure
    try {
      await ticker.tick() // step gather is picked
    } finally {
      BEHAVIOURS.gather = origGather
    }
    const ctx = bot._tickerCtx
    assert.equal(ctx.stepPick.source, 'goal-fsm')
    assert.equal(ctx.stepPick.why, 'start')
    assert.equal(ctx.stepPick.fsm, 'gather')
    const n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    const reply = bot.chats.slice(n)
    assert.ok(reply.length >= 1 && reply.length <= 3, `1-3 lines, got ${reply.length}`)
    const line1 = reply[0]
    for (const frag of ['working', 'body=work', 'step=gather', 'chopping wood', 'running', 'goal-fsm', 'start']) {
      assert.ok(line1.includes(frag), `line 1 names ${frag}: ${line1}`)
    }
    const all = reply.join('\n')
    for (const frag of ['logs=', 'planks=', 'home=']) {
      assert.ok(all.includes(frag), `reply keeps ${frag}: ${all}`)
    }
    ticker.destroy()
  })

  it('(f2) status names the rest reason when resting', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    bot._tickerCtx.step = 'rest'
    bot._tickerCtx.restWhy = 'gather: load full, explore: house not built yet'
    handleChat(bot, ticker, 'Steve', 'status')
    const line = bot.chats[bot.chats.length - 1]
    assert.ok(line.includes('working'), `mode: ${line}`)
    assert.ok(line.includes('step=rest'), `step: ${line}`)
    assert.ok(line.includes('resting because gather: load full, explore: house not built yet'), `same restWhy text: ${line}`)
    assert.ok(line.includes('logs=0') && line.includes('planks=0') && line.includes('home=none'), `facts: ${line}`)
    ticker.destroy()
  })

  it('(f3) status names held steps as blocked (gwvg A3)', async () => {
    const goal = require('../src/goal')
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    // A live hold (record text matches): stepWhy's own wording.
    const live = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
    ctx.stepFail = { gather: { status: 'failed:unreachable', text: live, pos: { x: 0, y: 64, z: 0 }, at: Date.now() } }
    let n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('blocked: gather holds after failure'), bot.chats.slice(n).join(' | '))
    // A stale record text with the gather latch still holding: same words.
    ctx.stepFail = { gather: { status: 'failed:unreachable', text: 't', pos: { x: 0, y: 64, z: 0 } } }
    n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('blocked: gather holds after failure'), bot.chats.slice(n).join(' | '))
    ticker.destroy()
  })

  it('(f3b) status stays silent on released failure records (gwvg A3, 01 core-1)', async () => {
    // No gather latch: gather stayed stubbed and the record text moved on,
    // so nothing holds — the released record must not read as blocked.
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const origGather = BEHAVIOURS.gather
    BEHAVIOURS.gather = () => {}
    try {
      await ticker.tick()
    } finally {
      BEHAVIOURS.gather = origGather
    }
    const ctx = bot._tickerCtx
    assert.ok(!ctx.gather, 'no gather latch without a gather run')
    ctx.stepFail = { gather: { status: 'failed:unreachable', text: 't', pos: { x: 0, y: 64, z: 0 } } }
    const n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(!bot.chats.slice(n).join('\n').includes('blocked:'), bot.chats.slice(n).join(' | '))
    ticker.destroy()
  })

  it('(f4) status names stuck and recovering episodes (gwvg A4)', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.stuckState = 'STUCK'
    let n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('stuck=STUCK'), bot.chats.slice(n).join(' | '))
    ctx.stuckState = 'MOVING'
    ctx.recovery = { action: 'pillar_up', status: 'running' }
    n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('recovering=pillar_up'), bot.chats.slice(n).join(' | '))
    ticker.destroy()
  })

  it('(f5) last recover outcome survives clearStuck (gwvg A4)', async () => {
    const recover = require('../src/behaviours/recover')
    const stuck = require('../src/stuck')
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.recovery = { action: 'pillar_up', source: 'fsm' }
    recover.release(bot, ctx, 'done')
    stuck.clearStuck(ctx)
    assert.equal(ctx.recovery, null)
    const n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('last recover: pillar_up done'), bot.chats.slice(n).join(' | '))
    ticker.destroy()
  })

  it('(f6) follow mode status names the brain source (gwvg A5)', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = { calls: 0, async decide() { this.calls++; return { action: 'follow', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('Steve')
    const origFollow = BEHAVIOURS.follow
    BEHAVIOURS.follow = () => {}
    try {
      await ticker.tick()
    } finally {
      BEHAVIOURS.follow = origFollow
    }
    assert.equal(bot._tickerCtx.lastDecision.source, 'stub')
    const n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    const reply = bot.chats.slice(n)
    assert.ok(reply[0].includes('following'), reply.join(' | '))
    assert.ok(reply[0].includes('body=follow'), reply.join(' | '))
    assert.ok(reply[0].includes('source=stub'), reply.join(' | '))
    ticker.destroy()
  })

  it('(f7) status lines clip to the 256-char chat cap (gwvg A6)', async () => {
    const { CHAT_LIMIT } = require('../src/commands')
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    bot._tickerCtx.step = 'rest'
    bot._tickerCtx.restWhy = 'x'.repeat(400)
    const n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    const reply = bot.chats.slice(n)
    assert.ok(reply.length >= 1 && reply.length <= 3, `1-3 lines, got ${reply.length}`)
    for (const l of reply) assert.ok(l.length <= CHAT_LIMIT, `line is ${l.length} chars`)
    assert.ok(reply[0].endsWith('…'), `clipped line ends with …: ${reply[0].slice(-10)}`)
    assert.ok(reply[0].includes('logs=') && reply[0].includes('home='), `facts survive the clip: ${reply[0].slice(0, 140)}`)
    ticker.destroy()
  })

  it('(f9) healthy bot omits path success and aged-out recoveries (gwvg 01 body-2)', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick()
    const ctx = bot._tickerCtx
    ctx.lastPathStatus = 'success'
    ctx.lastRecover = { action: 'pillar_up', outcome: 'done', at: Date.now() - 10 * 60 * 1000 }
    let n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    let reply = bot.chats.slice(n).join('\n')
    assert.ok(!reply.includes('path='), `no path on a healthy bot: ${reply}`)
    assert.ok(!reply.includes('last recover:'), `aged-out outcome hidden: ${reply}`)
    ctx.lastPathStatus = 'noPath'
    ctx.lastRecover = { action: 'pillar_up', outcome: 'done', at: Date.now() }
    n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    reply = bot.chats.slice(n).join('\n')
    assert.ok(reply.includes('path=noPath'), `abnormal verdict shown: ${reply}`)
    assert.ok(reply.includes('last recover: pillar_up done'), `fresh outcome shown: ${reply}`)
    ticker.destroy()
  })

  it('(f10) order hides the stale work pick (gwvg 01 core-2)', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    await ticker.tick() // gather picked
    const ctx = bot._tickerCtx
    assert.equal(ctx.stepPick.step, 'gather')
    let n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    assert.ok(bot.chats.slice(n).join('\n').includes('by goal-fsm'), 'pick shown for its own step')
    ctx.home = { site: { x: 0, y: 64, z: 0 }, built: true }
    handleChat(bot, ticker, 'Steve', 'come home')
    assert.ok(ctx.comehome, 'order armed')
    n = bot.chats.length
    handleChat(bot, ticker, 'Steve', 'status')
    const reply = bot.chats.slice(n).join('\n')
    assert.ok(reply.includes('coming home'), reply)
    assert.ok(!reply.includes('by goal-fsm'), `stale pick hidden: ${reply}`)
    ticker.destroy()
  })

  it('(f8) status never leaks the brain URL (gwvg A7)', async () => {
    const keep = process.env.BRAIN_URL
    process.env.BRAIN_URL = 'http://' + 'fake-host' + '.invalid:8000/v1/systemone'
    try {
      const bot = workBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      await ticker.tick()
      const n = bot.chats.length
      handleChat(bot, ticker, 'Steve', 'status')
      const bad = /http|:\/\/|\d+\.\d+\.\d+\.\d+/
      for (const l of bot.chats.slice(n)) assert.ok(!bad.test(l), `clean line: ${l}`)
      ticker.destroy()
    } finally {
      if (keep === undefined) delete process.env.BRAIN_URL
      else process.env.BRAIN_URL = keep
    }
  })

  it('(h) work + inShelter + hostile at 5: fight not dispatched', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    bot._tickerCtx.inShelter = true
    try {
      const r = await ticker.tick()
      assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
      assert.equal(bot.calls.setGoal, 0) // no pursuit: the wall stays shut
      assert.equal(bot.attackCalls, 0) // 5 blocks: out of reflex swing range
    } finally {
      ticker.destroy()
    }
  })

  it('(h2) vmzq.30 revmux 01 body-1: committed dig drives on the suppressed tick, no pursuit', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    bot._tickerCtx.inShelter = true
    bot._tickerCtx.step = 'shelter'
    bot._tickerCtx.shelter = { dig: { digs: 1 } }
    const origShelter = BEHAVIOURS.shelter
    let shelterRan = 0
    BEHAVIOURS.shelter = () => { shelterRan++ }
    try {
      const r = await ticker.tick()
      assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
      assert.equal(shelterRan, 1, 'the committed dig drives, no frozen pit')
      assert.equal(bot.calls.setGoal, 0, 'no pursuit')
    } finally {
      BEHAVIOURS.shelter = origShelter
      ticker.destroy()
    }
  })

  it('(h3) vmzq.30 revmux 01 body-1: plain hold drives nothing', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    bot._tickerCtx.inShelter = true
    bot._tickerCtx.step = 'shelter'
    bot._tickerCtx.shelter = { pillared: true }
    const origShelter = BEHAVIOURS.shelter
    let shelterRan = 0
    BEHAVIOURS.shelter = () => { shelterRan++ }
    try {
      const r = await ticker.tick()
      assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
      assert.equal(shelterRan, 0, 'a hold with no dig stays a hold')
    } finally {
      BEHAVIOURS.shelter = origShelter
      ticker.destroy()
    }
  })

  it('(i) sheltered + hostile at 2: reflex still swings', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 2) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    bot._tickerCtx.inShelter = true
    try {
      await ticker.tick()
      assert.ok(bot.attackCalls >= 1) // inside intruder still gets hit
      assert.equal(bot.calls.setGoal, 0) // but no pursuit through the wall
    } finally {
      ticker.destroy()
    }
  })

  it('(j) 33vm: sheltered + zombie inside the interior box: fight dispatched, not shelter-idle', async () => {
    const run = async (zx) => {
      const bot = workBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      bot.entities = { 1: zombie(1, zx) }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      bot._tickerCtx.inShelter = true
      bot._tickerCtx.home = { built: true, site: pos(-1, 64, -1), interior: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 65, z: 3 } } }
      try {
        const r = await ticker.tick()
        return { r, bot }
      } finally {
        ticker.destroy()
      }
    }
    const inside = await run(3.5) // floored x=3: inside the box
    assert.equal(inside.r.decision.action, 'fight')
    assert.ok(inside.bot.calls.setGoal >= 1, 'pursues the intruder')
    const outside = await run(6) // x=6: beyond the wall
    assert.deepEqual(outside.r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.equal(outside.bot.calls.setGoal, 0)
  })

  it('(l) g9cj: intruder fight plans no-dig; outside mob leaves canDig alone', async () => {
    const run = async (zx) => {
      const bot = workBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      bot.entities = { 1: zombie(1, zx) }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      bot._tickerCtx.inShelter = true
      bot._tickerCtx.movements = { canDig: true, allowSprinting: false, allowParkour: true }
      bot._tickerCtx.home = { built: true, site: pos(-1, 64, -1), interior: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 65, z: 3 } } }
      try {
        await ticker.tick()
        return bot._tickerCtx.movements.canDig
      } finally {
        ticker.destroy()
      }
    }
    assert.equal(await run(3.5), false)
    assert.equal(await run(6), true)
    // the tick-start claim keeps no-dig while the flag stands (sticky across resetTick when sheltered)
    const body = require('../src/body')
    const ctx = { inShelter: true, intruderFight: true, movements: { canDig: true, allowSprinting: false, allowParkour: true } }
    body.resetTick(ctx); body.claimBody({}, ctx, 'shelter')
    assert.equal(ctx.movements.canDig, false)
  })

  it('(k) 33vm: a nearer zombie outside the wall does not hide the one inside', async () => {
    const bot = workBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, -1.5), 2: zombie(2, 3.5) } // 1 outside (x=-2), nearer; 2 inside
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    bot._tickerCtx.inShelter = true
    bot._tickerCtx.home = { built: true, site: pos(-1, 64, -1), interior: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 65, z: 3 } } }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight')
      assert.equal(bot._tickerCtx.fightId, 2, 'the intruder, not the nearer mob outside')
    } finally {
      ticker.destroy()
    }
  })

  it('rw4.15: day + sheltered + fight diverts to goal.decide and exits; night still holds', async () => {
    // Prod 2026-10-06: the daytime fight check returned before the goal
    // arbiter — the only place the shelter flag clears at day — and the
    // bot sat 2 h in its hole (six dawns missed).
    const goal = require('../src/goal')
    const run = async (timeOfDay) => {
      const bot = workBot()
      bot.time = { timeOfDay }
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      bot.entities = { 1: zombie(1, 5), 2: zombie(2, -5), 3: zombie(3, 7) } // crowd, no home: no intruder
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
      ticker.work()
      const ctx = bot._tickerCtx
      ctx.inShelter = true
      // A stable running work step: decide short-circuits to it silently.
      const text = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
      ctx.step = 'rest'
      ctx.stepStatus = 'running'
      ctx.goalText = text
      ctx.askedKey = `${text}\nrunning`
      let decideCalls = 0
      let restRan = 0
      const origDecide = goal.decide
      const origRest = BEHAVIOURS.rest
      goal.decide = async (...a) => { decideCalls++; return origDecide(...a) }
      BEHAVIOURS.rest = () => { restRan++ }
      try {
        const r = await ticker.tick()
        return { action: r.decision.action, inShelter: ctx.inShelter, decideCalls, restRan }
      } finally {
        goal.decide = origDecide
        BEHAVIOURS.rest = origRest
        ticker.destroy()
      }
    }
    const day = await run(6000)
    assert.ok(day.decideCalls >= 1, 'day: goal.decide runs')
    assert.equal(day.inShelter, false, 'day: the shelter flag clears')
    assert.equal(day.restRan, 1, 'day: the work step dispatches')
    assert.equal(day.action, 'rest')
    const night = await run(15000)
    assert.equal(night.decideCalls, 0, 'night: the hold keeps decide out')
    assert.equal(night.inShelter, true, 'night: still sheltered')
    assert.equal(night.restRan, 0)
    assert.equal(night.action, 'idle')
  })

  it('rw4.15 revmux 01 body-1: an exiting comehome keeps the doorway guard by day (rw4.18: the legs run, work/fight stay out)', async () => {
    // releaseMeet arms inShelter with the exit legs so fight pursuit cannot
    // preempt the doorway (jr2.3) — the day divert must not clear it and
    // path a work step through the wall. rw4.18: the legs themselves run
    // on the fight tick instead of idling; only the work divert and fight
    // pursuit stay out.
    const bot = workBot()
    bot.time = { timeOfDay: 6000 }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.inShelter = true
    ctx.comehome = { exiting: true, phase: 'open' }
    const origComehome = BEHAVIOURS.comehome
    const origFight = BEHAVIOURS.fight
    let legsRan = 0
    let fightRan = 0
    BEHAVIOURS.comehome = () => { legsRan++ }
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'comehome')
      assert.equal(legsRan, 1, 'the exit legs run on the day fight tick')
      assert.equal(fightRan, 0, 'no pursuit through the doorway (jr2.3)')
      assert.equal(ctx.inShelter, true, 'the doorway guard stands')
      assert.equal(bot.calls.setGoal, 0, 'no work step paths while exiting')
    } finally {
      BEHAVIOURS.comehome = origComehome
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })

  it('rw4.18: a sheltered gocastle without an exiting comehome still idles on fight ticks', async () => {
    // The gocastle walk is A* — from inside it would path the wall, so the
    // hold stays. The real gocastle-from-inside flow arms a comehome exit
    // beside it, and that exit's legs run per the test above.
    const bot = workBot()
    bot.time = { timeOfDay: 6000 }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.inShelter = true
    ctx.gocastle = { phase: 'walk' }
    try {
      const r = await ticker.tick()
      assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
      assert.equal(ctx.inShelter, true, 'the doorway guard stands')
      assert.equal(bot.calls.setGoal, 0, 'no A* from inside the walls')
    } finally {
      ticker.destroy()
    }
  })
})

describe('stateKey', () => {
  const base = { distance_to_player: 12.4, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 0 }
  it('rounds distance to 1 block and covers the flags', () => {
    assert.equal(stateKey(base), stateKey({ ...base, distance_to_player: 12.1 }))
    assert.notEqual(stateKey(base), stateKey({ ...base, distance_to_player: 13.6 }))
    assert.notEqual(stateKey(base), stateKey({ ...base, player_moving: true }))
    assert.notEqual(stateKey(base), stateKey({ ...base, nearby_hostiles: 1 }))
    assert.equal(stateKey({ ...base, distance_to_player: null }), stateKey({ ...base, distance_to_player: undefined }))
  })
})

describe('dispatch table', () => {
  it('routes follow to the follow module and idle to stop', async () => {
    assert.equal(BEHAVIOURS.follow, follow)
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const followTicker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'jev' }), tickMs: 10, idleTickMs: 10 })
    await followTicker.tick()
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.stop, 0)
    const idleBot = mockBot()
    idleBot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    // idle only stops a real path; an empty path must not latch stopPathing
    idleBot.pathfinder.isMoving = () => true
    const idleTicker = createTicker({ bot: idleBot, brain: mockBrain({ action: 'idle', sprint: false, source: 'jev' }), tickMs: 10, idleTickMs: 10 })
    await idleTicker.tick()
    assert.equal(idleBot.calls.setGoal, 0)
    assert.equal(idleBot.calls.stop, 1)
  })

  it('dispatches registered actions through the table, not a hardcoded name', async () => {
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'jev' }), tickMs: 10, idleTickMs: 10 })
      await ticker.tick()
      assert.equal(fightRan, 1)
      assert.equal(bot.calls.stop, 0)
    } finally {
      delete BEHAVIOURS.fight
    }
  })
})

describe('target threading', () => {
  it('reports player_moving=true on tick 2 when the target moved', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const seen = []
    const brain = {
      calls: 0,
      async decide(state) {
        this.calls++
        seen.push({ player_moving: state.player_moving, distance_to_player: state.distance_to_player })
        return { action: 'follow', sprint: false, source: 'jev' }
      }
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    bot.players.Steve.entity.position = pos(14, 64, 0)
    await ticker.tick()
    assert.equal(seen.length, 2)
    assert.equal(seen[0].player_moving, false)
    assert.equal(seen[1].player_moving, true)
  })
})

describe('scout seam', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  function scoutBot() {
    const bot = mockBot()
    bot.registry = { blocksByName: { iron_ore: { id: 15 } } }
    bot.findCalls = 0
    bot.lines = []
    bot.findBlocks = (opts) => { bot.findCalls++; bot.lastOpts = opts; return [pos(4, 60, 1)] }
    bot.blockAt = () => ({ name: 'iron_ore' })
    bot.chat = (line) => { bot.lines.push(line) }
    return bot
  }

  it('creates and ticks the scout when a player is present', async () => {
    const bot = scoutBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.findCalls, 1)
    assert.deepEqual(bot.lines, ['iron_ore x1 at 4 60 1'])
  })

  it('never scans or chats when no player is online', async () => {
    const bot = scoutBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.findCalls, 0)
    assert.deepEqual(bot.lines, [])
  })
})

describe('paused stop', () => {
  let origLog
  let lines
  // silence per-tick decision logs but record them for the no-follow assertion
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  it('stop parks across ticks with a player nearby; follow me resumes', async () => {
    const bot = mockBot()
    bot.registry = { blocksByName: { iron_ore: { id: 15 } } }
    bot.findCalls = 0
    bot.lines = []
    bot.findBlocks = () => { bot.findCalls++; return [pos(4, 60, 1)] }
    bot.blockAt = () => ({ name: 'iron_ore' })
    bot.chat = (line) => { bot.lines.push(line) }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'jev' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setMovements({ allowSprinting: false })
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(brain.calls, 1)
    assert.equal(bot.findCalls, 1)
    assert.deepEqual(bot.lines, ['iron_ore x1 at 4 60 1'])
    // chat 'stop': clear the follow lock and park (moving, so the park stops once)
    bot.pathfinder.isMoving = () => true
    ticker.setFollow('')
    ticker.stop()
    lines.length = 0
    const brainBefore = brain.calls
    const goalsBefore = bot.calls.setGoal
    const stopsBefore = bot.calls.stop
    // scout throttle is 5 s: advance time and offer a new vein so the paused
    // tick must scan again to report it — deleting the scout seam fails here
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0 + 6000
    bot.findBlocks = () => { bot.findCalls++; return [pos(9, 60, 2)] }
    let r1, r2, r3
    try {
      r1 = await ticker.tick()
      r2 = await ticker.tick()
      r3 = await ticker.tick()
    } finally {
      Date.now = realNow
    }
    assert.equal(r1.calledBrain, false)
    assert.equal(r2.calledBrain, false)
    assert.equal(r3.calledBrain, false)
    assert.equal(brain.calls, brainBefore)
    assert.equal(bot.calls.setGoal, goalsBefore)
    // idle dispatched once: the park stopped already, paused ticks add no more stops
    assert.equal(bot.calls.stop, stopsBefore)
    assert.deepEqual(r3.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.ok(lines.every((l) => !l.includes('action=follow')), 'no follow decision while parked')
    assert.ok(bot.findCalls > 1, 'scout keeps scanning while parked')
    assert.ok(bot.lines.some((l) => l.includes('9 60 2')), 'scout reports new veins while parked')
    // chat 'follow me': resume
    ticker.setFollow('Steve')
    lines.length = 0
    await ticker.tick()
    assert.ok(bot.calls.setGoal > goalsBefore)
  })

  it('parked with nobody online scans nothing', async () => {
    const bot = mockBot()
    bot.registry = { blocksByName: { iron_ore: { id: 15 } } }
    bot.findCalls = 0
    bot.findBlocks = () => { bot.findCalls++; return [pos(4, 60, 1)] }
    bot.blockAt = () => ({ name: 'iron_ore' })
    bot.lines = []
    bot.chat = (line) => { bot.lines.push(line) }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.findCalls, 1)
    ticker.setFollow('')
    ticker.stop()
    bot.players = {}
    const before = bot.findCalls
    // advance past the 5 s scout throttle so a scan would fire without the
    // target guard — the assertion must pin the guard, not the throttle
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0 + 6000
    try {
      await ticker.tick()
    } finally {
      Date.now = realNow
    }
    assert.equal(bot.findCalls, before)
  })

  it('stop during the brain await discards the stale follow', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    let resolveBrain
    const brain = {
      calls: 0,
      decide() {
        this.calls++
        return new Promise((resolve) => { resolveBrain = resolve })
      }
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const pending = ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    // chat 'stop' lands while the brain call is in flight
    ticker.setFollow('')
    ticker.stop()
    lines.length = 0
    resolveBrain({ action: 'follow', sprint: false, source: 'jev' })
    const r = await pending
    assert.equal(bot.calls.setGoal, 0)
    assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.ok(lines.every((l) => !l.includes('action=follow')), 'no follow decision after mid-await stop')
  })

})

describe('death/respawn log lines', () => {
  const { deathLine, respawnLine, handleDeath, handleRespawn, createLifecycle } = require('../src/index')
  const { buildState } = require('../src/perception')

  function deadBot() {
    return {
      username: 'IdkBot',
      health: 0,
      food: 10,
      players: {},
      entities: {
        1: { id: 1, type: 'mob', name: 'zombie', position: pos(102, 64, -20) },
      },
      entity: { position: pos(100, 64, -20) },
    }
  }

  it('death line carries health, hostile count and position', () => {
    assert.equal(deathLine(deadBot()), 'death health=0 hostiles=1 at 100 64 -20 nearest=zombie 2.0')
  })

  it('hostile count ignores mobType-only entities (no deprecated fallback)', () => {
    const bot = deadBot()
    bot.entities[2] = { id: 2, type: 'mob', mobType: 'zombie', position: pos(101, 64, -20) }
    assert.equal(buildState(bot, null).nearby_hostiles, 1)
    assert.equal(deathLine(bot), 'death health=0 hostiles=1 at 100 64 -20 nearest=zombie 2.0')
  })

  it('respawn line carries the position', () => {
    const bot = deadBot()
    bot.entity = { position: pos(0, 64, 0) }
    assert.equal(respawnLine(bot), 'respawn at 0 64 0')
  })

  it('respawn prefers spawnPoint: entity position is still the death coords', () => {
    const bot = deadBot() // entity at death coords, spawnPoint at world spawn
    bot.spawnPoint = pos(0, 64, 0)
    assert.equal(respawnLine(bot), 'respawn at 0 64 0')
  })

  it('respawn falls back to entity position, then unknown', () => {
    const noSpawn = deadBot()
    noSpawn.entity = { position: pos(5, 64, 5) }
    assert.equal(respawnLine(noSpawn), 'respawn at 5 64 5')
    const neither = deadBot()
    neither.entity = null
    assert.equal(respawnLine(neither), 'respawn at unknown')
  })

  it('lifecycle pairs death/respawn: lone respawn (dimension change) stays silent', () => {
    const lines = []
    const orig = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      const life = createLifecycle()
      const bot = deadBot()
      bot.spawnPoint = pos(0, 64, 0)
      life.onRespawn(bot) // portal transit, no death before it
      assert.deepEqual(lines, [])
      life.onDeath(bot)
      life.onRespawn(bot)
      assert.deepEqual(lines, [
        'death health=0 hostiles=1 at 100 64 -20 nearest=zombie 2.0',
        'respawn at 0 64 0',
      ])
      life.onRespawn(bot) // second respawn without a death stays silent
      assert.equal(lines.length, 2)
      life.onDeath(bot) // a new death re-arms the respawn line
      life.onRespawn(bot)
      assert.equal(lines.length, 4)
    } finally {
      console.log = orig
    }
  })

  it('death line falls back to the last tick snapshot when the killer is gone', async () => {
    // Prod: creeper exploded on the bot, entity gone at the death tick, live
    // scan prints hostiles=0. The ticker snapshots every tick via meleeReflex.
    const bot = mockBot()
    bot.entities = { 9: { id: 9, name: 'creeper', type: 'mob', position: pos(4, 64, 0) } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const orig = console.log
    console.log = () => {}
    try {
      await ticker.tick() // nobody-online tick: snapshot records the creeper
    } finally {
      console.log = orig
    }
    bot.entities = {} // the killer exploded with the bot
    bot.health = 0
    assert.equal(deathLine(bot), 'death health=0 hostiles=1 at 0 64 0 nearest=creeper 4.0')
  })

  it('handlers print exactly one line each', () => {
    const lines = []
    const orig = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      handleDeath(deadBot())
      const bot = deadBot()
      bot.entity = { position: pos(0, 64, 0) }
      handleRespawn(bot)
    } finally {
      console.log = orig
    }
    assert.deepEqual(lines, [
      'death health=0 hostiles=1 at 100 64 -20 nearest=zombie 2.0',
      'respawn at 0 64 0',
    ])
  })
})

describe('nobody-online leave', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  function leaveBot() {
    const bot = mockBot()
    bot.quitCalls = 0
    bot.quit = () => { bot.quitCalls++ }
    return bot
  }

  it('fires onLeave once after leaveAfterMs of empty ticks; a target resets the streak', async () => {
    const bot = leaveBot()
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 60, onLeave: () => bot.quit('nobody online'), now: () => t })
    const tick = async () => { await ticker.tick(); t += 10 }
    for (let i = 0; i < 6; i++) await tick() // ticks at t=0..50: 50 ms elapsed
    assert.equal(bot.quitCalls, 0)
    await tick() // 7th tick at t=60: grace reached
    assert.equal(bot.quitCalls, 1)
    await tick()
    await tick()
    assert.equal(bot.quitCalls, 1) // latched: quit exactly once
    // a target appearing resets the streak
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    await tick() // seen tick resets the streak
    bot.players = {}
    for (let i = 0; i < 6; i++) await tick()
    assert.equal(bot.quitCalls, 1)
    await tick() // 7th tick again: grace reached
    assert.equal(bot.quitCalls, 2)
  })

  it('fast empty ticks do not expire a slow grace early (wall time, not ticks)', async () => {
    const bot = leaveBot()
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10000, leaveAfterMs: 60000, onLeave: () => bot.quit('nobody online'), now: () => t })
    // fast 1 s cadence (melee reflex swinging on an empty server): 6 ticks = 6 real s
    for (let i = 0; i < 6; i++) { await ticker.tick(); t += 1000 } // t=0..5000: 5 s elapsed
    assert.equal(bot.quitCalls, 0) // tick-counting code quits here (6 x 10 s)
    t += 54000 // 60 real seconds since the first empty tick
    await ticker.tick()
    assert.equal(bot.quitCalls, 1)
  })

  it('leaveAfterMs 0 disables the leave', async () => {
    const bot = leaveBot()
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 0, onLeave: () => bot.quit('nobody online') })
    for (let i = 0; i < 10; i++) await ticker.tick()
    assert.equal(bot.quitCalls, 0)
  })

  it('parseLeaveAfterMs defaults 60000, honours 0, falls back on garbage', async () => {
    const { parseLeaveAfterMs } = require('../src/index')
    assert.equal(parseLeaveAfterMs({}), 60000)
    assert.equal(parseLeaveAfterMs({ BOT_LEAVE_AFTER_MS: '0' }), 0)
    assert.equal(parseLeaveAfterMs({ BOT_LEAVE_AFTER_MS: '5000' }), 5000)
    assert.equal(parseLeaveAfterMs({ BOT_LEAVE_AFTER_MS: 'bogus' }), 60000)
  })

  it('waitForPlayers polls until players.online > 0; refused pings count as empty', async () => {
    const { waitForPlayers } = require('../src/index')
    let calls = 0
    const pingFn = async () => {
      calls++
      if (calls === 1) throw new Error('refused')
      return calls <= 2 ? { players: { online: 0 } } : { players: { online: 2 } }
    }
    await waitForPlayers({ host: 'x', port: 1, pingFn, pollMs: 10 })
    assert.equal(calls, 3)
  })

  it('rearm resets the leave streak after standing down', async () => {
    const bot = leaveBot()
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 60, onLeave: () => bot.quit('nobody online'), now: () => t })
    const tick = async () => { await ticker.tick(); t += 10 }
    for (let i = 0; i < 7; i++) await tick()
    assert.equal(bot.quitCalls, 1)
    ticker.rearm() // a re-check found someone online-but-far: stand down
    for (let i = 0; i < 7; i++) await tick()
    assert.equal(bot.quitCalls, 2) // next full grace period quits again
  })

  it('destroy stops the self re-arm', async () => {
    const delays = []
    const cleared = []
    const origSet = global.setTimeout
    const origClear = global.clearTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return origSet(fn, ms, ...rest) }
    global.clearTimeout = (t, ...rest) => { cleared.push(t); return origClear(t, ...rest) }
    try {
      const bot = leaveBot()
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
      ticker.start() // arms the timer
      assert.deepEqual(delays, [10])
      ticker.destroy() // clears the pending tick, schedules nothing after
      assert.equal(cleared.length, 1)
      await ticker.tick(true) // scheduled tick after destroy: runs, but the destroyed guard blocks re-arm
      assert.deepEqual(delays, [10])
    } finally {
      global.setTimeout = origSet
      global.clearTimeout = origClear
    }
  })

  function connBot() {
    const { EventEmitter } = require('node:events')
    const bot = new EventEmitter()
    bot.username = 'IdkBot'
    bot.players = {}
    bot.entities = {}
    bot.health = 20
    bot.food = 20
    bot.entity = { position: pos(0, 64, 0) }
    // real registry: Movements walks blocks/items/biomes via prismarine-*
    bot.registry = require('minecraft-data')('1.21.1')
    bot.pathfinder = {
      isMoving: () => false,
      stop: () => {},
      setGoal: () => {},
      setMovements: (m) => { bot.movements = m },
    }
    bot.loadPlugin = () => {}
    bot.quitCalls = 0
    bot.quit = (reason) => { bot.quitCalls++; bot.emit('end', reason || 'quit') }
    bot.chat = () => {}
    return bot
  }

  it('runOnce own quit resolves without exiting; unexpected end exits', async () => {
    const { runOnce } = require('../src/index')
    const realExit = process.exit
    let exits = 0
    process.exit = () => { exits++; throw new Error('exit') }
    try {
      // own quit: empty server, one grace tick, confirm ping empty -> quit -> resolve
      const bot = connBot()
      const p = runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 10, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      })
      bot.emit('spawn')
      await Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('runOnce never resolved')), 2000))])
      assert.equal(bot.quitCalls, 1)
      assert.equal(exits, 0)
      // hidden sample (hide-online-players): online==1 with an empty or
      // missing sample while connected is us — quit, not re-arm. Pins the
      // confirmLeave selfConnected wiring (revmux 01 major-1, 02 minor-1):
      // without it the streak re-arms and runOnce never resolves.
      for (const res of [{ players: { online: 1, sample: [] } }, { players: { online: 1 } }]) {
        const b = connBot()
        const pHidden = runOnce({
          host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
          brain: mockBrain(), leaveAfterMs: 10, followName: '',
          createBot: () => b, pingFn: async () => res,
        })
        b.emit('spawn')
        await Promise.race([pHidden, new Promise((_, reject) => setTimeout(() => reject(new Error('runOnce never resolved')), 2000))])
        assert.equal(b.quitCalls, 1)
        assert.equal(exits, 0)
      }
      // unexpected end with no quit: fatal exit, no resolve
      const bot2 = connBot()
      let resolved = false
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 60000, followName: '',
        createBot: () => bot2, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => { resolved = true }, () => { resolved = true })
      assert.throws(() => bot2.emit('end', 'boom'), /exit/)
      assert.equal(exits, 1)
      assert.equal(resolved, false)
      assert.equal(bot2.quitCalls, 0)

      // stand-down: a player online-but-far re-arms every grace period, never quits
      const bot3 = connBot()
      let pings = 0
      let resolved3 = false
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 10, followName: '',
        createBot: () => bot3,
        pingFn: async () => { pings++; return { players: { online: 1, sample: [{ name: 'Steve' }] } } },
      }).then(() => { resolved3 = true }, () => { resolved3 = true })
      bot3.emit('spawn')
      // Wait for repeated re-arms, not a fixed sleep: under scheduling
      // skew (cold first run + competing suites) fewer than 3 grace pings
      // fit a fixed 150 ms window (idkcraft-m1y). The cap only trips if
      // re-arming itself stops, never on a slow box.
      const deadline = Date.now() + 5000
      while (pings < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(bot3.quitCalls, 0) // stood down: still on the "server"
      assert.ok(pings >= 3, `re-armed every grace period (pings=${pings})`)
      assert.equal(resolved3, false)
      assert.equal(exits, 1) // no fatal exit from standing down
      // runOnce stays pending by design here (no quit, no end); its timers
      // are unref'd so the suite still exits cleanly.
    } finally {
      process.exit = realExit
    }
  })

  it('runOnce works on first spawn only without BOT_FOLLOW', async () => {
    const { runOnce } = require('../src/index')
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      // No follow target: first spawn enters work mode, so ticks log goal
      // steps. Emptying the roster afterwards lets the bot quit itself
      // (ticker destroyed: silent for the rest of the file).
      const bot = connBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      let done = false
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 10, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => { done = true }, () => { done = true })
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 60))
      assert.ok(lines.some((l) => l.includes('goal step=gather')), 'work mode entered on first spawn')
      bot.players = {}
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(done, true) // quit itself, ticker destroyed
      // Pinned follow target: no work mode — brain follow decides instead.
      const lines2 = []
      console.log = (l) => { lines2.push(String(l)) }
      const bot2 = connBot()
      bot2.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      let done2 = false
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
        brain: mockBrain(), leaveAfterMs: 10, followName: 'Steve',
        createBot: () => bot2, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => { done2 = true }, () => { done2 = true })
      bot2.emit('spawn')
      await new Promise((r) => setTimeout(r, 60))
      assert.ok(!lines2.some((l) => l.includes('goal step=')), 'no work mode with BOT_FOLLOW')
      assert.ok(lines2.some((l) => l.includes('action=follow')), 'brain follow decides instead')
      bot2.players = {}
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(done2, true)
    } finally {
      console.log = origLog
    }
  })

  it('runOnce wires spawn kit log and playerLeft lead clear', async () => {
    const { runOnce } = require('../src/index')
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    const realExit = process.exit
    let exits = 0
    process.exit = () => { exits++ }
    try {
      const bot = connBot()
      let done = false
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 100000,
        brain: mockBrain(), leaveAfterMs: 0, followName: '',
        createBot: () => bot,
        pingFn: async () => ({ players: { online: 1, sample: [{ name: 'Steve' }] } }),
      }).then(() => { done = true }, () => { done = true })
      // merge seam (3nt.11 x 3nt.14): both listeners must survive in runOnce
      assert.equal(bot.listenerCount('playerLeft'), 1, 'playerLeft wired')
      // +2: trackPlaced and installPlaceTiming defer their wraps to the first
      // spawn (idkcraft-dahd, idkcraft-6x7.11)
      assert.equal(bot.listeners('spawn').length, 4, 'spawn kit tap wired')
      const raw = bot.placeBlock
      bot.placeBlock = async () => {}
      bot.emit('spawn')
      assert.ok(bot._placedTrackInstalled && bot._placeTimingInstalled, 'both wraps installed on spawn')
      bot.placeBlock = raw
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      assert.ok(lines.some((l) => l.includes('spawned as IdkBot')), 'spawn logged')
      assert.ok(lines.some((l) => l.includes('kit scaffold=')), 'spawn logs kit line')
      bot.emit('playerLeft', { username: 'Steve' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(exits, 0)
      assert.equal(done, false)
    } finally {
      console.log = origLog
      process.exit = realExit
    }
  })

  it('declares minecraft-protocol (required directly by src/index.js)', () => {
    const pkg = require('../package.json')
    assert.ok(pkg.dependencies && pkg.dependencies['minecraft-protocol'], 'direct require must be declared')
    assert.equal(typeof require('minecraft-protocol').ping, 'function')
  })

  it('playersOccupied ignores our own just-quit ghost, joins on anyone else', async () => {
    const { playersOccupied, waitForPlayers } = require('../src/index')
    const ghost = { players: { online: 1, sample: [{ name: 'IdkBot' }] } }
    assert.equal(playersOccupied(ghost, 'IdkBot'), false)
    assert.equal(playersOccupied({ players: { online: 1, sample: [{ name: 'Steve' }] } }, 'IdkBot'), true)
    assert.equal(playersOccupied({ players: { online: 2, sample: [{ name: 'IdkBot' }] } }, 'IdkBot'), true)
    assert.equal(playersOccupied({ players: { online: 0 } }, 'IdkBot'), false)
    // ghost first, then truly empty, then a real player: polls past the ghost
    const seq = [ghost, { players: { online: 0 } }, { players: { online: 1, sample: [{ name: 'Steve' }] } }]
    let calls = 0
    await waitForPlayers({ host: 'x', port: 1, pingFn: async () => seq[calls++], pollMs: 10, username: 'IdkBot' })
    assert.equal(calls, 3)
  })

  it('playersOccupied with selfConnected treats online==1 as us (hidden sample)', async () => {
    const { playersOccupied } = require('../src/index')
    // confirmLeave pings while connected: the one online is the bot itself,
    // with or without a visible sample (hide-online-players empties it).
    assert.equal(playersOccupied({ players: { online: 1 } }, 'IdkBot', true), false)
    assert.equal(playersOccupied({ players: { online: 1, sample: [] } }, 'IdkBot', true), false)
    assert.equal(playersOccupied({ players: { online: 1, sample: [{ name: 'IdkBot' }] } }, 'IdkBot', true), false)
    assert.equal(playersOccupied({ players: { online: 2 } }, 'IdkBot', true), true)
    assert.equal(playersOccupied({ players: { online: 0 } }, 'IdkBot', true), false)
    // without selfConnected the old default stands: empty sample = occupied.
    assert.equal(playersOccupied({ players: { online: 1 } }, 'IdkBot'), true)
    assert.equal(playersOccupied({ players: { online: 1, sample: [] } }, 'IdkBot'), true)
  })

  it('waitForPlayers settles an ambiguous hidden-sample ghost, joins a real lone player', async () => {
    const { waitForPlayers } = require('../src/index')
    // ghost (online==1, empty sample) that clears on the settle re-ping:
    // keep waiting, then join Steve.
    const seq = [{ players: { online: 1, sample: [] } }, { players: { online: 0 } }, { players: { online: 1, sample: [{ name: 'Steve' }] } }]
    let calls = 0
    await waitForPlayers({ host: 'x', port: 1, pingFn: async () => seq[calls++], pollMs: 10, username: 'IdkBot' })
    assert.equal(calls, 3)
    // still ambiguous after the settle: a real lone player — join.
    let loneCalls = 0
    await waitForPlayers({ host: 'x', port: 1, pingFn: async () => { loneCalls++; return { players: { online: 1 } } }, pollMs: 10, username: 'IdkBot' })
    assert.equal(loneCalls, 2)
  })
})

describe('lead override', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function leadBot() {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    bot.chat = (line) => { bot.lines = bot.lines || []; bot.lines.push(line) }
    return bot
  }

  it('lead order overrides follow and logs action=lead', async () => {
    const bot = leadBot()
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'lead')
    assert.equal(bot.calls.setGoal, 1)
    assert.ok(lines.some((l) => l.includes('action=lead')), 'log keeps format with action=lead')
    assert.ok(!lines.some((l) => l.includes('action=follow')), 'brain follow not dispatched')
  })

  it('fight still preempts a lead order', async () => {
    const bot = leadBot()
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    // fight with no hostile shadows the player (bodyguard fallback): a goal,
    // but never the lead key.
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'fight')
    assert.ok(lines.some((l) => l.includes('action=fight')))
    assert.ok(!lines.some((l) => l.includes('action=lead')))
  })

  it('stop clears the lead order and parks', async () => {
    const bot = leadBot()
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    await ticker.tick()
    assert.equal(bot.calls.setGoal, 1)
    ticker.setFollow('')
    ticker.stop()
    lines.length = 0
    const goalsBefore = bot.calls.setGoal
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'idle')
    assert.equal(bot.calls.setGoal, goalsBefore) // parked: no fresh lead goal
    assert.ok(lines.every((l) => !l.includes('action=lead')))
  })

  it('follow me clears the lead order', async () => {
    const bot = leadBot()
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    ticker.setFollow('Steve') // chat 'follow me' path
    lines.length = 0
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
    assert.ok(!lines.some((l) => l.includes('action=lead')))
  })

  it('arrival clears the order so follow resumes next tick', async () => {
    const bot = leadBot()
    bot.entity.position = pos(9, 64, 0)
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(9) } }
    const seq = [
      { action: 'follow', sprint: false, source: 'stub' },
      { action: 'follow', sprint: false, source: 'stub' },
    ]
    let i = 0
    const brain = { calls: 0, async decide() { this.calls++; return seq[Math.min(i++, seq.length - 1)] } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'lead')
    assert.ok((bot.lines || []).some((l) => l === 'here: coal at 10 64 0; following you again'))
    lines.length = 0
    const r2 = await ticker.tick()
    assert.equal(r2.decision.action, 'follow') // order gone: brain owns the body again
    assert.ok(!lines.some((l) => l.includes('action=lead')))
  })
})

describe('find me chat sets the lead order', () => {
  const { handleChat } = require('../src/index')
  const { findNearest } = require('../src/behaviours/scout')

  it('find me <block> replies and sets ctx.lead when found', () => {
    const bot = mockBot()
    bot.username = 'IdkBot'
    bot.chat = (line) => { bot.lines = bot.lines || []; bot.lines.push(line) }
    bot.registry = { blocksByName: { coal_ore: { id: 16 } } }
    bot.entity = { position: pos(0, 64, 0) }
    bot.findBlocks = () => [pos(10, 60, 0)]
    bot.blockAt = () => ({ name: 'coal_ore' })
    let order = null
    const ticker = { setLead: (o) => { order = o }, setFollow: () => {}, stop: () => {} }
    // sanity: the fixture really resolves, or the assertion pins nothing
    const res = findNearest(bot, 'coal')
    assert.ok(res && res.position)
    handleChat(bot, ticker, 'Steve', 'find me coal')
    assert.ok(order, 'lead order not set')
    assert.equal(order.name, 'coal_ore')
    assert.equal(order.pos.x, 10)
    assert.equal(order.by, 'Steve')
    assert.deepEqual(bot.lines, ['leading you to coal_ore, 11 blocks, follow me'])
  })

  it('find me with nothing nearby sets no order', () => {
    const bot = mockBot()
    bot.username = 'IdkBot'
    bot.chat = () => {}
    bot.registry = { blocksByName: { coal_ore: { id: 16 } } }
    bot.entity = { position: pos(0, 64, 0) }
    bot.findBlocks = () => []
    let order = 'unset'
    const ticker = { setLead: (o) => { order = o }, setFollow: () => {}, stop: () => {} }
    handleChat(bot, ticker, 'Steve', 'find me coal')
    assert.equal(order, 'unset')
  })
})

describe('lead after stop', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  it('find me after stop unparks and leads', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    bot.chat = () => {}
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('')
    ticker.stop()
    await ticker.tick() // parked
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) }) // find me path
    lines.length = 0
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'lead')
    assert.ok(lines.some((l) => l.includes('action=lead')))
    assert.equal(bot.calls.setGoal, 1)
  })
})

describe('lead hygiene: death, respawn, and player left', () => {
  const { handlePlayerLeft, createLifecycle, TARGET_GONE_TICKS } = require('../src/index')

  it('bot death clears lead order', async () => {
    const bot = mockBot()
    const chats = []
    bot.chat = (line) => chats.push(line)
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    const life = createLifecycle(ticker)
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    life.onDeath(bot)
    assert.equal(ticker.getLead(), null)
    assert.deepEqual(chats, ['following you again'])
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
  })

  it('bot respawn clears lead order', async () => {
    const { handleRespawn } = require('../src/index')
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    const life = createLifecycle(ticker)
    life.onDeath(bot)
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    life.onRespawn(bot)
    assert.equal(ticker.getLead(), null)

    // handleRespawn directly
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    handleRespawn(bot, ticker)
    assert.equal(ticker.getLead(), null)
  })


  it('dead bot (health <= 0) clears lead order during tick', async () => {
    const bot = mockBot()
    bot.health = 0
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    const r = await ticker.tick()
    assert.equal(ticker.getLead(), null)
    assert.notEqual(r.decision.action, 'lead')
  })

  it('playerLeft clears lead order when followed player leaves', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: 'Steve' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    handlePlayerLeft(bot, ticker, { username: 'Steve' })
    assert.equal(ticker.getLead(), null)
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
  })

  it('playerLeft does not clear lead order when another player leaves', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: 'Steve' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    handlePlayerLeft(bot, ticker, { username: 'Alex' })
    assert.ok(ticker.getLead())
  })

  it('playerLeft clears lead order when followName is empty', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: '' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    handlePlayerLeft(bot, ticker, { username: 'Steve' })
    assert.equal(ticker.getLead(), null)
  })

  it('target gone for N ticks clears lead order', async () => {
    const bot = mockBot()
    const chats = []
    bot.chat = (line) => chats.push(line)
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: 'Steve' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    // Player disappears
    bot.players = {}
    for (let t = 0; t < TARGET_GONE_TICKS - 1; t++) {
      await ticker.tick()
      assert.ok(ticker.getLead(), `lead cleared early at tick ${t}`)
    }
    await ticker.tick() // Nth tick
    assert.equal(ticker.getLead(), null)
    assert.deepEqual(chats, ['giving up on coal; following you again'])
  })

  it('target returning before N ticks resets the target-gone counter', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: 'Steve' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    // Disappear for half the budget
    bot.players = {}
    for (let t = 0; t < Math.floor(TARGET_GONE_TICKS / 2); t++) {
      await ticker.tick()
    }
    assert.ok(ticker.getLead())
    // Reappear for 1 tick
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    await ticker.tick()
    assert.ok(ticker.getLead())
    // Disappear again for half the budget -> should NOT expire yet
    bot.players = {}
    for (let t = 0; t < Math.floor(TARGET_GONE_TICKS / 2); t++) {
      await ticker.tick()
    }
    assert.ok(ticker.getLead(), 'target gone counter was not reset when target reappeared')
  })

  it('unrelated player leaving in nearest-player mode does not clear order issued by another player', async () => {
    const bot = mockBot()
    bot.players = {
      Steve: { username: 'Steve', entity: playerEntity(2) },
      Alex: { username: 'Alex', entity: playerEntity(10) }
    }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: '' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0), by: 'Steve' })
    assert.ok(ticker.getLead())
    handlePlayerLeft(bot, ticker, { username: 'Alex' })
    assert.ok(ticker.getLead(), 'unrelated leaver cleared the lead order')
    handlePlayerLeft(bot, ticker, { username: 'Steve' })
    assert.equal(ticker.getLead(), null)
  })

  it('setLead resets leadTargetGone counter', async () => {
    const bot = mockBot()
    bot.players = {}
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10, followName: 'Steve' })
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    for (let t = 0; t < Math.floor(TARGET_GONE_TICKS / 2); t++) {
      await ticker.tick()
    }
    ticker.setLead({ name: 'diamond_ore', pos: pos(20, 64, 0) })
    for (let t = 0; t < Math.floor(TARGET_GONE_TICKS / 2); t++) {
      await ticker.tick()
    }
    assert.ok(ticker.getLead(), 'setLead did not reset leadTargetGone')
  })
})

describe('melee reflex', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function reflexBot() {
    const bot = mockBot()
    bot.attackCalls = 0
    bot.lookAtCalls = 0
    bot.equipCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => { bot.lookAtCalls++ }
    bot._items = [{ name: 'iron_sword' }]
    bot.inventory = { items: () => bot._items }
    bot.equip = () => { bot.equipCalls++ }
    return bot
  }

  function zombie(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  const reflexLines = () => lines.filter((l) => l.includes('reflex swing'))

  it('swings when the brain answers follow with a zombie at 1 block', async () => {
    const bot = reflexBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 1) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow') // brain still owns the body
    assert.equal(bot.attackCalls, 1) // ...while the arm swings anyway
    assert.deepEqual(reflexLines(), ['reflex swing zombie'])
  })

  it('does not swing when the zombie is at 5 blocks', async () => {
    const bot = reflexBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
    assert.equal(bot.attackCalls, 0)
    assert.deepEqual(reflexLines(), [])
  })

  it('swings with nobody online (spawn defence)', async () => {
    const bot = reflexBot()
    bot.entities = { 1: zombie(1, 1) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.equal(bot.attackCalls, 1)
    assert.deepEqual(reflexLines(), ['reflex swing zombie'])
  })

  it('swings every tick but logs and equips once per target', async () => {
    const bot = reflexBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 1) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve)) // gear batches are chained
    assert.equal(bot.attackCalls, 2)
    assert.deepEqual(reflexLines(), ['reflex swing zombie'])
    assert.equal(bot.equipCalls, 1)
    bot.entities = { 2: zombie(2, 1) } // new mob walks up
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.attackCalls, 3)
    assert.deepEqual(reflexLines(), ['reflex swing zombie', 'reflex swing zombie'])
    assert.equal(bot.equipCalls, 2)
  })
})

describe('creeper flee reflex', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => { console.log = origLog })

  function creeperBot() {
    const bot = mockBot()
    bot.attackCalls = 0
    bot.lookAtCalls = 0
    bot.equipCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => { bot.lookAtCalls++ }
    bot._items = [{ name: 'iron_sword' }]
    bot.inventory = { items: () => bot._items }
    bot.equip = () => { bot.equipCalls++ }
    return bot
  }

  function creeper(id, x) {
    return { id, name: 'creeper', type: 'mob', position: pos(x, 64, 0), height: 1.7 }
  }

  function zombieAt(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  const fleeLines = () => lines.filter((l) => l.includes('reflex flee creeper'))

  it('creeper at 4 blocks: away GoalNear, no swing, no brain call', async () => {
    const bot = creeperBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 9: creeper(9, 4) }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'stub' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'flee')
    assert.equal(r.decision.source, 'reflex')
    assert.equal(r.calledBrain, false)
    assert.equal(brain.calls, 0)
    assert.equal(bot.calls.setGoal, 1)
    const goal = bot.calls.goals[0]
    assert.equal(goal.constructor.name, 'GoalNear')
    assert.equal(goal.x, -6) // from (0,64,0) away from the creeper at x=4
    assert.equal(goal.y, 64)
    assert.equal(bot.attackCalls, 0) // never hit a creeper (explosion near the player)
    assert.deepEqual(fleeLines(), ['reflex flee creeper dist=4.0'])

    // Climbing out: moving along, no re-issue, distance grows, still fleeing.
    bot.entity.position = pos(-2, 64, 0)
    bot.pathfinder.isMoving = () => true
    const r2 = await ticker.tick()
    assert.equal(r2.decision.action, 'flee')
    assert.equal(bot.calls.setGoal, 1)
    assert.ok(bot.entity.position.distanceTo(bot.entities[9].position) > 4)
    assert.deepEqual(fleeLines(), ['reflex flee creeper dist=4.0']) // logged once per creeper
  })

  it('inShelter inside the home box: creeper at 5 blocks does not flee (rqdj); open-air shelter or no shelter still flees', () => {
    const { fleeReflex } = require('../src/reflexes')
    const home = { interior: { min: { x: -3, y: 64, z: -2 }, max: { x: 3, y: 65, z: 2 } } }
    const bot = creeperBot()
    bot.entities = { 9: creeper(9, 5) }
    assert.equal(fleeReflex(bot, { inShelter: true, home }), false)
    assert.equal(bot.calls.setGoal, 0)
    assert.ok(fleeReflex(bot, { inShelter: false, home }))
    assert.equal(bot.calls.setGoal, 1)
    bot.entity.position = pos(20, 64, 0) // night pillar / ground hold outside the box
    bot.entities = { 9: creeper(9, 25) }
    assert.ok(fleeReflex(bot, { inShelter: true, home }))
    assert.equal(bot.calls.setGoal, 2)
  })

  it('creeper beyond 6 blocks: normal follow dispatch, brain called', async () => {
    const bot = creeperBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 9: creeper(9, 10) }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'stub' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'follow')
    assert.equal(r.calledBrain, true)
    assert.equal(bot.calls.setGoal, 1)
    assert.equal(bot.calls.goals[0].constructor.name, 'GoalFollow')
    assert.deepEqual(fleeLines(), [])
  })

  it('fleeing with nobody online ticks fast (no 10 s idle cadence)', async () => {
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = creeperBot()
      bot.entities = { 9: creeper(9, 4) } // no players: nobody online
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 111, idleTickMs: 222 })
      await ticker.tick(true) // scheduled tick
      assert.deepEqual(delays, [111]) // fast re-arm while fleeing, not 222
      assert.equal(bot.calls.setGoal, 1)
    } finally {
      global.setTimeout = orig
    }
  })

  it('fleeing while parked ticks fast and keeps the away goal', async () => {
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = creeperBot()
      bot.entities = { 9: creeper(9, 4) } // no players: parked with nobody online
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 111, idleTickMs: 222 })
      ticker.stop() // park
      const r = await ticker.tick(true) // scheduled tick
      assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
      assert.deepEqual(delays, [111]) // fast re-arm while fleeing, not 222
      assert.equal(bot.calls.setGoal, 1)
      assert.equal(bot.calls.goals[0].constructor.name, 'GoalNear')
      assert.equal(bot.calls.goals[0].x, -6)
    } finally {
      global.setTimeout = orig
    }
  })

  it('zombie in reach plus creeper near: arm swings, body flees', async () => {
    const bot = creeperBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombieAt(1, 1), 9: creeper(9, 4) }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'flee') // body leaves even though the brain says fight
    assert.equal(bot.attackCalls, 1) // ...while the arm still hits the zombie
    assert.deepEqual(lines.filter((l) => l.includes('reflex swing')), ['reflex swing zombie'])
    assert.deepEqual(fleeLines(), ['reflex flee creeper dist=4.0'])
  })
})

describe('melee reflex cadence with nobody online', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  function pos2(x, y, z) {
    const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone() { return pos2(p.x, p.y, p.z) } }
    return p
  }

  it('ticks fast while swinging solo, slow once the mob is gone', async () => {
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = mockBot()
      bot.attack = () => { bot.attackCalls = (bot.attackCalls || 0) + 1 }
      bot.lookAt = () => {}
      const zp = pos2(1, 64, 0)
      zp.offset = (ox, oy, oz) => pos2(zp.x + ox, zp.y + oy, zp.z + oz)
      bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: zp, height: 1.95 } }
      const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 111, idleTickMs: 222 })
      await ticker.tick(true) // scheduled tick
      assert.equal(bot.attackCalls, 1)
      assert.deepEqual(delays, [111]) // swinging: fast, not the 10 s idle poll
      delete bot.entities[1] // mob dies
      await ticker.tick(true) // scheduled tick
      assert.deepEqual(delays, [111, 222]) // nothing in reach: back to slow
    } finally {
      global.setTimeout = orig
    }
  })
})

describe('melee reflex with two hostiles (one swing per tick)', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  function mob(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  it('reflex on the newcomer plus fight on the sticky incumbent is still one attack', async () => {
    const bot = mockBot()
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(30) } }
    bot.entities = { 1: mob(1, 2.5) } // incumbent, in swing reach
    // the dispatch-table test above deletes BEHAVIOURS.fight: restore it so
    // action=fight really dispatches (otherwise this test pins nothing).
    BEHAVIOURS.fight = require('../src/behaviours/fight')
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'fight', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.attackCalls, 1) // reflex + fight agree on the target: one swing
    bot.entities = { 1: mob(1, 2.5), 2: mob(2, 2.0) } // newcomer nearer, inside the 2-block sticky margin
    await ticker.tick()
    // reflex hits the nearest (2) while fight holds the incumbent (1):
    // the arm still swings exactly once.
    assert.equal(bot.attackCalls, 2)
  })
})

describe('melee reflex while parked', () => {
  let origLog
  beforeEach(() => {
    origLog = console.log
    console.log = () => {}
  })
  afterEach(() => { console.log = origLog })

  it('stop parks the body but the arm still swings, with no brain call', async () => {
    const bot = mockBot()
    bot.attackCalls = 0
    bot.attack = () => { bot.attackCalls++ }
    bot.lookAt = () => {}
    const zp = pos(1, 64, 0)
    zp.offset = (ox, oy, oz) => pos(zp.x + ox, zp.y + oy, zp.z + oz)
    bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: zp, height: 1.95 } }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain({ action: 'follow', sprint: false, source: 'laya' })
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('')
    ticker.stop()
    const r = await ticker.tick()
    assert.deepEqual(r.decision, { action: 'idle', sprint: false, source: 'local-idle' })
    assert.equal(r.calledBrain, false)
    assert.equal(bot.attackCalls, 1)
    assert.equal(bot.calls.setGoal, 0) // parked: no body goal issued
  })
})

describe('kit inventory log line', () => {
  const { kitLine } = require('../src/index')

  function kitBot(items) {
    return { inventory: { items: () => items } }
  }

  it('counts cobblestone 64 + dirt 3 as scaffold=67 with pickaxe and sword', () => {
    const bot = kitBot([
      { name: 'cobblestone', count: 64 },
      { name: 'dirt', count: 3 },
      { name: 'iron_pickaxe', count: 1 },
      { name: 'iron_sword', count: 1 },
    ])
    assert.equal(kitLine(bot), 'kit scaffold=67 pickaxe=yes sword=yes food=0')
  })

  it('ignores non-scaffolding blocks and reports missing tools as no', () => {
    const bot = kitBot([
      { name: 'stone', count: 64 },
      { name: 'iron_sword', count: 1 },
    ])
    assert.equal(kitLine(bot), 'kit scaffold=0 pickaxe=no sword=yes food=0')
  })

  it('reports sword=no when other items are present but no sword', () => {
    const bot = kitBot([
      { name: 'cobblestone', count: 10 },
      { name: 'iron_pickaxe', count: 1 },
    ])
    assert.equal(kitLine(bot), 'kit scaffold=10 pickaxe=yes sword=no food=0')
  })

  it('counts bread and other edibles as food count', () => {
    const bot = kitBot([
      { name: 'bread', count: 64 },
      { name: 'cooked_beef', count: 16 },
      { name: 'iron_sword', count: 1 },
    ])
    assert.equal(kitLine(bot), 'kit scaffold=0 pickaxe=no sword=yes food=80')
  })

  it('counts safe raw meat as food, raw chicken as none (vmzq.34)', () => {
    const bot = kitBot([
      { name: 'beef', count: 3 },
      { name: 'mutton', count: 2 },
      { name: 'chicken', count: 9 },
      { name: 'iron_sword', count: 1 },
    ])
    assert.equal(kitLine(bot), 'kit scaffold=0 pickaxe=no sword=yes food=5')
  })

  it('empty inventory still prints zeros', () => {
    assert.equal(kitLine(kitBot([])), 'kit scaffold=0 pickaxe=no sword=no food=0')
  })

  it('missing inventory still prints zeros instead of throwing', () => {
    assert.equal(kitLine({}), 'kit scaffold=0 pickaxe=no sword=no food=0')
    assert.equal(kitLine({ inventory: { items: () => { throw new Error('not ready') } } }), 'kit scaffold=0 pickaxe=no sword=no food=0')
  })
})

describe('eat reflex', () => {
  let origLog
  let lines
  // Every tick() arms an unref'd 10 ms re-tick timer. A ticker left alive
  // re-ticks after its test ends and its late 'eat bread' line lands in the
  // next test's console capture (flake under load). Track and destroy.
  const tickers = []
  function eatTicker(opts) {
    const ticker = createTicker(opts)
    tickers.push(ticker)
    return ticker
  }
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (line) => { lines.push(String(line)) }
  })
  afterEach(() => {
    console.log = origLog
    for (const ticker of tickers.splice(0)) ticker.destroy()
  })

  function eatBot({ food = 12, items = [{ name: 'bread', count: 16 }] } = {}) {
    const bot = mockBot()
    bot.food = food
    bot._items = items
    bot.inventory = { items: () => bot._items }
    bot.consumeCalls = 0
    bot.equipCalls = []
    bot.equip = async (item, dest) => { bot.equipCalls.push({ item, dest }) }
    bot.consume = async () => { bot.consumeCalls++ }
    return bot
  }

  function zombie(id, x) {
    const p = pos(x, 64, 0)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  const eatLines = () => lines.filter((l) => l.startsWith('eat '))

  it('food 12 + bread in inventory -> consume called once and not again while in flight', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    let resolveConsume
    bot.consume = () => {
      bot.consumeCalls++
      return new Promise((resolve) => { resolveConsume = resolve })
    }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })

    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), []) // in flight: logged only after meal completes
    assert.equal(bot.equipCalls.length, 1)
    assert.equal(bot.equipCalls[0].dest, 'hand')
    assert.equal(bot.equipCalls[0].item.name, 'bread')

    // Second tick while consume is still in flight: must not call consume again
    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), [])

    // Complete consume
    resolveConsume()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(eatLines(), ['eat bread food=12'])

    // Third tick: consume completed, so it can eat again
    await ticker.tick()
    assert.equal(bot.consumeCalls, 2)
  })

  it('destroyed ticker never re-ticks (no eat after test end)', async () => {
    // Regression: the unref'd 10 ms re-tick timer outlives the test and its
    // late 'eat bread' line lands in the next test's capture (flake under
    // load). destroy() must disarm it.
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)
    ticker.start() // arm the re-tick timer (manual ticks arm nothing)
    ticker.destroy() // disarm it
    await new Promise((resolve) => setTimeout(resolve, 30)) // past the 10 ms re-tick
    assert.equal(bot.consumeCalls, 1)
  })

  it('food 18 -> not called', async () => {
    const bot = eatBot({ food: 18, items: [{ name: 'bread', count: 16 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.consumeCalls, 0)
    assert.deepEqual(eatLines(), [])
  })

  it('hostile at 1 block -> not called (fists first)', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 1) }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.consumeCalls, 0)
    assert.deepEqual(eatLines(), [])
  })

  it('hostile at 5 blocks -> consume called', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat bread food=12'])
  })

  it('no edible food in inventory -> not called', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'cobblestone', count: 64 }, { name: 'iron_sword', count: 1 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.consumeCalls, 0)
    assert.deepEqual(eatLines(), [])
  })

  it('consumes other supported edible items (cooked_beef)', async () => {
    const bot = eatBot({ food: 14, items: [{ name: 'cooked_beef', count: 5 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat cooked_beef food=14'])
  })

  it('eats safe raw meat (beef) at hunger 17 when nothing better is on hand (vmzq.34)', async () => {
    const bot = eatBot({ food: 17, items: [{ name: 'beef', count: 3 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat beef food=17'])
  })

  it('prefers cooked over raw even when raw comes first in inventory (vmzq.34)', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'porkchop', count: 2 }, { name: 'cooked_beef', count: 5 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat cooked_beef food=12'])
  })

  it('raw chicken alone is not eaten (hunger risk stays out, vmzq.34)', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'chicken', count: 4 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    assert.equal(bot.consumeCalls, 0)
    assert.deepEqual(eatLines(), [])
  })

  it('re-equips gear after consume finishes', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }, { name: 'iron_sword', count: 1 }] })
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    const handEquips = bot.equipCalls.filter((c) => c.dest === 'hand')
    assert.ok(handEquips.length >= 2)
    assert.equal(handEquips[0].item.name, 'bread')
    assert.equal(handEquips[1].item.name, 'iron_sword')
  })

  it('consume failure/rejection resets in-flight state and restores gear', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }, { name: 'iron_sword', count: 1 }] })
    let call = 0
    bot.consume = async () => {
      call++
      if (call === 1) throw new Error('consume interrupted')
    }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(call, 1)
    // Sword was restored in finally despite consume throwing
    const handEquips = bot.equipCalls.filter((c) => c.dest === 'hand')
    assert.ok(handEquips.length >= 2)
    assert.equal(handEquips[handEquips.length - 1].item.name, 'iron_sword')

    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(call, 2)
  })

  it('installs equip guard lazily when bot.equip is assigned after createTicker', async () => {
    const bot = mockBot()
    bot.food = 12
    bot.inventory = { items: () => [{ name: 'bread', count: 16 }, { name: 'iron_sword', count: 1 }] }
    delete bot.equip
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })

    bot.equipCalls = []
    bot.equip = (item, dest) => { bot.equipCalls.push({ item, dest }); return Promise.resolve() }
    let resolveConsume
    bot.consume = () => {
      bot.consumeCalls = (bot.consumeCalls || 0) + 1
      return new Promise((resolve) => { resolveConsume = resolve })
    }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }

    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)
    await bot.equip({ name: 'iron_sword' }, 'hand')
    const handSwords = bot.equipCalls.filter((c) => c.dest === 'hand' && c.item.name === 'iron_sword')
    assert.equal(handSwords.length, 0) // blocked while eat in flight

    resolveConsume()
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('eats when nobody is online', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    lines.length = 0
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat bread food=12'])
  })

  it('eats when parked', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    lines.length = 0
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.stop()
    await ticker.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bot.consumeCalls, 1)
    assert.deepEqual(eatLines(), ['eat bread food=12'])
  })

  it('fight decision does not steal hand while eat is in flight', async () => {
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }, { name: 'iron_sword', count: 1 }] })
    lines.length = 0
    let resolveConsume
    bot.consume = () => {
      bot.consumeCalls++
      return new Promise((resolve) => { resolveConsume = resolve })
    }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    bot.entities = { 1: zombie(1, 5) }
    const brain = mockBrain({ action: 'fight', sprint: false, source: 'stub' })
    const ticker = eatTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })

    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)
    assert.equal(bot.equipCalls.length, 1)
    assert.equal(bot.equipCalls[0].item.name, 'bread')
    assert.deepEqual(eatLines(), [])

    resolveConsume()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(eatLines(), ['eat bread food=12'])
    const handEquips = bot.equipCalls.filter((c) => c.dest === 'hand')
    assert.ok(handEquips.length >= 2)
    assert.equal(handEquips[handEquips.length - 1].item.name, 'iron_sword')
  })

  it('hostile-in-swing-range guard in eatReflex directly refuses eating even if reflexSwung is false', () => {
    const { eatReflex } = require('../src/index')
    const bot = eatBot({ food: 12, items: [{ name: 'bread', count: 16 }] })
    const ctx = { eatInFlight: false, reflexSwung: false }
    const state = { hostile: zombie(1, 1), hostile_distance: 1 }
    const res = eatReflex(bot, ctx, state)
    assert.equal(res, false)
    assert.equal(bot.consumeCalls, 0)
  })

  it('tool or block equip (e.g. pickaxe) is not dropped during in-flight eat', async () => {
    const bot = mockBot()
    bot.food = 12
    bot.inventory = { items: () => [{ name: 'bread', count: 16 }, { name: 'iron_pickaxe', count: 1 }] }
    bot.equipCalls = []
    bot.equip = (item, dest) => { bot.equipCalls.push({ item, dest }); return Promise.resolve() }
    let resolveConsume
    bot.consume = () => {
      bot.consumeCalls = (bot.consumeCalls || 0) + 1
      return new Promise((resolve) => { resolveConsume = resolve })
    }
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = eatTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })

    await ticker.tick()
    assert.equal(bot.consumeCalls, 1)

    // While eat is in flight, pathfinder equips a pickaxe to hand:
    await bot.equip({ name: 'iron_pickaxe' }, 'hand')
    const handPickaxes = bot.equipCalls.filter((c) => c.dest === 'hand' && c.item.name === 'iron_pickaxe')
    assert.equal(handPickaxes.length, 1)

    resolveConsume()
    await new Promise((resolve) => setImmediate(resolve))
  })
})

describe('place_error backstop removal (idkcraft-p4s)', () => {
  it('place_error streaks never raise the ticker stuck fact', async () => {
    const bot = mockBot()
    bot.chat = () => {}
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'rest', sprint: false, source: 'test' }), tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.placeErrors = 3
    ctx.lastGoalKey = 'roam:1,64,0'
    try {
      await ticker.tick()
      assert.equal(ctx.stuck, null, 'no recover handover on placement errors')
      assert.equal(ctx.recovery, null, 'body stays with the step')
    } finally {
      ticker.destroy()
    }
  })
})

describe('go work revokes persisted follow (idkcraft-p4s)', () => {
  it('work() with a remembered-but-offline name keeps it on ctx', async () => {
    // Round-02 minor: restore() may set ctx.followName for an offline player
    // the spawn did not adopt — work() must not erase it for next restart.
    const bot = mockBot()
    bot.chat = () => {}
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    try {
      const ctx = bot._tickerCtx
      ctx.followName = 'Absent'
      ticker.work()
      assert.equal(ticker.getFollowName(), '')
      assert.equal(ctx.followName, 'Absent')
    } finally {
      ticker.destroy()
    }
  })

  it('work() clears the closure and the ctx copy', async () => {
    const bot = mockBot()
    bot.chat = () => {}
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    try {
      const ctx = bot._tickerCtx
      ticker.setFollow('Steve')
      assert.equal(ticker.getFollowName(), 'Steve')
      assert.equal(ctx.followName, 'Steve')
      ticker.work()
      assert.equal(ticker.getFollowName(), '')
      assert.equal(ctx.followName, null)
    } finally {
      ticker.destroy()
    }
  })
})

describe('startup follow adoption (idkcraft-p4s)', () => {
  const { startupFollow } = require('../src/index')
  function rosterBot(names) {
    const players = {}
    for (const n of names) players[n] = { username: n, entity: { position: pos(10, 64, 0) } }
    return { username: 'IdkBot', players }
  }
  it('saved follow online wins', () => {
    assert.equal(startupFollow(rosterBot(['LoptiFriend']), 'LoptiFriend'), 'LoptiFriend')
  })
  it('saved follow offline adopts nobody (AGY correction)', () => {
    assert.equal(startupFollow(rosterBot(['Solo']), 'Gone'), '')
  })
  it('no saved follow, single online player: no adoption (AGY correction)', () => {
    assert.equal(startupFollow(rosterBot(['Solo']), ''), '')
  })
  it('no saved follow, several players: no adoption', () => {
    assert.equal(startupFollow(rosterBot(['A', 'B']), ''), '')
  })
  it('nobody online: no adoption', () => {
    assert.equal(startupFollow(rosterBot([]), ''), '')
  })
})

describe('rest mark clears on relocation ticks (idkcraft-q0h core-1 follow-up)', () => {
  it('a teleported body clears the gave-up mark on the next tick', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    try {
      await ticker.tick() // follow goal issued, lastPos sampled
      const ctx = bot._tickerCtx
      ctx.restGaveUpAt = { x: 0, y: 64, z: 0 }
      ctx.restGaveUpCalled = true
      ctx.restGaveUps = 1
      await ticker.tick() // still here: mark survives
      assert.ok(ctx.restGaveUpAt, 'mark kept at the pit')
      bot.entity.position = pos(10, 64, 0) // /tp out
      await ticker.tick()
      assert.equal(ctx.restGaveUpAt, null, 'relocation clears the mark')
      assert.equal(ctx.restGaveUpCalled, false)
      assert.equal(ctx.restGaveUps, 0)
    } finally {
      ticker.destroy()
    }
  })
})

describe('ticker manual vs scheduled ticks (idkcraft-8e9)', () => {
  it('a manual tick arms no background timer', async () => {
    // A re-armed timer fires shadow ticks into harness loops (8e9): they
    // advance recovery without the harness stepBody and flake climbs.
    // (brain.calls cannot pin this — background ticks reuse the cached
    // decision — so spy the timer arming itself.)
    const delays = []
    const orig = global.setTimeout
    global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return orig(fn, ms, ...rest) }
    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const brain = mockBrain()
      const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
      await ticker.tick()
      assert.equal(brain.calls, 1, 'manual tick still decides once')
      assert.deepEqual(delays, [], 'manual tick arms nothing')
      ticker.destroy()
    } finally {
      global.setTimeout = orig
    }
  })

  it('start() keeps the timer loop ticking', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const lines = []
    const origLog = console.log
    console.log = (m) => lines.push(String(m))
    try {
      ticker.start()
      await new Promise((r) => setTimeout(r, 100))
      const decisions = lines.filter((l) => l.startsWith('decision '))
      assert.ok(decisions.length >= 2, `timer loop keeps ticking, got ${decisions.length} decision lines`)
    } finally {
      console.log = origLog
      ticker.destroy()
    }
  })
})
