'use strict'

// idkcraft-g0z.61: the post-complete sweep covers the site box + a 16-block
// apron and clears bot scaffolding by shape, whoever placed it (owner Q1
// 2026-10-18): a lone 1-wide dirt/cobble/stone pillar or bridge. Plan
// cells, laid decor, beds, chests and doors are never litter; a player
// within 8 of a cell holds it without a strike.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 3
const st3 = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const { w, d } = blueprint.siteDimensions(0, V)
const R = blueprint.CASTLE_APRON

// Same fake-bot surface as test/castle-g0z44.test.js:32 worldBot (mineflayer
// bot.blockAt -> Block {name, position, boundingBox}, prismarine-block
// boundingBox 'empty'|'block'); dirt below the site floor, air above.
function worldBot(cells, opts = {}) {
  const bot = {
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 }, onGround: true },
    inventory: { items: () => [] },
    players: opts.players || {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
  return bot
}
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest', stairs: 'cobblestone_stairs' }
function painted(v = V) {
  const cells = new Map()
  for (const c of blueprint.absPlan(SITE, 0, v).cells) {
    cells.set(key(c.x, c.y, c.z), blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, v).cells) {
    cells.set(key(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : c.kind === 'fence' ? 'oak_fence' : 'white_wall_banner')
  }
  return cells
}
// One full sliced pass (band + every x-strip).
function pass(bot, ctx, now = Date.now()) {
  let list = []
  for (let i = 0; i <= w + 2 * R + 1; i++) list = castle.litterTargets(bot, ctx, ctx.castle, now)
  return list
}
const has = (list, x, y, z) => list.some((c) => c.x === x && c.y === y && c.z === z)

describe('g0z.61 apron region', () => {
  it('dx -16 listed, dx -17 not; dx 5 dy 9 inside the box; dy -4 only by shape', () => {
    const cells = painted()
    const zc = SITE.z + 13
    cells.set(key(SITE.x - 16, SITE.y, zc), 'dirt') // lone 1-high post on the ground, the apron edge
    cells.set(key(SITE.x - 17, SITE.y, zc + 3), 'dirt') // one further out
    const inBox = { x: SITE.x + 5, y: SITE.y + 9, z: SITE.z + 12 }
    assert.equal(blueprint.absPlan(SITE, 0, V).at.has(key(inBox.x, inBox.y, inBox.z)), false, 'off-plan cell')
    cells.set(key(inBox.x, inBox.y, inBox.z), 'cobblestone') // a tower top inside the box
    // dy -4: own dirt in solid ground stays; a dirt column in a dug pocket goes.
    const own = { x: SITE.x - 5, y: SITE.y - 4, z: zc }
    const lone = { x: SITE.x - 10, y: SITE.y - 4, z: zc }
    // A dirt post at the bottom of an open 3x3 pit (dy -4..-1 dug around and above it).
    for (let y = lone.y; y < SITE.y; y++) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz || y > lone.y) cells.set(key(lone.x + dx, y, lone.z + dz), 'air')
    }
    const bot = worldBot(cells)
    const ctx = { castle: st3(), placedByBot: new Set([key(own.x, own.y, own.z)]) }
    const list = pass(bot, ctx)
    assert.ok(has(list, SITE.x - 16, SITE.y, zc), 'dx -16')
    assert.ok(!has(list, SITE.x - 17, SITE.y, zc + 3), 'dx -17')
    assert.ok(has(list, inBox.x, inBox.y, inBox.z), 'dx 5 dy 9 in the box')
    assert.ok(!has(list, own.x, own.y, own.z), 'own dirt below the floor: shape only')
    assert.ok(has(list, lone.x, lone.y, lone.z), 'dy -4 lone column')
    assert.ok(!has(list, SITE.x - 3, SITE.y - 1, zc), 'natural ground never')
  })
  it('the first call is the band (slice 0); a pass ends after w + 2R strips', () => {
    const cells = painted()
    cells.set(key(SITE.x - 1, SITE.y, SITE.z + 13), 'dirt')
    cells.set(key(SITE.x - 10, SITE.y, SITE.z + 13), 'dirt')
    const bot = worldBot(cells)
    const ctx = { castle: st3() }
    const first = castle.litterTargets(bot, ctx, ctx.castle, 1000)
    assert.ok(has(first, SITE.x - 1, SITE.y, SITE.z + 13), 'band cell at once')
    assert.ok(!has(first, SITE.x - 10, SITE.y, SITE.z + 13), 'strip not yet')
    const all = pass(bot, ctx, 1000)
    assert.ok(has(all, SITE.x - 10, SITE.y, SITE.z + 13))
    assert.equal(new Set(all.map((c) => c.idx)).size, all.length, 'no slice duplicates the band')
    cells.set(key(SITE.x - 10, SITE.y, SITE.z + 13), 'air')
    assert.ok(!has(castle.litterTargets(bot, ctx, ctx.castle, 2000), SITE.x - 10, SITE.y, SITE.z + 13), 'dug drops at read time')
  })
})

