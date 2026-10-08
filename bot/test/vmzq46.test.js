'use strict'

// idkcraft-vmzq.46: quarry-down pit — when no usable exposed stone exists and
// every trench side is dead or dug, dig a stepped pit at a dry spot near the
// site (outside the footprint and door path) through the dirt cap into stone.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const { canBreak } = require('../src/behaviours/util')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), under = (y) => (y <= 63 ? 'dirt' : 'air') } = {}) {
  const calls = { goals: [], dig: [] }
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : under(Math.floor(p.y))
  }
  return {
    username: 'IdkBot',
    calls,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { stone: { id: 1 }, chest: { id: 2 } },
      itemsByName: { cobblestone: {}, dirt: {}, stone: {}, torch: {} },
    },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: ({ matching }) => {
      const out = []
      for (const [k, n] of set) {
        if ((matching === 1 && n !== 'stone') || (matching === 2 && n !== 'chest')) continue
        const [x, y, z] = k.split(',').map(Number)
        out.push(pos(x, y, z))
      }
      return out
    },
    equip: async () => {},
    dig: async (b) => {
      calls.dig.push(b.position)
      set.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air')
    },
    pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

const TOOLS = () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }]

function quiet(fn) {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  try { fn() } finally { console.log = orig }
  return lines
}

// Column/lane of a cell within a pit frame.
function band(o, c) {
  return { i: (c.x - o.x) * o.dx + (c.z - o.z) * o.dz, l: (c.x - o.x) * o.lx + (c.z - o.z) * o.lz }
}

describe('quarry-down pit spots (vmzq.46)', () => {
  it('35 spots ring the footprint, nearest gap first, never the gate side', () => {
    for (const v of [1, 2]) {
      for (let rot = 0; rot < 4; rot++) {
        const st = castleState({ blueprintVersion: v, rot })
        const { w, d } = blueprint.siteDimensions(rot, v)
        const spots = fetch.pitSpots(st)
        assert.equal(spots.length, 35, `v${v} rot${rot}: 7 per gap`)
        const gaps = spots.map((o) => (
          o.dx === -1 ? SITE.x - o.x
          : o.dx === 1 ? o.x - (SITE.x + w - 1)
          : o.dz === -1 ? SITE.z - o.z
          : o.z - (SITE.z + d - 1)
        ))
        assert.deepEqual(gaps, [4, 6, 8, 10, 12].flatMap((g) => Array(7).fill(g)), `v${v} rot${rot}: outward gaps ascend`)
        // The gate side (apron minus door, rotated) has corners only, no mid.
        const bp = blueprint.blueprintOf(v)
        const at = (c) => blueprint.rotatePlan([{ ...c }], rot, v)[0]
        const door = at({ ...bp.DOOR })
        const apron = at({ ...bp.ENTRANCE })
        const gate = [Math.sign(apron.dx - door.dx), Math.sign(apron.dz - door.dz)]
        const isMid = (o) => o.dx !== 0
          ? (o.z >= SITE.z && o.z < SITE.z + d)
          : (o.x >= SITE.x && o.x < SITE.x + w)
        const mids = spots.filter(isMid)
        assert.equal(mids.length, 15, `v${v} rot${rot}: 3 mids per gap`)
        for (const m of mids) {
          assert.ok(!(m.dx === gate[0] && m.dz === gate[1]), `v${v} rot${rot}: no mid on the gate side`)
        }
      }
    }
  })

  it('every spot band stays off the 8 trench lanes (v1+v2, all rotations; revmux 01 major)', () => {
    for (const v of [1, 2]) {
      for (let rot = 0; rot < 4; rot++) {
        const st = castleState({ blueprintVersion: v, rot })
        for (const o of fetch.pitSpots(st)) {
          for (let i = 0; i < fetch.PIT_LEN; i++) {
            for (let l = 0; l < 2; l++) {
              const c = { x: o.x + o.dx * i + o.lx * l, z: o.z + o.dz * i + o.lz * l }
              assert.equal(fetch.inTrench(st, { ...c, y: st.site.y }), false, `v${v} rot${rot} pit cell ${c.x},${c.z} off trench lanes`)
              assert.equal(fetch.inTrench(st, { ...c, y: st.site.y - fetch.PIT_DEPTH }), false, `v${v} rot${rot} deep pit cell ${c.x},${c.z} off trench lanes`)
            }
          }
        }
        // Sanity: a trench origin reads as trenched.
        const t = fetch.quarrySide(st, 0, 0)
        assert.ok(fetch.inTrench(st, { x: t.x, y: st.site.y, z: t.z }), `v${v} rot${rot} trench origin is trenched`)
      }
    }
  })

  it('every spot band stays outside the footprint and door path (v1+v2, all rotations)', () => {
    for (const v of [1, 2]) {
      for (let rot = 0; rot < 4; rot++) {
        const st = castleState({ blueprintVersion: v, rot })
        for (const o of fetch.pitSpots(st)) {
          for (let i = 0; i < fetch.PIT_LEN; i++) {
            for (let l = 0; l < 2; l++) {
              const c = { x: o.x + o.dx * i + o.lx * l, z: o.z + o.dz * i + o.lz * l }
              assert.equal(blueprint.inFootprint(st, { ...c, y: st.site.y }), false, `v${v} rot${rot} origin band ${c.x},${c.z}`)
              assert.equal(blueprint.inFootprint(st, { ...c, y: st.site.y - fetch.PIT_DEPTH }), false, `v${v} rot${rot} deep band ${c.x},${c.z}`)
            }
          }
        }
      }
    }
  })
})

