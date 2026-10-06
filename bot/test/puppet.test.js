'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { findHumans, parseArgs, startControlServer } = require('../tools/puppet')
const { handleChat } = require('../src/index')

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
    yielded: false, connected: true, calls: [], logged: [], touches: 0,
    gate() {
      if (h.yielded) return { status: 409, error: 'human online' }
      if (!h.connected) return { status: 503, error: 'not connected' }
      return null
    },
    touch() { h.touches++ },
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

  it('/state stays 200 after yield and polls neither log nor idle-touch', async () => {
    const hooks = fakeHooks()
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    hooks.yielded = true
    const r = await get(port, '/state?n=5')
    assert.equal(r.status, 200)
    assert.equal(r.body.state, 'yielded')
    assert.deepEqual(hooks.logged, [])
    assert.equal(hooks.touches, 0)
  })

  it('control calls log and idle-touch even when gated', async () => {
    const hooks = fakeHooks()
    hooks.yielded = true
    const srv = await startControlServer(0, hooks)
    servers.push(srv)
    const port = srv.address().port
    const r = await post(port, '/stop', {})
    assert.equal(r.status, 409)
    assert.equal(hooks.touches, 1)
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
