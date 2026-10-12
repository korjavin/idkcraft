// idkcraft-neuc.2: BOT_BODY switch (selectBody/main wiring) + bridge
// createBot lifecycle/state-mapping tests. Run: `cd bot && npm test`.
'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { selectBody, runOnce } = require('../src/index')
const bridge = require('../src/bridge/index')
const { BaritoneBot, createBot } = bridge
const { FakeTransport } = require('../src/bridge/transport')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function once(emitter, name, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), ms)
    emitter.once(name, (...args) => { clearTimeout(timer); resolve(args) })
  })
}
// The handshake logs its progress; tests assert on seams, not the log.
async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = orig
  }
}

describe('selectBody (BOT_BODY switch)', () => {
  it('unset means mineflayer with no createBot override', () => {
    const sel = selectBody({})
    assert.equal(sel.name, 'mineflayer')
    assert.ok(!('createBot' in sel), 'v1 keeps runOnce default factory')
    assert.ok(!('bodyTag' in sel), 'v1 log line untouched')
    assert.ok(!sel.fatal && !sel.idle)
  })

  it("'mineflayer' is explicit v1", () => {
    const sel = selectBody({ BOT_BODY: 'mineflayer' })
    assert.equal(sel.name, 'mineflayer')
    assert.ok(!('createBot' in sel))
  })

  it('baritone with a name hands runOnce the bridge factory + tag', () => {
    const sel = selectBody({ BOT_BODY: 'baritone', BOT_USERNAME: 'IdkBody' })
    assert.equal(sel.name, 'baritone')
    assert.equal(sel.createBot, bridge.createBot)
    assert.equal(sel.bodyTag, ' body=baritone')
    assert.ok(!sel.fatal && !sel.idle)
  })

  it('baritone with an empty or missing name idles (never joins as IdkBot)', () => {
    assert.equal(selectBody({ BOT_BODY: 'baritone', BOT_USERNAME: '' }).idle, true)
    assert.equal(selectBody({ BOT_BODY: 'baritone' }).idle, true)
  })

  it('unknown bodies are fatal with a one-line message', () => {
    const sel = selectBody({ BOT_BODY: 'bogus' })
    assert.ok(typeof sel.fatal === 'string' && sel.fatal.includes('bogus'))
    assert.equal(sel.fatal.includes('\n'), false)
  })
})

describe('runOnce bodyTag (spawned-as line)', () => {
  function tagBot() {
    const bot = new EventEmitter()
    bot.username = 'IdkBot'
    bot.players = {}
    bot.entities = {}
    bot.health = 20
    bot.food = 20
    bot.entity = { position: { x: 0, y: 64, z: 0 } }
    bot.spawnPoint = { x: 0, y: 64, z: 0 }
    bot.registry = require('minecraft-data')('1.21.1')
    bot.pathfinder = { isMoving: () => false, stop: () => {}, setGoal: () => {}, setMovements: () => {} }
    bot.loadPlugin = () => {}
    bot.quit = () => {}
    bot.chat = () => {}
    return bot
  }
  function tagBrain() {
    return { async decide() { return { action: 'idle' } } }
  }
  async function spawnLine(extraArgs) {
    const lines = []
    const origLog = console.log
    console.log = (l) => { lines.push(String(l)) }
    try {
      const bot = tagBot()
      runOnce({
        host: 'x', port: 1, username: 'IdkBot', tickMs: 10, idleTickMs: 100000,
        brain: tagBrain(), leaveAfterMs: 0, followName: '',
        createBot: () => bot, pingFn: async () => ({ players: { online: 0 } }),
        ...extraArgs,
      }).then(() => {}, () => {})
      bot.emit('spawn')
      await sleep(50)
      return lines.find((l) => l.startsWith('spawned as')) || null
    } finally {
      console.log = origLog
    }
  }

  it('v1 line is byte-identical (no tag by default)', async () => {
    assert.equal(await spawnLine({}), 'spawned as IdkBot')
  })

  it('v2 line gains the body tag', async () => {
    assert.equal(await spawnLine({ bodyTag: ' body=baritone' }), 'spawned as IdkBot body=baritone')
  })
})

