'use strict'

// Bead idkcraft-vmzq.48: prod castle run8 spent 80 of 180 min in
// action=shelter yet the shelter never closed at the site — every night
// 'shelter pillar failed:place-error ... the block is still air' +
// 'shelter dig-in failed:protected', then the bot held in the open with
// fight suppressed until a zombie killed it (14:56Z). The dig-in vetoes
// the castle footprint (protected ground), and the hold armed inShelter
// unconditionally. Shelter now walks off the footprint (6+ blocks from
// the castle box) and digs in there; with no viable ground past the
// footprint it holds EXPOSED (fight preempts) instead of idling next to
// a hostile. Non-castle failures keep the old armed hold (ipn.12/ed88).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const castleData = require('../src/castle')

const CASTLE = { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: 2, phase: 'body' }
const BOT_AT = { x: 5.5, y: 64, z: 5.5 } // site centre, on castle ground

function key(x, y, z) { return `${x},${y},${z}` }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Flat world: solid at y<=63 plus placements, air above. groundAt names
// the natural cells; dig breaks, drops dirt, and lets the body fall;
// placeBlock refuses inside the castle box (the prod 'still air'
// refusal) and lands anywhere past it.
function castleBot(at, opts = {}) {
  const dug = new Set()
  const placed = new Set()
  const items = (opts.items || []).map((i) => ({ ...i }))
  const solidAt = (x, y, z) => placed.has(key(x, y, z)) || (y <= 63 && !dug.has(key(x, y, z)))
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
      const s = solidAt(x, y, z)
      const name = !s ? 'air'
        : placed.has(key(x, y, z)) ? 'cobblestone'
        : (opts.groundAt && opts.groundAt(x, y, z)) || 'dirt'
      return { name, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    async dig(b) {
      dug.add(key(b.position.x, b.position.y, b.position.z))
      const d = items.find((i) => i.name === 'dirt')
      if (d) d.count++
      else items.push({ name: 'dirt', count: 1 })
      const e = bot.entity.position
      let y = Math.floor(e.y)
      while (!solidAt(Math.floor(e.x), y - 1, Math.floor(e.z))) y--
      bot.entity.position = pos(e.x, y, e.z)
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) {
      const d = ref.position.plus(face)
      if (opts.refuseSite !== false && castleData.inFootprint(CASTLE, { x: d.x, y: d.y, z: d.z })) {
        throw new Error(`Server refused to place cobblestone at (${d.x}, ${d.y}, ${d.z}): the block is still air`)
      }
      if (!bot.heldItem || bot.heldItem.count < 1) throw new Error('no block')
      placed.add(key(d.x, d.y, d.z))
      bot.heldItem.count--
    },
  }
  bot.solidAt = solidAt
  return bot
}

function closedIn(bot) {
  const p = bot.entity.position
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const dy of [0, 1]) for (const [dx, dz] of sides) if (!bot.solidAt(x + dx, y + dy, z + dz)) return false
  return bot.solidAt(x, y - 1, z) && bot.solidAt(x, y + 2, z)
}