describe('quarry-down pit digging (vmzq.46)', () => {
  // Dirt cap 61..63 over stone: the pit must go through into stone.
  const CAP = (y) => (y <= 60 ? 'stone' : y <= 63 ? 'dirt' : 'air')

  function digPit(set, st, ctx) {
    const bot = makeBot({ items: TOOLS(), set, under: CAP })
    const o = fetch.pitSpots(st)[0]
    const f = { skip: new Set() }
    const dug = []
    const names = []
    quiet(() => {
      for (let n = 0; n < 3000; n++) {
        const c = fetch.pickPit(bot, ctx, f)
        if (!c) break
        const { i, l } = band(o, c)
        if (i < 0 || i >= fetch.PIT_LEN || l < 0 || l >= 2) break // next spot: pit 1 is dug out
        names.push(bot.blockAt({ x: c.x, y: c.y, z: c.z }).name)
        dug.push(c)
        set.set(c.k, 'air')
      }
    })
    return { dug, names, o }
  }

  it('cuts top-down per column through the dirt cap into stone, staircase then level room', () => {
    const set = new Map()
    const st = castleState()
    const ctx = { castle: st }
    const { dug, names, o } = digPit(set, st, ctx)
    assert.ok(dug.length >= 100, `a pit yields its staircase + room, got ${dug.length}`)
    const stone = names.filter((n) => n === 'stone').length
    assert.ok(stone >= 80, `through the cap into stone, got ${stone}`)
    // Pick order is the scan order: columns advance, y descends within one
    // (both lanes per layer before the next).
    let lastI = -1
    let lastY = Infinity
    let lastL = -1
    for (const c of dug) {
      const { i, l } = band(o, c)
      if (i !== lastI) {
        assert.ok(i > lastI, `columns advance, got ${i} after ${lastI}`)
        lastI = i
        lastY = Infinity
        lastL = -1
      }
      assert.ok(c.y < lastY || (c.y === lastY && l > lastL),
        `column ${i} cuts top-down, got y=${c.y} lane ${l} after y=${lastY} lane ${lastL}`)
      lastY = c.y
      lastL = l
    }
    // The walk-out path is complete: every staircase floor and room floor dug.
    const at = new Set(dug.map((c) => c.k))
    for (let i = 0; i < fetch.PIT_DEPTH; i++) {
      for (let l = 0; l < 2; l++) {
        assert.ok(at.has(`${o.x + o.dx * i + o.lx * l},${64 - 1 - i},${o.z + o.dz * i + o.lz * l}`), `stair floor ${i} lane ${l} dug`)
      }
    }
    for (let i = fetch.PIT_DEPTH; i < fetch.PIT_LEN; i++) {
      for (let l = 0; l < 2; l++) {
        assert.ok(at.has(`${o.x + o.dx * i + o.lx * l},${64 - fetch.PIT_DEPTH},${o.z + o.dz * i + o.lz * l}`), `room floor ${i} lane ${l} dug`)
      }
    }
    // High walls stand: out-of-reach cells are never picked.
    assert.ok(!at.has(`${o.x + o.dx * (fetch.PIT_LEN - 1)},63,${o.z + o.dz * (fetch.PIT_LEN - 1)}`), 'room wall stands')
  })

  it('every stair floor is dug from the previous floor stance (the walk-down chain)', () => {
    const set = new Map()
    const st = castleState()
    const { dug, o } = digPit(set, st, { castle: st })
    for (let i = 1; i < fetch.PIT_DEPTH; i++) {
      const c = dug.find((d) => {
        const b = band(o, d)
        return b.i === i && b.l === 0 && d.y === 64 - 1 - i
      })
      assert.ok(c, `stair floor ${i} dug`)
      assert.ok(c.stance, `stair floor ${i} has a stance`)
      assert.deepEqual([c.stance.x, c.stance.y, c.stance.z],
        [o.x + o.dx * (i - 1), 64 - i, o.z + o.dz * (i - 1)], `floor ${i} stance is floor ${i - 1}`)
    }
  })

  it('a latched frame resumes across legs without re-probing (dug floors never shift the base)', () => {
    const set = new Map()
    const st = castleState()
    const ctx = { castle: st }
    const bot = makeBot({ items: TOOLS(), set, under: CAP })
    const o = fetch.pitSpots(st)[0]
    let t1 = null
    const l1 = quiet(() => { t1 = fetch.pickPit(bot, ctx, { skip: new Set() }) })
    assert.deepEqual([t1.x, t1.y, t1.z], [o.x, 63, o.z])
    assert.ok(l1.some((m) => m.includes('pit live at')), 'leg 1 latches')
    set.set(t1.k, 'air') // dig it
    let t2 = null
    const l2 = quiet(() => { t2 = fetch.pickPit(bot, ctx, { skip: new Set() }) }) // fresh leg
    assert.deepEqual([t2.x, t2.y, t2.z], [o.x, 63, o.z + 1], 'leg 2 continues the frame')
    assert.equal(st.quarryPits.length, 1)
    assert.equal(st.quarryPits[0].base, 64, 'base holds, dug floors do not walk it down')
    assert.ok(!l2.some((m) => m.includes('pit live at')), 'leg 2 re-probes nothing')
  })

  it('latched pit cells read as ours, so exposed stone never undermines the stairs', () => {
    const set = new Map()
    const st = castleState()
    const ctx = { castle: st }
    const bot = makeBot({ items: TOOLS(), set, under: CAP })
    quiet(() => fetch.pickPit(bot, ctx, { skip: new Set() }))
    const o = fetch.pitSpots(st)[0]
    assert.ok(fetch.inTrench(st, { x: o.x, y: 63, z: o.z }), 'stair cell is ours')
    assert.ok(fetch.inTrench(st, { x: o.x + o.dx * 15, y: 56, z: o.z + o.dz * 15 + 1 }), 'room cell is ours')
    assert.ok(!fetch.inTrench(st, { x: SITE.x + 5, y: 64, z: SITE.z + 5 }), 'far ground is not')
    st.quarryPits[0].dead = true
    assert.ok(fetch.inTrench(st, { x: o.x, y: 63, z: o.z }), 'a dead pit stays ours')
  })
})

