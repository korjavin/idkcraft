'use strict'

// idkcraft-vmzq.1: the unattended build oracle runs end to end — a fake
// puppet (the HTTP surface of bot/tools/puppet.js) and a fake VictoriaLogs
// endpoint drive task-run.sh through every exit code. No MC server, no prod.

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const TOOLS = path.join(__dirname, '..', 'tools')
const SCRIPT = path.join(TOOLS, 'task-run.sh')
const MC_SENTINEL = 'mc-host-sentinel-xyz'
const TOKEN_SENTINEL = 'grafana-token-sentinel-xyz'

// The shipped chat lines, byte for byte: follow-unseen uses curly quotes
// (chat.js), the build-here refusal straight ones.
const UNSEEN_AT = 'I can’t see you — I’m at 10 64 20 (~30 blocks from spawn); come closer or /tp IdkBot IdkTester'
const BUILD_HERE_ACK = 'building a home at 10 64 20'
const BUILD_HERE_NOSEE = "I can't see you, come closer"
const CASTLE_ACK = 'castle at 1 64 3, ~1722 blocks, this will take many hours; I work while someone is online (or autonomous on)'
const HOUSE_DONE = '[16:14:17 INFO]: [Not Secure] <IdkBot> home done at 10 64 20'
const HOUSE_PROGRESS = '[16:14:17 INFO]: [Not Secure] <IdkBot> building 45/99'
const CASTLE_DONE = '[16:14:17 INFO]: [Not Secure] <IdkBot> castle done at 1 64 3'

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, 'localhost', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

// VictoriaLogs _time carries whole seconds: the fake matches prod.
const nowIsoSec = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

function writeFakePuppet(dir) {
  const file = path.join(dir, 'fake-puppet.js')
  fs.writeFileSync(file, `'use strict'
// Test fake for task-run.sh: the puppet HTTP surface only (--http-port is
// the only argv it reads). Scenario JSON comes from FAKE_SCENARIO:
// { bot, dist0, gotoReveals, sayStatus, stateStatus, replies: { text: [lines] } }.
const http = require('node:http')
const fs = require('node:fs')
const port = Number((process.argv.find((a) => a.startsWith('--http-port=')) || '=').split('=')[1])
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'))
const reqlog = process.env.FAKE_REQLOG
const log = (o) => fs.appendFileSync(reqlog, JSON.stringify(o) + '\\n')
const chat = []
let dist = scenario.dist0 === undefined ? null : scenario.dist0
const t0 = Date.now()
const botHere = () => !scenario.rosterSansBot || (Date.now() - t0) >= Number(scenario.botDelayMs || 0)
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x')
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj) + '\\n') }
    if (req.method === 'POST' && u.pathname === '/say') {
      let text = ''
      try { text = JSON.parse(body || '{}').text } catch (_) { text = '' }
      log({ op: 'say', text, botPresent: botHere() })
      if (scenario.sayStatus === 409) return send(409, { error: 'human online' })
      for (const m of (scenario.replies || {})[text] || []) chat.push({ t: new Date().toISOString(), from: scenario.bot || 'IdkBot', msg: m })
      if (botHere()) for (const m of (scenario.repliesWhenBotHere || {})[text] || []) chat.push({ t: new Date().toISOString(), from: scenario.bot || 'IdkBot', msg: m })
      return send(200, { ok: true })
    }
    if (req.method === 'POST' && u.pathname === '/goto') {
      log({ op: 'goto', body })
      if (scenario.gotoReveals !== false) dist = 12.5
      return send(200, { ok: true })
    }
    if (req.method === 'POST' && u.pathname === '/stop') return send(200, { ok: true })
    if (req.method === 'GET' && u.pathname === '/state') {
      if (scenario.stateStatus === 409) return send(409, { error: 'human online' })
      const n = Math.min(100, Math.max(1, Number(u.searchParams.get('n')) || 20))
      return send(200, { state: 'online', connected: true,
        bot: { name: 'IdkBot', pos: dist === null ? null : { x: 1, y: 2, z: 3 }, dist },
        roster: botHere() ? ['IdkTester', 'IdkBot'] : ['IdkTester'], humans: [], chat: chat.slice(-n) })
    }
    if (req.method === 'POST' && u.pathname === '/quit') {
      send(200, { ok: true })
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
      return
    }
    return send(404, { error: 'nope' })
  })
})
server.listen(port, 'localhost', () => {})
`)
  return file
}

