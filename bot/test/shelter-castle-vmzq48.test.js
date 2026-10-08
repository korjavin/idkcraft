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
const { createTicker, BEHAVIOURS } = require('../src/index')

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
      if (bot.failPlace) throw new Error(`Server refused to place ${bot.heldItem && bot.heldItem.name} at (${d.x}, ${d.y}, ${d.z})`)
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

  it('a walk-off that never arrives (no-walk) holds exposed', async () => {
    // Revmux 01 core-3a: the st.offCastle arm — a relocation walk that
    // dies on the surface must release fight, not arm the open hold.
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
    assert.ok(ctx.shelter.dig && ctx.shelter.dig.walk, 'relocation launched')
    for (let t = 0; t < 20 && ctx.shelter.dig; t++) {
      logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
      await flush()
    }
    assert.ok(!ctx.shelter.dig, 'walk gave up')
    assert.ok(logs.includes('shelter dig-in failed:no-walk'), JSON.stringify(logs))
    assert.equal(ctx.shelter.pillared, true, 'never fails the step, never marches')
    assert.equal(ctx.inShelter, false, 'exposed: fight preempts')
  })

  it('a walk-off that descends and times out (downhill no-walk) holds exposed', async () => {
    // Revmux 03 core-1: floor0 seeds when the walk starts, so walk
    // descent is not pit descent — a timed-out downhill walk must not
    // arm the open hold.
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
    assert.ok(ctx.shelter.dig && ctx.shelter.dig.walk, 'relocation launched')
    logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
    await flush() // one walk tick seeds floor0 at the start ...
    bot.entity.position = pos(0.5, 62, 0.5) // ... then the walk descends, never arrives
    for (let t = 0; t < 20 && ctx.shelter.dig; t++) {
      logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
      await flush()
    }
    assert.ok(logs.includes('shelter dig-in failed:no-walk'), JSON.stringify(logs))
    assert.equal(ctx.inShelter, false, 'walk descent is not a dug pit: fight preempts')
  })

  it('a protected failure off the castle (house ground) keeps the armed hold', async () => {
    // Revmux 01 core-3b: the castleGroundHere gate — exposing every
    // protected failure would break the house-porch hold.
    const bot = castleBot(BOT_AT, {
      items: [{ name: 'cobblestone', count: 16 }],
      groundAt: (x, y, z) => (x === 5 && z === 5 ? 'dirt' : 'stone'),
    })
    const ctx = {
      step: 'shelter', stepStatus: 'running',
      home: {
        site: { x: 0, y: 64, z: 0 }, built: true, v: 2,
        interior: { min: { x: 1, y: 64, z: 1 }, max: { x: 5, y: 65, z: 4 } },
        door: { x: 3, y: 64, z: 0 },
      },
    }
    const logs = []
    await pillarTicks(bot, ctx, logs)
    assert.ok(logs.includes('shelter dig-in failed:protected'), JSON.stringify(logs))
    assert.equal(ctx.shelter.pillared, true)
    assert.equal(ctx.inShelter, true, 'house ground: the old armed hold')
    assert.ok(!ctx.shelter.offCastle, 'no castle, no walk-off')
  })

  it('an undiggable surface on castle ground (laid deck) holds exposed', async () => {
    // Revmux 01 core-2: the bot stands on laid blocks, the veto never
    // reaches the protected check, but the open hold is the same death.
    const bot = castleBot(BOT_AT, {
      items: [{ name: 'cobblestone', count: 16 }],
      groundAt: (x, y, z) => (x === 5 && z === 5 ? 'cobblestone' : 'stone'),
    })
    const ctx = { step: 'shelter', stepStatus: 'running', castle: { ...CASTLE, site: { ...CASTLE.site } } }
    const logs = []
    await pillarTicks(bot, ctx, logs)
    assert.ok(logs.includes('shelter dig-in failed:undiggable:cobblestone'), JSON.stringify(logs))
    assert.equal(ctx.shelter.pillared, true, 'never fails the step, never marches')
    assert.equal(ctx.inShelter, false, 'exposed: fight preempts')
    assert.ok(!ctx.shelter.offCastle, 'the walk-off stays protected-gated')
  })

  it('a refused first break at the walk-off spot (no descent) holds exposed', async () => {
    // Revmux 02 core-1/2: st.digs counts dispatched digs — a break the
    // server refuses leaves the body on the surface, and the open hold
    // must release fight.
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
    const walk = ctx.shelter.dig.walk
    assert.ok(walk, 'relocation launched')
    bot.entity.position = pos(walk.x + 0.5, walk.y, walk.z + 0.5)
    bot.dig = async () => { throw new Error('Server refused to break dirt') }
    for (let t = 0; t < 10 && ctx.shelter.dig; t++) {
      logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
      await flush()
    }
    assert.ok(!ctx.shelter.dig, 'dig gave up')
    assert.ok(logs.includes('shelter dig-in failed:dig-error'), JSON.stringify(logs))
    assert.equal(Math.floor(bot.entity.position.y), walk.y, 'body never descended')
    assert.equal(ctx.inShelter, false, 'no descent: fight preempts')
  })

  it('a descended pit whose cap is refused keeps the armed hold', async () => {
    // Revmux 02 core-2: measured descent still commits — abandoning a
    // 3-deep pit to chase is worse than holding it.
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
    const walk = ctx.shelter.dig.walk
    assert.ok(walk, 'relocation launched')
    bot.entity.position = pos(walk.x + 0.5, walk.y, walk.z + 0.5)
    for (let t = 0; t < 20 && ctx.shelter.dig; t++) {
      if (Math.floor(bot.entity.position.y) <= walk.y - 3) bot.failPlace = true // pit dug, cap refused
      logs.push(...await quiet(() => home.shelter(bot, ctx, null, null)))
      await flush()
    }
    assert.ok(!ctx.shelter.dig, 'dig gave up')
    assert.ok(logs.includes('shelter dig-in failed:cap-error'), JSON.stringify(logs))
    assert.equal(Math.floor(bot.entity.position.y), walk.y - 3, 'three deep')
    assert.equal(ctx.inShelter, true, 'descended: the armed hold keeps the pit')
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

describe('vmzq.48 exposed hold releases fight (tick level)', () => {
  function tickBot() {
    const calls = { setGoal: 0, stop: 0 }
    const bot = {
      calls,
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      time: { timeOfDay: 15000, day: 5 },
      entity: { position: pos(240.5, 70, 352.5) },
      inventory: { items: () => [] },
      attackCalls: 0,
      attack() { this.attackCalls++ },
      lookAt() {},
      equip: async () => {},
      pathfinder: {
        goal: null,
        setGoal(g) { calls.setGoal++; bot.pathfinder.goal = g },
        stop() { calls.stop++ },
        isMoving: () => false,
        setMovements() {},
      },
      setControlState() {},
      clearControlStates() {},
      chat() {},
    }
    return bot
  }

  function zombie(id, x, z) {
    const p = pos(x, 70, z)
    p.offset = (ox, oy, oz) => pos(p.x + ox, p.y + oy, p.z + oz)
    return { id, name: 'zombie', type: 'mob', position: p, height: 1.95 }
  }

  it('exposed hold + adjacent zombie: fight dispatched, the arm swings (not shelter-idle)', async () => {
    // Revmux 01 core-3: the bead's 'fights back, not idle' through the
    // real dispatch — the (h) mirror with the hold exposed.
    const bot = tickBot()
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(250, 70, 352) } } }
    bot.entities = { 1: zombie(1, 241.5, 352.5) } // adjacent: melee range
    const ticker = createTicker({ bot, brain: { calls: 0, async decide() { this.calls++; return { action: 'fight', sprint: false, source: 'stub' } } }, tickMs: 10, idleTickMs: 10 })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.step = 'shelter'
    ctx.shelter = { pillared: true, pillarAt: { x: 240.5, z: 352.5 }, exposed: true }
    ctx.inShelter = false
    const origFight = BEHAVIOURS.fight
    let fightRan = 0
    BEHAVIOURS.fight = () => { fightRan++ }
    const origLog = console.log
    const logs = []
    console.log = (m) => { logs.push(String(m)) }
    try {
      const r = await ticker.tick()
      assert.equal(r.decision.action, 'fight', `fight released: ${JSON.stringify(r.decision)}`)
      assert.equal(fightRan, 1, 'fight behaviour dispatched')
      assert.ok(!logs.some((m) => m.includes('action=shelter')), `never shelter-idles: ${JSON.stringify(logs)}`)
      // Control (revmux 02 core-3): the same tick with the hold armed
      // suppresses fight — the dispatch, not the every-tick melee
      // reflex, tells the exposed hold apart. (attackCalls is not
      // asserted: the reflex swings regardless of inShelter.)
      ctx.inShelter = true
      fightRan = 0
      const held = await ticker.tick()
      assert.equal(held.decision.action, 'idle', 'armed hold still suppresses')
      assert.equal(fightRan, 0, 'fight not dispatched under the armed hold')
    } finally {
      console.log = origLog
      BEHAVIOURS.fight = origFight
      ticker.destroy()
    }
  })
})
