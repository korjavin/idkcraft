'use strict'

// idkcraft-6x7.4: the stuck oracle gate — baseline comparison, baseline
// coverage, and rig-script pins. No physics here (no server): the pure
// compare, the file contracts, and the exit-code arms.

process.env.REPLAY_QUIET = '0' // keep the script's ticker-chatter filter off
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { compareBaseline, pickBrain, gateCode } = require('../tools/stuck-replay')

const TOOLS = path.join(__dirname, '..', 'tools')

function row(spot, reached, stuck, eps) {
  return { spot, reached, stuck, eps, by: [], call: 0, secs: 10, maxDisp: 1, minDist: 1, minGuide: 1, note: '' }
}

describe('compareBaseline verdicts (idkcraft-6x7.4)', () => {
  const base = { brain: 'stub', spots: { A: { reached: true, maxStuck: 2, maxEps: 1 } } }

  it('exact match is ok', () => {
    const [d] = compareBaseline([row('A', true, 2, 1)], base)
    assert.equal(d.verdict, 'ok')
  })

  it('reached flipping true->false is regressed', () => {
    const [d] = compareBaseline([row('A', false, 0, 0)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /unreached/)
  })

  it('stuck over the ceiling is regressed', () => {
    const [d] = compareBaseline([row('A', true, 3, 0)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /stuck 3 > 2/)
  })

  it('episodes over the ceiling are regressed', () => {
    const [d] = compareBaseline([row('A', true, 0, 2)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /episodes 2 > 1/)
  })

  it('improvement is not a regression', () => {
    const [d] = compareBaseline([row('A', true, 0, 0)], base)
    assert.equal(d.verdict, 'improved')
  })

  it('reached flipping false->true is improved', () => {
    const b = { brain: 'stub', spots: { A: { reached: false, maxStuck: 5, maxEps: 2 } } }
    const [d] = compareBaseline([row('A', true, 5, 2)], b)
    assert.equal(d.verdict, 'improved')
  })

  it('spot without a baseline entry fails the gate', () => {
    const [d] = compareBaseline([row('NEW', true, 0, 0)], base)
    assert.equal(d.verdict, 'no-baseline')
    assert.equal(d.was, 'none')
  })

  it('malformed entry counts as missing', () => {
    const b = { brain: 'stub', spots: { A: { reached: true } } }
    const [d] = compareBaseline([row('A', true, 0, 0)], b)
    assert.equal(d.verdict, 'no-baseline')
  })

  it('was/now diff prints on every non-ok verdict', () => {
    const [d] = compareBaseline([row('A', false, 9, 3)], base)
    assert.match(d.was, /reached=true stuck<=2 eps<=1/)
    assert.match(d.now, /reached=false stuck=9 eps=3/)
  })
})

describe('gateCode verdict reduction (idkcraft-6x7.4 round 2)', () => {
  const diff = (spot, verdict, why = 'x') => ({ spot, verdict, was: 'w', now: 'n', why })
  const rowWith = (note) => ({ spot: 'A', reached: false, stuck: 0, eps: 0, note })

  it('all ok exits 0', () => {
    const v = gateCode([rowWith('')], [diff('A', 'ok')])
    assert.deepEqual(v, { code: 0, ok: 1, better: 0, bad: 0, env: 0 })
  })

  it('regressed exits 1', () => {
    const v = gateCode([rowWith('')], [diff('A', 'regressed')])
    assert.equal(v.code, 1)
    assert.equal(v.bad, 1)
  })

  it('no-baseline exits 1 (the corpus rule fails the gate)', () => {
    const v = gateCode([rowWith('')], [diff('A', 'no-baseline')])
    assert.equal(v.code, 1)
    assert.equal(v.bad, 1)
  })

  it('improved exits 0', () => {
    const v = gateCode([rowWith('')], [diff('A', 'improved')])
    assert.deepEqual(v, { code: 0, ok: 0, better: 1, bad: 0, env: 0 })
  })

  it('GUIDE-BURIED skips the comparison and exits 2', () => {
    const v = gateCode([rowWith('GUIDE-BURIED')], [diff('A', 'regressed')])
    assert.deepEqual(v, { code: 2, ok: 0, better: 0, bad: 0, env: 1 })
  })

  it('GUIDE-DIED exits 2 like buried', () => {
    const v = gateCode([rowWith('GUIDE-DIED')], [diff('A', 'regressed')])
    assert.equal(v.code, 2)
    assert.equal(v.env, 1)
  })

  it('env dominates a co-occurring regression', () => {
    const v = gateCode([rowWith('GUIDE-BURIED'), rowWith('')], [diff('A', 'regressed'), diff('B', 'regressed')])
    assert.equal(v.code, 2)
    assert.equal(v.bad, 1)
    assert.equal(v.env, 1)
  })

  it('DIED stays judged (dying is behavior)', () => {
    const v = gateCode([rowWith('DIED')], [diff('A', 'regressed')])
    assert.equal(v.code, 1)
    assert.equal(v.env, 0)
  })
})

describe('pickBrain (idkcraft-6x7.4)', () => {
  it('defaults to stub', () => {
    delete process.env.REPLAY_BRAIN
    const p = pickBrain()
    assert.equal(p.label, 'stub')
    assert.equal(p.make().name, 'stub')
  })

  it('laya builds the shipped hybrid, never a copy', () => {
    process.env.REPLAY_BRAIN = 'laya'
    try {
      const p = pickBrain()
      assert.match(p.label, /^laya\(http/)
      const brain = p.make()
      assert.equal(brain.name, 'hybrid')
      assert.equal(typeof brain.decide, 'function')
    } finally {
      delete process.env.REPLAY_BRAIN
    }
  })

  it('unknown brain fails loud', () => {
    process.env.REPLAY_BRAIN = 'jev'
    try {
      assert.throws(() => pickBrain(), /REPLAY_BRAIN: want stub\|laya/)
    } finally {
      delete process.env.REPLAY_BRAIN
    }
  })
})

describe('stuck-baseline.json covers the corpus (idkcraft-6x7.4)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))

  it('baseline names the stub brain', () => {
    assert.equal(baseline.brain, 'stub')
  })

  it('every corpus spot has a well-formed entry', () => {
    const names = new Set(spots.map((s) => s.name))
    assert.ok(names.size === spots.length, 'duplicate spot names')
    for (const s of spots) {
      const e = baseline.spots[s.name]
      assert.ok(e, `spot ${s.name} has no baseline entry`)
      assert.equal(typeof e.reached, 'boolean', `${s.name}: reached must be boolean`)
      assert.ok(Number.isInteger(e.maxStuck) && e.maxStuck >= 0, `${s.name}: bad maxStuck`)
      assert.ok(Number.isInteger(e.maxEps) && e.maxEps >= 0, `${s.name}: bad maxEps`)
    }
  })

  it('no baseline entry dangles off-corpus', () => {
    const names = new Set(spots.map((s) => s.name))
    for (const k of Object.keys(baseline.spots)) {
      assert.ok(names.has(k), `baseline entry ${k} has no corpus spot`)
    }
  })

  it('work-bug terrain spots carry their bead', () => {
    const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
    for (const [spot, bead] of [['ATL-SHAFT', 'idkcraft-atl.17'], ['JR-SLOPE', 'idkcraft-jr2.4'], ['Q0H-PIT', 'idkcraft-q0h']]) {
      assert.ok(byName[spot], `missing work-terrain spot ${spot}`)
      assert.ok((byName[spot].bead || '').includes(bead), `${spot} must cite ${bead}`)
    }
  })
})

describe('stuck-replay.js gate wiring (idkcraft-6x7.4)', () => {
  const replay = fs.readFileSync(path.join(TOOLS, 'stuck-replay.js'), 'utf8')

  it('REPLAY_OUT defaults to tools/last-replay.json', () => {
    assert.ok(replay.includes("process.env.REPLAY_OUT || path.join(__dirname, 'last-replay.json')"),
      'REPLAY_OUT default missing')
  })

  it('no unconditional exit 0 survives (the always-green bug)', () => {
    assert.ok(!replay.includes('process.exit(0)'), 'unconditional exit 0 is back')
    assert.ok(replay.includes('process.exit(code)'), 'gate code must reach the exit')
    assert.ok(replay.includes('process.exit(2)'), 'harness errors must exit 2')
  })

  it('a dropped follower exits 2, never 1', () => {
    assert.ok(replay.includes('follower dropped before the verdict'), 'drop log missing')
    assert.ok(replay.includes('gating = true'), 'gate exit must pass the wrapper through')
  })

  it('laya runs never judge against the stub baseline', () => {
    assert.ok(replay.includes("brainName !== 'stub'"), 'brain guard missing')
    assert.ok(replay.includes('stub baseline does not apply'), 'skip message missing')
  })

  it('overlong bot names fail fast with the real cause', () => {
    assert.ok(replay.includes('bot names exceed 16 chars'), 'name-length guard missing')
  })
})

describe('stuck-run.sh oracle wiring (idkcraft-6x7.4)', () => {
  const script = fs.readFileSync(path.join(TOOLS, 'stuck-run.sh'), 'utf8')

  it('exports a stable REPLAY_TAG and pre-ops both bots', () => {
    assert.ok(script.includes('_ptail=$(( $$ % 1000 ))'), 'TAG pid-tail missing')
    assert.ok(script.includes('export REPLAY_TAG="${REPLAY_TAG:-r$_ptail}"'), 'TAG default missing')
    assert.ok(script.includes('rcon_assert "op StuckGuide$REPLAY_TAG"'), 'guide pre-op missing')
    assert.ok(script.includes('rcon_assert "op StuckReplay$REPLAY_TAG"'), 'follower pre-op missing')
  })

  it('pristine sha mismatch fails the run with exit 2', () => {
    assert.ok(script.includes('PRISTINE world.tar CHANGED'), 'mismatch message missing')
    assert.ok(script.includes('exit 2 # env failure dominates'), 'mismatch must exit 2')
  })

  it('the replay verdict passes through, signals never pass', () => {
    assert.ok(script.includes('exit "$rc"'), 'verdict passthrough missing')
    assert.ok(script.includes('exit 130'), 'interrupted runs must not exit 0')
  })

  it('last-replay.json is gitignored', () => {
    const rootIgnore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8')
    assert.ok(rootIgnore.includes('bot/tools/last-replay.json'), 'results file must be gitignored')
  })
})