describe('bridge self-containment', () => {
  it('bot/src/bridge/* never requires bot/src outside bridge/', () => {
    const dir = path.join(__dirname, '..', 'src', 'bridge')
    const pkg = require('../package.json')
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ])
    const bad = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const target = m[1]
        if (target.startsWith('node:')) continue
        if (target.startsWith('.')) {
          const resolved = path.posix.normalize(path.posix.join('src/bridge', target))
          if (!resolved.startsWith('src/bridge/')) bad.push(`${f}: ${target} escapes bridge/`)
        } else if (!declared.has(target)) {
          bad.push(`${f}: ${target} is not a declared dependency`)
        }
      }
    }
    assert.deepEqual(bad, [])
  })
})

describe('createBot lifecycle on FakeTransport', () => {
  function rig(state = {}) {
    const transport = new FakeTransport(state)
    const consoleLines = []
    const inj = { transport, consoleSend: async (line) => { consoleLines.push(line); return true } }
    return { transport, consoleLines, inj }
  }

  it('handshakes (console connect, hello, first state) then login+spawn', async () => {
    const { consoleLines, inj, transport } = rig()
    const order = []
    await quiet(async () => {
      const bot = createBot({ host: 'x', port: 1, username: 'IdkBody' }, inj)
      bot.on('login', () => order.push('login'))
      bot.on('spawn', () => order.push('spawn'))
      bot.on('error', () => {})
      await once(bot, 'spawn')
      assert.deepEqual(order, ['login', 'spawn'])
      assert.deepEqual(consoleLines, ['connect x 1'])
      assert.equal(bot.username, 'IdkBody')
      assert.equal(bot.version, '26.1.2')
      assert.equal(bot.protocolVersion, 775)
      assert.equal(bot.registry && bot.registry.version && bot.registry.version.minecraftVersion, '26.1')
      assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [0, 64, 0])
      assert.equal(typeof bot.loadPlugin, 'function')
      bot.loadPlugin() // runOnce calls this on every body: must not throw
      const endP = once(bot, 'end')
      bot.quit('test done')
      const [reason] = await endP
      assert.equal(reason, 'test done')
      assert.ok(transport.connected === false)
    })
    assert.deepEqual(consoleLines.slice(-1), ['disconnect'])
  })

  it('unknown hello.mc surfaces as error, never spawn', async () => {
    // FakeTransport answers hello from code; override the one call.
    const transport = new FakeTransport()
    const origCall = transport.call.bind(transport)
    transport.call = async (method, params) => (method === 'hello' ? { mod: 'idkcraft-bridge', v: 0, mc: 'bogus-9.9' } : origCall(method, params))
    await quiet(async () => {
      const bot = createBot({ host: 'x', port: 1, username: 'IdkBody' }, { transport, consoleSend: async () => true })
      let spawned = false
      bot.on('spawn', () => { spawned = true })
      const [err] = await once(bot, 'error')
      assert.ok(String(err && err.message).includes('no minecraft-data'))
      assert.equal(spawned, false)
      await bot.stop()
    })
  })

  it('socket close while connected ends the bot (runOnce fatal()s = reconnect)', async () => {
    const { inj, transport } = rig()
    await quiet(async () => {
      const bot = createBot({ host: 'x', port: 1, username: 'IdkBody' }, inj)
      bot.on('error', () => {})
      await once(bot, 'spawn')
      const endP = once(bot, 'end')
      transport.close()
      const [reason] = await endP
      assert.equal(reason, 'bridge closed')
      await bot.stop()
    })
  })

  it('no spawn until the first state with a non-null pos', async () => {
    const { inj, transport } = rig({ pos: null })
    await quiet(async () => {
      const bot = createBot({ host: 'x', port: 1, username: 'IdkBody' }, inj)
      bot.on('error', () => {})
      let spawned = false
      bot.on('spawn', () => { spawned = true })
      await sleep(300)
      assert.equal(spawned, false)
      transport.state.pos = { x: 5, y: 65, z: 5, yaw: 0, pitch: 0, onGround: true, vel: { x: 0, y: 0, z: 0 } }
      await once(bot, 'spawn')
      assert.equal(spawned, true)
      assert.deepEqual([bot.entity.position.x, bot.entity.position.z], [5, 5])
      bot.quit('test done')
      await once(bot, 'end')
    })
  })
})

