'use strict'
// idkcraft-vf8e.10: tools/curriculum.sh pick/gate/ledger/cap end to end with
// a stubbed rig (CURRICULUM_PRERUN) and a stubbed skill loop
// (CURRICULUM_LOOP), plus unit tests for the new curriculum.js subcommands
// and the skill-loop.js curriculum env knob. No Docker, no model calls.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BOT = path.join(__dirname, '..')
const DUMP = path.join(__dirname, 'fixtures', 'curriculum-dump.txt')
const CURRICULUM = require('../tools/curriculum')
const LOOP = require('../tools/skill-loop')

const FAKE_PRERUN = [
  '#!/bin/sh',
  '# fake no-skill reproduction run: $1 = spots.json, $2 = out.json.',
  '# FAKE_GATE=red writes a RED row, anything else a reached row.',
  'echo "PRERUN BODY=${REPLAY_BODY:-mineflayer}" >> "${FAKE_ENV:-/dev/null}"',
  'if [ "$FAKE_GATE" = dead ]; then echo "fake-prerun: rig dead"; exit 2; fi',
  'if [ "$FAKE_GATE" = red ]; then',
  '  printf \'[{"spot":"AUTO-fake","reached":false,"stuck":9,"eps":2,"call":1}]\' > "$2"',
  'else',
  '  printf \'[{"spot":"AUTO-fake","reached":true,"stuck":0,"eps":0,"call":0}]\' > "$2"',
  'fi',
  'exit 0',
].join('\n')

const FAKE_LOOP = [
  '#!/bin/sh',
  '# fake skill loop: $1 = scenario name, $2 = max attempts.',
  '# FAKE_LOOP=green|red|env, FAKE_COST; writes SKILL_LOOP_DIR/result.json.',
  'd="$SKILL_LOOP_DIR"',
  'mkdir -p "$d/skills"',
  'echo "$1" >> "${FAKE_MARKER:-/dev/null}"',
  'echo "LOOP BODY=${REPLAY_BODY:-mineflayer} RIG=$SKILL_LOOP_RIG SCN=$SKILL_LOOP_SCENARIOS SPOTS=$SKILL_LOOP_SPOTS" >> "${FAKE_ENV:-/dev/null}"',
  'if [ "$FAKE_LOOP" = noresult ]; then echo "fake-loop: crashed before result"; exit 1; fi',
  "skill=\"$(SK=\"$SKILL_LOOP_SCENARIOS\" SCN=\"$1\" node -p \"JSON.parse(require('fs').readFileSync(process.env.SK,'utf8')).find((s)=>s.name===process.env.SCN).skill\")\"",
  'echo "fake-loop $1 max=$2 skill=$skill"',
  'cost="${FAKE_COST:-0.50}"',
  'if [ "$FAKE_LOOP" = env ]; then printf \'{"scenario":"%s","spot":"AUTO-fake","skill":"%s","green":false,"attempts":2,"wall":9,"in":100,"out":50,"cost":%s,"rows":[]}\' "$1" "$skill" "$cost" > "$d/result.json"; echo "fake-loop: environment failure"; exit 2; fi',
  'if [ "$FAKE_LOOP" = green ]; then green=true; rc=0; else green=false; rc=1; fi',
  'if [ "$green" = true ]; then printf "/* skill fake */\\n" > "$d/skills/$skill.js"; fi',
  "printf '{\"scenario\":\"%s\",\"spot\":\"AUTO-fake\",\"skill\":\"%s\",\"green\":%s,\"attempts\":2,\"wall\":9,\"in\":100,\"out\":50,\"cost\":%s,\"rows\":[]}' \"$1\" \"$skill\" \"$green\" \"$cost\" > \"$d/result.json\"",
  'exit "$rc"',
].join('\n')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-night-'))
  fs.writeFileSync(path.join(dir, 'prerun.sh'), FAKE_PRERUN)
  fs.writeFileSync(path.join(dir, 'loop.sh'), FAKE_LOOP)
  return { dir, prerun: path.join(dir, 'prerun.sh'), loop: path.join(dir, 'loop.sh'), marker: path.join(dir, 'loop-marker'), seen: path.join(dir, 'seen-env') }
}

