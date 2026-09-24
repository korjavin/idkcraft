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
    assert.deepEqual(ctx2.home.site, { x: 10, y: 64, z: 20 })
    assert.equal(ctx2.home.built, true)
    assert.deepEqual(ctx2.home.table, { x: 11, y: 64, z: 20 })
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
    assert.deepEqual(ctx2.home.site, { x: 10, y: 64, z: 20 })
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
    assert.deepEqual(ctx3.home.site, { x: 2, y: 64, z: 2 })
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
    assert.deepEqual(t2.home().site, { x: 7, y: 64, z: 9 })
  })
})