describe('g0z.61 scaffoldShape', () => {
  const at = (cells, x, y, z) => worldBot(cells).blockAt({ x, y, z })
  const ctx = { castle: st3() }
  const X = SITE.x - 8; const Z = SITE.z + 5; const Y = SITE.y
  it('true for a lone dirt column cell and a 1-wide cobble bridge cell over air', () => {
    const cells = painted()
    cells.set(key(X, Y, Z), 'dirt'); cells.set(key(X, Y + 1, Z), 'dirt'); cells.set(key(X, Y + 2, Z), 'dirt')
    const bot = worldBot(cells)
    assert.equal(castle.scaffoldShape(bot, ctx, at(cells, X, Y + 1, Z)), true, 'mid column')
    assert.equal(castle.scaffoldShape(bot, ctx, at(cells, X, Y, Z)), true, 'column foot')
    const b = new Map(painted())
    for (let i = 0; i < 5; i++) b.set(key(X + i, Y + 3, Z - 4), 'cobblestone')
    const bb = worldBot(b)
    assert.equal(castle.scaffoldShape(bb, ctx, at(b, X, Y + 3, Z - 4)), true, 'bridge end')
    // At most one neighbour (revmux 01): the middle waits for the ends.
    assert.equal(castle.scaffoldShape(bb, ctx, at(b, X + 2, Y + 3, Z - 4)), false, 'bridge middle (2 neighbours)')
    b.set(key(X, Y + 3, Z - 4), 'air')
    assert.equal(castle.scaffoldShape(bb, ctx, at(b, X + 1, Y + 3, Z - 4)), true, 'the next cell is an end once the end is dug')
  })
  it('false for the block over a doorway in a 1-thick player wall (revmux 01)', () => {
    const cells = painted()
    for (let i = 0; i < 3; i++) for (let h = 0; h < 3; h++) cells.set(key(X + i, Y + h, Z), 'cobblestone')
    cells.set(key(X + 1, Y, Z), 'air'); cells.set(key(X + 1, Y + 1, Z), 'air') // a 1x2 doorway
    const bot = worldBot(cells)
    assert.equal(castle.scaffoldShape(bot, ctx, at(cells, X + 1, Y + 2, Z)), false, 'lintel')
    const list = pass(bot, { castle: st3() })
    assert.ok(!list.some((c) => c.z === Z && c.x >= X && c.x <= X + 2 && c.y >= Y && c.y <= Y + 2), 'no wall cell listed')
  })
  it('scaffold in a dug moat cell (plan dig) is litter, ground in a plan place cell never', () => {
    const cells = painted()
    const dig = blueprint.absPlan(SITE, 0, V).cells.find((c) => c.kind === 'dig' && c.dy === -1)
    cells.set(key(dig.x, dig.y, dig.z), 'cobblestone') // a walker's bridge in the moat
    const list = pass(worldBot(cells), { castle: st3() })
    assert.ok(has(list, dig.x, dig.y, dig.z), 'moat fill listed')
    assert.equal(list.length, 1, 'nothing else')
  })
  it('false for grass with 4 solid neighbours, a 2-wide wall, a plan cell, laid decor, a bed', () => {
    const cells = painted()
    assert.equal(castle.scaffoldShape(worldBot(cells), ctx, { name: 'grass_block', position: new Vec3(X, Y - 1, Z) }), false, 'grass')
    assert.equal(castle.scaffoldShape(worldBot(cells), ctx, at(cells, X, Y - 1, Z)), false, 'buried dirt')
    const wall = painted()
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let h = 0; h < 2; h++) wall.set(key(X + i, Y + h, Z + j), 'cobblestone')
    const wb = worldBot(wall)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let h = 0; h < 2; h++) {
      assert.equal(castle.scaffoldShape(wb, ctx, at(wall, X + i, Y + h, Z + j)), false, `2-wide wall ${i},${h},${j}`)
    }
    const floating = painted()
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) floating.set(key(X + i, Y + 4, Z + j), 'cobblestone')
    assert.equal(castle.scaffoldShape(worldBot(floating), ctx, at(floating, X + 1, Y + 4, Z)), false, '2-wide bridge')
    const plan = blueprint.absPlan(SITE, 0, V).cells.find((c) => c.kind === 'stone' && c.dy === 2)
    assert.equal(castle.scaffoldShape(worldBot(cells), ctx, at(cells, plan.x, plan.y, plan.z)), false, 'cobblestone plan cell')
    const fence = blueprint.decorPlan(SITE, 0, V).cells.find((c) => c.kind === 'fence')
    assert.equal(castle.scaffoldShape(worldBot(cells), ctx, at(cells, fence.x, fence.y, fence.z)), false, 'laid fence decor')
    const bed = painted(); bed.set(key(X, Y, Z), 'red_bed')
    assert.equal(castle.scaffoldShape(worldBot(bed), ctx, at(bed, X, Y, Z)), false, 'bed')
  })
  it('a tower against a castle wall or window is lone (plan neighbours do not count above the floor)', () => {
    const pane = blueprint.decorPlan(SITE, 0, V).cells.find((c) => c.kind === 'pane' && c.dy >= 3)
    const cells = painted()
    let spot = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(pane.x + dx, pane.y, pane.z + dz)
      if (cells.get(k) === undefined || cells.get(k) === 'air') { spot = { x: pane.x + dx, z: pane.z + dz }; break }
    }
    assert.ok(spot, 'an open side of the window')
    for (let y = pane.y - 3; y <= pane.y; y++) if (!cells.has(key(spot.x, y, spot.z))) cells.set(key(spot.x, y, spot.z), 'cobblestone')
    const bot = worldBot(cells)
    assert.equal(castle.scaffoldShape(bot, ctx, at(cells, spot.x, pane.y, spot.z)), true, 'beside the pane')
    const list = pass(bot, { castle: st3() })
    assert.ok(has(list, spot.x, pane.y, spot.z), 'listed post-complete')
  })
})