function runNight(t, opts = {}) {
  const env = {
    ...process.env,
    CURRICULUM_NO_KEEPER: '1',
    CURRICULUM_K: String(opts.k === undefined ? 1 : opts.k),
    CURRICULUM_DIR: t.dir,
    CURRICULUM_PRERUN: t.prerun,
    CURRICULUM_LOOP: t.loop,
    CURRICULUM_USD_PER_DAY: opts.cap || '30',
    FAKE_GATE: opts.gate || 'red',
    FAKE_LOOP: opts.loopMode || 'green',
    FAKE_COST: opts.cost || '0.50',
    FAKE_MARKER: t.marker,
    FAKE_ENV: t.seen,
  }
  if (opts.body) env.CURRICULUM_BODY = opts.body
  if (opts.goals) env.CURRICULUM_GOALS = opts.goals
  if (opts.seed) fs.writeFileSync(path.join(t.dir, 'curriculum-ledger.json'), JSON.stringify(opts.seed, null, 1))
  const cwd = opts.cwd || BOT
  const script = opts.script || 'tools/curriculum.sh'
  const dump = opts.dump || DUMP
  const r = spawnSync('sh', [script, dump], { cwd, env, encoding: 'utf8' })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

function ledger(t) {
  try {
    return JSON.parse(fs.readFileSync(path.join(t.dir, 'curriculum-ledger.json'), 'utf8'))
  } catch (_) {
    return {}
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10)

describe('curriculum.sh night (idkcraft-vf8e.10)', () => {
  it('not-reproduced spends nothing and never starts the loop', () => {
    const t = setup()
    const r = runNight(t, { gate: 'green', loopMode: 'green' })
    assert.equal(r.rc, 0)
    assert.match(r.out, /not-reproduced/)
    assert.ok(!r.out.includes('PROMOTE:'), 'no promotion without reproduction')
    assert.ok(!fs.existsSync(t.marker), 'the loop never started')
    const all = Object.values(ledger(t))
    assert.equal(all.length, 1)
    assert.deepEqual([all[0].verdict, all[0].cost, all[0].attempts], ['not-reproduced', 0, 0])
    assert.match(r.out, /CURRICULUM night=\d{4}-\d\d-\d\d tried=1 green=0 red=0 skipped=1 cost=\$0\.00/)
  })

  it('a relative dump path works from the repo root', () => {
    const t = setup()
    const r = runNight(t, {
      gate: 'green', loopMode: 'green',
      cwd: path.join(BOT, '..'), script: 'bot/tools/curriculum.sh', dump: 'bot/test/fixtures/curriculum-dump.txt',
    })
    assert.equal(r.rc, 0)
    assert.match(r.out, /not-reproduced/)
  })

  it('a night with 0 signatures prints the per-family counts it saw (idkcraft-vf8e.16)', () => {
    const t = setup()
    const r = runNight(t, { dump: path.join(__dirname, 'fixtures', 'curriculum-dump-nopage.txt') })
    assert.equal(r.rc, 0)
    assert.match(r.out, /harvest events=0 signatures=0 page=0 bring=0 stepfail=0 park=0 proposable=0 days=7 parsed=3\/3 recover=2 refusals=0/)
    assert.match(r.out, /harvest why: recover=2 but 0 page events \(no call_player\/gave-up episode\); bring=excluded/)
    assert.match(r.out, /CURRICULUM night=\d{4}-\d\d-\d\d tried=0 green=0 red=0 skipped=0 cost=\$0\.00/)
  })

  it('a failed pre-run never reads last night pre.json', () => {
    const t = setup()
    const top = CURRICULUM.rank(CURRICULUM.parse(fs.readFileSync(DUMP, 'utf8'), {}), 7).find((c) => c.proposable)
    const cand = path.join(t.dir, `AUTO-${top.sig}`)
    fs.mkdirSync(path.join(cand, 'loop'), { recursive: true })
    fs.writeFileSync(path.join(cand, 'pre.json'), JSON.stringify([{ spot: 'AUTO-stale', reached: false, stuck: 9, eps: 2, call: 1 }]))
    const r = runNight(t, { gate: 'dead', loopMode: 'green' })
    assert.match(r.out, /env: pre-run failed/)
    assert.ok(!fs.existsSync(t.marker), 'the loop never started on a stale gate')
    assert.equal(r.rc, 2)
  })

  it('a loop that dies before result.json never re-charges last night cost', () => {
    const t = setup()
    const top = CURRICULUM.rank(CURRICULUM.parse(fs.readFileSync(DUMP, 'utf8'), {}), 7).find((c) => c.proposable)
    const cand = path.join(t.dir, `AUTO-${top.sig}`)
    fs.mkdirSync(path.join(cand, 'loop'), { recursive: true })
    fs.writeFileSync(path.join(cand, 'loop', 'result.json'), JSON.stringify({
      scenario: 'x', spot: 'AUTO-stale', skill: 'gen_x', green: false, attempts: 6, wall: 9, in: 100, out: 50, cost: 9.99, rows: [],
    }))
    const r = runNight(t, { gate: 'red', loopMode: 'noresult' })
    assert.match(r.out, /env: loop rc 1 but no .*result\.json/)
    assert.ok(!/RED attempts=/.test(r.out), 'no stale RED verdict')
    assert.deepEqual(ledger(t), {}, 'stale cost never recorded')
    assert.equal(r.rc, 2)
  })

  it('a GREEN prints the PROMOTE line and records cost + skill', () => {
    const t = setup()
    const r = runNight(t, { gate: 'red', loopMode: 'green', cost: '1.09' })
    assert.equal(r.rc, 0)
    const m = /CURRICULUM ([0-9a-f]{8}) GREEN attempts=2 cost=\$1\.09/.exec(r.out)
    assert.ok(m, `GREEN line:\n${r.out}`)
    assert.match(r.out, new RegExp(`PROMOTE: node tools/skill-promote\\.js idkcraft-vf8e\\.9 .*/loop/skills/gen_${m[1]}\\.js`))
    const e = ledger(t)[m[1]]
    assert.deepEqual([e.verdict, e.cost, e.attempts], ['GREEN:unpromoted', 1.09, 2])
    assert.ok(e.skillPath.endsWith(`gen_${m[1]}.js`) && e.resultJson.endsWith('result.json'))
    assert.match(r.out, /tried=1 green=1 red=0 skipped=0 cost=\$1\.09/)
  })

  it('the $ cap refuses to start the next scenario (exit 3)', () => {
    const t = setup()
    // The harvest top (pillar place-error, count 2) is RED from today at
    // $0.60: it is skipped as recent, the next pick runs GREEN at $0.50,
    // and the night then owns $1.10 >= the $1.00 cap.
    const top = CURRICULUM.rank(CURRICULUM.parse(fs.readFileSync(DUMP, 'utf8'), {}), 7)[0]
    const seed = { [top.sig]: { date: daysAgo(0), verdict: 'RED', attempts: 6, cost: 0.6, skillPath: null, resultJson: null, count: top.count, reds: 1 } }
    const r = runNight(t, { k: 3, gate: 'red', loopMode: 'green', cost: '0.50', cap: '1.00', seed })
    assert.equal(r.rc, 3)
    assert.equal((r.out.match(/PROMOTE: /g) || []).length, 1)
    assert.match(r.out, /budget: today \$1\.10 >= \$1\.00 cap — refusing to start \(exit 3\)/)
    assert.ok(!fs.existsSync(path.join(t.dir, 'curriculum-ledger.json')) || ledger(t)[top.sig].cost === 0.6, 'the refused candidate is not recorded')
    assert.match(r.out, /cost=\$0\.50/)
  })

  it('loop exit 2 is not RED, but paid spend still reaches the ledger', () => {
    const t = setup()
    const r = runNight(t, { gate: 'red', loopMode: 'env', cost: '0.75' })
    assert.match(r.out, /CURRICULUM [0-9a-f]{8} RED: gate:/)
    assert.match(r.out, /env: skill-loop exit 2.*not RED, spend \$0\.75 recorded/)
    assert.ok(!/CURRICULUM [0-9a-f]{8} (GREEN|RED) attempts=/.test(r.out), 'no loop verdict')
    const m = /CURRICULUM ([0-9a-f]{8}) env: skill-loop/.exec(r.out)
    const e = ledger(t)[m[1]]
    assert.deepEqual([e.verdict, e.cost, e.attempts, e.reds, e.envs], ['env', 0.75, 2, 0, 1])
    assert.match(r.out, /cost=\$0\.75/)
    assert.equal(r.rc, 2)
  })

  it('loop exit 2 with no spend records nothing', () => {
    const t = setup()
    const r = runNight(t, { gate: 'red', loopMode: 'env', cost: '0.00' })
    assert.match(r.out, /not RED, cap unspent/)
    assert.deepEqual(ledger(t), {}, 'no ledger entry on cost-free env failure')
    assert.equal(r.rc, 2)
  })

  it('CURRICULUM_BODY reaches the keeper runs and the loop; default is mineflayer', () => {
    const t = setup()
    const r = runNight(t, { gate: 'red', loopMode: 'green', body: 'baritone' })
    assert.equal(r.rc, 0)
    const seen = fs.readFileSync(t.seen, 'utf8')
    assert.match(seen, /PRERUN BODY=baritone/)
    assert.match(seen, /LOOP BODY=baritone RIG=0 SCN=.*AUTO-.*scenario\.json SPOTS=.*AUTO-.*spots\.json/)
    assert.equal(Object.values(ledger(t))[0].body, 'baritone')
    const t2 = setup()
    const r2 = runNight(t2, { gate: 'red', loopMode: 'green' })
    assert.equal(r2.rc, 0)
    const seen2 = fs.readFileSync(t2.seen, 'utf8')
    assert.match(seen2, /PRERUN BODY=mineflayer/)
    assert.match(seen2, /LOOP BODY=mineflayer RIG=0/)
    assert.equal(Object.values(ledger(t2))[0].body, 'mineflayer')
    assert.match(r.out, /PROMOTE: REPLAY_BODY=baritone node tools\/skill-promote\.js/)
    assert.match(r2.out, /PROMOTE: node tools\/skill-promote\.js/)
    assert.ok(!/PROMOTE: REPLAY_BODY/.test(r2.out), 'default PROMOTE carries no body')
  })

  it('the 7-day retry re-picks grown RED, parks at 3 REDs, skips recent', () => {
    const t = setup()
    const list = CURRICULUM.rank(CURRICULUM.parse(fs.readFileSync(DUMP, 'utf8'), {}), 7)
    const prop = list.filter((c) => c.proposable)
    // prop[0]: pillar place-error (count 2); prop[1]: bone (count 2);
    // prop[2]: pillar no-scaffold (count 1).
    const seed = {
      [prop[0].sig]: { date: daysAgo(8), verdict: 'RED', attempts: 6, cost: 0.5, skillPath: null, resultJson: null, count: 1, reds: 1 },
      [prop[1].sig]: { date: daysAgo(1), verdict: 'RED', attempts: 6, cost: 0.5, skillPath: null, resultJson: null, count: 2, reds: 1 },
      [prop[2].sig]: { date: daysAgo(9), verdict: 'RED', attempts: 6, cost: 0.5, skillPath: null, resultJson: null, count: 1, reds: 3 },
    }
    const r = runNight(t, { k: 2, gate: 'red', loopMode: 'red', seed })
    assert.equal(r.rc, 0)
    assert.match(r.out, new RegExp(`CURRICULUM ${prop[0].sig} RED`))
    assert.ok(!r.out.includes(`CURRICULUM ${prop[1].sig} RED`), 'recent RED is not retried')
    assert.match(r.out, new RegExp(`CURRICULUM ${prop[1].sig} skipped: red-recent`))
    assert.match(r.out, new RegExp(`CURRICULUM ${prop[2].sig} skipped: parked`))
    assert.equal(ledger(t)[prop[0].sig].reds, 2)
    assert.match(r.out, /tried=2 green=0 red=2 skipped=2 cost=\$1\.00/)
  })

  it('a castlefetch-unreachable park never reaches the runner (idkcraft-sggu)', () => {
    // Judging `build castle` by `castle done at ` in 300 s is RED on every
    // run, so the signature stays honestly parked: the night spends no rig
    // run and no paid loop on it.
    const t = setup()
    const SF = path.join(__dirname, 'fixtures', 'curriculum-dump-stepfail.txt')
    const sig = CURRICULUM.rank(CURRICULUM.parse(fs.readFileSync(SF, 'utf8'), {}), 7)
      .find((c) => c.reason === 'castlefetch-unreachable').sig
    const r = runNight(t, { dump: SF, k: 1, gate: 'red', loopMode: 'red', cost: '0.50' })
    assert.equal(r.rc, 0)
    assert.ok(!new RegExp(`CURRICULUM ${sig} `).test(r.out), `parked sig takes no verdict:\n${r.out}`)
    assert.equal(ledger(t)[sig], undefined)
    const ran = fs.existsSync(t.marker) ? fs.readFileSync(t.marker, 'utf8') : ''
    assert.ok(!ran.includes(`auto-${sig}`), 'the loop never started for the parked sig')
  })
})

describe('curriculum ledger helpers (idkcraft-vf8e.10)', () => {
  function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-unit-'))
    const saved = process.env.CURRICULUM_DIR
    const log = console.log
    const out = []
    process.env.CURRICULUM_DIR = dir
    console.log = (...a) => out.push(a.join(' '))
    try { return fn(dir, out) } finally {
      console.log = log
      if (saved === undefined) delete process.env.CURRICULUM_DIR
      else process.env.CURRICULUM_DIR = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('gate: RED on unreached or paged rows, NOT-RED on clean reached', () => {
    withDir((dir) => {
      const f = (rows) => { const p = path.join(dir, 'r.json'); fs.writeFileSync(p, JSON.stringify(rows)); return p }
      assert.equal(CURRICULUM.main(['gate', f([{ spot: 'A', reached: false, call: 0 }])]), 0)
      assert.equal(CURRICULUM.main(['gate', f([{ spot: 'A', reached: true, call: 1 }])]), 0)
      assert.equal(CURRICULUM.main(['gate', f([{ spot: 'A', reached: true, call: 0 }])]), 1)
      assert.equal(CURRICULUM.main(['gate', path.join(dir, 'missing.json')]), 2)
    })
  })

  it('record: RED accumulates lifetime reds, costs come from result.json only', () => {
    withDir((dir, out) => {
      fs.writeFileSync(path.join(dir, 'curriculum.json'), JSON.stringify([{ sig: 'ab12cd34', count: 5 }]))
      const res = path.join(dir, 'result.json')
      fs.writeFileSync(res, JSON.stringify({ attempts: 6, cost: 1.25 }))
      assert.equal(CURRICULUM.main(['record', 'ab12cd34', 'RED', res]), 0)
      assert.equal(CURRICULUM.main(['record', 'ab12cd34', 'RED', res]), 0)
      let e = CURRICULUM.readLedger()['ab12cd34']
      // Same-day re-record adds (revmux 02 core-1): the $ cap stays exact.
      assert.deepEqual([e.verdict, e.attempts, e.cost, e.count, e.reds], ['RED', 12, 2.5, 5, 2])
      assert.equal(CURRICULUM.main(['record', 'ab12cd34', 'GREEN:unpromoted', res, '/w/skills/gen_x.js']), 0)
      e = CURRICULUM.readLedger()['ab12cd34']
      assert.deepEqual([e.verdict, e.reds, e.skillPath, e.body], ['GREEN:unpromoted', 2, '/w/skills/gen_x.js', 'mineflayer'])
      assert.equal(CURRICULUM.main(['record', 'ab12cd34', 'env', res]), 0)
      e = CURRICULUM.readLedger()['ab12cd34']
      assert.deepEqual([e.verdict, e.reds, e.envs], ['env', 2, 1])
      assert.equal(CURRICULUM.main(['record', 'ab12cd34', 'bogus']), 2)
      assert.match(out.join('\n'), /ledger ab12cd34: RED attempts=6 cost=\$1\.25 reds=1/)
    })
  })

  it('spent sums only today, pick skips GREEN and stale RED', () => {
    withDir((dir) => {
      const list = [
        { sig: 's1', family: 'page', reason: 'r1', count: 3, score: 9, bots: ['b'], lastSeen: '2026-10-18 10:00:00', cell: 'c', proposable: true },
        { sig: 's2', family: 'page', reason: 'r2', count: 2, score: 6, bots: ['b'], lastSeen: '2026-10-18 10:00:00', cell: 'c', proposable: true },
        { sig: 's3', family: 'page', reason: 'r3', count: 1, score: 3, bots: ['b'], lastSeen: '2026-10-18 10:00:00', cell: 'c', proposable: true },
        { sig: 's4', family: 'page', reason: 'r4', count: 1, score: 2, bots: ['b'], lastSeen: '2026-10-18 10:00:00', cell: 'c', proposable: true },
      ]
      fs.writeFileSync(path.join(dir, 'curriculum.json'), JSON.stringify(list))
      const today = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(path.join(dir, 'curriculum-ledger.json'), JSON.stringify({
        s1: { date: today, verdict: 'RED', attempts: 6, cost: 1.5, count: 3, reds: 1 },
        s2: { date: daysAgo(9), verdict: 'RED', attempts: 6, cost: 9.99, count: 2, reds: 1 },
        s3: { date: daysAgo(1), verdict: 'env', attempts: 2, cost: 0.75, count: 1, reds: 0, envs: 1 },
        s4: { date: daysAgo(1), verdict: 'env', attempts: 2, cost: 0.75, count: 1, reds: 0, envs: 3 },
      }))
      const log = console.log
      const out = []
      console.log = (...a) => out.push(a.join(' '))
      try {
        assert.equal(CURRICULUM.main(['spent']), 0)
        assert.equal(CURRICULUM.main(['pick', '4']), 0)
      } finally { console.log = log }
      assert.equal(out[0], '1.50')
      assert.deepEqual(out[1].split('\n'), ['skip s1 red-recent', 'skip s2 red-stale', 'pick s3', 'skip s4 parked'])
    })
  })

  it('gate: setup-failure notes are ENV, never RED', () => {
    withDir((dir) => {
      const f = (rows) => { const p = path.join(dir, 'r.json'); fs.writeFileSync(p, JSON.stringify(rows)); return p }
      assert.equal(CURRICULUM.main(['gate', f([{ spot: 'A', reached: false, call: 1, note: 'GUIDE-BURIED' }])]), 2)
      assert.equal(CURRICULUM.main(['gate', f([{ spot: 'A', reached: true, call: 0, note: 'GUIDE-DIED' }])]), 2)
      // The set tracks stuck-replay.js ENV_NOTES exactly.
      const replay = require('../tools/stuck-replay')
      assert.deepEqual([...CURRICULUM.ENV_FAIL_NOTES].sort(), [...replay.ENV_NOTES].sort())
    })
  })

  it('gate RED and rowGreen GREEN agree on every row shape', () => {
    withDir((dir) => {
      const rows = [
        { spot: 'A', reached: true, stuck: 0, eps: 0, call: 0 },
        { spot: 'A', reached: true, stuck: 4, eps: 2, call: 1 },
        { spot: 'A', reached: false, stuck: 9, eps: 2, call: 1 },
        { spot: 'A', reached: false, stuck: 0, eps: 0, call: 0 },
      ]
      for (const row of rows) {
        const p = path.join(dir, 'r.json')
        fs.writeFileSync(p, JSON.stringify([row]))
        const log = console.log
        console.log = () => {}
        let rc
        try { rc = CURRICULUM.main(['gate', p]) } finally { console.log = log }
        assert.equal(rc === 0, !LOOP.rowGreen(row), `gate/rowGreen agree on ${JSON.stringify(row)}`)
      }
      assert.equal(LOOP.rowGreen(null), false)
    })
  })
})

describe('skill-loop curriculum env (idkcraft-vf8e.10)', () => {
  it('defaults keep water-climb on the committed tables', () => {
    const d = LOOP.loopFiles({})
    assert.ok(d.scenarios.endsWith('skill-scenarios.json'))
    assert.ok(d.spots.endsWith('stuck-spots.json'))
    assert.deepEqual([d.rig, d.curriculum], ['', false])
  })

  it('SKILL_LOOP_* overrides point at the proposed files + kept rig', () => {
    const d = LOOP.loopFiles({ SKILL_LOOP_SCENARIOS: '/w/scenario.json', SKILL_LOOP_SPOTS: '/w/spots.json', SKILL_LOOP_RIG: '0' })
    assert.deepEqual([d.scenarios, d.spots, d.rig, d.curriculum], ['/w/scenario.json', '/w/spots.json', '0', true])
  })

  it('readRow/rowText judge the replay row, not the exit code', () => {
    assert.equal(LOOP.readRow('/nonexistent.json'), null)
    const row = { spot: 'AUTO-ab12', reached: true, stuck: 2, eps: 1, call: 0 }
    assert.match(LOOP.rowText(row), /AUTO-ab12: reached=true stuck=2 eps=1 calls=0/)
  })

  it('main reads the custom files: unknown scenario is usage, unknown spot names its file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loop-env-'))
    try {
      const scn = path.join(dir, 'scenario.json')
      const spots = path.join(dir, 'spots.json')
      fs.writeFileSync(scn, JSON.stringify([{ name: 'auto-x', spot: 'AUTO-x', sabotage: null, skill: 'gen_x', kind: 'recover', task: 't' }]))
      fs.writeFileSync(spots, JSON.stringify([]))
      const run = (env, args) => spawnSync('node', ['tools/skill-loop.js', ...args], { cwd: BOT, env: { ...process.env, ...env }, encoding: 'utf8' })
      const clean = { SKILL_LOOP_SCENARIOS: scn, SKILL_LOOP_SPOTS: spots }
      let r = run(clean, ['water-climb', '6'])
      assert.equal(r.status, 2)
      assert.match(`${r.stdout}`, /usage: node tools\/skill-loop\.js/)
      r = run(clean, ['auto-x', '6'])
      assert.equal(r.status, 2)
      assert.match(`${r.stdout}`, new RegExp(`spot AUTO-x not in ${spots}`))
      // Default path unchanged: unknown name is still usage, before any key/rig work.
      r = run({}, ['no-such-scenario', '6'])
      assert.equal(r.status, 2)
      assert.match(`${r.stdout}`, /usage: node tools\/skill-loop\.js/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('curriculum.sh hand-written goals (idkcraft-vf8e.20)', () => {
  const NOPAGE = path.join(__dirname, 'fixtures', 'curriculum-dump-nopage.txt')

  // A goal dir as bot/tools/goals/park will hold it (vf8e.19): scenario.json
  // + spots.json in propose() shape. Built in tmp: goals/park may not exist.
  function makeGoal(dir, name = 'park') {
    const g = path.join(dir, name)
    fs.mkdirSync(g, { recursive: true })
    fs.writeFileSync(path.join(g, 'scenario.json'), JSON.stringify([{
      name, spot: `GOAL-${name}`, sabotage: null, skill: 'gen_park',
      bead: 'idkcraft-vf8e.19', kind: 'recover',
      task: 'hand-written curriculum goal: park the bot without paging',
    }], null, 1) + '\n')
    fs.writeFileSync(path.join(g, 'spots.json'), JSON.stringify([{
      name: `GOAL-${name}`, spawn: [59.5, 64, -205.5], goal: [62.5, 64, -205.5],
      secs: 90, scaffold: 64, pickaxe: true, bead: 'idkcraft-vf8e.19',
    }], null, 1) + '\n')
    return g
  }

  it('record accepts a GOAL-* key with no harvest entry (count falls back to 0)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-unit-'))
    const saved = process.env.CURRICULUM_DIR
    process.env.CURRICULUM_DIR = dir
    const log = console.log
    console.log = () => {}
    try {
      assert.equal(CURRICULUM.main(['record', 'GOAL-park', 'RED']), 0)
    } finally {
      console.log = log
      if (saved === undefined) delete process.env.CURRICULUM_DIR
      else process.env.CURRICULUM_DIR = saved
    }
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, 'curriculum-ledger.json'), 'utf8'))['GOAL-park']
      assert.deepEqual([e.verdict, e.reds, e.count], ['RED', 1, 0])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a goal runs through the same block: GOAL-<name> ledger row, copied files, PROMOTE on GREEN', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const r = runNight(t, { dump: NOPAGE, goals: g, gate: 'red', loopMode: 'green', cost: '0.50' })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-park RED: gate:/)
    assert.match(r.out, /CURRICULUM GOAL-park GREEN attempts=2 cost=\$0\.50/)
    assert.match(r.out, /PROMOTE: node tools\/skill-promote\.js idkcraft-vf8e\.19 .*GOAL-park\/loop\/skills\/gen_park\.js/)
    assert.match(r.out, /tried=1 green=1 red=0 skipped=0 cost=\$0\.50/)
    const e = ledger(t)['GOAL-park']
    assert.deepEqual([e.verdict, e.cost, e.attempts], ['GREEN:unpromoted', 0.5, 2])
    // The loop saw the copies under $WORK, never the source dir.
    const copied = path.join(t.dir, 'GOAL-park')
    assert.equal(fs.readFileSync(path.join(copied, 'scenario.json'), 'utf8'), fs.readFileSync(path.join(g, 'scenario.json'), 'utf8'))
    assert.equal(fs.readFileSync(path.join(copied, 'spots.json'), 'utf8'), fs.readFileSync(path.join(g, 'spots.json'), 'utf8'))
    const seen = fs.readFileSync(t.seen, 'utf8')
    assert.ok(seen.includes(`SCN=${copied}/scenario.json`), `loop scenarios at the copy:\n${seen}`)
    assert.ok(seen.includes(`SPOTS=${copied}/spots.json`), `loop spots at the copy:\n${seen}`)
    assert.equal(fs.readFileSync(t.marker, 'utf8').trim(), 'park')
  })

  it('goals run before harvested picks', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const r = runNight(t, { goals: g, gate: 'red', loopMode: 'green' })
    assert.equal(r.rc, 0)
    const m = /CURRICULUM ([0-9a-f]{8}) RED:/.exec(r.out)
    assert.ok(m, `a harvested signature also ran:\n${r.out}`)
    assert.ok(r.out.indexOf('CURRICULUM GOAL-park') !== -1 && r.out.indexOf('CURRICULUM GOAL-park') < r.out.indexOf(m[0]))
    assert.match(r.out, /tried=2 green=2 red=0 skipped=0 cost=\$1\.00/)
  })

  it('the $ cap refuses to start the goal (exit 3)', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const seed = { old: { date: daysAgo(0), verdict: 'RED', attempts: 6, cost: 30, skillPath: null, resultJson: null, count: 1, reds: 1 } }
    const r = runNight(t, { dump: NOPAGE, goals: g, gate: 'red', loopMode: 'green', cap: '30.00', seed })
    assert.equal(r.rc, 3)
    assert.match(r.out, /CURRICULUM GOAL-park budget: today \$30\.00 >= \$30\.00 cap — refusing to start \(exit 3\)/)
    assert.ok(!fs.existsSync(t.marker), 'the loop never started')
    assert.ok(!ledger(t)['GOAL-park'], 'the refused goal is not recorded')
  })

  it('a goal dir missing files is skipped, never env; the other goal still runs', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const bad = path.join(t.dir, 'broken')
    fs.mkdirSync(bad, { recursive: true })
    fs.writeFileSync(path.join(bad, 'spots.json'), JSON.stringify([]))
    const r = runNight(t, { dump: NOPAGE, goals: `${g},${bad}`, gate: 'red', loopMode: 'green', cost: '0.50' })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-broken skipped: no goal files/)
    assert.match(r.out, /CURRICULUM GOAL-park GREEN attempts=2 cost=\$0\.50/)
    assert.equal(ledger(t)['GOAL-park'].verdict, 'GREEN:unpromoted')
    assert.ok(!ledger(t)['GOAL-broken'], 'nothing recorded for the skipped goal')
    assert.match(r.out, /tried=1 green=1 red=0 skipped=1 cost=\$0\.50/)
  })

  it('a relative goal path resolves from the caller cwd, like DUMP (revmux 01 core-1)', () => {
    const t = setup()
    makeGoal(t.dir) // t.dir/park
    const r = runNight(t, {
      dump: NOPAGE, goals: 'park', gate: 'red', loopMode: 'green',
      cwd: t.dir, script: path.join(BOT, 'tools/curriculum.sh'),
    })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-park GREEN attempts=2 cost=\$0\.50/)
  })

  it('a present but malformed scenario.json is skipped, never fatal (revmux 01 core-2)', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    fs.writeFileSync(path.join(g, 'scenario.json'), '[]\n')
    const r = runNight(t, { dump: NOPAGE, goals: g, gate: 'red', loopMode: 'green' })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-park skipped: bad goal files/)
    assert.deepEqual(ledger(t), {}, 'nothing recorded for the malformed goal')
    assert.ok(!fs.existsSync(t.marker), 'the loop never started')
    assert.match(r.out, /tried=0 green=0 red=0 skipped=1 cost=\$0\.00/)
  })

  it('CURRICULUM_K=0 with goals runs goals only and needs no dump', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const r = runNight(t, { k: 0, dump: path.join(t.dir, 'no-such-dump.txt'), goals: g, gate: 'red', loopMode: 'green' })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-park GREEN attempts=2 cost=\$0\.50/)
    assert.ok(!r.out.includes('harvest events='), 'no harvest on a goals-only night')
  })

  it('DUMP stays required when K>0', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const r = runNight(t, { dump: path.join(t.dir, 'no-such-dump.txt'), goals: g })
    assert.equal(r.rc, 2)
    assert.match(r.out, /usage: sh tools\/curriculum\.sh/)
  })

  it('a recent RED goal is skipped; a week-old RED goal is retried', () => {
    const t = setup()
    const g = makeGoal(t.dir)
    const seed = { 'GOAL-park': { date: daysAgo(0), verdict: 'RED', attempts: 2, cost: 0.5, skillPath: null, resultJson: null, count: 0, reds: 1 } }
    const r = runNight(t, { dump: NOPAGE, goals: g, gate: 'red', loopMode: 'green', seed })
    assert.equal(r.rc, 0)
    assert.match(r.out, /CURRICULUM GOAL-park skipped: red-recent/)
    assert.ok(!fs.existsSync(t.marker), 'the loop never started')
    const t2 = setup()
    const g2 = makeGoal(t2.dir)
    const seed2 = { 'GOAL-park': { date: daysAgo(8), verdict: 'RED', attempts: 2, cost: 0.5, skillPath: null, resultJson: null, count: 0, reds: 1 } }
    const r2 = runNight(t2, { dump: NOPAGE, goals: g2, gate: 'red', loopMode: 'green', seed: seed2 })
    assert.equal(r2.rc, 0)
    assert.match(r2.out, /CURRICULUM GOAL-park GREEN/)
    assert.deepEqual([ledger(t2)['GOAL-park'].verdict, ledger(t2)['GOAL-park'].reds], ['GREEN:unpromoted', 1])
  })
})
