'use strict'

// Disk memory (idkcraft-hlk): homes, resource finds, explored chunks and
// danger spots survive a restart via one JSON file.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const memory = require('../src/memory')
const resources = require('../src/resources')
const danger = require('../src/danger')
const { Vec3 } = require('vec3')

const SPAWN_A = { x: 0, y: 64, z: 0 }
const SPAWN_B = { x: 1000, y: 70, z: -500 }

function botAt(spawn) {
  return { username: 'MemBot', spawnPoint: { ...spawn } }
}

function homeAt(x, y, z) {
  return {
    site: { x, y, z },
    interior: { min: { x: x + 1, y, z: z + 1 }, max: { x: x + 2, y: y + 1, z: z + 2 } },
    door: { x: x + 1, y, z },
    table: null,
    built: false,
  }
}

let dir = null
let file = null
let prevEnv = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlk-'))
  file = path.join(dir, 'bot.json')
  prevEnv = process.env.BOT_MEMORY_FILE
  process.env.BOT_MEMORY_FILE = file
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
  else process.env.BOT_MEMORY_FILE = prevEnv
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
})

function fillCtx(ctx, now) {
  ctx.home = homeAt(10, 64, 20)
  ctx.home.built = true
  ctx.home.table = { x: 11, y: 64, z: 20 }
  resources.noteSpots(ctx, [
    { x: 12, y: 60, z: 22, name: 'iron_ore' },
    { x: -5, y: 64, z: 8, name: 'oak_log' },
  ], now)
  ctx.explore = { visited: new Set(['0,0', '1,0', '-3,2']) }
  danger.mark(ctx, { x: 30, y: 64, z: 30 }, now)
}

