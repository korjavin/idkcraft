'use strict'
// idkcraft-b64i: tools/curriculum-feed.sh (VictoriaLogs bot2 feed for the
// harvest) + `sh tools/curriculum.sh vlogs`. All HTTP is stubbed through
// CURRICULUM_FEED_CURL; all stash through CURRICULUM_KV. No Docker, no prod.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BOT = path.join(__dirname, '..')
const CURRICULUM = require('../tools/curriculum')

// VictoriaLogs JSONL for one paged recover episode (the raw-fixture lines
// as _msg values): harvest must read exactly one proposable page signature.
const VLOGS = [
  { _time: '2026-10-19T21:45:23.123456789Z', _msg: 'recover action=pillar_up source=fsm outcome=chosen pos=100.5,64,200.5 facts=stuck=very-long goal=high dist=105 scaffold=186 pickaxe=yes bucket=no water=no head=free walls=1 pit=no player=far resets=0/0 last=none feet=air head=air next=116,65,201.4:air' },
  { _time: '2026-10-19T21:45:31Z', _msg: 'recover action=pillar_up source=fsm outcome=failed:no-scaffold pos=100.5,64,200.5' },
  { _time: '2026-10-19T21:45:32.500000000Z', _msg: 'recover action=call_player source=fsm outcome=chosen pos=100.5,64,200.5' },
  { _time: '2026-10-19T21:45:33Z', _msg: 'recover action=call_player source=fsm outcome=gave-up pos=100.5,64,200.5' },
].map((o) => JSON.stringify(o)).join('\n') + '\n'

const FAKE_CURL = [
  '#!/bin/sh',
  '# fake curl for the feed tests: records "$@" in $FAKE_CURL_ARGS.',
  '# */api/stacks prints a monitoring stack (GRAFANA_HOST); otherwise the',
  '# canned VictoriaLogs JSONL ($FAKE_VLOGS) lands in the -o file and 200',
  '# goes to stdout. FAKE_CURL_MODE=dead|probe-fail breaks the logs call.',
  'echo "$@" >> "$FAKE_CURL_ARGS"',
  'if [ "$FAKE_CURL_MODE" = dead ]; then exit 1; fi',
  'prev=""; OUT=""; STACKS=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "-o" ]; then OUT="$a"; fi',
  '  prev="$a"',
  '  case "$a" in */api/stacks*) STACKS=1 ;; esac',
  'done',
  'if [ -n "$STACKS" ]; then',
  '  printf \'[{"name":"monitoring","Env":[{"name":"GRAFANA_HOST","value":"%s"}]}]\' "${FAKE_GRAFANA_HOST:-grafana.invalid}"',
  '  exit 0',
  'fi',
  'if [ "$FAKE_CURL_MODE" = probe-fail ]; then',
  '  printf \'{"error":"bad query"}\\n\' > "$OUT"',
  '  printf 200',
  '  exit 0',
  'fi',
  'cat "$FAKE_VLOGS" > "$OUT"',
  'printf 200',
  'exit 0',
].join('\n')

const FAKE_KV = [
  '#!/bin/sh',
  '# fake kv: canned values per key suffix (never real secrets).',
  'if [ "$1" = get ]; then',
  '  case "$2" in',
  "    *portainer-url) printf 'https://grafana.invalid/' ;;",
  "    *api-key) printf 'PKEY' ;;",
  "    *sa-token) printf 'TOKEN' ;;",
  '  esac',
  'fi',
  'exit 0',
].join('\n')

const FAKE_PRERUN_RED = [
  '#!/bin/sh',
  'printf \'[{"spot":"AUTO-fake","reached":false,"stuck":9,"eps":2,"call":1}]\' > "$2"',
  'exit 0',
].join('\n')

