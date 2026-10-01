'use strict'

// E2E scenarios, batch 1a (idkcraft-2ib): closed follow/stuck bugs replayed
// through the full brain→behaviour path (createTicker + ticker.tick with a
// scripted world). The behaviour-level regression tests call follow()/roam()
// directly; these scenarios pin the seams between ticker routing, the
// decision cache, body-theft ticks and the recover handoff — the joints
// where prod mode 68p lived.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

// Flat world: dirt below y=64, air at and above. Chat, controls, goals and
// stops are recorded; the body never moves unless the script moves it.
function scenarioBot() {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    _moving: false,
    _goals: [],
    _stops: 0,
    chats: [],
    controls: {},
    pathfinder: {
      goal: null,
      setGoal(g) { bot._goals.push(g); bot.pathfinder.goal = g || null },
      stop() { bot._stops++ },
      isMoving: () => bot._moving,
      setMovements(m) { bot._movements = m },
    },
    setControlState(c, v) { bot.controls[c] = !!v },
    getControlState(c) { return !!bot.controls[c] },
    clearControlStates() { bot.controls = {} },
    chat(m) { bot.chats.push(String(m)) },
    attack() {},
    lookAt() {},
    equip() {},
    inventory: { items: () => [] },
    blockAt(p) {
      const y = Math.floor(p.y)
      return y < 64 ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
    },
  }
  return bot
}

function visiblePlayer(name, x, y = 64, z = 0) {
  return { username: name, entity: { id: 7, username: name, position: pos(x, y, z) } }
}

function zombie(id, x) {
  return { id, name: 'zombie', type: 'mob', position: pos(x, 64, 0), height: 1.95 }
}

function scriptBrain(fn) {
  const calls = []
  return {
    calls,
    async decide(state) {
      calls.push(state)
      return fn(state, calls.length)
    },
  }
}

function capture() {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = orig } }
}