describe('g0z.61 rig seeds (castle-replay litterSeeds)', () => {
  it('30 litter items all sweep by shape in a full pass, the 5 player structures never', () => {
    const { litterSeeds, seedCastleCells } = require('../tools/castle-replay')
    const st = st3()
    const seeds = litterSeeds(st)
    assert.equal(seeds.litter.length, 30)
    assert.deepEqual(seeds.litter.map((o) => o.what).reduce((m, w) => ({ ...m, [w]: (m[w] || 0) + 1 }), {}), { tower: 1, yard: 9, bridge: 10, outside: 10 })
    assert.equal(seeds.litter.find((o) => o.what === 'tower').cells.length, 4)
    assert.deepEqual(seeds.player.map((o) => o.what), ['wall', 'path', 'chest', 'bed', 'post'])
    // The rig world: the seeded castle (rcon setblocks) on a dirt pad, then the seeds.
    const cells = new Map()
    for (const c of seedCastleCells(st)) cells.set(key(c.x, c.y, c.z), c.block.split('[')[0])
    for (const o of [...seeds.litter, ...seeds.player]) for (const c of o.cells) cells.set(key(c.x, c.y, c.z), c.block.split('[')[0])
    const bot = worldBot(cells)
    const list = pass(bot, { castle: st })
    for (const o of seeds.litter) for (const c of o.cells) assert.ok(has(list, c.x, c.y, c.z), `${o.what} ${c.x},${c.y},${c.z}`)
    for (const o of seeds.player) for (const c of o.cells) assert.ok(!has(list, c.x, c.y, c.z), `player ${o.what} ${c.x},${c.y},${c.z}`)
    const litterK = new Set(seeds.litter.flatMap((o) => o.cells).map((c) => key(c.x, c.y, c.z)))
    assert.deepEqual(list.filter((c) => !litterK.has(key(c.x, c.y, c.z))).map((c) => key(c.x, c.y, c.z)), [], 'nothing else in the seeded castle')
  })
})

