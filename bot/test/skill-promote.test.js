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
    const g = p.greenVerdict(RESULT, 'gen_x')
    assert.equal(g.verdict, 'baseline: 1/1 ok, 0 improved, 0 regressed, 0 env (stuck-baseline.json) | micro-run: exit 0 in 80s')
  })

  it('refuses a red result or another skill', () => {
    assert.match(p.greenVerdict({ ...RESULT, green: false }, 'gen_x'), /not green/)
    assert.match(p.greenVerdict(RESULT, 'gen_y'), /not gen_y/)
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
