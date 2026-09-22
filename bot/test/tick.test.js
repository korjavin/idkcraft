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
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => { calls.stop++ },
      isMoving: () => false,
      setMovements: (m) => { calls.movements = m }
    },
    setControlState: (control, val) => {
      if (control === 'jump' && val) calls.jump++
    },
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
      assert.equal(bot.calls.jump, 1)
      const stuckLines = lines.filter((l) => l.includes('stuck reason=noPath'))
      assert.equal(stuckLines.length, 1)
      assert.match(stuckLines[0], /^stuck reason=noPath pos=0,64,0 dist=10\.0$/)

      // Next tick: restores GoalFollow
      await ticker.tick()
      assert.equal(bot.calls.setGoal, 4)
      assert.equal(bot.calls.goals[3].constructor.name, 'GoalFollow')
      assert.equal(lines.filter((l) => l.includes('stuck reason=noPath')).length, 1)
      assert.equal(bot.calls.jump, 1)
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
