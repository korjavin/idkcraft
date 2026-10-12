'use strict'

// Hybrid worker (idkcraft-jlda.2): the head learns a worker player exists —
// and that it is NOT a player. Unit pins for the worker.js bridge client
// (send/ensureJoined/players) plus fake-player e2e through the ticker: the
// head never follows the worker, never delivers to it, ignores its
// 'follow me', and still leaves on nobody-online with only it on.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const net = require('net')
const worker = require('../src/worker')
const { createTicker, handleChat, playersOccupied } = require('../src/index')
const { findTarget, resolvePlayer } = require('../src/perception')
const { playerStatus } = require('../src/behaviours/deliver')
const goal = require('../src/goal')
const taskMod = require('../src/task')
const goalOptions = require('../src/goal-options')
const exploreMod = require('../src/behaviours/explore')

const WORKER = 'IdkWorker'

afterEach(() => {
  delete process.env.WORKER_NAME
  delete process.env.WORKER_HOST
  delete process.env.WORKER_PORT
  delete process.env.MC_HOST
  delete process.env.MC_PORT
  worker.configure({})
})

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
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
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    chats: [],
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
      setMovements: (m) => { calls.movements = m },
    },
    setControlState: (control, val) => { controls[control] = !!val },
    clearControlStates: () => { for (const k in controls) controls[k] = false },
    getControlState: (control) => !!controls[control],
    chat: (m) => { bot.chats.push(String(m)) },
  }
  return bot
}

function mockBrain(decision) {
  return {
    calls: 0,
    async decide() {
      this.calls++
      return decision || { action: 'follow', sprint: false, source: 'stub' }
    },
  }
}

function playerEntry(name, x) {
  return { username: name, entity: { id: 7, username: name, position: pos(x, 64, 0) } }
}

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

// A localhost port nothing listens on (listen + close; the race with a
// stranger grabbing it mid-test is negligible).
async function closedPort() {
  const s = net.createServer()
  await new Promise((resolve) => s.listen(0, 'localhost', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}

describe('worker unit: identity and roster sieve', () => {
  it('isWorker is exact, and false until configured', () => {
    assert.equal(worker.configured(), false)
    assert.equal(worker.isWorker(WORKER), false)
    worker.configure({ WORKER_NAME: WORKER })
    assert.equal(worker.configured(), true)
    assert.equal(worker.isWorker(WORKER), true)
    assert.equal(worker.isWorker('.' + WORKER), false) // no Floodgate tolerance: a Java client
    assert.equal(worker.isWorker(WORKER.toLowerCase()), false)
    assert.equal(worker.isWorker('Steve'), false)
    assert.equal(worker.isWorker(''), false)
    assert.equal(worker.isWorker(null), false)
    assert.equal(worker.isWorker(undefined), false)
    worker.configure({})
    assert.equal(worker.configured(), false)
    assert.equal(worker.isWorker(WORKER), false)
  })

  it('players() drops self and worker, keeps everyone else', () => {
    const bot = mockBot()
    bot.players = {
      IdkBot: { username: 'IdkBot' }, // tab list carries the head too, entity-less
      [WORKER]: playerEntry(WORKER, 5),
      Steve: playerEntry('Steve', 10),
    }
    worker.configure({ WORKER_NAME: WORKER })
    assert.deepEqual(Object.keys(worker.players(bot)), ['Steve'])
    worker.configure({})
    assert.deepEqual(Object.keys(worker.players(bot)).sort(), [WORKER, 'Steve'].sort())
    // A nameless bot (unit mocks) drops nothing by name: undefined self
    // must not eat nameless entries with it.
    const bare = { players: { P: { entity: {} } } }
    assert.deepEqual(Object.keys(worker.players(bare)), ['P'])
  })

  it('workerEntity/workerOnline read the tab list, null/false until configured', () => {
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    assert.equal(worker.workerOnline(bot), false)
    assert.equal(worker.workerEntity(bot), null)
    worker.configure({ WORKER_NAME: WORKER })
    assert.equal(worker.workerOnline(bot), true)
    assert.equal(worker.workerEntity(bot), bot.players[WORKER].entity)
    bot.players = {}
    assert.equal(worker.workerOnline(bot), false)
    assert.equal(worker.workerEntity(bot), null)
  })

  it('resolvePlayer maps the worker to nothing, others untouched', () => {
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5), Steve: playerEntry('Steve', 10) }
    worker.configure({ WORKER_NAME: WORKER })
    assert.equal(resolvePlayer(bot, WORKER), null)
    assert.equal(resolvePlayer(bot, 'idkworker'), null) // case-insensitive match still lands on it
    assert.equal(resolvePlayer(bot, 'Steve'), 'Steve')
    worker.configure({})
    assert.equal(resolvePlayer(bot, WORKER), WORKER) // unconfigured: the old resolve
  })
})