const FAKE_LOOP_GREEN = [
  '#!/bin/sh',
  'd="$SKILL_LOOP_DIR"',
  'mkdir -p "$d/skills"',
  'echo "$1" >> "${FAKE_MARKER:-/dev/null}"',
  "skill=\"$(SK=\"$SKILL_LOOP_SCENARIOS\" SCN=\"$1\" node -p \"JSON.parse(require('fs').readFileSync(process.env.SK,'utf8')).find((s)=>s.name===process.env.SCN).skill\")\"",
  'printf "/* skill fake */\\n" > "$d/skills/$skill.js"',
  "printf '{\"scenario\":\"%s\",\"spot\":\"AUTO-fake\",\"skill\":\"%s\",\"green\":true,\"attempts\":2,\"wall\":9,\"in\":100,\"out\":50,\"cost\":0.50,\"rows\":[]}' \"$1\" \"$skill\" > \"$d/result.json\"",
  'exit 0',
].join('\n')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-feed-'))
  const curl = path.join(dir, 'curl.sh')
  const kv = path.join(dir, 'kv.sh')
  const vlogs = path.join(dir, 'vlogs.jsonl')
  const args = path.join(dir, 'curl-args')
  fs.writeFileSync(curl, FAKE_CURL)
  fs.writeFileSync(kv, FAKE_KV)
  fs.writeFileSync(vlogs, VLOGS)
  fs.chmodSync(curl, 0o755)
  fs.chmodSync(kv, 0o755)
  return { dir, curl, kv, vlogs, args }
}

function feedEnv(t, extra = {}) {
  return {
    ...process.env,
    CURRICULUM_FEED_CURL: t.curl,
    CURRICULUM_LOGS_URL: 'http://logs.invalid/select/logsql/query',
    CURRICULUM_GRAFANA_TOKEN: 'TOKEN',
    FAKE_VLOGS: t.vlogs,
    FAKE_CURL_ARGS: t.args,
    FAKE_CURL_MODE: 'ok',
    ...extra,
  }
}

function runFeed(t, days = '7', extra = {}) {
  const r = spawnSync('sh', ['tools/curriculum-feed.sh', days], { cwd: BOT, env: feedEnv(t, extra), encoding: 'utf8' })
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '' }
}

function harvestLines(t, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-feed-harvest-'))
  t.dirs = (t.dirs || []).concat(dir)
  const feed = path.join(dir, 'feed.txt')
  fs.writeFileSync(feed, out)
  const saved = process.env.CURRICULUM_DIR
  const log = console.log
  const logged = []
  process.env.CURRICULUM_DIR = dir
  console.log = (...a) => logged.push(a.join(' '))
  try {
    assert.equal(CURRICULUM.main(['harvest', feed]), 0)
    return JSON.parse(fs.readFileSync(path.join(dir, 'curriculum.json'), 'utf8'))
  } finally {
    console.log = log
    if (saved === undefined) delete process.env.CURRICULUM_DIR
    else process.env.CURRICULUM_DIR = saved
  }
}