describe('g0z.61 own blocks, players, idx', () => {
  it('own scaffold in the band sweeps, own beds/chests never', () => {
    const cells = painted()
    cells.set(key(SITE.x - 1, SITE.y, SITE.z + 2), 'red_bed')
    cells.set(key(SITE.x - 1, SITE.y, SITE.z + 4), 'oak_planks')
    cells.set(key(SITE.x - 1, SITE.y, SITE.z + 6), 'cobblestone')
    cells.set(key(SITE.x - 1, SITE.y, SITE.z + 7), 'cobblestone')
    cells.set(key(SITE.x - 1, SITE.y - 1, SITE.z + 6), 'dirt')
    const placed = new Set([key(SITE.x - 1, SITE.y, SITE.z + 2), key(SITE.x - 1, SITE.y, SITE.z + 4), key(SITE.x - 1, SITE.y, SITE.z + 6), key(SITE.x - 1, SITE.y, SITE.z + 7)])
    const list = pass(worldBot(cells), { castle: st3(), placedByBot: placed })
    assert.ok(!has(list, SITE.x - 1, SITE.y, SITE.z + 2), 'bed')
    assert.ok(!has(list, SITE.x - 1, SITE.y, SITE.z + 4), 'planks')
    assert.ok(has(list, SITE.x - 1, SITE.y, SITE.z + 6), 'own cobble on the ground (not a lone shape)')
  })
  it('a player within 8 holds the cell without a strike; beyond 8 it clears', () => {
    const cells = painted(2) // v2: this fake has no Block.getProperties (read by src/behaviours/castle.js:172 stateAt), so v3 stairs would read undone
    const c = { x: SITE.x - 10, y: SITE.y, z: SITE.z + 13 }
    cells.set(key(c.x, c.y, c.z), 'dirt')
    const players = { Owner: { username: 'Owner', entity: { position: { x: c.x + 5, y: c.y, z: c.z } } } }
    const bot = worldBot(cells, { players })
    const ctx = { castle: st3({ blueprintVersion: 2 }) }
    pass(bot, ctx)
    assert.notEqual(castle.menuFact(bot, ctx), 'clear', 'held by the player')
    castle(bot, ctx)
    assert.deepEqual(Object.keys(ctx.castle.blocked), [], 'no strike')
    players.Owner.entity.position = { x: c.x + 9, y: c.y, z: c.z }
    assert.equal(castle.menuFact(bot, ctx), 'clear', 'free again')
  })
  it('idx unique over the whole grown box and bandOf inverts it', () => {
    const st = st3()
    const seen = new Set()
    for (let dx = -R; dx < w + R; dx++) {
      for (let dz = -R; dz < d + R; dz++) {
        for (let dy = -blueprint.NIGHT_BAND_BELOW; dy <= 16; dy++) {
          const cell = castle.litterCell(st, d, SITE.x + dx, SITE.y + dy, SITE.z + dz)
          assert.ok(!seen.has(cell.idx), `dup ${dx},${dy},${dz}`)
          seen.add(cell.idx)
          assert.ok(cell.idx >= castle.LITTER_BAND_BASE && cell.idx < blueprint.DECOR_BASE)
          const back = castle.bandOf(st, cell.idx)
          assert.ok(back && back.x === cell.x && back.y === cell.y && back.z === cell.z, `bandOf ${dx},${dy},${dz}`)
        }
      }
    }
    assert.equal(castle.bandOf(st, 2100000), null, 'a g0z.44 band idx prunes')
    assert.equal(castle.bandOf(st, blueprint.DECOR_BASE), null, 'decor idx space')
  })
})