describe('worker unit: send bridge', () => {
  it('a local server receives the line + newline, one log line, resolves true', async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, 'localhost', resolve))
    try {
      const port = server.address().port
      worker.configure({ WORKER_NAME: WORKER, WORKER_HOST: 'localhost', WORKER_PORT: String(port) })
      const got = new Promise((resolve) => server.once('connection', (c) => {
        let buf = ''
        c.on('data', (d) => { buf += d })
        c.on('end', () => resolve(buf))
      }))
      const cap = capture()
      let ok = false
      try {
        ok = await worker.send('connect mc 25565')
      } finally {
        cap.release()
      }
      assert.equal(ok, true)
      assert.equal(await got, 'connect mc 25565\n')
      const sends = cap.lines.filter((l) => l.startsWith('worker send '))
      assert.equal(sends.length, 1)
      assert.match(sends[0], /worker send connect mc 25565 ok=true/)
    } finally {
      server.close()
    }
  })

  it('an unreachable bridge resolves false fast, never throws', async () => {
    worker.configure({ WORKER_NAME: WORKER, WORKER_HOST: 'localhost', WORKER_PORT: String(await closedPort()) })
    const cap = capture()
    const t0 = Date.now()
    let ok = true
    try {
      ok = await worker.send('disconnect')
    } finally {
      cap.release()
    }
    assert.equal(ok, false)
    assert.ok(Date.now() - t0 < 1000, `send took ${Date.now() - t0} ms`)
    assert.equal(cap.lines.filter((l) => l.startsWith('worker send ')).length, 1)
    assert.match(cap.lines.join('\n'), /worker send disconnect ok=false/)
  })

  it('unconfigured send is a silent no-op', async () => {
    const cap = capture()
    try {
      assert.equal(await worker.send('disconnect'), false)
      assert.equal(await worker.leave(), false)
      assert.equal(cap.lines.length, 0)
    } finally {
      cap.release()
    }
  })
})

describe('worker unit: ensureJoined rate limit', () => {
  it('first connect after 30 s absent, at most one per 30 s, state-change logs only', async () => {
    worker.configure({ WORKER_NAME: WORKER, WORKER_HOST: 'localhost', WORKER_PORT: String(await closedPort()) })
    const bot = mockBot()
    const cap = capture()
    try {
      assert.equal(worker.ensureJoined(bot, 0), null) // absent, but not 30 s yet
      assert.equal(worker.ensureJoined(bot, 29999), null)
      const first = worker.ensureJoined(bot, 30001)
      assert.ok(first && typeof first.then === 'function', 'connect sent past 30 s absent')
      assert.equal(await first, false) // bridge down here; the line still went out
      assert.equal(worker.ensureJoined(bot, 31000), null) // a resend mid-login restarts the handshake
      assert.equal(worker.ensureJoined(bot, 60000), null) // 29999 ms since the send: still held
      const second = worker.ensureJoined(bot, 60002)
      assert.ok(second && typeof second.then === 'function', 'second connect after 30 s')
      assert.equal(await second, false)
      const sends = cap.lines.filter((l) => l.startsWith('worker send '))
      assert.equal(sends.length, 2)
      assert.ok(sends.every((l) => l === 'worker send connect mc 25565 ok=false'), sends.join('\n'))
      // Join and part log once each, then stay quiet.
      bot.players = { [WORKER]: playerEntry(WORKER, 5) }
      assert.equal(worker.ensureJoined(bot, 61000), null)
      assert.equal(worker.ensureJoined(bot, 62000), null)
      assert.equal(cap.lines.filter((l) => l === 'worker online').length, 1)
      bot.players = {}
      assert.equal(worker.ensureJoined(bot, 63000), null)
      assert.equal(worker.ensureJoined(bot, 64000), null)
      assert.equal(cap.lines.filter((l) => l === 'worker offline').length, 1)
    } finally {
      cap.release()
    }
  })

  it('the connect line carries MC_HOST/MC_PORT', async () => {
    worker.configure({ WORKER_NAME: WORKER, WORKER_HOST: 'localhost', WORKER_PORT: String(await closedPort()), MC_HOST: 'mchost', MC_PORT: '25566' })
    const bot = mockBot()
    const cap = capture()
    try {
      assert.equal(worker.ensureJoined(bot, 0), null) // first absent tick starts the clock
      const p = worker.ensureJoined(bot, 30001)
      assert.ok(p && typeof p.then === 'function')
      await p
      assert.match(cap.lines.join('\n'), /worker send connect mchost 25566 ok=false/)
    } finally {
      cap.release()
    }
  })

  it('unconfigured ensureJoined is a silent no-op', () => {
    const cap = capture()
    try {
      assert.equal(worker.ensureJoined(mockBot(), 999999), null)
      assert.equal(cap.lines.length, 0)
    } finally {
      cap.release()
    }
  })
})

