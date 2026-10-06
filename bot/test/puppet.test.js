'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { findHumans, parseArgs, startControlServer, puppetMovements } = require('../tools/puppet')
const { handleChat } = require('../src/index')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    const req = http.request({ host: 'localhost', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }))
    }).on('error', reject)
  })
}

// Fake puppet behind the real HTTP + gating: no MC server anywhere.
function fakeHooks() {
  const h = {
    yielded: false, connected: true, calls: [], logged: [],
    gate() {
      if (h.yielded) return { status: 409, error: 'human online' }
      if (!h.connected) return { status: 503, error: 'not connected' }
      return null
    },
    idleMs: 60000, idles: 0,
    onIdle() { h.idles++ },
    logCall(line) { h.logged.push(line) },
    state: (n) => ({ state: h.yielded ? 'yielded' : 'online', chat: [], n }),
    say: async (body) => {
      const text = body && body.text
      if (typeof text !== 'string' || text.length === 0 || text.length > 256) return { status: 400, error: 'text must be a 1..256 char string' }
      h.calls.push(['say', text])
      return { status: 200 }
    },
    goto: async (body) => { h.calls.push(['goto', body]); return { status: 200, body: { ok: true, goal: body } } },
    look: async (body) => { h.calls.push(['look', body]); return { status: 200 } },
    stop: async () => { h.calls.push(['stop']); return { status: 200 } },
    quit: () => { h.calls.push(['quit']) },
  }
  return h
}

let servers = []
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  servers = []
})

describe('puppet human detection (idkcraft-jlw7)', () => {
  it('empty roster plus bot and puppet is nobody human', () => {
    assert.deepEqual(findHumans(['IdkTester', 'IdkBot'], 'IdkBot', 'IdkTester'), [])
  })

  it('a Java name other than bot/puppet is human', () => {
    assert.deepEqual(findHumans(['IdkTester', 'IdkBot', 'Steve'], 'IdkBot', 'IdkTester'), ['Steve'])
  })

  it('a Bedrock .name is human (exact match, no dot-stripping)', () => {
    assert.deepEqual(findHumans(['IdkTester', 'IdkBot', '.Steve'], 'IdkBot', 'IdkTester'), ['.Steve'])
  })

  it('custom bot/puppet names are excluded by their own values', () => {
    assert.deepEqual(findHumans(['P1', 'B1', 'Steve'], 'B1', 'P1'), ['Steve'])
  })

  it('null roster reads as nobody', () => {
    assert.deepEqual(findHumans(null, 'IdkBot', 'IdkTester'), [])
  })
})

describe('puppet argv/env (idkcraft-jlw7)', () => {
  it('defaults join localhost as IdkTester', () => {
    const cfg = parseArgs([], {})
    assert.equal(cfg.host, 'localhost')
    assert.equal(cfg.port, 25565)
    assert.equal(cfg.name, 'IdkTester')
    assert.equal(cfg.botName, 'IdkBot')
    assert.equal(cfg.httpPort, 18080)
    assert.equal(cfg.idleMs, 15 * 60 * 1000)
  })

  it('argv wins over env', () => {
    const cfg = parseArgs(['--host=example.invalid', '--port=25566', '--name=P', '--bot-name=B', '--http-port=18081', '--log=/tmp/x.jsonl', '--idle-ms=60000'], { PUPPET_HOST: 'other.invalid' })
    assert.equal(cfg.host, 'example.invalid')
    assert.equal(cfg.port, 25566)
    assert.equal(cfg.name, 'P')
    assert.equal(cfg.botName, 'B')
    assert.equal(cfg.httpPort, 18081)
    assert.equal(cfg.log, '/tmp/x.jsonl')
    assert.equal(cfg.idleMs, 60000)
  })

  it('env fills what argv omits', () => {
    const cfg = parseArgs([], { PUPPET_HOST: 'example.invalid', BOT_USERNAME: 'B' })
    assert.equal(cfg.host, 'example.invalid')
    assert.equal(cfg.botName, 'B')
  })

  it('rejects bad port, overlong name, unknown arg', () => {
    assert.throws(() => parseArgs(['--port=abc'], {}), /bad port/)
    assert.throws(() => parseArgs(['--name=12345678901234567'], {}), /1\.\.16/)
    assert.throws(() => parseArgs(['--nope=1'], {}), /unknown arg/)
  })

  it('empty env reads as unset, not zero (verify #310.4)', () => {
    const cfg = parseArgs([], { PUPPET_PORT: '', PUPPET_IDLE_MS: '' })
    assert.equal(cfg.port, 25565)
    assert.equal(cfg.idleMs, 15 * 60 * 1000)
  })
})

