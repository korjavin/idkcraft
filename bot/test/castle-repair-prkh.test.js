'use strict'

// idkcraft-prkh rig scenario: dead quarry + protected-only logs + chest
// planks. prkhCells is the fence-and-torch knock subset, stoneheldAt the
// verdict's stone-gap tag.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { prkhCells, quarryDeadFills, chestwaterFills, stoneheldAt } = require('../tools/castle-replay')
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

  // idkcraft-awt9: the dead-quarry water sits wholly below the surface
  // block (top at site.y - 2, surface intact). A top at site.y + 1 flooded
  // the pad surface and the gate approach, stalling Baritone's chest walk
  // (noPath) so the v2 fence leg failed no-trees without drawing the
  // stocked chest.
  it('buries the dead-quarry water below the surface block, one column per probe', () => {
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: blueprint.BLUEPRINT_VERSION }
    const fills = quarryDeadFills(st)
    assert.ok(fills.length > 16, `want quarry sides + pit spots, got ${fills.length}`)
    for (const cmd of fills) {
      const m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:water$/.exec(cmd)
      assert.ok(m, `unparseable fill: ${cmd}`)
      const [, x0, yTop, z0, x1, yBot, z1] = m.map(Number)
      assert.equal(x0, x1, `not a single column: ${cmd}`)
      assert.equal(z0, z1, `not a single column: ${cmd}`)
      assert.equal(yTop, st.site.y - 2, `water touches the surface block: ${cmd}`)
      assert.equal(yBot, st.site.y - 9, `probe column too short to stay wet: ${cmd}`)
    }
  })

  it('wires the new knobs through castle-rig.sh', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8')
    for (const knob of ["''|wood|nowood|planks|prkh", 'CASTLE_QUARRY', 'CASTLE_REKNOCK', 'CASTLE_CHESTWATER']) {
      assert.ok(script.includes(knob), `missing ${knob}`)
    }
    assert.ok(script.includes('CASTLE_QUARRY="${CASTLE_QUARRY:-}"'), 'quarry not exported')
    assert.ok(script.includes('CASTLE_REKNOCK="${CASTLE_REKNOCK:-}"'), 'reknock not exported')
    assert.ok(script.includes('CASTLE_CHESTWATER="${CASTLE_CHESTWATER:-}"'), 'chestwater not exported')
  })

  // idkcraft-6fc1: a sunken pit across the gate-approach walkway, outside
  // the fence line — lid opened at pad top, water a block below grade, so
  // the climb-out is the obstacle. Rotation-safe; the box never touches a
  // plan cell (damage) or the spawn (the bot must walk the approach).
  it('sinks the gate approach outside the fence line on every rotation', () => {
    for (const rot of [0, 1, 2, 3]) {
      const st = { site: { x: 0, y: 64, z: 0 }, rot, blueprintVersion: blueprint.BLUEPRINT_VERSION }
      const fills = chestwaterFills(st)
      assert.equal(fills.length, 2, `lid + body, rot ${rot}`)
      const lid = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:air$/.exec(fills[0])
      const body = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:water$/.exec(fills[1])
      assert.ok(lid, `unparseable lid: ${fills[0]}`)
      assert.ok(body, `unparseable body: ${fills[1]}`)
      const [x0, yLid, z0, x1, yLid1, z1] = lid.slice(1).map(Number)
      const [wx0, yTop, wz0, wx1, yBot, wz1] = body.slice(1).map(Number)
      assert.equal(yLid, st.site.y - 1, `lid off the pad top, rot ${rot}`)
      assert.equal(yLid1, yLid, `lid one layer, rot ${rot}`)
      assert.equal(yTop, st.site.y - 2, `surface not a block below grade, rot ${rot}`)
      assert.equal(yBot, st.site.y - 6, `pit through the pad base, rot ${rot}`)
      assert.deepEqual([wx0, wz0, wx1, wz1], [x0, z0, x1, z1], `body under the lid, rot ${rot}`)
      assert.ok(Math.max(x1 - x0, z1 - z0) + 1 >= 11 && Math.min(x1 - x0, z1 - z0) + 1 >= 2,
        `a crossing, not a puddle, rot ${rot}`)
      const plan = new Set(blueprint.absPlan(st.site, rot, blueprint.BLUEPRINT_VERSION).cells.map((c) => `${c.x},${c.z}`))
      let overlap = 0
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (plan.has(`${x},${z}`)) overlap++
      assert.equal(overlap, 0, `pit under the castle, rot ${rot}`)
      // The box straddles the walkway axis (no dry walk through the middle).
      const gap = blueprint.rotatePlan([{ dx: 15, dy: 0, dz: 0 }], rot, blueprint.BLUEPRINT_VERSION)[0]
      const ent = blueprint.rotatePlan([{ dx: 15, dy: 0, dz: 5 }], rot, blueprint.BLUEPRINT_VERSION)[0]
      const door = blueprint.rotatePlan([{ dx: 15, dy: 0, dz: 7 }], rot, blueprint.BLUEPRINT_VERSION)[0]
      const ax = Math.abs(ent.dx - door.dx) >= Math.abs(ent.dz - door.dz) ? Math.sign(ent.dx - door.dx) : 0
      const az = Math.abs(ent.dx - door.dx) >= Math.abs(ent.dz - door.dz) ? 0 : Math.sign(ent.dz - door.dz)
      // The walk line's constant coordinate runs through the box.
      if (ax !== 0) assert.ok(z0 <= st.site.z + gap.dz && st.site.z + gap.dz <= z1, `pit off the walkway, rot ${rot}`)
      else assert.ok(x0 <= st.site.x + gap.dx && st.site.x + gap.dx <= x1, `pit off the walkway, rot ${rot}`)
    }
    // The seed's rot-0 spawn (gate.x + 2.5, gate.z - 3.5) stands clear.
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: blueprint.BLUEPRINT_VERSION }
    const gap = blueprint.rotatePlan([{ dx: 15, dy: 0, dz: 0 }], 0, blueprint.BLUEPRINT_VERSION)[0]
    const spawn = { x: st.site.x + gap.dx + 2.5, z: st.site.z + gap.dz - 3.5 }
    const lid = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) /.exec(chestwaterFills(st)[0])
    const [x0, , z0, x1, , z1] = lid.slice(1).map(Number)
    assert.ok(spawn.x < x0 - 1 || spawn.x > x1 + 1 || spawn.z < z0 - 1 || spawn.z > z1 + 1,
      `spawn inside the pit (${spawn.x},${spawn.z} vs ${x0}..${x1} ${z0}..${z1})`)
  })
})
