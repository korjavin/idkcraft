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
const index = require('../src/index')
const { createTicker, handleChat, playersOccupied, waitForPlayers, waitForWorkerLeave } = require('../src/index')
const { findTarget, resolvePlayer } = require('../src/perception')
const { playerStatus } = require('../src/behaviours/deliver')
const { cellOccupiedByPlayer, threatenedByPlayer } = require('../src/behaviours/flat')
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

// Poll fn until it returns truthy (async arrival: bridge lines, quit calls).
async function waitFor(fn, timeoutMs = 2000, pollMs = 25) {
  const stop = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() >= stop) return null
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// Fake write-only bridge: collects every '\n'-terminated line sent to it.
function startBridge() {
  const lines = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
  })
  return {
    lines,
    server,
    listen: () => new Promise((r) => server.listen(0, 'localhost', r)),
    close: () => new Promise((r) => server.close(r)),
  }
}

// runOnce-capable bot: an EventEmitter with the ticking shape (leaveBot) and
// the spawn shape (memory.test.js connBot: spawnPoint, registry, loadPlugin).
function connBot() {
  const { EventEmitter } = require('node:events')
  const bot = new EventEmitter()
  const controls = {}
  Object.assign(bot, {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0) },
    spawnPoint: pos(0, 64, 0),
    registry: require('minecraft-data')('1.21.1'),
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    chats: [],
    quitCalls: 0,
    quitReason: null,
    quitAt: 0,
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g },
      stop() {},
      isMoving: () => false,
      setMovements() {},
    },
    loadPlugin() {},
    chat(m) { bot.chats.push(String(m)) },
    setControlState(c, v) { controls[c] = !!v },
    clearControlStates() { for (const k in controls) controls[k] = false },
    getControlState(c) { return !!controls[c] },
    quit(reason) { bot.quitCalls++; bot.quitReason = reason; bot.quitAt = Date.now(); bot.emit('end', reason) },
  })
  return bot
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

describe('worker e2e: flat occupancy keeps the prod roster shape (revmux 01 core-2)', () => {
  // Prod roster shape: mineflayer backfills bot.players[self].entity (login
  // + player_info in entities.js), so the occupancy loops always matched
  // self — the sieve must not change that on the default config.
  function prodBot() {
    return {
      username: 'IdkBot',
      entity: { position: pos(0, 64, 0) },
      players: {
        IdkBot: { username: 'IdkBot', entity: { position: pos(0, 64, 0) } },
      },
    }
  }
  it('still matches the entity-ful self, but never the worker', () => {
    const bot = prodBot()
    assert.equal(threatenedByPlayer(bot, 0, 64, 0), true) // own feet cell: self matches (pre-jlda shape)
    assert.equal(cellOccupiedByPlayer(bot, 0, 64, 0), true)
    worker.configure({ WORKER_NAME: WORKER })
    bot.players[WORKER] = { username: WORKER, entity: { position: pos(5, 64, 0) } }
    assert.equal(threatenedByPlayer(bot, 0, 64, 0), true) // self still matches
    assert.equal(cellOccupiedByPlayer(bot, 0, 64, 0), true)
    assert.equal(threatenedByPlayer(bot, 5, 64, 0), false) // ...but the worker never does
    assert.equal(cellOccupiedByPlayer(bot, 5, 64, 0), false)
  })
})

describe('worker unit: waitForWorkerLeave bounded tab-drop wait (revmux 01 core-1)', () => {
  it('returns at once when the worker is already gone', async () => {
    worker.configure({ WORKER_NAME: WORKER })
    let sleeps = 0
    await waitForWorkerLeave(mockBot(), { sleepFn: async () => { sleeps++ } })
    assert.equal(sleeps, 0)
  })
  it('returns as soon as the tab drops the worker', async () => {
    worker.configure({ WORKER_NAME: WORKER })
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    let t = 0
    let sleeps = 0
    await waitForWorkerLeave(bot, {
      waitMs: 5000,
      pollMs: 250,
      nowFn: () => t,
      sleepFn: async () => { sleeps++; t += 250; if (sleeps === 2) bot.players = {} },
    })
    assert.equal(sleeps, 2)
  })
  it('gives up after waitMs with a stuck worker', async () => {
    worker.configure({ WORKER_NAME: WORKER })
    const bot = mockBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    let t = 0
    let sleeps = 0
    await waitForWorkerLeave(bot, {
      waitMs: 5000,
      pollMs: 250,
      nowFn: () => t,
      sleepFn: async () => { sleeps++; t += 250 },
    })
    assert.equal(sleeps, 20)
  })
})

