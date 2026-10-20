'use strict'

// idkcraft-vf8e.19: the hand-written park curriculum goal stays runnable —
// both goal files parse with the replay's spot parser, the verify fields
// carry the bead's contract (GAP #617 checkerboard, 5 saplings, gap 2),
// and the r=3 checkerboard fits the verdict box. The rig
// (REPLAY_BODY=baritone) is the verdict; this is the fast rot gate.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, '..', 'tools', 'goals', 'park')
const SAPLINGS = ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling']

function readGoals() {
  return {
    scenarios: JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8')),
    spots: JSON.parse(fs.readFileSync(path.join(DIR, 'spots.json'), 'utf8')),
  }
}

function loadViaParser() {
  const prev = process.env.REPLAY_SPOTS
  process.env.REPLAY_SPOTS = path.join(DIR, 'spots.json')
  try {
    return require('../tools/stuck-replay.js').loadSpots()
  } finally {
    if (prev === undefined) delete process.env.REPLAY_SPOTS
    else process.env.REPLAY_SPOTS = prev
  }
}

// The pitch-2 checkerboard the task text specifies (GAP #617): grid cells
// with even dx,dz from the anchor, only where (dx/2+dz/2) is even.
function lattice(cx, cz, r) {
  const cells = []
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx % 2 !== 0 || dz % 2 !== 0) continue
      if (Math.abs(dx / 2 + dz / 2) % 2 === 0) cells.push([cx + dx, cz + dz])
    }
  }
  return cells
}