function fakeLogs(handler) {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const q = new URLSearchParams(body).get('query') || ''
      const out = handler(q)
      const status = out && typeof out === 'object' && !Array.isArray(out) ? out.status : 200
      const rows = out && typeof out === 'object' && !Array.isArray(out) ? out.rows : out
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, 'localhost', () => resolve({ srv, url: `http://localhost:${srv.address().port}/select/logsql/query` }))
  })
}

function runScript(args, env, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile('sh', [SCRIPT, ...args], { env: { ...process.env, ...env }, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? -1 : 0)
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), err })
    })
  })
}

function seriesOf(stdout) {
  const m = /series: (\S+)/.exec(stdout)
  assert.ok(m, `no series path in:\n${stdout}`)
  return JSON.parse(fs.readFileSync(m[1], 'utf8'))
}

function saidTexts(reqlog) {
  return fs.readFileSync(reqlog, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((o) => o.op === 'say').map((o) => o.text)
}

function saidOps(reqlog) {
  return fs.readFileSync(reqlog, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((o) => o.op === 'say')
}

const HOUSE_SKIP = 'build skip -35 63 -214 after 3 refusals (no-ref)'

describe('task-run.sh (idkcraft-vmzq.1)', () => {
  let dir
  let fakePuppet

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskrun-'))
    fakePuppet = writeFakePuppet(dir)
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function harness(t, { puppet, logs, extra = {}, budgetMin = '1' }) {
    const sub = fs.mkdtempSync(path.join(dir, `${t.name.replace(/[^a-z0-9]+/gi, '-')}-`))
    const scenarioFile = path.join(sub, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify(puppet))
    const reqlog = path.join(sub, 'requests.jsonl')
    fs.writeFileSync(reqlog, '')
    const { srv, url } = await fakeLogs(logs)
    const port = await freePort()
    try {
      const r = await runScript([t.task, budgetMin], {
        TASK_RUN_MC_HOST: MC_SENTINEL,
        TASK_RUN_MC_PORT: '29999',
        TASK_RUN_LOGS_URL: url,
        TASK_RUN_GRAFANA_TOKEN: TOKEN_SENTINEL,
        TASK_RUN_PUPPET_CMD: `node ${fakePuppet}`,
        TASK_RUN_HTTP_PORT: String(port),
        TASK_RUN_OUTDIR: sub,
        TASK_RUN_POLL_SECS: '2',
        TASK_RUN_MEET_SECS: '30',
        TASK_RUN_REPLY_SECS: '10',
        TASK_RUN_RESUMES: '1',
        FAKE_SCENARIO: scenarioFile,
        FAKE_REQLOG: reqlog,
        ...extra,
      })
      return { ...r, sub, reqlog }
    } finally {
      srv.close()
    }
  }

  const probeOk = (q) => (q.includes('stats count') ? [{ n: '1' }] : [])

  it('rejects bad args with exit 2', async () => {
    for (const args of [[], ['bogus'], ['house', '0'], ['house', '-5'], ['house', 'x']]) {
      const r = await runScript(args, { TASK_RUN_OUTDIR: dir })
      assert.equal(r.code, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`)
    }
    const r = await runScript([], { TASK_RUN_OUTDIR: dir })
    assert.match(r.stderr, /usage: task-run\.sh <house\|castle>/)
  })

  it('house happy path exits 0 with a done series', async () => {
    const r = await harness({ task: 'house', name: 'happy' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: HOUSE_PROGRESS }, { _time: nowIsoSec(), _msg: HOUSE_DONE }]
        return [{ _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
    })
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /window start \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)
    assert.match(r.stdout, /manual VictoriaLogs queries/)
    assert.match(r.stdout, /container_name:idkcraft-mc _time:\d+h home done at/)
    assert.match(r.stdout, /DONE within budget/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'done')
    assert.equal(s.task, 'house')
    assert.equal(s.order, 'build here')
    assert.equal(s.orderReply, BUILD_HERE_ACK)
    assert.deepEqual(s.events.map((e) => e.kind), ['progress', 'done'])
    assert.ok(!r.stdout.includes(MC_SENTINEL) && !r.stdout.includes(TOKEN_SENTINEL), 'secrets never print')
    const said = saidTexts(r.reqlog)
    assert.ok(said.includes('autonomous on') && said.includes('follow me') && said.includes('build here'), said.join(','))
    assert.ok(said.indexOf('autonomous on') > said.indexOf('follow me'), 'autonomous on only once the bot is seen (revmux 01 major)')
  })

  it('castle happy path exits 0 on the castle marker', async () => {
    const r = await harness({ task: 'castle', name: 'castle-happy' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build castle': [CASTLE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: CASTLE_DONE }]
        return [{ _time: nowIsoSec(), _msg: 'castle 1722/1722' }]
      },
    })
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'done')
    assert.ok(s.orderReply.includes('castle at '))
    assert.deepEqual(s.events.map((e) => e.kind).sort(), ['done', 'progress'])
  })

  it('budget exceeded exits 1 with the last lines, deduped series', async () => {
    let fixed = null // one log line re-fetched by every overlapping poll
    const r = await harness({ task: 'house', name: 'budget' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) {
          if (!fixed) fixed = nowIsoSec()
          return [{ _time: fixed, _msg: HOUSE_PROGRESS }]
        }
        return [{ _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
      extra: { TASK_RUN_BUDGET_SECS: '7' },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /BUDGET EXCEEDED/)
    assert.match(r.stdout, /last progress: .*building 45\/99/)
    assert.match(r.stdout, /--- last 20 bot lines ---/)
    assert.match(r.stdout, /decision source=goal-fsm action=build/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'budget-exceeded')
    assert.equal(s.events.filter((e) => e.kind === 'progress').length, 1, 'overlapping polls dedupe')
  })

  it('a human join voids the run with exit 2 (bot joins do not)', async () => {
    const r = await harness({ task: 'house', name: 'void' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) {
          return [
            { _time: nowIsoSec(), _msg: '[16:14:17 INFO]: IdkBot joined the game' },
            { _time: nowIsoSec(), _msg: '[16:14:17 INFO]: IdkTester left the game' },
            { _time: nowIsoSec(), _msg: '[16:14:17 INFO]: Steve joined the game' },
          ]
        }
        return []
      },
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /VOID — human joined \(Steve\)/)
    assert.equal(seriesOf(r.stdout).verdict, 'void-human')
  })

  it('a refused order exits 2 after one re-meet', async () => {
    const r = await harness({ task: 'house', name: 'refused' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_NOSEE] } },
      logs: probeOk,
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /order refused/)
    const said = saidTexts(r.reqlog)
    assert.equal(said.filter((t) => t === 'build here').length, 2, 'order, one retry, then give up')
  })

  it('no order reply exits 2', async () => {
    const r = await harness({ task: 'house', name: 'noreply' }, {
      puppet: { dist0: 5, replies: {} }, // visible at once, hears nothing back
      logs: probeOk,
      extra: { TASK_RUN_REPLY_SECS: '4' },
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /no order reply/)
  })

  it('a 409 from the puppet voids with exit 2', async () => {
    const r = await harness({ task: 'house', name: 'human409' }, {
      puppet: { sayStatus: 409, replies: {} },
      logs: probeOk,
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /human online \(409\)/)
  })

  it('a bot leave triggers one verified resume, then budget', async () => {
    let left = false
    const r = await harness({ task: 'house', name: 'resume' }, {
      puppet: { rosterSansBot: true, botDelayMs: 3000, replies: { 'follow me': [UNSEEN_AT], 'build here': [BUILD_HERE_ACK] }, repliesWhenBotHere: { 'autonomous on': ['autonomous on — stays'] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return []
        if (!left) { left = true; return [{ _time: nowIsoSec(), _msg: 'leaving: nobody online' }] }
        return [{ _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }] // the bot is back after the resume
      },
      extra: { TASK_RUN_BUDGET_SECS: '9', TASK_RUN_RESUMES: '1' },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /resume attempt 1\/1/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'budget-exceeded')
    assert.deepEqual(s.events.map((e) => e.kind).sort(), ['leave', 'resume'])
    assert.equal(s.resumesUsed, 1)
    assert.match(s.events.find((e) => e.kind === 'resume').line, /ok=1/)
    const autos = saidOps(r.reqlog).filter((o) => o.text === 'autonomous on')
    assert.ok(autos.length >= 2, 'order session + resume session')
    assert.equal(autos[autos.length - 1].botPresent, true, 'the resume says it only with the bot on the roster')
  })

  it('waiting for players triggers a resume like a leave', async () => {
    let waited = false
    const r = await harness({ task: 'house', name: 'waiting' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return []
        if (!waited) { waited = true; return [{ _time: nowIsoSec(), _msg: 'waiting for players' }] }
        return [{ _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
      extra: { TASK_RUN_BUDGET_SECS: '9', TASK_RUN_RESUMES: '1' },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'budget-exceeded')
    assert.deepEqual(s.events.map((e) => e.kind).sort(), ['resume', 'waiting'])
    assert.match(s.events.find((e) => e.kind === 'resume').line, /ok=1/)
  })

  it('a stale waiting line after a verified resume does not re-trigger', async () => {
    let polls = 0
    let firstT = null
    const r = await harness({ task: 'house', name: 'stale-waiting' }, {
      puppet: { rosterSansBot: true, botDelayMs: 3000, replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return []
        polls++
        if (polls === 1) { firstT = nowIsoSec(); return [{ _time: firstT, _msg: 'waiting for players' }] }
        // Ingestion lag: a NEW key from before the resume-end arrives late.
        const stale = new Date(Date.parse(firstT) + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
        return [{ _time: stale, _msg: 'waiting for players' }, { _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
      extra: { TASK_RUN_BUDGET_SECS: '11', TASK_RUN_RESUMES: '1' },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'budget-exceeded')
    assert.equal(s.resumesUsed, 1, 'one resume, not one per lagged line')
    assert.equal(s.events.filter((e) => e.kind === 'waiting').length, 2, 'both lines recorded')
  })

  it('an unverified resume with none left exits 2, not budget', async () => {
    let left = false
    const r = await harness({ task: 'house', name: 'resume-unverified' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'build here': [BUILD_HERE_ACK] } }, // `autonomous on` never answered
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return []
        if (!left) { left = true; return [{ _time: nowIsoSec(), _msg: 'leaving: nobody online' }] }
        return []
      },
      extra: { TASK_RUN_BUDGET_SECS: '60', TASK_RUN_RESUMES: '1', TASK_RUN_REPLY_SECS: '4' },
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /bot autonomy unverified/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'unverified')
    assert.match(s.events.find((e) => e.kind === 'resume').line, /ok=0/)
  })

  it('two silent polls trigger a resume; still silent with none left exits 2', async () => {
    const r = await harness({ task: 'house', name: 'silence' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        return [] // both containers answer, the bot just never ticks (a silent restart)
      },
      extra: { TASK_RUN_BUDGET_SECS: '60', TASK_RUN_RESUMES: '1' },
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /resume attempt 1\/1/)
    assert.match(r.stderr, /bot autonomy unverified/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'unverified')
    assert.equal(s.resumesUsed, 1)
    assert.match(s.events.find((e) => e.kind === 'resume').line, /ok=1/, 'the resume ran; the bot just never came back')
  })

  it('a house done over unhealed skips is PARTIAL, exit 1', async () => {
    const r = await harness({ task: 'house', name: 'partial' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: HOUSE_PROGRESS }, { _time: nowIsoSec(), _msg: HOUSE_DONE }]
        return [{ _time: nowIsoSec(), _msg: HOUSE_SKIP }, { _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /PARTIAL — done marker over unhealed skips: 1 /)
    assert.match(r.stdout, /last progress: .*building 45\/99/)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'partial')
    assert.deepEqual(s.events.map((e) => e.kind).sort(), ['done', 'progress', 'skip'])
  })

  it('a skip older than the horizon reads healed: DONE', async () => {
    let mcFetches = 0
    let botFetches = 0
    const r = await harness({ task: 'house', name: 'healed' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) {
          mcFetches++
          if (mcFetches < 4) return [{ _time: nowIsoSec(), _msg: HOUSE_PROGRESS }]
          return [{ _time: nowIsoSec(), _msg: HOUSE_DONE }]
        }
        botFetches++
        if (botFetches === 1) return [{ _time: nowIsoSec(), _msg: HOUSE_SKIP }]
        return [{ _time: nowIsoSec(), _msg: 'decision source=goal-fsm action=build' }]
      },
      extra: { TASK_RUN_SKIP_HORIZON_SECS: '2' },
    })
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'done')
    assert.ok(s.events.some((e) => e.kind === 'skip'), 'the old skip is recorded, just not vetoing')
  })

  it('a deploy restart is recorded, never voiding', async () => {
    const r = await harness({ task: 'house', name: 'restart' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return []
        return [{ _time: nowIsoSec(), _msg: 'spawned as IdkBot mc=26.1 proto=775 data=26.1' }]
      },
      extra: { TASK_RUN_BUDGET_SECS: '6' },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`) // budget, not void
    const s = seriesOf(r.stdout)
    assert.equal(s.verdict, 'budget-exceeded')
    assert.ok(s.events.some((e) => e.kind === 'restart'), JSON.stringify(s.events))
  })

  it('castle with no site exits 1 early with the diagnosis', async () => {
    const r = await harness({ task: 'castle', name: 'nosite' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build castle': ['not right here (water) — looking for a castle spot within 64 blocks…'] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: '[16:14:17 INFO]: [Not Secure] <IdkBot> I found no castle spot within 64 blocks — mostly water (9 of 12 spots); try another area' }]
        return []
      },
    })
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /no castle site/)
    assert.equal(seriesOf(r.stdout).verdict, 'no-site')
  })

  it('resolves the MC endpoint from kv, prints no secrets', async () => {
    const kv = path.join(dir, 'fake-kv.sh')
    fs.writeFileSync(kv, '#!/bin/sh\ncase "$2" in *mc-host) echo kv-host-sentinel-abc;; *mc-port) echo 29998;; *) exit 1;; esac\n')
    fs.chmodSync(kv, 0o755)
    const sub = fs.mkdtempSync(path.join(dir, 'kv-'))
    const scenarioFile = path.join(sub, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify({ replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['ok'], 'build here': [BUILD_HERE_ACK] } }))
    const reqlog = path.join(sub, 'requests.jsonl')
    fs.writeFileSync(reqlog, '')
    const { srv, url } = await fakeLogs((q) => {
      if (q.includes('stats count')) return [{ n: '1' }]
      if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: HOUSE_DONE }]
      return []
    })
    const port = await freePort()
    try {
      const env = {
        TASK_RUN_KV: kv,
        TASK_RUN_LOGS_URL: url,
        TASK_RUN_GRAFANA_TOKEN: TOKEN_SENTINEL,
        TASK_RUN_PUPPET_CMD: `node ${fakePuppet}`,
        TASK_RUN_HTTP_PORT: String(port),
        TASK_RUN_OUTDIR: sub,
        TASK_RUN_POLL_SECS: '2',
        TASK_RUN_MEET_SECS: '30',
        TASK_RUN_REPLY_SECS: '10',
        FAKE_SCENARIO: scenarioFile,
        FAKE_REQLOG: reqlog,
      }
      const r = await runScript(['house', '1'], env)
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
      assert.ok(!r.stdout.includes('kv-host-sentinel-abc') && !r.stdout.includes(TOKEN_SENTINEL), 'no secret values print')
    } finally {
      srv.close()
    }
  })

  it('empty stash and dead logs exit 2 before touching prod', async () => {
    const kv = path.join(dir, 'empty-kv.sh')
    fs.writeFileSync(kv, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(kv, 0o755)
    const base = { TASK_RUN_KV: kv, TASK_RUN_OUTDIR: dir, TASK_RUN_PUPPET_CMD: `node ${fakePuppet}` }
    const r1 = await runScript(['house', '1'], base)
    assert.equal(r1.code, 2)
    assert.match(r1.stderr, /no MC host\/port/)
    const port = await freePort()
    const r2 = await runScript(['house', '1'], {
      ...base,
      TASK_RUN_MC_HOST: MC_SENTINEL,
      TASK_RUN_MC_PORT: '29999',
      TASK_RUN_LOGS_URL: `http://localhost:${port}/dead`,
      TASK_RUN_GRAFANA_TOKEN: TOKEN_SENTINEL,
    })
    assert.equal(r2.code, 2)
    assert.match(r2.stderr, /logs unreachable/)
  })

  it('3 dead polls mid-run exit 2, not budget', async () => {
    let fetches = 0
    const r = await harness({ task: 'house', name: 'logslost' }, {
      puppet: { replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['autonomous on — stays'], 'build here': [BUILD_HERE_ACK] } },
      logs: (q) => {
        if (q.includes('stats count')) return [{ n: '1' }]
        fetches++
        if (fetches <= 2) return [] // first poll ok-but-empty; then the endpoint dies
        return { status: 500, rows: [] }
      },
      extra: { TASK_RUN_BUDGET_SECS: '60' },
    })
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /logs unreachable 3 polls in a row/)
    assert.equal(seriesOf(r.stdout).verdict, 'logs-lost')
  })

  it('a logs endpoint answering errors exits 2 up front', async () => {
    const { srv, url } = await fakeLogs(() => ({ status: 200, rows: [{ error: 'no such table' }] }))
    try {
      const r = await runScript(['house', '1'], {
        TASK_RUN_MC_HOST: MC_SENTINEL,
        TASK_RUN_MC_PORT: '29999',
        TASK_RUN_LOGS_URL: url,
        TASK_RUN_GRAFANA_TOKEN: TOKEN_SENTINEL,
        TASK_RUN_OUTDIR: dir,
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /logs unreachable/)
    } finally {
      srv.close()
    }
  })

  it('fuzzy stash keys resolve end to end (decoys present, nothing printed)', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'fuzzy-'))
    const scenarioFile = path.join(sub, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify({ replies: { 'follow me': [UNSEEN_AT], 'autonomous on': ['ok'], 'build here': [BUILD_HERE_ACK] } }))
    const reqlog = path.join(sub, 'requests.jsonl')
    fs.writeFileSync(reqlog, '')
    const { srv: logsSrv, url: logsUrl } = await fakeLogs((q) => {
      if (q.includes('stats count')) return [{ n: '1' }]
      if (q.includes('idkcraft-mc')) return [{ _time: nowIsoSec(), _msg: HOUSE_DONE }]
      return [{ _time: nowIsoSec(), _msg: 'decision x' }]
    })
    const logsPort = Number(new URL(logsUrl).port)
    const portainer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ Id: 2, Name: 'local', Env: [{ name: 'GRAFANA_HOST', value: `localhost:${logsPort}` }] }]))
    })
    await new Promise((r) => portainer.listen(0, 'localhost', r))
    const portainerPort = portainer.address().port
    const kv = path.join(sub, 'fuzzy-kv.sh')
    fs.writeFileSync(kv, `#!/bin/sh
if [ "$1" = ls ]; then
  echo '[{"key":"secrets/decoy-portainerbox-url"},{"key":"secrets/testenv-portainer-url"},{"key":"secrets/portainer-apikey"},{"key":"secrets/testenv-portainer-api-key"},{"key":"secrets/grafana-oidc-secret"},{"key":"secrets/testenv-grafana-token"}]'
  exit 0
fi
case "$2" in
  *testenv-portainer-url) echo http://localhost:${portainerPort};;
  *testenv-portainer-api-key) echo testenv-portainer-key;;
  *testenv-grafana-token) echo testenv-grafana-token;;
  *mc-host) echo ${MC_SENTINEL};;
  *mc-port) echo 29999;;
  *) exit 1;;
esac
`)
    fs.chmodSync(kv, 0o755)
    const port = await freePort()
    try {
      const r = await runScript(['house', '1'], {
        TASK_RUN_KV: kv,
        TASK_RUN_LOGS_SCHEME: 'http',
        TASK_RUN_PUPPET_CMD: `node ${fakePuppet}`,
        TASK_RUN_HTTP_PORT: String(port),
        TASK_RUN_OUTDIR: sub,
        TASK_RUN_POLL_SECS: '2',
        TASK_RUN_MEET_SECS: '30',
        TASK_RUN_REPLY_SECS: '10',
        FAKE_SCENARIO: scenarioFile,
        FAKE_REQLOG: reqlog,
      })
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
      assert.ok(!r.stdout.includes('testenv') && !r.stdout.includes(MC_SENTINEL), 'resolved keys and values never print')
    } finally {
      logsSrv.close()
      portainer.close()
    }
  })

  it('order markers match the shipped chat lines', () => {
    const sh = fs.readFileSync(SCRIPT, 'utf8')
    const chat = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat.js'), 'utf8')
    for (const m of ['building a home at ', 'castle at ', 'looking for a castle spot', 'I found no castle spot']) {
      assert.ok(sh.includes(m), `script lost marker ${m}`)
      assert.ok(chat.includes(m), `chat.js lost line ${m}`)
    }
    const build = fs.readFileSync(path.join(__dirname, '..', 'src', 'behaviours', 'build.js'), 'utf8')
    assert.ok(sh.includes('home done at ') && build.includes('home done at '))
    const castle = fs.readFileSync(path.join(__dirname, '..', 'src', 'behaviours', 'castle.js'), 'utf8')
    assert.ok(sh.includes('castle done at ') && castle.includes('castle done at '))
    assert.ok(castle.includes('castle ${n}/${total}'), 'castle progress line')
  })

  it('no infra labels in the script (revmux 01 critical, 02 critical)', () => {
    const sh = fs.readFileSync(SCRIPT, 'utf8')
    // Allowlist, not a denylist: the test itself must not name the labels.
    const lits = [...new Set([...sh.matchAll(/secrets\/[\w][\w.-]*/g)].map((m) => m[0]))].sort()
    assert.deepEqual(lits, ['secrets/idkcraft-mc-host', 'secrets/idkcraft-mc-port'])
  })
})