describe('worker unit: playersOccupied counts the worker out', () => {
  function ping(online, names) {
    return { players: { online, sample: names.map((name) => ({ name })) } }
  }
  it('subtracts the worker when on, filters its sample name always', () => {
    worker.configure({ WORKER_NAME: WORKER })
    // Hidden sample (prod HIDE_ONLINE_PLAYERS): self + worker reads empty.
    assert.equal(playersOccupied(ping(2, []), 'IdkBot', true, true), false)
    assert.equal(playersOccupied(ping(2, []), 'IdkBot', true, false), true) // old path, worker off
    assert.equal(playersOccupied(ping(3, []), 'IdkBot', true, true), true) // one real player
    // Visible sample: the worker name never counts, on or off.
    assert.equal(playersOccupied(ping(2, ['IdkBot', WORKER]), 'IdkBot', true, true), false)
    assert.equal(playersOccupied(ping(2, ['IdkBot', 'Steve']), 'IdkBot', true, true), true)
    // waitForPlayers guard: a stray worker alone off-server still waits.
    assert.equal(playersOccupied(ping(1, [WORKER]), 'IdkBot', false, false), false)
    assert.equal(playersOccupied(ping(1, ['Steve']), 'IdkBot', false, false), true)
    assert.equal(playersOccupied(ping(1, []), 'IdkBot', false, false), true) // ghost-or-player: join
  })
})

describe('worker e2e: a worker on the roster is not a player', () => {
  it('the head never follows it: no target, no brain call, no follow goal', async () => {
    process.env.WORKER_NAME = WORKER // createTicker reads the env once
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    const cap = capture()
    try {
      assert.equal(findTarget(bot, ''), null)
      const r = await ticker.tick()
      assert.equal(r.calledBrain, false)
      assert.equal(brain.calls, 0)
      assert.equal(bot.calls.goals.length, 0)
      assert.equal(r.decision.action, 'idle')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })

  it('deliver/stockpile gates read none: playerStatus, facts.player, owner onlines, alone idle', async () => {
    process.env.WORKER_NAME = WORKER
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    const brain = mockBrain()
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    try {
      assert.equal(playerStatus(bot).level, 'none')
      assert.equal(goal.goalFacts(bot, bot._tickerCtx).player, 'none')
      assert.equal(taskMod.ownerOnline(bot), false)
      assert.equal(goalOptions.ownerOnline(bot), false)
      assert.equal(exploreMod.aloneIdle(bot, bot._tickerCtx), true)
      // A real player flips every gate back.
      bot.players.Steve = playerEntry('Steve', 10)
      assert.equal(playerStatus(bot).level, 'near')
      assert.equal(playerStatus(bot).name, 'Steve')
      assert.equal(taskMod.ownerOnline(bot), true)
      assert.equal(exploreMod.aloneIdle(bot, bot._tickerCtx), false)
    } finally {
      ticker.destroy()
    }
  })

  it("'follow me' from the worker is ignored, from a player still lands", async () => {
    process.env.WORKER_NAME = WORKER
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5), Steve: playerEntry('Steve', 10) }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const cap = capture()
    try {
      handleChat(bot, ticker, WORKER, 'follow me')
      assert.ok(!ticker.getFollowName(), `worker followed: ${ticker.getFollowName()}`)
      assert.ok(!bot.chats.some((c) => c.startsWith('Following')), bot.chats.join('\n'))
      assert.ok(!cap.lines.some((l) => l.includes(`from=${WORKER}`)), cap.lines.join('\n'))
      handleChat(bot, ticker, 'Steve', 'follow me')
      assert.equal(ticker.getFollowName(), 'Steve')
      assert.ok(bot.chats.some((c) => c === 'Following Steve'), bot.chats.join('\n'))
    } finally {
      cap.release()
      ticker.destroy()
    }
  })

  it('the nobody-online leave still fires with only the worker on', async () => {
    process.env.WORKER_NAME = WORKER
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    bot.quitCalls = 0
    bot.quit = () => { bot.quitCalls++ }
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, leaveAfterMs: 60, onLeave: () => bot.quit('nobody online'), now: () => t })
    const cap = capture()
    try {
      const tick = async () => { await ticker.tick(); t += 10 }
      for (let i = 0; i < 6; i++) await tick()
      assert.equal(bot.quitCalls, 0)
      await tick() // 7th tick at t=60: grace reached, the worker never reset it
      assert.equal(bot.quitCalls, 1)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})