// Box distance from the castle footprint (columns the dig may not touch).
function boxDist(x, z) {
  const { w, d } = castleData.siteDimensions(CASTLE.rot, CASTLE.blueprintVersion)
  const ox = x < CASTLE.site.x ? CASTLE.site.x - x : x >= CASTLE.site.x + w ? x - (CASTLE.site.x + w - 1) : 0
  const oz = z < CASTLE.site.z ? CASTLE.site.z - z : z >= CASTLE.site.z + d ? z - (CASTLE.site.z + d - 1) : 0
  return Math.hypot(ox, oz)
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

// Run the pillar to its terminal verdict: one tick to arm the jump-start
// timer, the body past the trigger height when it fires, one tick to read
// the verdict. Returns the shelter logs so far.
async function pillarTicks(bot, ctx, logs) {
  const tick = async () => { logs.push(...await quiet(() => home.shelter(bot, ctx, null, null))) }
  await tick()
  assert.match(ctx.recovery && ctx.recovery.status, /running|starting/, 'pillar climbing')
  bot.entity.position = pos(bot.entity.position.x, 64.7, bot.entity.position.z) // past the +0.6 trigger
  await sleep(300) // the 150 ms jump-start timer fires and the async place resolves
  bot.entity.position = pos(bot.entity.position.x, 64, bot.entity.position.z) // landed
  await tick()
}

describe('vmzq.48 shelter at the castle site: pillar refused + ground protected', () => {
  it('walks off the footprint and digs in 6+ blocks from the castle', async () => {
    // The prod shape: the bot column digs (dirt) but is castle ground
    // (protected); every column the ±8 dig-in scan could walk to is
    // un-diggable (the run8 trench/quarry/apron vetoes stand in as
    // stone); natural ground resumes past it.
    const bot = castleBot(BOT_AT, {
      items: [{ name: 'cobblestone', count: 16 }],
      groundAt: (x, y, z) => {
        if (x === 5 && z === 5) return 'dirt'
        return Math.hypot(x - 5, z - 5) <= 12 ? 'stone' : 'dirt'
      },
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = []
    await pillarTicks(bot, ctx, logs)
    assert.ok(logs.some((m) => m.includes('shelter pillar failed:place-error')), JSON.stringify(logs))
    assert.ok(logs.some((m) => m.includes('recover ban action=pillar_up')), 'the #356 refusal ban, reused')
    const walk = ctx.shelter && ctx.shelter.dig && ctx.shelter.dig.walk
    assert.ok(walk, `relocation walk issued, not an open hold: ${JSON.stringify(logs)}`)
    assert.ok(boxDist(walk.x, walk.z) >= 6, `6+ blocks from the castle: ${JSON.stringify(walk)}`)
    assert.ok(logs.some((m) => m.includes('leaving the castle footprint')), JSON.stringify(logs))
    // The pathfinder walks it; arrival digs a closed pit and arms the hold.
    bot.entity.position = pos(walk.x + 0.5, walk.y, walk.z + 0.5)
    for (let t = 0; t < 20 && ctx.shelter.dig; t++) {
      logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
      await flush()
    }
    assert.ok(!ctx.shelter.dig, 'dig finished')
    assert.ok(closedIn(bot), 'enclosed pit past the footprint')
    assert.equal(ctx.inShelter, true, 'a closed pit arms the hold')
    assert.ok(logs.includes('shelter dig-in done'), JSON.stringify(logs))
  })

  it('no viable ground past the footprint: holds exposed so fight preempts', async () => {
    const bot = castleBot(BOT_AT, {
      items: [{ name: 'cobblestone', count: 16 }],
      groundAt: (x, y, z) => (x === 5 && z === 5 ? 'dirt' : 'stone'),
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = []
    await pillarTicks(bot, ctx, logs)
    assert.equal(ctx.shelter.pillared, true, 'never fails the step, never marches')
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.inShelter, false, 'exposed: fight preempts instead of idling')
    assert.ok(!(ctx.shelter.dig && ctx.shelter.dig.walk), 'no walk to nowhere')
    assert.ok(logs.includes('shelter dig-in failed:protected'), JSON.stringify(logs))
    // Steady: later ticks keep the exposed hold, no march, no re-pillar.
    const goals = []
    bot.pathfinder.setGoal = (g) => { goals.push(g) }
    logs.push(...await quiet(() => { for (let t = 0; t < 5; t++) home.shelter(bot, ctx, null, null) }))
    assert.equal(ctx.inShelter, false)
    assert.deepEqual(goals, [], 'still holding, still no march')
  })

  it('normal pad: a working pillar at the castle perches armed, no relocation', async () => {
    // By-construction pin: the relocation path only runs after a
    // protected dig failure — a site that pillars (or digs) keeps the
    // exact old shape.
    const bot = castleBot(BOT_AT, {
      items: [{ name: 'cobblestone', count: 16 }],
      refuseSite: false,
      groundAt: () => 'dirt',
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = []
    await pillarTicks(bot, ctx, logs)
    assert.equal(ctx.shelter.perched, true)
    assert.equal(ctx.shelter.pillared, true)
    assert.equal(ctx.inShelter, true)
    assert.ok(!ctx.shelter.offCastle && !ctx.shelter.exposed, 'no relocation markers on the normal path')
    assert.ok(!logs.some((m) => m.includes('digging in')), `no dig fallback: ${JSON.stringify(logs)}`)
  })
})
