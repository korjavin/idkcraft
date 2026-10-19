const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { extractCode, verdictLine, cost, check } = require('../tools/skill-loop')
const scenarios = require('../tools/skill-scenarios.json')
const spots = require('../tools/stuck-spots.json')
const { RECOVER_MENU } = require('../src/behaviours/recover')
const { MENU } = require('../src/goal')

// idkcraft-vf8e.3: the loop host's pure parts and the scenario table.
describe('skill-loop (idkcraft-vf8e.3)', () => {
  it('extractCode takes the last fenced block, else the whole text', () => {
    assert.equal(extractCode('plan\n```js\na()\n```\nfix\n```javascript\nb()\n```\n'), 'b()\n')
    assert.equal(extractCode('c()'), 'c()\n')
  })

  it('verdictLine keeps the BASELINE and micro-run lines', () => {
    assert.equal(verdictLine('x\nBASELINE S: was a | now b\nmicro-run: exit 1 in 9s\n'), 'BASELINE S: was a | now b | micro-run: exit 1 in 9s')
  })

  it('cost prices opus 5.5 at $4/$20 per 1M', () => {
    assert.equal(cost(1e6, 1e5, 'claude-opus-5-5'), 6)
  })

  it('check compiles with the real loader and pins the header', () => {
    const sc = { skill: 'gen_x', kind: 'recover' }
    const ok = '/* skill {"name": "gen_x", "description": "d", "kind": "recover"} */\nfunction feasible(f) { return false }\nfunction run(bot, st) { return "done" }\n'
    assert.equal(check(sc, 'gen_x.js', ok), null)
    assert.match(check({ skill: 'gen_y', kind: 'recover' }, 'gen_x.js', ok), /header must say/)
    assert.match(check(sc, 'gen_x.js', 'nope'), /^compile: /)
  })

  it('every scenario names a corpus spot, a real sabotage target and a free skill name', () => {
    for (const sc of scenarios) {
      assert.ok(spots.some((s) => s.name === sc.spot), sc.spot)
      assert.ok(Object.hasOwn(RECOVER_MENU, sc.sabotage) || Object.hasOwn(MENU, sc.sabotage), sc.sabotage)
      assert.ok(['recover', 'step'].includes(sc.kind))
      assert.match(sc.skill, /^gen_[a-z0-9_]+$/)
      assert.ok(sc.task.length > 40)
    }
  })
})
