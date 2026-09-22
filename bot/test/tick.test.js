'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, BEHAVIOURS } = require('../src/index')
const { stateKey } = require('../src/perception')
const follow = require('../src/behaviours/follow')

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
      await ticker.tick() // no target -> slow
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(5) } }
      await ticker.tick() // target -> fast
      assert.deepEqual(delays, [222, 111])
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

  it('two consecutive noPath results with unchanged position produce one stuck log, one jump, one GoalNear, then GoalFollow', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }

    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      // Tick 1: initial setGoal (GoalFollow)
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 1)
      assert.equal(bot.calls.goals[0].constructor.name, 'GoalFollow')

      // First terminal result
      ticker.setPathStatus('noPath')
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.goals[1].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      assert.equal(lines.filter((l) => l.includes('stuck reason=noPath')).length, 0)

      // Second consecutive terminal result with position unchanged
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.goals[2].constructor.name, 'GoalNear')
      const g = bot.calls.goals[2]
      assert.ok(Math.hypot(g.x - 0, g.z - 0) >= 1 && Math.hypot(g.x, g.z) <= 3)
      assert.equal(g.y, 64)
      assert.equal(bot.calls.jump, 1)
      const stuckLines = lines.filter((l) => l.includes('stuck reason=noPath'))
      assert.equal(stuckLines.length, 1)
      assert.match(stuckLines[0], /^stuck reason=noPath pos=0,64,0 dist=10\.0$/)

      // Next tick: restores GoalFollow
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 4)
      assert.equal(bot.calls.goals[3].constructor.name, 'GoalFollow')
      assert.equal(lines.filter((l) => l.includes('stuck reason=noPath')).length, 1)
      assert.equal(bot.calls.jump, 0) // jump released after one tick
    } finally {
      console.log = origLog
    }
  })

  it('movement (>0.5 block) resets the stall counter', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }

    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal
      ticker.setPathStatus('noPath')
      await ticker.tick() // 1st noPath from (0, 64, 0)
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.jump, 0)

      // Bot moves > 0.5 block (e.g. 1.0 block)
      bot.entity.position = pos(1, 64, 0)
      await ticker.tick() // 1st noPath from (1, 64, 0) -> stall counter was reset, now 1
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.goals[2].constructor.name, 'GoalFollow')
      assert.equal(bot.calls.jump, 0)
      assert.equal(lines.filter((l) => l.includes('stuck reason=noPath')).length, 0)

      // Second consecutive noPath from (1, 64, 0)
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 4)
      assert.equal(bot.calls.goals[3].constructor.name, 'GoalNear')
      assert.equal(bot.calls.jump, 1)
      const stuckLines = lines.filter((l) => l.includes('stuck reason=noPath'))
      assert.equal(stuckLines.length, 1)
      assert.match(stuckLines[0], /^stuck reason=noPath pos=1,64,0 dist=/)
    } finally {
      console.log = origLog
    }
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

  it('movement <= 0.5 block does not reset the stall counter', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick() // initial setGoal
    ticker.setPathStatus('noPath')
    await ticker.tick() // stall 1 at (0, 64, 0)
    assert.equal(bot.calls.jump, 0)

    // Minor jitter: 0.3 block movement (<= 0.5)
    bot.entity.position = pos(0.3, 64, 0)
    await ticker.tick() // stall 2 -> must escalate
    assert.equal(bot.calls.jump, 1)
    assert.equal(bot.calls.goals[2].constructor.name, 'GoalNear')
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

  it('timeout status triggers re-issue and escalation after 2 consecutive timeouts', async () => {
    const lines = []
    const origLog = console.log
    console.log = (line) => { lines.push(String(line)) }

    try {
      const bot = mockBot()
      bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
      const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

      await ticker.tick() // initial setGoal
      ticker.setPathStatus('timeout')
      await ticker.tick() // timeout 1
      assert.equal(bot.calls.setGoal, 2)
      assert.equal(bot.calls.jump, 0)

      await ticker.tick() // timeout 2 -> escalate
      assert.equal(bot.calls.setGoal, 3)
      assert.equal(bot.calls.jump, 1)
      assert.equal(bot.calls.goals[2].constructor.name, 'GoalNear')
      const stuckLines = lines.filter((l) => l.includes('stuck reason=timeout'))
      assert.equal(stuckLines.length, 1)
    } finally {
      console.log = origLog
    }
  })

  it('success with empty path (stationary) counts as terminal and triggers escalation', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(10) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'laya' }), tickMs: 10, idleTickMs: 10 })

    await ticker.tick()
    ticker.setPathStatus('success')
    bot.pathfinder.isMoving = () => false // success but empty path
    await ticker.tick() // stall 1
    assert.equal(bot.calls.setGoal, 2)

    await ticker.tick() // stall 2
    assert.equal(bot.calls.setGoal, 3)
    assert.equal(bot.calls.jump, 1)
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
    assert.equal(deathLine(deadBot()), 'death health=0 hostiles=1 at 100 64 -20')
  })

  it('hostile count ignores mobType-only entities (no deprecated fallback)', () => {
    const bot = deadBot()
    bot.entities[2] = { id: 2, type: 'mob', mobType: 'zombie', position: pos(101, 64, -20) }
    assert.equal(buildState(bot, null).nearby_hostiles, 1)
    assert.equal(deathLine(bot), 'death health=0 hostiles=1 at 100 64 -20')
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
        'death health=0 hostiles=1 at 100 64 -20',
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
      'death health=0 hostiles=1 at 100 64 -20',
      'respawn at 0 64 0',
    ])
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
    assert.ok((bot.lines || []).some((l) => l === 'here: coal at 10 64 0'))
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
    assert.ok((bot.lines || []).some((l) => l.includes('coal_ore at 10 60 0')))
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
    bot.players = { Steve: { username: 'Steve', entity: playerEntity(2) } }
    const ticker = createTicker({ bot, brain: mockBrain({ action: 'follow', sprint: false, source: 'stub' }), tickMs: 10, idleTickMs: 10 })
    const life = createLifecycle(ticker)
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    assert.ok(ticker.getLead())
    life.onDeath(bot)
    assert.equal(ticker.getLead(), null)
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
      await ticker.tick()
      assert.equal(bot.attackCalls, 1)
      assert.deepEqual(delays, [111]) // swinging: fast, not the 10 s idle poll
      delete bot.entities[1] // mob dies
      await ticker.tick()
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