describe('quarry-down pit abandon rules (vmzq.46)', () => {
  for (const bad of ['water', 'air']) {
    it(`${bad === 'water' ? 'liquid' : 'a hole'} under a stair floor abandons the spot and the next takes over (${bad})`, () => {
      const set = new Map()
      const st = castleState()
      const ctx = { castle: st }
      const o = fetch.pitSpots(st)[0]
      set.set(`${o.x - 1},61,${o.z}`, bad) // under column-1 floor, both lanes
      set.set(`${o.x - 1},61,${o.z + 1}`, bad)
      const bot = makeBot({ items: TOOLS(), set })
      const f = { skip: new Set() }
      let t = null
      const lines = quiet(() => {
        for (let n = 0; n < 50; n++) {
          t = fetch.pickPit(bot, ctx, f)
          const { i, l } = band(o, t)
          if (i < 0 || i >= fetch.PIT_LEN || l < 0 || l >= 2) break // left spot 1
          set.set(t.k, 'air')
        }
      })
      assert.equal(st.quarryPits[0].dead, true, 'spot 1 persists abandoned')
      const o2 = fetch.pitSpots(st)[1]
      assert.deepEqual([t.x, t.y, t.z], [o2.x, 63, o2.z], 'spot 2 takes over')
      assert.ok(t.pit, 'still a pit cell')
      const want = bad === 'water' ? 'abandoned (water under column 1' : 'abandoned (hole under column 1'
      assert.ok(lines.some((m) => m.includes(want)), `abandon line, got: ${lines.join(' | ')}`)
    })
  }

  it('a protected place abandons the spot; a protected type is stepped around', () => {
    const o = fetch.pitSpots(castleState())[0]
    // Place: the house footprint covers spot 1 (dirt itself is protected there).
    {
      const set = new Map()
      const st = castleState()
      const ctx = {
        castle: st,
        home: { site: pos(o.x, 64, o.z), interior: { min: { x: o.x - 2, y: 60, z: o.z - 2 }, max: { x: o.x + 2, y: 70, z: o.z + 2 } } },
      }
      const bot = makeBot({ items: TOOLS(), set })
      let t = null
      const lines = quiet(() => { t = fetch.pickPit(bot, ctx, { skip: new Set() }) })
      assert.equal(st.quarryPits[0].dead, true, 'the house ground persists abandoned')
      const o2 = fetch.pitSpots(st)[1]
      assert.deepEqual([t.x, t.y, t.z], [o2.x, 63, o2.z], 'the next spot takes over')
      assert.ok(lines.some((m) => m.includes('abandoned (protected place at')), `abandon line, got: ${lines.join(' | ')}`)
      assert.equal(bot.calls.dig.length, 0, 'nothing dug')
    }
    // Type: a lone log (no tree) steps aside, the pit stands.
    {
      const set = new Map([[`${o.x},63,${o.z}`, 'oak_log']])
      const st = castleState()
      const ctx = { castle: st }
      const bot = makeBot({ items: TOOLS(), set })
      const f = { skip: new Set() }
      let t = null
      quiet(() => { t = fetch.pickPit(bot, ctx, f) })
      assert.deepEqual([t.x, t.y, t.z], [o.x, 63, o.z + 1], 'the layer finishes past the log')
      assert.ok(f.skip.has(`${o.x},63,${o.z}`), 'the log is skipped, never dug')
      set.set(t.k, 'air')
      quiet(() => { t = fetch.pickPit(bot, ctx, f) })
      assert.deepEqual([t.x, t.y, t.z], [o.x - 1, 63, o.z], 'the staircase advances past the log')
      assert.ok(f.skip.has(`${o.x},63,${o.z}`), 'the log stays skipped, never dug')
      assert.equal(st.quarryPits[0].dead, false, 'the pit stands')
    }
  })

  it('no fresh spot probes dug ground: a shadowed wider gap is skipped, never latched (revmux 01 major)', () => {
    // Drown every gap-4 spot but the first, dig the first out, then the
    // same-lateral gap-6 spot (inside the dug band) must be skipped while a
    // clear lateral goes live.
    const set = new Map()
    const st = castleState()
    const ctx = { castle: st }
    const spots = fetch.pitSpots(st)
    for (const o of spots.slice(1, 7)) {
      for (let y = SITE.y - 8; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
    }
    const bot = makeBot({ items: TOOLS(), set })
    const oA = spots[0]
    quiet(() => {
      const f = { skip: new Set() }
      for (let n = 0; n < 3000; n++) {
        const c = fetch.pickPit(bot, ctx, f)
        if (!c) break
        const { i, l } = band(oA, c)
        if (i < 0 || i >= fetch.PIT_LEN || l < 0 || l >= 2) break // spot A dug out
        set.set(c.k, 'air')
      }
    })
    assert.equal(st.quarryPits.length, 2, 'spot A dug out, one live frame latched past it')
    const oShadow = spots[7] // same lateral, gap 6: origin inside spot A's band
    assert.deepEqual([oShadow.x, oShadow.z], [oA.x - 2, oA.z], 'gap 6 sits on the gap-4 lane')
    let t = null
    const lines = quiet(() => { t = fetch.pickPit(bot, ctx, { skip: new Set() }) })
    const inA = band(oA, t)
    assert.ok(inA.i < 0 || inA.i >= fetch.PIT_LEN, 'the takeover is outside spot A')
    assert.ok(!st.quarryPits.some((e) => e.x === oShadow.x && e.z === oShadow.z), 'the shadowed spot never latches')
    assert.ok(lines.some((m) => m.includes(`pit spot ${oShadow.x} ${oShadow.z} skipped (dug ground)`)),
      `dug-ground skip line, got: ${lines.join(' | ')}`)
  })

  it('a far leg with no stone at the candidate ends no-stone and never pits', () => {
    const st = castleState()
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], at: pos(190, 64, 200) })
    const ctx = {
      castle: st,
      lastGoalKey: '',
      goal: {
        id: 'castle-1', kind: 'castle', generation: 1,
        commit: {
          goalId: 'castle-1', generation: 1, kind: 'castle', optionId: 'castlefetch-far', step: 'castlefetch',
          until: Date.now() + 60000, unlock: { radius: 256, candidate: { x: 190, y: 64, z: 200 } },
        },
      },
    }
    const f = { kind: 'stone', skip: new Set(), target: null }
    quiet(() => fetch.digTick(bot, ctx, f))
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
    assert.equal(st.quarryPits, undefined, 'no pit latched far from the site')
  })
})

describe('quarry-down stone set (vmzq.46)', () => {
  it('smooth_basalt digs like terrain and counts as castle stone', () => {
    const set = new Map()
    const bot = makeBot({ items: [], set, at: pos(97, 64, 202) })
    const block = { name: 'smooth_basalt', position: pos(96, 63, 202) }
    assert.equal(canBreak(bot, block, { castle: castleState() }), true, 'natural basalt digs')
    assert.ok(blueprint.isStone('smooth_basalt'), 'counts')
    const pack = { inventory: { items: () => [{ name: 'smooth_basalt', count: 11 }, { name: 'calcite', count: 12 }] } }
    assert.equal(castleMod.held(pack, 'stone'), 23, 'the run7 pack now funds the batch')
  })
})