describe('2oe: place_error streak wedges follow and opens the menu', () => {
  it('three place_error with no displacement route follow -> wedge -> sidestep', async () => {
    // Prod 2oe: 142 s standing, 60 reset=place_error, no wedge — the
    // detector only counted 'stuck'. Fixed: a place_error streak counts the
    // same way, and the fact routes to the recover menu on the next tick.
    const bot = scenarioBot()
    bot.players = { P: visiblePlayer('P', 20) }
    bot._moving = true // executor claims to drive while the body stands still
    const brain = scriptBrain(() => ({ action: 'follow', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('P')
    const cap = capture()
    try {
      await ticker.tick() // issues GoalFollow
      for (let i = 0; i < 3; i++) {
        ticker.setPathReset('place_error')
        await ticker.tick()
      }
      const wedge = cap.lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(wedge.length, 1, cap.lines.join('\n'))
      assert.match(wedge[0], /^stuck reason=wedge pos=0,64,0 dist=20\.0 /)
      assert.deepEqual(bot._tickerCtx.stuck, { by: 'follow', goal: { x: 20, y: 64, z: 0 }, key: 'follow:P' })
      const brainCalls = brain.calls.length
      const r = await ticker.tick() // the fact owns the tick, not the brain
      assert.equal(r.calledBrain, false)
      assert.equal(brain.calls.length, brainCalls)
      assert.equal(r.decision.action, 'sidestep')
      assert.ok(bot.chats.some((c) => c.includes('stuck, trying sidestepping (fsm)')), bot.chats.join('\n'))
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('2oe: wedged homing walk reaches the menu', () => {
  it('return-spawn with no displacement raises the home fact and sidesteps', async () => {
    // Prod 2oe, second half: the unseen-player walk home (walkHomeTick) had
    // no detector at all — a wedged homing walk stood forever. 6x7.2: the
    // walk is a plain walk, the central detector raises by=home off the
    // return-spawn key at the unified slow threshold (30 stills).
    const bot = scenarioBot()
    bot.entity.position = pos(100, 64, 0)
    bot.spawnPoint = pos(0, 64, 0)
    bot.players = { P: { username: 'P', entity: null } } // roster online, nobody visible
    bot._moving = true // executor claims to drive the homing walk
    const brain = scriptBrain(() => ({ action: 'follow', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('P')
    const cap = capture()
    try {
      for (let i = 0; i < 10; i++) await ticker.tick() // unseen streak trips homing
      assert.match(bot._tickerCtx.lastGoalKey, /^return-spawn:0,64,0$/)
      assert.ok(bot._goals[bot._goals.length - 1] instanceof goals.GoalNear)
      let r = null
      for (let i = 0; i < 31; i++) r = await ticker.tick() // wedged walk, no displacement
      const wedge = cap.lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(wedge.length, 1, cap.lines.join('\n'))
      assert.equal(bot._tickerCtx.stuck.by, 'home')
      assert.deepEqual(bot._tickerCtx.stuck.goal, { x: 0, y: 64, z: 0 })
      assert.equal(r.decision.action, 'sidestep') // routed in the same idle tick
      assert.equal(r.calledBrain, false)
      assert.equal(brain.calls.length, 0) // idle branch never calls the brain
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('68p: wedge budget survives a fight tick stealing the body', () => {
  it('follow wedges after two stuck resets despite a fight tick in between', async () => {
    // Prod 68p: every fight/bring tick flipped lastGoalKey and zeroed the
    // stuck counters, so a wedged pursuit never raised. 6x7.2: the streak
    // is the central detector's and sticky across brain-action switches (a
    // fight tick is not an order — no clearStuck), so the second knock
    // still wedges after the theft. The brain here answers fight while the
    // zombie is near, follow otherwise — the theft arrives through the
    // real arbitration path, not a ctx poke.
    const bot = scenarioBot()
    bot.players = { P: visiblePlayer('P', 20) }
    bot._moving = true
    const brain = scriptBrain((state) => (state.hostile
      ? { action: 'fight', sprint: false, source: 'stub' }
      : { action: 'follow', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('P')
    const cap = capture()
    try {
      await ticker.tick() // follow issues GoalFollow
      ticker.setPathReset('stuck')
      await ticker.tick() // first knock: replan, budget kept
      bot.entities = { 1: zombie(1, 5) } // fight steals the body for one tick
      await ticker.tick()
      assert.match(bot._tickerCtx.lastGoalKey, /^fight:1$/)
      bot.entities = {}
      ticker.setPathReset('stuck')
      await ticker.tick() // follow retakes the same target: re-issue
      assert.equal(bot._tickerCtx.lastGoalKey, 'follow:P')
      await ticker.tick() // second stuck reset still counted: wedge
      const wedge = cap.lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(wedge.length, 1, cap.lines.join('\n'))
      assert.equal(bot._tickerCtx.stuck.by, 'follow')
      assert.ok(bot._goals.length >= 4, `goals: ${bot._goals.length}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('5vv: sprint on flat pursuit end to end', () => {
  it('level plan nodes sprint, a +1 node kills it', async () => {
    // Prod 5vv: the bot walked (4.3 b/s) behind a runner (5.6 b/s), dist
    // 6→58 in 36 s. Fixed: far level pursuit sprints; the flag is owned by
    // the tick — the lease applies it post-dispatch, tick start holds the default.
    const bot = scenarioBot()
    bot.players = { P: visiblePlayer('P', 12) }
    const brain = scriptBrain(() => ({ action: 'follow', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('P')
    const mov = { allowSprinting: false, allowParkour: true }
    ticker.setMovements(mov)
    try {
      await ticker.tick() // issues GoalFollow
      ticker.setPathNodes([{ x: 3, y: 64, z: 0 }, { x: 6, y: 64, z: 0 }])
      await ticker.tick()
      assert.equal(mov.allowSprinting, true, 'far level pursuit sprints')
      assert.equal(mov.allowParkour, false, 'plan rides the sprint window')
      ticker.setPathNodes([{ x: 3, y: 64, z: 0 }, { x: 5, y: 65, z: 0 }])
      await ticker.tick()
      assert.equal(mov.allowSprinting, false, 'a +1 in the window kills the sprint')
      assert.equal(mov.allowParkour, true)
    } finally {
      ticker.destroy()
    }
  })
})

describe('3nt.19: follow leaves a fresh search alone', () => {
  it('no re-issue until the plan goes terminal or 6 s pass', async () => {
    // The 3nt.19 core: tearing down the A* search every tick restarts a
    // search that needs more than a tick. Fixed: a fresh non-terminal plan
    // is left alone; only a terminal status or the 6 s timeout re-issues.
    const bot = scenarioBot()
    bot.players = { P: visiblePlayer('P', 20) }
    const brain = scriptBrain(() => ({ action: 'follow', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('P')
    const cap = capture()
    try {
      await ticker.tick()
      assert.equal(bot._goals.length, 1)
      for (let i = 0; i < 5; i++) await ticker.tick() // fresh plan, standing by
      assert.equal(bot._goals.length, 1, 'no teardown of a fresh search')
      bot._tickerCtx.followIssuedAt -= 7000 // the 6 s search timeout passes
      await ticker.tick()
      assert.equal(bot._goals.length, 2, 'stale plan re-issues once')
      assert.ok(bot._goals[1] instanceof goals.GoalFollow)
      assert.equal(bot._tickerCtx.stuck || null, null)
      assert.equal(cap.lines.filter((l) => l.includes('stuck reason=')).length, 0)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('b3n: roam wedge takes another point, never the menu', () => {
  it('two stuck resets re-issue a stroll goal with no stuck fact', async () => {
    // Prod b3n: roam stood 10 s with moving=true and repeated reset=stuck.
    // Contract (p4s): a wedged stroll just takes another point — handing
    // the body to recover turned every 3.5 s pathfinder stop into a long
    // sidestep/dig/call episode walking back into the same trap.
    const bot = scenarioBot()
    bot.players = { P: visiblePlayer('P', 2) } // close and still: roam envelope
    const brain = scriptBrain(() => ({ action: 'roam', sprint: false, source: 'stub' }))
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const cap = capture()
    try {
      await ticker.tick() // first stroll point
      assert.equal(bot._goals.length, 1)
      assert.match(bot._tickerCtx.lastGoalKey, /^roam:/)
      bot._moving = true // executor drives, body stands still
      ticker.setPathReset('stuck')
      await ticker.tick() // single knock: keep walking
      assert.equal(bot._goals.length, 1)
      ticker.setPathReset('stuck')
      await ticker.tick() // wedge: another point, never the menu
      assert.equal(bot._goals.length, 2)
      assert.match(bot._tickerCtx.lastGoalKey, /^roam:/)
      assert.equal(bot._tickerCtx.stuck || null, null)
      assert.equal(cap.lines.filter((l) => l.includes('stuck reason=')).length, 0)
      assert.equal(bot.controls.jump || false, false)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})