describe('bridge state mapping + chat shape', () => {
  function mappedBot(state = {}) {
    const transport = new FakeTransport({
      pos: { x: 1, y: 65, z: 2, yaw: 1.5, pitch: -0.2, onGround: false, vel: { x: 0.5, y: -1, z: 0 } },
      health: 15,
      food: 12,
      oxygen: 7,
      time: { age: 24000 + 6000, timeOfDay: 6000, day: 1, isDay: true },
      spawn: { x: 10, y: 64, z: -3 },
      isRaining: true,
      isSleeping: true,
      dimension: 'minecraft:the_nether',
      gameMode: 1,
      ...state,
    })
    const bot = new BaritoneBot(transport, { Vec3, registry: { blocksByName: {} }, username: 'IdkBody' })
    return { transport, bot }
  }

  it('maps the epic-contract state.get onto mineflayer shapes', async () => {
    const { bot } = mappedBot()
    await bot.start({ pollMs: 0 })
    try {
      assert.deepEqual([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z], [1, 65, 2])
      assert.deepEqual([bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z], [0.5, -1, 0])
      assert.equal(bot.entity.yaw, 1.5)
      assert.equal(bot.entity.pitch, -0.2)
      assert.equal(bot.entity.onGround, false)
      assert.equal(bot.health, 15)
      assert.equal(bot.food, 12)
      assert.equal(bot.oxygenLevel, 7)
      assert.equal(bot.time.age, 30000)
      assert.equal(bot.time.timeOfDay, 6000)
      assert.equal(bot.time.day, 1)
      assert.equal(bot.time.isDay, true)
      assert.equal(bot.time.time, 30000)
      assert.equal(bot.time.moonPhase, 1)
      assert.deepEqual([bot.spawnPoint.x, bot.spawnPoint.y, bot.spawnPoint.z], [10, 64, -3])
      assert.equal(bot.isRaining, true)
      assert.equal(bot.isSleeping, true)
      assert.equal(bot.game.dimension, 'the_nether') // minecraft: prefix stripped like mineflayer
      assert.equal(bot.game.gameMode, 'creative') // numeric gameMode mapped like mineflayer
    } finally {
      await bot.stop()
    }
  })

  it('missing optional state keeps the previous values (older mod tolerated)', async () => {
    const { bot } = mappedBot()
    await bot.start({ pollMs: 0 })
    try {
      assert.equal(bot.time.day, 1)
      bot.transport.state.time = null
      bot.transport.state.oxygen = undefined
      bot.transport.state.dimension = undefined
      await bot.refresh()
      assert.equal(bot.time.day, 1)
      assert.equal(bot.oxygenLevel, 7)
      assert.equal(bot.game.dimension, 'the_nether')
    } finally {
      await bot.stop()
    }
  })

  it("chat events arrive as chat + message with position and sender uuid (index.js:1485's shape)", async () => {
    const { bot, transport } = mappedBot()
    await bot.start({ pollMs: 0 })
    try {
      const seen = {}
      bot.on('chat', (username, message) => { seen.chat = [username, message] })
      bot.on('message', (msg, position, uuid) => { seen.message = [String(msg), position, uuid] })
      transport.inject('chat', { username: 'Owner', uuid: 'uuid-1', message: 'where are you', position: 'chat' })
      assert.deepEqual(seen.chat, ['Owner', 'where are you'])
      assert.deepEqual(seen.message, ['where are you', 'chat', 'uuid-1'])
    } finally {
      await bot.stop()
    }
  })
})

describe('main() wiring (child process)', () => {
  const INDEX = path.join(__dirname, '..', 'src', 'index.js')

  it('unknown BOT_BODY exits 1 with the one-line message', async () => {
    const { code, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [INDEX], {
        env: { ...process.env, BOT_BODY: 'bogus', BOT_USERNAME: 'IdkBody' },
        timeout: 15000,
      }, (err, _stdout, stderr) => resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stderr: String(stderr) }))
    })
    assert.equal(code, 1)
    assert.ok(stderr.includes('unknown BOT_BODY=bogus'), `stderr was: ${stderr.slice(0, 200)}`)
  })

  it('baritone with an empty name logs v2 idle once and stays up', async () => {
    const child = spawn(process.execPath, [INDEX], {
      env: { ...process.env, BOT_BODY: 'baritone', BOT_USERNAME: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      const deadline = Date.now() + 15000
      while (!out.includes('v2 idle: BOT_USERNAME empty') && Date.now() < deadline) await sleep(100)
      assert.ok(out.includes('v2 idle: BOT_USERNAME empty'), `stdout was: ${out.slice(0, 200)}`)
      assert.equal(child.exitCode, null, 'idle never exits')
      assert.equal(out.split('v2 idle').length - 1, 1, 'logged once')
    } finally {
      child.kill('SIGKILL')
    }
  })
})
