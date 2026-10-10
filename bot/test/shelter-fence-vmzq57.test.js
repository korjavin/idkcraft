'use strict'

// Bead idkcraft-vmzq.57: prod world2, completed castle v2 at 8 65 -12 rot 2
// (fence ring x=8/38 z=-12/14). Nightly 'shelter pillar failed:place-error
// ... (9, 66, 14) the block is still air, digging in' -> 'dig-in done' with
// the body ON the fence post (9,65,14); the castle read 1720/1722 later.
// Reproduction: the exact world (every plan cell laid, natural ground at
// y<=64, the moat dug), the pillar refused, the full shelter episode run,
// every break and place recorded — then the plan is re-read. It did not
// reproduce: the post fails the dig-in as undiggable, the walk lands
// outside the ring, and digInVeto's protectedReason branch guards the
// castle ground (mutating it fails both cases). Scope: the shelter's own
// episode only — gohome, the morning recover and other executors are
// not modelled here (their digs go through denyReason / guardCastle).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const castleData = require('../src/castle')

const CASTLE = { site: { x: 8, y: 65, z: -12 }, rot: 2, blueprintVersion: 2, phase: 'complete' }
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const PASS = new Set(['air', 'torch', 'oak_door'])

function key(x, y, z) { return `${x},${y},${z}` }
function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  p.offset = (a, b, c) => pos(p.x + a, p.y + b, p.z + c)
  return p
}

function castleWorld(at, opts = {}) {
  const plan = castleData.absPlan(CASTLE.site, CASTLE.rot, CASTLE.blueprintVersion)
  const world = new Map()
  for (const c of plan.cells) world.set(key(c.x, c.y, c.z), LAID[c.kind] || 'air')
  const nameAt = (x, y, z) => {
    const k = key(x, y, z)
    if (world.has(k)) return world.get(k)
    if (y > 64) return 'air'
    return (opts.ground && opts.ground(x, y, z)) || (y === 64 ? 'grass_block' : 'dirt')
  }
  const breaks = []
  const places = []
  const items = [{ name: 'cobblestone', count: 16 }]
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 15000, day: 5 },
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    controls: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const name = nameAt(x, y, z)
      return { name, position: new Vec3(x, y, z), boundingBox: PASS.has(name) ? 'empty' : 'block' }
    },
    async dig(b) {
      const { x, y, z } = b.position
      breaks.push({ x, y, z, name: nameAt(x, y, z) })
      world.set(key(x, y, z), 'air')
      const e = bot.entity.position
      let fy = Math.floor(e.y)
      while (PASS.has(nameAt(Math.floor(e.x), fy - 1, Math.floor(e.z)))) fy--
      bot.entity.position = pos(e.x, fy, e.z)
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) {
      const d = ref.position.plus(face)
      if (opts.refuse && opts.refuse(d)) throw new Error(`Server refused to place cobblestone at (${d.x}, ${d.y}, ${d.z}): the block is still air`)
      places.push({ x: d.x, y: d.y, z: d.z })
      world.set(key(d.x, d.y, d.z), 'cobblestone')
      if (bot.heldItem) bot.heldItem.count--
    },
  }
  const intact = () => plan.cells.filter((c) => castleData.isPlaceTarget(c.kind) && !castleData.matches(c.kind, nameAt(c.x, c.y, c.z)))
  return { bot, breaks, places, intact, nameAt }
}

const flush = () => new Promise((r) => setImmediate(r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function quiet(fn) {
  const orig = console.log
  const logs = []
  console.log = (m) => { logs.push(String(m)) }
  try { await fn() } finally { console.log = orig }
  return logs
}

// The pillar to its terminal verdict, then the dig-in to its end (a
// pathfinder walk lands on its goal block on the next tick).
async function episode(bot, ctx) {
  const logs = []
  const tick = async () => { logs.push(...await quiet(() => home.shelter(bot, ctx, null, null))); await flush() }
  const y0 = bot.entity.position.y
  await tick()
  bot.entity.position = pos(bot.entity.position.x, y0 + 0.7, bot.entity.position.z)
  await sleep(300)
  bot.entity.position = pos(bot.entity.position.x, y0, bot.entity.position.z)
  for (let t = 0; t < 40 && !(ctx.shelter && ctx.shelter.pillared); t++) {
    const g = bot.pathfinder.goal
    if (g && typeof g.x === 'number' && ctx.shelter && ctx.shelter.dig && ctx.shelter.dig.walk) {
      bot.entity.position = pos(g.x + 0.5, g.y, g.z + 0.5)
    }
    await tick()
  }
  return logs
}

describe('vmzq.57 shelter on the castle fence corner (9,66,14)', () => {
  it('pillar refused on the fence post: the episode breaks and places no castle cell', async () => {
    const w = castleWorld({ x: 9.5, y: 66, z: 14.5 }, {
      refuse: (d) => castleData.inFootprint(CASTLE, d),
    })
    assert.equal(w.nameAt(9, 65, 14), 'oak_fence', 'the prod post under the feet')
    assert.deepEqual(w.intact(), [], 'complete castle before the night')
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = await episode(w.bot, ctx)
    // g0z.44: the yard guard refuses before the mock server (was place-error).
    assert.ok(logs.some((m) => m.includes('shelter pillar failed:place-protected')), JSON.stringify(logs))
    assert.deepEqual(w.intact(), [], `castle cells lost: ${JSON.stringify({ breaks: w.breaks, logs })}`)
    assert.ok(w.breaks.length > 0 && logs.includes('shelter dig-in done'), 'a pit was dug (not vacuous)')
    for (const b of w.breaks) {
      assert.ok(!castleData.inFootprint(CASTLE, b) && !castleData.groundCell(CASTLE, b), `dig in the castle: ${JSON.stringify(b)}`)
    }
  })

  it('one cell inside the ring (castle ground under the feet): no castle dig either', async () => {
    // Sensitivity pin: here the in-place column IS castle ground, so the
    // digInVeto protected branch is what keeps the castle whole.
    const w = castleWorld({ x: 9.5, y: 65, z: 13.5 }, {
      refuse: (d) => castleData.inFootprint(CASTLE, d),
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = await episode(w.bot, ctx)
    // g0z.44: the yard guard refuses before the mock server (was place-error).
    assert.ok(logs.some((m) => m.includes('shelter pillar failed:place-protected')), JSON.stringify(logs))
    assert.deepEqual(w.intact(), [], JSON.stringify({ breaks: w.breaks, logs }))
    for (const b of w.breaks) {
      assert.ok(!castleData.inFootprint(CASTLE, b) && !castleData.groundCell(CASTLE, b), `dig in the castle: ${JSON.stringify({ b, logs })}`)
    }
  })

  it('no diggable column in reach (stone all round): holds without digging a plan cell', async () => {
    const w = castleWorld({ x: 9.5, y: 66, z: 14.5 }, {
      refuse: (d) => castleData.inFootprint(CASTLE, d),
      ground: () => 'stone',
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = await episode(w.bot, ctx)
    assert.ok(logs.includes('shelter dig-in failed:undiggable:oak_fence'), JSON.stringify(logs))
    assert.deepEqual(w.breaks, [], 'no dig at all')
    assert.deepEqual(w.intact(), [])
    assert.equal(ctx.shelter.pillared, true, 'holds, never marches')
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.inShelter, false, 'castle ground: exposed hold, fight preempts (vmzq.48)')
  })
})
