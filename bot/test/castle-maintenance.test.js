'use strict'

// Castle maintenance (owner 2026-11-17, v2 bot4 'castle 2040/2048' answered
// 'not complete' to repair): only-holes castles are built, the complete
// sweep clears interior clutter, a tidy visit logs the upkeep counts.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
function completeSet() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, { pane: 'glass_pane', fence: 'oak_fence', gate: 'oak_fence_gate' }[c.kind] || 'air')
  }
  return set
}
// creeper damage: four wall stones knocked out
function damaged() {
  const set = completeSet()
  const cells = blueprint.absPlan(SITE, 0, V).cells.filter((c) => c.kind === 'stone' && c.y === SITE.y + 1).slice(0, 4)
  for (const c of cells) set.set(`${c.x},${c.y},${c.z}`, 'air')
  return { set, cells }
}
function worldBot(set, items = []) {
  return {
    chats: [],
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null },
    setControlState() {}, clearControlStates() {},
    chat(m) { this.chats.push(String(m)) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = set.has(k) ? set.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const retired = (cells, why) => Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 8, until: 0, why, retired: true }]))
const state = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })


describe('castle maintenance (owner 2026-11-17)', () => {
  it('built: only holes open flips the phase to complete (the counter and repair agree)', () => {
    const { set, cells } = damaged()
    const bot = worldBot(set)
    const mk = (e) => Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { until: 0, why: 'unreachable', ...e }]))
    const st = state({ phase: 'body', blocked: mk({ tries: 2 }) })
    const plan = blueprint.absPlan(SITE, 0, V).cells
    assert.equal(castle.builtOut(bot, st, plan), true, 'struck holes only: built')
    st.blocked = { ...mk({ tries: 1 }), [`2:${cells[0].idx}`]: { tries: 8, until: 0, why: 'unreachable' } }
    assert.equal(castle.builtOut(bot, st, plan), true, 'try-1 neighbours of a hard hole are remainders (bot4)')
    st.blocked = mk({ tries: 8 })
    delete st.blocked[`2:${cells[1].idx}`]
    assert.equal(castle.builtOut(bot, st, plan), false, 'a never-struck cell is real work')
    st.blocked = mk({ tries: 0, ever: 6 }) // requeued, backoff expired: workable again, yet hard
    assert.equal(castle.builtOut(bot, st, plan), true)
    // A never-struck cell resting on a hole waits on it, not on us.
    const top = cells[0]
    const above = { x: top.x, y: top.y + 1, z: top.z }
    if (blueprint.absPlan(SITE, 0, V).at.has(`${above.x},${above.y},${above.z}`)) {
      set.set(`${above.x},${above.y},${above.z}`, 'air')
      assert.equal(castle.builtOut(bot, st, plan), true, 'gated on the hole below')
    }
    st.blocked = {}
    assert.equal(castle.builtOut(bot, st, plan), false, 'an unblocked open cell is still work')
    assert.equal(castle.builtOut(bot, st, plan, new Set(cells.map((c) => c.idx))), true, 'touched (deferred/fluid) cells are remainders')
    assert.equal(castle.builtOut(worldBot(completeSet()), st, plan), true, 'all laid: built (bot3 11493/11493 stayed body)')
  })

  it('menuFact flips a castle stuck on hard holes even when one is off its backoff (bot4 2036/2048)', () => {
    const { set, cells } = damaged()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ phase: 'body', visitedAt: Date.now(), blocked: Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 6, ever: 6, until: 0, why: 'unreachable' }])) }) }
    ctx.castleLaidSince = 1 // read built past the grace
    const log = console.log
    console.log = () => {}
    try { castle.menuFact(bot, ctx, Date.now()) } finally { console.log = log }
    assert.equal(ctx.castle.phase, 'complete')
    assert.ok(bot.chats.some((m) => m.startsWith('castle done at')))
  })

  it("any building phase flips ('moat' from older memory), and a miss logs phase and cell (bot4)", () => {
    const { set, cells } = damaged()
    const bot = worldBot(set)
    const plan = blueprint.absPlan(SITE, 0, V).cells
    const st = state({ phase: 'moat', blocked: Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 0, ever: 4, until: 0, why: 'unreachable' }])) })
    const logs = []
    const log = console.log
    console.log = (s) => logs.push(String(s))
    try {
      const miss = state({ phase: 'body', blocked: {} })
      castle.checkBuilt(bot, miss, plan)
      castle.checkBuilt(bot, st, plan)
    } finally { console.log = log }
    assert.ok(logs.some((l) => /^castle built=no phase=body stone@/.test(l)), logs.join('\n'))
    assert.equal(st.phase, 'complete')
  })

  it("a full counter flips from any phase, 'prep' included (bot4 stayed in prep)", () => {
    for (const phase of ['body', 'prep', 'moat']) {
      const bot = worldBot(completeSet())
      const st = state({ phase })
      const ctx = {}
      const log = console.log
      console.log = () => {}
      try {
        castle.checkBuilt(bot, st, blueprint.absPlan(SITE, 0, V).cells, ctx)
        assert.equal(st.phase, phase, 'the tail gets its grace first')
        ctx.castleLaidSince -= 11 * 60 * 1000
        castle.checkBuilt(bot, st, blueprint.absPlan(SITE, 0, V).cells, ctx)
      } finally { console.log = log }
      assert.equal(st.phase, 'complete', phase)
    }
  })

  it('a brief non-built read (a refilled moat, a transient cell) does not restart the grace (#898 bot3)', () => {
    const plan = blueprint.absPlan(SITE, 0, V).cells
    const st = state({ phase: 'body' })
    const ctx = {}
    const log = console.log
    console.log = () => {}
    try {
      const full = completeSet()
      const moat = plan.find((c) => c.kind === 'dig')
      full.set(`${moat.x},${moat.y},${moat.z}`, 'dirt') // refilled moat: never holds the flip
      castle.checkBuilt(worldBot(full), st, plan, ctx)
      ctx.castleLaidSince -= 9 * 60 * 1000
      const { set } = damaged() // a brief never-struck read
      castle.checkBuilt(worldBot(set), st, plan, ctx)
      assert.equal(st.phase, 'body')
      ctx.castleLaidSince -= 2 * 60 * 1000
      castle.checkBuilt(worldBot(full), st, plan, ctx)
      assert.equal(st.phase, 'complete', 'the grace ran on through the brief read')
    } finally { console.log = log }
  })

  it('a requeued hole keeps its lifetime strikes across a restart', () => {
    const memory = require('../src/memory')
    const st = state({ phase: 'body', blocked: { '2:5': { tries: 0, ever: 6, until: 0, why: 'unreachable' } } })
    const back = memory.castleOf(JSON.parse(JSON.stringify(st)))
    assert.equal(back.blocked['2:5'].ever, 6)
  })

  it('interior clutter: dirt on a stairwell/doorway or off-plan inside the footprint is swept; furniture stays', () => {
    const set = completeSet()
    const plan = blueprint.absPlan(SITE, 0, V)
    const { w, d } = blueprint.siteDimensions(0, V)
    const keep = plan.cells.find((c) => c.kind === 'air' && c.y > SITE.y && c.x > SITE.x && c.x < SITE.x + w && c.z > SITE.z && c.z < SITE.z + d &&
      !blueprint.decorPlan(SITE, 0, V).at.has(`${c.x},${c.y},${c.z}`))
    set.set(`${keep.x},${keep.y},${keep.z}`, 'dirt')
    // an off-plan interior cell above grade
    let off = null
    for (let dx = 3; dx < 20 && !off; dx++) {
      for (let dz = 3; dz < 20 && !off; dz++) {
        const k = `${SITE.x + dx},${SITE.y + 1},${SITE.z + dz}`
        if (!plan.at.has(k)) off = { x: SITE.x + dx, y: SITE.y + 1, z: SITE.z + dz }
      }
    }
    set.set(`${off.x},${off.y},${off.z}`, 'cobblestone')
    const chest = { x: off.x, y: off.y + 1, z: off.z }
    set.set(`${chest.x},${chest.y},${chest.z}`, 'chest')
    const bot = worldBot(set)
    const ctx = {}
    const st = state({ visitedAt: Date.now() })
    const list = []
    // The sweep is sliced: read slices until the pass ends.
    for (let i = 0; i < 400 && !(ctx.castleLitter && ctx.castleLitter.acc.length === 0 && ctx.castleLitter.next > 0 && ctx.castleLitter.list.length); i++) {
      for (const o of castle.litterTargets(bot, ctx, st, Date.now())) list.push(o)
      st.blocked = Object.fromEntries(list.map((o) => [`2:${o.idx}`, { until: Date.now() + 60000, tries: 1 }]))
    }
    const has = (p) => list.some((o) => o.x === p.x && o.y === p.y && o.z === p.z)
    assert.ok(has(keep), 'keep-clear plan cell')
    assert.ok(has(off), 'off-plan interior block')
    assert.ok(!has(chest), 'owner furniture stays')
  })

  it('a tidy visit logs holes/clutter/missing', () => {
    const { set } = damaged()
    const bot = worldBot(set)
    const st = state({ visitedAt: 1 })
    const logs = []
    const log = console.log
    console.log = (s) => logs.push(String(s))
    try { castle.menuFact(bot, {}, Date.now()) ; castle.menuFact(bot, { castle: st }, Date.now()) } finally { console.log = log }
    assert.ok(logs.some((l) => /^castle tidy holes=\d+ clutter=\d+ missing=4$/.test(l)), logs.join('\n'))
  })

  // A 2-wide cobble tower on grade outside the footprint, against the x-min ring (owner 2026-11-17).
  function towerSet() {
    const set = completeSet()
    const plan = blueprint.absPlan(SITE, 0, V).at
    const dec = blueprint.decorPlan(SITE, 0, V).at
    const free = (x, z) => [0, 1, 2, 3].every((dy) => !plan.has(`${x},${SITE.y + dy},${z}`) && !dec.has(`${x},${SITE.y + dy},${z}`))
    const wall = (x, z) => plan.has(`${x},${SITE.y},${z}`) // the fence ring on the footprint edge
    let at = null
    for (let x = SITE.x - 6; x < SITE.x && !at; x++) {
      for (let z = SITE.z + 2; z < SITE.z + 20 && !at; z++) {
        if (free(x, z) && free(x, z + 1) && wall(x + 1, z) && wall(x + 1, z + 1)) at = { x, z }
      }
    }
    assert.ok(at, 'a tower spot against a wall')
    const cells = []
    for (const z of [at.z, at.z + 1]) {
      for (let dy = 0; dy <= 3; dy++) { set.set(key(at.x, SITE.y + dy, z), 'cobblestone'); cells.push({ x: at.x, y: SITE.y + dy, z }) }
    }
    return { set, cells }
  }
  function fullPass(bot, ctx, st) {
    const list = []
    for (let i = 0; i < 400 && !(ctx.castleLitter && ctx.castleLitter.acc.length === 0 && ctx.castleLitter.next > 0 && ctx.castleLitter.list.length); i++) {
      for (const o of castle.litterTargets(bot, ctx, st, Date.now())) list.push(o)
      st.blocked = Object.fromEntries(list.map((o) => [`2:${o.idx}`, { until: Date.now() + 60000, tries: 1 }]))
    }
    return list
  }

  it('a 2-wide scaffold tower against the wall is cleared; the scan logs its tally', () => {
    const { set, cells } = towerSet()
    const logs = []
    const log = console.log
    console.log = (s) => logs.push(String(s))
    let list
    try { list = fullPass(worldBot(set), {}, state({ visitedAt: Date.now() })) } finally { console.log = log }
    for (const c of cells) assert.ok(list.some((o) => o.x === c.x && o.y === c.y && o.z === c.z), `tower cell ${c.x},${c.y},${c.z}`)
    const scan = logs.find((l) => l.startsWith('castle scaffold scan '))
    assert.match(scan || '', /^castle scaffold scan cand=\d+ litter=\d+ hits=\{.*\} mats=\{.*cobblestone:\d+.*\} rejected=\{.*\}$/, logs.join('\n'))
  })

  it('a grass-topped 2-wide mound against the wall stays', () => {
    const { set, cells } = towerSet()
    for (const c of cells) set.set(key(c.x, c.y, c.z), c.y === SITE.y + 3 ? 'grass_block' : 'dirt')
    const log = console.log
    console.log = () => {}
    let list
    try { list = fullPass(worldBot(set), {}, state({ visitedAt: Date.now() })) } finally { console.log = log }
    for (const c of cells) assert.ok(!list.some((o) => o.x === c.x && o.y === c.y && o.z === c.z), `mound cell ${c.x},${c.y},${c.z}`)
  })

  it('the arbiter picks the castle on a complete castle with clutter, and walks back while it is owed', () => {
    const goal = require('../src/goal')
    const { set } = towerSet()
    const bot = worldBot(set)
    const ctx = { castle: state({ visitedAt: Date.now() }) }
    const log = console.log
    console.log = () => {}
    let w
    try { for (let i = 0; i < 400 && w !== 'clear'; i++) w = castle.menuFact(bot, ctx, Date.now()) } finally { console.log = log }
    assert.equal(w, 'clear')
    assert.equal(ctx.castle.upkeepOwed, true)
    assert.equal(goal.MENU.castle.feasible({ castle: w, time: 'day', health: 20, food: 20 }, bot, ctx), true)
    // off the loaded map the owed upkeep words 'tidy' now, not in an hour
    const far = { ...worldBot(set), blockAt: () => null }
    assert.equal(castle.menuFact(far, ctx, Date.now()), 'tidy')
  })
})