describe('park curriculum goal (vf8e.19)', () => {
  it('one scenario entry per spot, same skill, kind step, sabotage null', () => {
    const { scenarios, spots } = readGoals()
    assert.equal(scenarios.length, 2)
    assert.equal(spots.length, 2)
    for (const sc of scenarios) {
      assert.equal(sc.skill, 'gen_park')
      assert.equal(sc.kind, 'step')
      assert.equal(sc.bead, 'idkcraft-vf8e.19')
      assert.equal(sc.sabotage, null)
      assert.ok(sc.task.length > 200, 'the task carries the full contract')
      assert.ok(spots.some((s) => s.name === sc.spot), sc.spot)
    }
    assert.deepEqual(scenarios.map((s) => s.spot).sort(), ['PARK-GATHER', 'PARK-KIT'])
  })

  it('the task text states the whole contract', () => {
    const { scenarios } = readGoals()
    for (const sc of scenarios) {
      for (const clause of [
        'do gen_park', 'st.count', 'entities()', 'checkerboard',
        'both even', '(dx/2 + dz/2) is even',
        'Chebyshev', 'grass_block', 'never dig below the surface',
        "facts.pinned === 'gen_park'", "'day'", 'castle', 'no chat',
        "'done'", "'failed:no-saplings'",
      ]) assert.ok(sc.task.includes(clause), `${sc.name}: task must state ${clause}`)
    }
  })

  it('the spots parse with the replay spot parser as order spots', () => {
    const parsed = loadViaParser()
    assert.equal(parsed.length, 2)
    for (const s of parsed) {
      assert.equal(s.mode, 'order')
      assert.equal(s.order, 'do gen_park 3')
      assert.deepEqual(s.expect, ['done: do gen_park'])
      assert.deepEqual(s.fail, ['no step ', 'plan stopped at ', "I can't plan that", "can't "])
      assert.deepEqual(s.spawn, [59.5, 64, -205.5])
      assert.deepEqual(s.goal, [62.5, 64, -205.5])
      assert.equal(s.scaffold, 0)
      assert.equal(s.pickaxe, false)
      assert.ok(s.verify, `${s.name}: the world verdict watches the planting`)
    }
  })

  it('the verify fields carry the bead contract', () => {
    const parsed = loadViaParser()
    const kit = parsed.find((s) => s.name === 'PARK-KIT')
    const gather = parsed.find((s) => s.name === 'PARK-GATHER')
    for (const s of [kit, gather]) {
      assert.deepEqual(s.verify.blocks, SAPLINGS, 'the 7 overworld saplings')
      assert.equal(s.verify.around, 'goal')
      assert.equal(s.verify.radius, 3)
      assert.equal(s.verify.dy, 1)
      assert.equal(s.verify.gap, 2)
      assert.equal(s.verify.lattice, 'checkerboard', 'GAP #617: the lattice, not just the gap')
    }
    assert.equal(kit.verify.min, 5, 'r=3 checkerboard yields 5 cells')
    assert.equal(gather.verify.min, 5, 'r=3 checkerboard yields 5 cells')
    assert.equal(kit.secs, 300)
    assert.equal(gather.secs, 600)
  })

  it('KIT plants from the pack, GATHER fells the prep oaks', () => {
    const parsed = loadViaParser()
    const kit = parsed.find((s) => s.name === 'PARK-KIT')
    const gather = parsed.find((s) => s.name === 'PARK-GATHER')
    assert.deepEqual(kit.kit, ['oak_sapling 16', 'dirt 16'])
    assert.deepEqual(gather.kit, ['iron_axe 1', 'dirt 16'])
    assert.ok(!gather.kit.some((k) => k.includes('sapling')), 'gather carries no saplings')
    const oaks = gather.prep.filter((c) => c.startsWith('place feature minecraft:oak '))
    assert.equal(oaks.length, 6, 'six prep oaks to fell')
    const [gx, , gz] = gather.goal
    for (const c of oaks) {
      const m = /^place feature minecraft:oak (\d+) 64 (-?\d+)$/.exec(c)
      assert.ok(m, `oak prep shape: ${c}`)
      const [x, z] = [+m[1], +m[2]]
      assert.ok(x >= 55 && x <= 69 && z >= -212 && z <= -198, `oak on the cleared flat: ${c}`)
      assert.ok(Math.hypot(x - gx, z - gz) <= 20, `oak within 20 blocks of the goal: ${c}`)
    }
  })

  it('the r=3 checkerboard fits the verdict box with room for the kit', () => {
    const parsed = loadViaParser()
    const kit = parsed.find((s) => s.name === 'PARK-KIT')
    const cx = Math.floor(kit.goal[0])
    const cz = Math.floor(kit.goal[2])
    const cells = lattice(cx, cz, 3)
    assert.deepEqual(cells.sort(), [[cx - 2, cz - 2], [cx - 2, cz + 2], [cx, cz], [cx + 2, cz - 2], [cx + 2, cz + 2]].sort(),
      'r=3 checkerboard: the anchor plus (±2,±2)')
    assert.ok(cells.length >= kit.verify.min, 'the lattice clears min even with no loss')
    for (const [x, z] of cells) {
      assert.ok(Math.abs(x - cx) <= 3 && Math.abs(z - cz) <= 3, `lattice cell in the verify box: ${x},${z}`)
      assert.ok(x >= 55 && x <= 69 && z >= -212 && z <= -198, `lattice cell on the cleared flat: ${x},${z}`)
    }
    for (let a = 0; a < cells.length; a++) {
      for (let b = a + 1; b < cells.length; b++) {
        const d = Math.max(Math.abs(cells[a][0] - cells[b][0]), Math.abs(cells[a][1] - cells[b][1]))
        assert.ok(d >= 2, `no two saplings within Chebyshev 1: ${cells[a]} vs ${cells[b]}`)
      }
    }
    const gather = parsed.find((s) => s.name === 'PARK-GATHER')
    const trunks = gather.prep.filter((c) => c.startsWith('place ')).map((c) => c.split(' ').slice(-2).join(','))
    for (const [x, z] of cells) assert.ok(!trunks.includes(`${x},${z}`), `no oak trunk on lattice cell ${x},${z}`)
  })

  it('the loop seam resolves both scenarios from the goal files', () => {
    const { loopFiles } = require('../tools/skill-loop')
    const files = loopFiles({
      SKILL_LOOP_SCENARIOS: path.join(DIR, 'scenario.json'),
      SKILL_LOOP_SPOTS: path.join(DIR, 'spots.json'),
    })
    assert.equal(files.curriculum, true, 'goal files run in curriculum verdict mode')
    const scList = JSON.parse(fs.readFileSync(files.scenarios, 'utf8'))
    const spotList = JSON.parse(fs.readFileSync(files.spots, 'utf8'))
    for (const name of ['park-kit', 'park-gather']) {
      const sc = scList.find((s) => s.name === name)
      assert.ok(sc, name)
      assert.ok(spotList.some((s) => s.name === sc.spot), `${name}: spot in the spots file`)
      assert.equal(sc.sabotage, null, `${name}: no baseline entry, the replay row decides`)
    }
  })
})