describe('worker e2e: off-server wait settles a disconnecting worker (revmux 01 core-1)', () => {
  it('online=2 with an empty sample re-pings when configured, joins at once when not', async () => {
    // Configured: ghost + slow worker reads ambiguous; the re-ping clears it.
    {
      const pings = []
      const script = [
        { players: { online: 2 } }, // ghost + worker mid-disconnect, hidden sample
        { players: { online: 0 } }, // settle: both gone
        { players: { online: 0 } },
        { players: { online: 1, sample: [{ name: 'Steve' }] } },
      ]
      const cap = capture()
      try {
        await waitForPlayers({
          host: 'x', port: 1, pollMs: 5, username: 'IdkBot', workerConfigured: true,
          pingFn: async () => { const r = script[Math.min(pings.length, script.length - 1)]; pings.push(r); return r },
        })
      } finally {
        cap.release()
      }
      assert.equal(pings.length, 4) // the first 2 did NOT read occupied
    }
    // Unconfigured default: online=2 reads occupied at once (old path).
    {
      const pings = []
      const cap = capture()
      try {
        await waitForPlayers({
          host: 'x', port: 1, pollMs: 5, username: 'IdkBot',
          pingFn: async () => { pings.push(1); return { players: { online: 2 } } },
        })
      } finally {
        cap.release()
      }
      assert.equal(pings.length, 1)
    }
  })
})

describe('worker e2e: runOnce leave disconnects the worker first (revmux 01 core-1/3)', () => {
  async function bridgedEnv() {
    const bridge = startBridge()
    await bridge.listen()
    delete process.env.MC_HOST
    delete process.env.MC_PORT
    process.env.WORKER_NAME = WORKER
    process.env.WORKER_HOST = 'localhost'
    process.env.WORKER_PORT = String(bridge.server.address().port)
    return bridge
  }
  function runLeaving(bot, pingFn) {
    let settled = false
    index.runOnce({
      host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 10,
      brain: mockBrain(), leaveAfterMs: 30, followName: '', createBot: () => bot, pingFn,
    }).then(() => { settled = true }, () => { settled = true })
    return () => settled
  }

  it('nobody-online quit sends disconnect, resolved before bot.quit runs', async () => {
    const bridge = await bridgedEnv()
    const bot = connBot()
    // Causal ordering log (no wall clock: resolve and quit land in the same
    // ms): fire-and-forget would log quit BEFORE leave-resolved.
    const events = []
    const realQuit = bot.quit.bind(bot)
    bot.quit = (r) => { events.push('quit'); realQuit(r) }
    const realLeave = worker.leave
    worker.leave = (...a) => realLeave(...a).then((v) => { events.push('leave-resolved'); return v })
    const cap = capture()
    try {
      const settled = runLeaving(bot, async () => ({ players: { online: 0 } }))
      bot.emit('spawn')
      assert.ok(await waitFor(() => (bot.quitCalls > 0 ? true : null), 5000), 'bot quit on nobody-online')
      assert.equal(bot.quitReason, 'nobody online')
      assert.equal(await waitFor(() => (bridge.lines.length > 0 ? bridge.lines.join('\n') : null), 2000), 'disconnect')
      assert.deepEqual(events, ['leave-resolved', 'quit'])
      assert.ok(await waitFor(() => (settled() ? true : null), 2000), 'runOnce resolved into the join loop')
    } finally {
      worker.leave = realLeave
      cap.release()
      await bridge.close()
    }
  })

  it('with the worker on and ping online=2 (hidden sample) the head still leaves', async () => {
    const bridge = await bridgedEnv()
    const bot = connBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    const cap = capture()
    try {
      runLeaving(bot, async () => ({ players: { online: 2 } })) // self + worker, hidden sample
      bot.emit('spawn')
      setTimeout(() => { bot.players = {} }, 100) // the worker processes the disconnect
      assert.ok(await waitFor(() => (bot.quitCalls > 0 ? true : null), 5000), 'bot quit with only the worker on')
      assert.equal(await waitFor(() => (bridge.lines.length > 0 ? bridge.lines.join('\n') : null), 2000), 'disconnect')
    } finally {
      cap.release()
      await bridge.close()
    }
  })

  it('a real player beside the worker re-arms: no quit, no disconnect', async () => {
    const bridge = await bridgedEnv()
    const bot = connBot()
    bot.players = { [WORKER]: playerEntry(WORKER, 5) }
    let pingRes = { players: { online: 3 } } // self + worker + one real player, hidden sample
    const cap = capture()
    try {
      runLeaving(bot, async () => pingRes)
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 200)) // several re-armed grace cycles
      assert.equal(bot.quitCalls, 0)
      assert.equal(bridge.lines.length, 0)
      // The player leaves and the worker processes its disconnect: the next
      // grace quits fast (the full 5 s bound with a stuck worker is pinned
      // by the waitForWorkerLeave unit test instead).
      pingRes = { players: { online: 0 } }
      bot.players = {}
      assert.ok(await waitFor(() => (bot.quitCalls > 0 ? true : null), 5000), 'bot quit after the player left')
      assert.equal(await waitFor(() => (bridge.lines.length > 0 ? bridge.lines.join('\n') : null), 2000), 'disconnect')
    } finally {
      cap.release()
      await bridge.close()
    }
  })
})