describe('curriculum-feed.sh (idkcraft-b64i)', () => {
  it('prints harvest-ready lines; the harvest finds the paged episode', () => {
    const t = setup()
    const r = runFeed(t)
    assert.equal(r.rc, 0)
    const lines = r.out.split('\n').filter((l) => l)
    assert.equal(lines.length, 4)
    assert.ok(lines.every((l) => l.startsWith('2026-10-19 21:45:') && l.includes(' IdkBotV2 recover action=')))
    assert.match(r.err, /curriculum-feed: service feed lines=4/)
    const list = harvestLines(t, r.out)
    assert.equal(list.length, 1)
    assert.deepEqual([list[0].family, list[0].reason, list[0].proposable], ['page', 'pillar_up:failed:no-scaffold', true])
  })

  it('service/bot/query/limit seams reach the LogsQL call', () => {
    const t = setup()
    const r = runFeed(t, '3', { CURRICULUM_FEED_SERVICE: 'bot', CURRICULUM_FEED_BOT: 'IdkBot', CURRICULUM_FEED_LIMIT: '7' })
    assert.equal(r.rc, 0)
    assert.ok(r.out.split('\n').filter((l) => l).every((l) => l.includes(' IdkBot recover action=')))
    const seen = fs.readFileSync(t.args, 'utf8')
    assert.match(seen, /compose_service:bot /)
    assert.match(seen, /_time:3d/)
    assert.match(seen, /limit=7/)
    const t2 = setup()
    const r2 = runFeed(t2, '7', { CURRICULUM_FEED_QUERY: 'compose_service:bot2 "recover action=" _time:7d' })
    assert.equal(r2.rc, 0)
    assert.match(fs.readFileSync(t2.args, 'utf8'), /compose_service:bot2 "recover action=" _time:7d/)
  })

  it('portainer resolution finds GRAFANA_HOST (stash keys explicit, values stubbed)', () => {
    const t = setup()
    const env = feedEnv(t)
    delete env.CURRICULUM_LOGS_URL
    delete env.CURRICULUM_GRAFANA_TOKEN
    env.CURRICULUM_KV = t.kv
    const r = spawnSync('sh', ['tools/curriculum-feed.sh', '7'], { cwd: BOT, env, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.split('\n').filter((l) => l).length, 4)
    const seen = fs.readFileSync(t.args, 'utf8')
    assert.match(seen, /\/api\/stacks/)
    assert.match(seen, /grafana\.invalid\/api\/datasources\/proxy/)
  })

  it('missing keys exit 2 and name the stash keys (never a verdict)', () => {
    const t = setup()
    const env = feedEnv(t, { CURRICULUM_KV: 'false' })
    delete env.CURRICULUM_LOGS_URL
    delete env.CURRICULUM_GRAFANA_TOKEN
    const r = spawnSync('sh', ['tools/curriculum-feed.sh', '7'], { cwd: BOT, env, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(`${r.stdout}${r.stderr}`, /secrets\/kfamcloud-portainer-url/)
  })

  it('a dead feed and a probe failure both exit 2', () => {
    const t = setup()
    assert.equal(runFeed(t, '7', { FAKE_CURL_MODE: 'dead' }).rc, 2)
    const r = runFeed(t, '7', { FAKE_CURL_MODE: 'probe-fail' })
    assert.equal(r.rc, 2)
    assert.match(r.err, /probe failed/)
  })

  it('bad days exits 2', () => {
    const t = setup()
    assert.equal(runFeed(t, '0').rc, 2)
    assert.equal(runFeed(t, 'soon').rc, 2)
  })
})

describe('curriculum.sh vlogs night (idkcraft-b64i)', () => {
  function runNight(t, opts = {}) {
    const prerun = path.join(t.dir, 'prerun.sh')
    const loop = path.join(t.dir, 'loop.sh')
    fs.writeFileSync(prerun, FAKE_PRERUN_RED)
    fs.writeFileSync(loop, FAKE_LOOP_GREEN)
    const env = {
      ...process.env,
      CURRICULUM_NO_KEEPER: '1',
      CURRICULUM_K: '1',
      CURRICULUM_DIR: t.dir,
      CURRICULUM_PRERUN: prerun,
      CURRICULUM_LOOP: loop,
      CURRICULUM_FEED_CURL: t.curl,
      CURRICULUM_LOGS_URL: 'http://logs.invalid/select/logsql/query',
      CURRICULUM_GRAFANA_TOKEN: 'TOKEN',
      FAKE_VLOGS: t.vlogs,
      FAKE_CURL_ARGS: t.args,
      FAKE_CURL_MODE: opts.feedMode || 'ok',
      FAKE_MARKER: path.join(t.dir, 'loop-marker'),
    }
    const r = spawnSync('sh', ['tools/curriculum.sh', opts.dump || 'vlogs'], { cwd: BOT, env, encoding: 'utf8' })
    return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  }

  it('a vlogs night fetches, harvests and loops to GREEN with a PROMOTE line', () => {
    const t = setup()
    const r = runNight(t)
    assert.equal(r.rc, 0)
    assert.match(r.out, /curriculum: fetching the VictoriaLogs feed \(service bot2, last 7 days\)/)
    assert.match(r.out, /harvest events=1 signatures=1 page=1 bring=0 proposable=1/)
    assert.match(r.out, /CURRICULUM [0-9a-f]{8} GREEN attempts=2 cost=\$0\.50/)
    assert.match(r.out, /PROMOTE: node tools\/skill-promote\.js/)
    assert.ok(fs.existsSync(path.join(t.dir, 'feed-bot2-7.txt')), 'the feed lands in the work root')
    assert.ok(fs.existsSync(path.join(t.dir, 'loop-marker')), 'the loop started')
  })

  it('a dead feed is environment (exit 2): the loop never starts', () => {
    const t = setup()
    const r = runNight(t, { feedMode: 'dead' })
    assert.equal(r.rc, 2)
    assert.match(r.out, /logs unreachable/)
    assert.ok(!fs.existsSync(path.join(t.dir, 'loop-marker')), 'the loop never started')
  })
})