describe('puppet 409 gate (idkcraft-jlw7)', () => {
  it('/say works open, 409s after yield, and never runs the act gated', async () => {
    const hooks = fakeHooks()
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    const bound = srv.address().address
    assert.ok(bound === '::1' || bound.startsWith('127.'), `bound to ${bound}, want loopback`)
    let r = await post(port, '/say', { text: 'follow me' })
    assert.equal(r.status, 200)
    assert.deepEqual(hooks.calls, [['say', 'follow me']])
    hooks.yielded = true
    r = await post(port, '/say', { text: 'follow me' })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'human online')
    assert.deepEqual(hooks.calls, [['say', 'follow me']]) // gated: act not run
    r = await post(port, '/goto', { x: 1, y: 2, z: 3 })
    assert.equal(r.status, 409)
  })

  it('/state stays 200 after yield and polls are not logged', async () => {
    const hooks = fakeHooks()
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    hooks.yielded = true
    const r = await get(port, '/state?n=5')
    assert.equal(r.status, 200)
    assert.equal(r.body.state, 'yielded')
    assert.deepEqual(hooks.logged, [])
  })

  it('a gate that flips mid-request still 409s (verify #310.2)', async () => {
    // A human joining between the accept and the body read: the post-read
    // re-check must deny what the pre-read check allowed.
    const hooks = fakeHooks()
    let n = 0
    hooks.gate = () => (++n > 1 ? { status: 409, error: 'human online' } : null)
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    const r = await post(port, '/say', { text: 'follow me' })
    assert.equal(r.status, 409)
    assert.deepEqual(hooks.calls, []) // denied: act not run
  })

  it('control calls log even when gated', async () => {
    const hooks = fakeHooks()
    hooks.yielded = true
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    const r = await post(port, '/stop', {})
    assert.equal(r.status, 409)
    assert.equal(hooks.logged.length, 1)
    assert.equal(hooks.logged[0].path, '/stop')
    assert.equal(hooks.logged[0].status, 409)
  })

  it('bad bodies are 400 and unknown paths 404', async () => {
    const hooks = fakeHooks()
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    let r = await post(port, '/say', { text: '' })
    assert.equal(r.status, 400)
    r = await post(port, '/nope', {})
    assert.equal(r.status, 404)
    r = await get(port, '/say')
    assert.equal(r.status, 405)
  })
})

describe('puppet idle watchdog (verify #310.3)', () => {
  it('fires with no control calls at all', async () => {
    const hooks = fakeHooks()
    hooks.idleMs = 60
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    await sleep(300)
    assert.equal(hooks.idles, 1)
  })

  it('a control call re-arms the clock', async () => {
    const hooks = fakeHooks()
    hooks.idleMs = 200
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    await sleep(100)
    await post(port, '/stop', {})
    await sleep(150) // past the original deadline, before the re-armed one
    assert.equal(hooks.idles, 0)
    await sleep(400)
    assert.equal(hooks.idles, 1)
  })

  it('/state polls do not re-arm the clock', async () => {
    const hooks = fakeHooks()
    hooks.idleMs = 150
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    for (let i = 0; i < 4; i++) { await get(port, '/state'); await sleep(40) }
    await sleep(250)
    assert.equal(hooks.idles, 1)
  })
})

describe('puppet /state chat default (verify #310.4)', () => {
  it('a plain GET /state asks for 20 lines, not 1', async () => {
    const hooks = fakeHooks()
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    const r = await get(port, '/state')
    assert.equal(r.status, 200)
    assert.equal(r.body.n, 20)
  })
})

describe('puppet movements never dig or place (verify #310.1)', () => {
  it('canDig off, no towers, zero scaffolding even holding dirt', () => {
    const registry = require('minecraft-data')('1.21.1')
    const dirt = registry.itemsByName.dirt.id
    const bot = { registry, inventory: { items: () => [{ type: dirt, count: 64 }] } }
    const mov = puppetMovements(bot)
    assert.equal(mov.canDig, false)
    assert.equal(mov.allow1by1towers, false)
    assert.deepEqual(mov.scafoldingBlocks, [])
    assert.equal(mov.countScaffoldingItems(), 0)
  })
})

describe('puppet chat tag (idkcraft-jlw7)', () => {
  it("handleChat logs 'chat from=<name> msg=<msg>'", () => {
    const bot = {
      username: 'IdkBot',
      players: { IdkTester: { username: 'IdkTester', entity: { position: { x: 1, y: 64, z: 1 } } } },
      entity: { position: { x: 0, y: 64, z: 0 } },
      chats: [],
      chat(m) { this.chats.push(String(m)) },
    }
    const lines = []
    const orig = console.log
    console.log = (...a) => { lines.push(a.join(' ')) }
    try {
      handleChat(bot, null, 'IdkTester', 'follow me')
    } finally {
      console.log = orig
    }
    assert.ok(lines.some((l) => l === 'chat from=IdkTester msg=follow me'), `lines: ${JSON.stringify(lines)}`)
  })
})