describe('worker e2e: tickPrelude joins the worker (revmux 01 core-3)', () => {
  it('past 30 s absent the tick sends connect over the bridge', async () => {
    const bridge = startBridge()
    await bridge.listen()
    delete process.env.MC_HOST
    delete process.env.MC_PORT
    process.env.WORKER_NAME = WORKER
    process.env.WORKER_HOST = 'localhost'
    process.env.WORKER_PORT = String(bridge.server.address().port)
    const bot = mockBot()
    let t = 0
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10, now: () => t })
    const cap = capture()
    try {
      await ticker.tick() // t=0: the absence clock starts, nothing sent
      assert.equal(bridge.lines.length, 0)
      t = 30001
      await ticker.tick()
      assert.equal(await waitFor(() => (bridge.lines.length > 0 ? bridge.lines.join('\n') : null), 2000), 'connect mc 25565')
    } finally {
      cap.release()
      ticker.destroy()
      await bridge.close()
    }
  })
})

describe('worker e2e: SIGTERM disconnects the worker, then exits 143 (revmux 01 core-3)', () => {
  it('configured SIGTERM sends disconnect before exit', async () => {
    const bridge = startBridge()
    await bridge.listen()
    process.env.WORKER_NAME = WORKER
    process.env.WORKER_HOST = 'localhost'
    process.env.WORKER_PORT = String(bridge.server.address().port)
    const bot = connBot()
    const realExit = process.exit
    let exitCode = null
    process.exit = (c) => { exitCode = c }
    const cap = capture()
    try {
      index.runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 60000, idleTickMs: 60000,
        brain: mockBrain(), leaveAfterMs: 0, followName: '', createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      process.emit('SIGTERM') // consumes this file's once-per-process listener
      assert.equal(await waitFor(() => (bridge.lines.length > 0 ? bridge.lines.join('\n') : null), 2000), 'disconnect')
      assert.equal(await waitFor(() => (exitCode !== null ? exitCode : null), 2000), 143)
    } finally {
      cap.release()
      process.exit = realExit
      await bridge.close()
    }
  })
})
