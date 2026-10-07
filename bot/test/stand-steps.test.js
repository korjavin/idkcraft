const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// idkcraft-vmzq.23: the +history+options variant is the exact .21 watchdog
// ask, and the fixture carries the run-2/3/4 watchdog rows. No network:
// the variant builders and the fixture cache are asserted, not the model.
describe('stand-steps.js +history+options variant', () => {
  const { VARIANTS } = require('../tools/stand-steps')
  const { STEP_CRITERIA } = require('../src/goal')
  const { PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION } = require('../src/task')

  it('asks the prod watchdog question: PLAN instructions, criteria, full planState', () => {
    const V = VARIANTS['+history+options']
    assert.ok(V, 'missing +history+options variant')
    assert.equal(V.instr({}), PLAN_INSTRUCTIONS)
    const criteria = V.criteria()
    assert.equal(criteria.park, PLAN_PARK_CRITERION)
    for (const n of ['castle', 'castlefetch', 'beds', 'shelter']) {
      assert.equal(criteria[n], STEP_CRITERIA[n], `criteria drift for ${n}`)
    }
    const row = {
      facts: 'time=day',
      menu: ['castlefetch', 'castle', 'park'],
      context: {
        goal: 'build castle', progress: '0/1722', blocked_on: 'stone', recent: ['x'],
        since_min: 12, history: [{ choice: 'castle', outcome: 'flat', dur_s: 60, delta: '+0' }],
      },
    }
    assert.deepEqual(V.state(row), {
      goal: 'build castle', progress: '0/1722', blocked_on: 'stone', recent: ['x'],
      since_min: 12, facts: 'time=day',
      history: [{ choice: 'castle', outcome: 'flat', dur_s: 60, delta: '+0' }],
    })
    assert.deepEqual(V.menu(row), ['castlefetch', 'castle', 'park'])
  })

  it('defaults a missing history ring to [] (pre-.21 rows ride along)', () => {
    const V = VARIANTS['+history+options']
    const row = {
      facts: 'time=day', menu: ['equip', 'rest'],
      context: { goal: 'build home', progress: 'n/a', blocked_on: 'none', recent: [], since_min: 0 },
    }
    assert.deepEqual(V.state(row).history, [])
  })
})

describe('goal-context-eval.json watchdog rows', () => {
  const file = path.join(__dirname, 'fixtures', 'goal-context-eval.json')
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { goalFsm } = require('../src/goal')

  it('carries >= 10 .21-shaped rows (history ring in context)', () => {
    const wd = rows.filter((r) => r.context && Array.isArray(r.context.history))
    assert.ok(wd.length >= 10, `only ${wd.length} rows with history`)
    for (const r of wd) {
      assert.ok(r.menu.includes('park'), `${r.id}: watchdog menu without park`)
      assert.ok(r.menu.every((n) => n !== 'rest'), `${r.id}: watchdog menu with rest`)
    }
  })

  it('keeps the fsm cache honest: every filed fsm matches goalFsm', () => {
    for (const r of rows) {
      const m = /time=(day|dusk|night)/.exec(r.facts)
      const fsm = goalFsm({ time: m ? m[1] : 'day' }, r.menu)
      assert.equal(r.fsm, fsm, `fixture ${r.id}: filed fsm=${r.fsm} but goalFsm says ${fsm}`)
      assert.ok(r.context && r.context.goal, `fixture ${r.id}: missing context`)
    }
  })
})