describe('disk memory', () => {
  it('round-trips home, resources, visited and danger into a fresh ctx', () => {
    const now = Date.now()
    const ctx1 = {}
    fillCtx(ctx1, now)
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)

    const ctx2 = {}
    const back = memory.restore(botAt(SPAWN_A), ctx2, file, now)
    assert.ok(back)
    // Revived as Vec3 like adoptHome/build produce: craft's blockAt(table)
    // needs the methods, a plain object throws inside prismarine-world.
    assert.ok(ctx2.home.site instanceof Vec3)
    assert.equal(ctx2.home.site.x, 10)
    assert.equal(ctx2.home.built, true)
    assert.ok(ctx2.home.table instanceof Vec3)
    assert.equal(ctx2.home.table.z, 20)
    assert.equal(resources.count(ctx2), 2)
    assert.equal(resources.nearest(ctx2, { x: 12, y: 60, z: 22 }).name, 'iron_ore')
    assert.ok(ctx2.explore.visited instanceof Set)
    assert.ok(ctx2.explore.visited.has('0,0'))
    assert.ok(ctx2.explore.visited.has('-3,2'))
    assert.equal(danger.count(ctx2), 1)
    assert.equal(danger.near(ctx2, { x: 31, z: 31 }), true)
  })

  it('missing file restores nothing and never throws', () => {
    const ctx = {}
    assert.equal(memory.restore(botAt(SPAWN_A), ctx, file), null)
    assert.equal(ctx.home, undefined)
  })

  it('corrupt file restores nothing and never throws', () => {
    fs.writeFileSync(file, '{not json,,,')
    const ctx = {}
    assert.equal(memory.restore(botAt(SPAWN_A), ctx, file), null)
    assert.equal(ctx.home, undefined)
  })

  it('another world is ignored', () => {
    const now = Date.now()
    const ctx1 = {}
    fillCtx(ctx1, now)
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)
    const ctx2 = {}
    assert.equal(memory.restore(botAt(SPAWN_B), ctx2, file, now), null)
    assert.equal(ctx2.home, undefined)
    assert.equal(resources.count(ctx2), 0)
  })

  it('expired danger marks are dropped, the rest survives', () => {
    const now = Date.now()
    const ctx1 = {}
    fillCtx(ctx1, now - danger.TTL_MS - 1000)
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)
    const ctx2 = {}
    const back = memory.restore(botAt(SPAWN_A), ctx2, file, now)
    assert.ok(back)
    assert.equal(danger.count(ctx2), 0)
    assert.ok(ctx2.home.site instanceof Vec3)
    assert.equal(ctx2.home.site.x, 10)
    assert.equal(resources.count(ctx2), 2)
  })

  it('keeps earlier homes, current last, capped', () => {
    const now = Date.now()
    const ctx1 = { home: homeAt(1, 64, 1) }
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)
    const ctx2 = { home: homeAt(2, 64, 2) }
    assert.equal(memory.save(botAt(SPAWN_A), ctx2, file, now), true)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(raw.homes.length, 2)
    assert.deepEqual(raw.homes[1].site, { x: 2, y: 64, z: 2 })
    const ctx3 = {}
    memory.restore(botAt(SPAWN_A), ctx3, file, now)
    assert.ok(ctx3.home.site instanceof Vec3)
    assert.equal(ctx3.home.site.x, 2)
  })

  it('empty snapshot never touches the disk', () => {
    const now = Date.now()
    const ctx1 = {}
    fillCtx(ctx1, now)
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)
    const before = fs.readFileSync(file, 'utf8')
    // An 'end' before spawn ever restored (empty ctx, same world) must not
    // clobber the real file with empty stores.
    assert.equal(memory.save(botAt(SPAWN_A), {}, file, now), false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    // ...nor create a file that was never there.
    const missing = path.join(dir, 'new.json')
    assert.equal(memory.save(botAt(SPAWN_A), {}, missing, now), false)
    assert.equal(fs.existsSync(missing), false)
  })

  it('write is atomic: no tmp litter, save without world key fails clean', () => {
    const now = Date.now()
    const ctx1 = {}
    fillCtx(ctx1, now)
    assert.equal(memory.save(botAt(SPAWN_A), ctx1, file, now), true)
    assert.deepEqual(fs.readdirSync(dir), ['bot.json'])
    assert.equal(memory.save({ username: 'MemBot' }, {}, file, now), false)
  })

  it('throttled save writes once per window', () => {
    const now = Date.now()
    const ctx = {}
    fillCtx(ctx, now)
    const bot = botAt(SPAWN_A)
    assert.equal(memory.saveThrottled(bot, ctx, now), true)
    const mtime = fs.statSync(file).mtimeMs
    ctx.home.built = false
    assert.equal(memory.saveThrottled(bot, ctx, now + 1000), false)
    assert.equal(fs.statSync(file).mtimeMs, mtime)
    assert.equal(memory.saveThrottled(bot, ctx, now + memory.SAVE_MIN_MS + 1), true)
    assert.notEqual(fs.statSync(file).mtimeMs, mtime)
  })

  it('ticker setHome persists; a new ticker with the same file resumes it', () => {
    const index = require('../src/index')
    const bot1 = { username: 'MemBot', spawnPoint: { ...SPAWN_A } }
    const t1 = index.createTicker({ bot: bot1, brain: null })
    t1.setHome(homeAt(7, 64, 9))
    const bot2 = { username: 'MemBot', spawnPoint: { ...SPAWN_A } }
    const t2 = index.createTicker({ bot: bot2, brain: null })
    assert.equal(t2.home(), null)
    t2.loadMemory()
    assert.ok(t2.home().site instanceof Vec3)
    assert.deepEqual({ x: t2.home().site.x, y: t2.home().site.y, z: t2.home().site.z }, { x: 7, y: 64, z: 9 })
  })

  it('runOnce restores before adopting: a saved home skips adoptHome', async () => {
    const { EventEmitter } = require('node:events')
    const index = require('../src/index')
    const goal = require('../src/goal')
    function connBot(spawn) {
      const bot = new EventEmitter()
      bot.username = 'MemBot'
      bot.spawnPoint = { ...spawn }
      bot.players = {}
      bot.entities = {}
      bot.health = 20
      bot.food = 20
      bot.entity = { position: { x: spawn.x, y: spawn.y, z: spawn.z } }
      bot.registry = require('minecraft-data')('1.21.1')
      bot.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: () => {}, setMovements: () => {} }
      bot.loadPlugin = () => {}
      bot.quit = () => {}
      bot.chat = () => {}
      return bot
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const origAdopt = goal.adoptHome
    let adopts = 0
    goal.adoptHome = (b) => { adopts++; return origAdopt(b) }
    try {
      // Saved home present: load wins, adopt never runs.
      const now = Date.now()
      assert.equal(memory.save(botAt(SPAWN_A), { home: homeAt(7, 64, 9) }, file, now), true)
      const bot = connBot(SPAWN_A)
      runOnceFor(index, bot, brain)
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(adopts, 0)
      assert.equal(bot._tickerCtx.home.site.x, 7)
      // No memory file: adopt runs as before.
      fs.rmSync(file)
      adopts = 0
      const bot2 = connBot(SPAWN_A)
      runOnceFor(index, bot2, brain)
      bot2.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(adopts, 1)
      assert.equal(bot2._tickerCtx.home || null, null)
    } finally {
      goal.adoptHome = origAdopt
    }
    function runOnceFor(index, bot, brain) {
      index.runOnce({
        host: 'x', port: 1, username: 'MemBot', tickMs: 60000, idleTickMs: 60000,
        brain, leaveAfterMs: 0, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
    }
  })

  it("runOnce saves on 'end', even before spawn ever restored", async () => {
    const { EventEmitter } = require('node:events')
    const index = require('../src/index')
    function connBot(spawn) {
      const bot = new EventEmitter()
      bot.username = 'MemBot'
      bot.spawnPoint = { ...spawn }
      bot.players = {}
      bot.entity = { position: { x: spawn.x, y: spawn.y, z: spawn.z } }
      bot.registry = require('minecraft-data')('1.21.1')
      bot.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: () => {}, setMovements: () => {} }
      bot.loadPlugin = () => {}
      bot.quit = () => {}
      bot.chat = () => {}
      return bot
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const realExit = process.exit
    process.exit = () => { throw new Error('exit') }
    try {
      // Post-spawn end with a home in ctx: the file is written.
      const bot = connBot(SPAWN_A)
      index.runOnce({
        host: 'x', port: 1, username: 'MemBot', tickMs: 60000, idleTickMs: 60000,
        brain, leaveAfterMs: 0, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      bot._tickerCtx.home = homeAt(7, 64, 9)
      assert.throws(() => bot.emit('end', 'boom'), /exit/)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(raw.homes[raw.homes.length - 1].site.x, 7)
      // Pre-spawn end: the real file keeps its stores, nothing clobbered.
      const now = Date.now()
      const full = {}
      fillCtx(full, now)
      assert.equal(memory.save(botAt(SPAWN_A), full, file, now), true)
      const before = fs.readFileSync(file, 'utf8')
      const bot2 = connBot(SPAWN_A)
      index.runOnce({
        host: 'x', port: 1, username: 'MemBot', tickMs: 60000, idleTickMs: 60000,
        brain, leaveAfterMs: 0, followName: '',
        createBot: () => bot2, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
      assert.throws(() => bot2.emit('end', 'early'), /exit/)
      assert.equal(fs.readFileSync(file, 'utf8'), before)
    } finally {
      process.exit = realExit
    }
  })

  it("runOnce saves before fatal on 'kicked' (Paper shutdown)", async () => {
    const { EventEmitter } = require('node:events')
    const index = require('../src/index')
    function connBot(spawn) {
      const bot = new EventEmitter()
      bot.username = 'MemBot'
      bot.spawnPoint = { ...spawn }
      bot.players = {}
      bot.entity = { position: { x: spawn.x, y: spawn.y, z: spawn.z } }
      bot.registry = require('minecraft-data')('1.21.1')
      bot.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: () => {}, setMovements: () => {} }
      bot.loadPlugin = () => {}
      bot.quit = () => {}
      bot.chat = () => {}
      return bot
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const realExit = process.exit
    process.exit = () => { throw new Error('exit') }
    try {
      const bot = connBot(SPAWN_A)
      index.runOnce({
        host: 'x', port: 1, username: 'MemBot', tickMs: 60000, idleTickMs: 60000,
        brain, leaveAfterMs: 0, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      bot._tickerCtx.home = homeAt(7, 64, 9)
      // A deploy shutdown arrives as kicked and fatal() would skip 'end':
      // the save must land before the exit.
      assert.throws(() => bot.emit('kicked', 'shutdown'), /exit/)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(raw.homes[raw.homes.length - 1].site.x, 7)
    } finally {
      process.exit = realExit
    }
  })

  it('runOnce SIGTERM handler saves the live connection', async () => {
    const { EventEmitter } = require('node:events')
    const index = require('../src/index')
    function connBot(spawn) {
      const bot = new EventEmitter()
      bot.username = 'MemBot'
      bot.spawnPoint = { ...spawn }
      bot.players = {}
      bot.entity = { position: { x: spawn.x, y: spawn.y, z: spawn.z } }
      bot.registry = require('minecraft-data')('1.21.1')
      bot.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: () => {}, setMovements: () => {} }
      bot.loadPlugin = () => {}
      bot.quit = () => {}
      bot.chat = () => {}
      return bot
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const realExit = process.exit
    process.exit = () => { throw new Error('exit') }
    try {
      const bot = connBot(SPAWN_A)
      index.runOnce({
        host: 'x', port: 1, username: 'MemBot', tickMs: 60000, idleTickMs: 60000,
        brain, leaveAfterMs: 0, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await new Promise((r) => setTimeout(r, 50))
      bot._tickerCtx.home = homeAt(7, 64, 9)
      // Container stop: no mineflayer event, only the process handler.
      // (Consumes index.js's once-per-process SIGTERM listener.)
      assert.throws(() => process.emit('SIGTERM'), /exit/)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(raw.homes[raw.homes.length - 1].site.x, 7)
    } finally {
      process.exit = realExit
    }
  })
})
