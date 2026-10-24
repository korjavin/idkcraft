'use strict'

// skill-promote.js pure parts (idkcraft-vf8e.4). result.json mirrors what
// skill-loop.js writes (rows[].verdict = its verdictLine of the inner run).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { parseHeader } = require('../src/skills')
const p = require('../tools/skill-promote')

const SKILL = '/* skill {"name": "gen_x", "description": "climb: x", "kind": "recover"} */\nfunction feasible(f) { return true }\nfunction run(bot, st) { return \'done\' }\n'
const RESULT = {
  scenario: 'water-climb', spot: 'DUGPIT-BARE', sabotage: 'water_up', skill: 'gen_x', body: 'baritone', sha: 'c9a98c94', green: true, envFail: null,
  rows: [
    { attempt: 1, rc: 1, verdict: 'BASELINE DUGPIT-BARE: REGRESSION | micro-run: exit 1 in 107s' },
    { attempt: 2, rc: 0, verdict: 'baseline: 1/1 ok, 0 improved, 0 regressed, 0 env (/Users/someone/Projects/idkcraft/bot/tools/stuck-baseline.json) | micro-run: exit 0 in 80s' },
  ],
}

describe('skill-promote (vf8e.4)', () => {
  it('takes the green row verdict without local paths', () => {
    const g = p.greenVerdict(RESULT, 'gen_x', 'baritone')
    assert.equal(g.verdict, 'baseline: 1/1 ok, 0 improved, 0 regressed, 0 env (stuck-baseline.json) | micro-run: exit 0 in 80s')
  })

  it('refuses a red result, another skill, a missing/dirty sha or another body', () => {
    assert.match(p.greenVerdict({ ...RESULT, green: false }, 'gen_x', 'baritone'), /not green/)
    assert.match(p.greenVerdict(RESULT, 'gen_y', 'baritone'), /not gen_y/)
    for (const sha of [undefined, '?', 'c9a98c94-dirty']) assert.match(p.greenVerdict({ ...RESULT, sha }, 'gen_x', 'baritone'), /re-verify/, String(sha))
    assert.match(p.greenVerdict(RESULT, 'gen_x', 'mineflayer'), /verified on body baritone/)
  })

  it('a green run must show the skill done in its bot log', () => {
    assert.equal(p.ranDone('skills loaded n=1\nskill run skill=gen_x kind=recover outcome=done ticks=19\n', 'gen_x'), true)
    assert.equal(p.ranDone('skill run skill=gen_x kind=recover outcome=failed:no-dir ticks=5\n', 'gen_x'), false)
    assert.equal(p.ranDone('skills loaded n=1 names=gen_x\n', 'gen_x'), false, 'never chosen (v2 S6-LEAD)')
  })

  it('demotes a skill banned 3 days in a row, keeps the rest (idkcraft-vf8e.22)', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const log = [
      '2026-10-20 10:00:01 skill gen_dig banned fails=3 last=failed:no-progress',
      '2026-10-21 10:00:01 IdkBotV2 skill gen_dig banned fails=4 last=failed:no-progress',
      '2026-10-21 10:00:02 IdkBotV2 skill gen_climb banned fails=3 last=skill-timeout',
      '2026-10-22 10:00:01 skill gen_dig banned fails=5 last=failed:no-progress',
      '2026-10-22 10:00:02 skill run skill=gen_dig kind=step outcome=failed:no-progress ticks=9',
      '2026-10-22 10:00:03 skills loaded n=2 names=gen_climb,gen_dig',
    ].join('\n')
    assert.deepEqual(p.prodBans(log), { gen_dig: ['2026-10-20', '2026-10-21', '2026-10-22'], gen_climb: ['2026-10-21'] })
    assert.deepEqual(p.demotable(p.prodBans(log)), [{ skill: 'gen_dig', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
    // A gap breaks the run, and an old run does not demote a recovered skill.
    assert.deepEqual(p.demotable({ gen_gap: ['2026-10-20', '2026-10-22'] }), [])
    assert.deepEqual(p.demotable({ gen_old: ['2026-10-18', '2026-10-19', '2026-10-20'], gen_now: ['2026-10-22'] }), [])
    assert.deepEqual(p.demotable({ gen_two: ['2026-10-21', '2026-10-22'] }, 2), [{ skill: 'gen_two', days: ['2026-10-21', '2026-10-22'] }])
    // The file goes, the kept skill stays, a demotable name with no file is missing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-'))
    try {
      fs.writeFileSync(path.join(dir, 'gen_dig.js'), '// doomed\n')
      fs.writeFileSync(path.join(dir, 'gen_climb.js'), '// kept\n')
      const r = p.demoteFromLog(log, dir)
      assert.deepEqual(r.demoted, [{ skill: 'gen_dig', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
      assert.deepEqual(r.kept, [{ skill: 'gen_climb', days: ['2026-10-21'] }])
      assert.deepEqual(r.missing, [])
      assert.equal(fs.existsSync(path.join(dir, 'gen_dig.js')), false)
      assert.equal(fs.existsSync(path.join(dir, 'gen_climb.js')), true)
      const r2 = p.demoteFromLog(log, dir)
      assert.deepEqual(r2.missing, [{ skill: 'gen_dig', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('a skill named like an Object key does not break demotion (send-back R1)', () => {
    const log = [
      '2026-10-20 10:00:01 skill constructor banned fails=3 last=failed:no-progress',
      '2026-10-21 10:00:01 skill constructor banned fails=4 last=failed:no-progress',
      '2026-10-22 10:00:01 skill constructor banned fails=5 last=failed:no-progress',
    ].join('\n')
    assert.deepEqual(p.prodBans(log), { constructor: ['2026-10-20', '2026-10-21', '2026-10-22'] })
    assert.deepEqual(p.demotable(p.prodBans(log)), [{ skill: 'constructor', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
  })

  it('a skill clean on the newest log day is kept (codex 01-review)', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const log = [
      '2026-10-20 10:00:01 skill gen_dig banned fails=3 last=failed:no-progress',
      '2026-10-21 10:00:01 skill gen_dig banned fails=4 last=failed:no-progress',
      '2026-10-22 10:00:01 skill gen_dig banned fails=5 last=failed:no-progress',
      '2026-10-23 10:00:01 skill run skill=gen_dig kind=step outcome=done ticks=9',
      '2026-10-23 10:00:02 decision source=fsm action=gather sprint=false dist=none',
    ].join('\n')
    assert.equal(p.newestDay(log), '2026-10-23')
    assert.equal(p.newestDay('no dated lines here'), null)
    // Unanchored, the old run still reads demotable; anchored at the log end
    // the recovered skill is kept and its file stays.
    assert.deepEqual(p.demotable(p.prodBans(log)), [{ skill: 'gen_dig', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-recovered-'))
    try {
      fs.writeFileSync(path.join(dir, 'gen_dig.js'), '// recovered\n')
      const r = p.demoteFromLog(log, dir)
      assert.deepEqual([r.demoted, r.missing], [[], []])
      assert.deepEqual(r.kept, [{ skill: 'gen_dig', days: ['2026-10-20', '2026-10-21', '2026-10-22'] }])
      assert.equal(fs.existsSync(path.join(dir, 'gen_dig.js')), true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('demote usage without logs exits 2', () => {
    const log = console.log
    console.log = () => {}
    try { assert.equal(p.demoteMain([]), 2) } finally { console.log = log }
  })

  it('mine is judged on the mean of its legs vs the v2 baseline', () => {
    const comps = [20, 35.3, 30].map((r) => ({ kind: 'mine', line: `mine-rate ${r}/game-min: banked=+1` }))
    assert.equal(p.meanLine(comps, 'mine', 29.4), 'mine mean 28.4 over 3 legs (20, 35.3, 30), baseline 29.4 (-3%, within)')
    assert.match(p.meanLine(comps.slice(0, 1), 'mine', 29.4), /-32%, REGRESSION/)
    assert.equal(p.meanLine([], 'lay', 76.5), 'lay mean: no rate')
  })

  it('writes verifiedBy and bead into the header, body untouched', () => {
    const out = p.promoteText(SKILL, RESULT, 'v', 'idkcraft-vf8e.4')
    const meta = parseHeader(out)
    assert.deepEqual(meta.verifiedBy, { scenario: 'water-climb', verdict: 'v', sha: 'c9a98c94', body: 'baritone' })
    assert.equal(meta.bead, 'idkcraft-vf8e.4')
    assert.equal(out.slice(out.indexOf('*/')), SKILL.slice(SKILL.indexOf('*/')))
  })

  it('quotes the stuck-run table rows and verdict lines only', () => {
    const out = [
      'boot: paper-base (log /tmp/x.log)',
      'S6-LEAD   true    0      1    false  54     6.3      OK here',
      'BASELINE S6-LEAD: was a | now b — REGRESSION',
      'baseline: 31/32 ok, 0 improved, 1 regressed, 0 env (/a/b/c/stuck-baseline.json)',
      'verdict: FLAKY — S6-LEAD (exit 0)',
    ].join('\n')
    assert.deepEqual(p.stuckLines(out), [
      'S6-LEAD   true    0      1    false  54     6.3      OK here',
      'BASELINE S6-LEAD: was a | now b — REGRESSION',
      'baseline: 31/32 ok, 0 improved, 1 regressed, 0 env (stuck-baseline.json)',
      'verdict: FLAKY — S6-LEAD (exit 0)',
    ])
    assert.equal(p.componentLine('x\nlay-rate 75.4/game-min: laid=754 in 10.0 game-min, tick=1, baseline 76.5 -> 75.4 (-1%, within ±20%)\n', 'lay'),
      'lay-rate 75.4/game-min: laid=754 in 10.0 game-min, tick=1, baseline 76.5 -> 75.4 (-1%, within ±20%)')
    assert.equal(p.componentLine('', 'mine'), '(no mine-rate line)')
  })
})
