'use strict'

// idkcraft-prkh rig scenario: dead quarry + protected-only logs + chest
// planks. prkhCells is the fence-and-torch knock subset, stoneheldAt the
// verdict's stone-gap tag.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { prkhCells, stoneheldAt } = require('../tools/castle-replay')
const blueprint = require('../src/castle')

describe('prkh rig scenario', () => {
  it('knocks 12 fence + 3 torch cells, no stone/door/stairs', () => {
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: blueprint.BLUEPRINT_VERSION }
    const knocked = prkhCells(st)
    assert.equal(knocked.length, 15)
    assert.equal(knocked.filter((c) => c.kind === 'fence').length, 12)
    assert.equal(knocked.filter((c) => c.kind === 'torch').length, 3)
    assert.ok(knocked.every((c) => typeof c.x === 'number' && typeof c.y === 'number' && typeof c.z === 'number'))
  })

  it('names the first stamped stone fetch; a torch hold under a stone word never misattributes', () => {
    const at = (t, status, kind, cword) => ({ t, castleFail: status ? { status, kind } : undefined, cword })
    assert.equal(stoneheldAt([
      at(15, 'failed:castlefetch-no-torch', 'torch', 'torch'),
      at(30, 'failed:castlefetch-no-stone', 'stone', 'stone'),
    ]), 30, 'kinded stone failure')
    assert.equal(stoneheldAt([
      at(30, 'failed:castlefetch-no-torch', 'torch', 'stone'),
      at(45, 'failed:castlefetch-unreachable', null, 'stone'),
    ]), null, 'torch hold / kindless record under a stone word: no tag')
    assert.equal(stoneheldAt([]), null)
  })

  it('wires the new knobs through castle-rig.sh', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8')
    for (const knob of ["''|wood|nowood|planks|prkh", 'CASTLE_QUARRY', 'CASTLE_REKNOCK']) {
      assert.ok(script.includes(knob), `missing ${knob}`)
    }
    assert.ok(script.includes('CASTLE_QUARRY="${CASTLE_QUARRY:-}"'), 'quarry not exported')
    assert.ok(script.includes('CASTLE_REKNOCK="${CASTLE_REKNOCK:-}"'), 'reknock not exported')
  })
})
