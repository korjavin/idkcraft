'use strict'

// water_up escape (idkcraft-jsf.2): scan + phase-machine unit tests. The mock
// world pours like the server (source + falling column to the floor) and
// scoops like the server (top source in reach + column drain), so the swim
// plateau, the traverse and the strip emerge instead of being scripted.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const waterup = require('../src/behaviours/waterup')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Shaft world: floor top at 61 (feet 61), 1-wide shaft (0,61..70,0) open to
// the sky, stone walls around, alcove dest (1,67,0) with solid below (1,66,0),
// side ref (2,67,0), clear head. A pours at (0,66,0) (feet+5), B at (1,67,0).
function shaftWorld() {
  const solids = new Set()
  for (let x = -3; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    }
  }
  for (let y = 61; y <= 70; y++) {
    for (let x = -3; x <= 4; x++) {
      for (let z = -3; z <= 3; z++) {
        if (x === 0 && z === 0) continue
        if (x === 1 && z === 0 && y >= 67 && y <= 68) continue
        solids.add(key(x, y, z))
      }
    }
  }
  return solids
}

function worldBot(solids, items, opts = {}) {
  const waters = new Set() // poured water cells
  const columns = new Map() // source key -> [column cell keys] (drain on scoop)
  const bot = {
    username: 'IdkBot',
    players: {},
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    heldItem: null,
    controls: {},
    aims: [],
    uses: 0,
    opts,
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const water = waters.has(k)
      const solidCell = solids.has(k)
      const name = water ? 'water' : solidCell ? 'stone' : 'air'
      return {
        name,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: water || !solidCell ? 'empty' : 'block',
      }
    },
    async equip(item) {
      await Promise.resolve()
      bot.heldItem = item
    },
    lookAt(pt) { bot.aims.push({ x: pt.x, y: pt.y, z: pt.z }) },
    activateItem() {
      bot.uses++
      if (bot.opts.refuseUse) return // spawn protection: use silently refused
      const aim = bot.aims.length > 0 ? bot.aims[bot.aims.length - 1] : null
      const held = bot.heldItem
      if (!aim || !held) return
      if (held.name === 'water_bucket') {
        // Pour: nearest known site dest within 2 of the aim, else the Paper
        // quirk eats the bucket (aim into an occupied cell, jsf.1 a2).
        let best = null
        for (const s of bot.opts.sites || []) {
          const d = Math.hypot(aim.x - (s.x + 0.5), aim.y - (s.y + 0.5), aim.z - (s.z + 0.5))
          if (d < 2 && (!best || d < best.d)) best = { s, d }
        }
        held.count--
        if (held.count <= 0 && items.indexOf(held) >= 0) items.splice(items.indexOf(held), 1)
        if (!best) return // quirk: water lost, no empty back
        const eb = items.find((i) => i.name === 'bucket')
        if (eb) eb.count++
        else items.push({ name: 'bucket', count: 1 })
        // Source + falling column down to the floor (server behaviour).
        const cells = []
        for (let y = best.s.y; y >= 55; y--) {
          const k = key(best.s.x, y, best.s.z)
          if (solids.has(k)) break
          waters.add(k)
          cells.push(k)
        }
        columns.set(key(best.s.x, best.s.y, best.s.z), cells)
        return
      }
      if (held.name === 'bucket') {
        if (bot.opts.fizzleScoops > 0) { bot.opts.fizzleScoops--; return }
        // Scoop: the TOP water within 2 of the aim (server rule, jsf.1 e).
        let top = null
        for (const k of waters) {
          const [x, y, z] = k.split(',').map(Number)
          const d = Math.hypot(aim.x - (x + 0.5), aim.y - (y + 0.5), aim.z - (z + 0.5))
          if (d < 2 && (!top || y > top.y)) top = { x, y, z }
        }
        if (!top) return
        held.count--
        if (held.count <= 0 && items.indexOf(held) >= 0) items.splice(items.indexOf(held), 1)
        const wb = items.find((i) => i.name === 'water_bucket')
        if (wb) wb.count++
        else items.push({ name: 'water_bucket', count: 1 })
        const col = columns.get(key(top.x, top.y, top.z))
        if (col) for (const k of col) waters.delete(k)
        else waters.delete(key(top.x, top.y, top.z))
      }
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
    chat() {},
    _waters: waters,
  }
  return bot
}

// Harness physics per tick (after the run tick): swim rise while the eye is
// submerged (the eye-out plateau emerges), traverse cruise toward the aim,
// sink/fall otherwise. Returns the run's return.
function harness(bot, ctx) {
  const out = waterup.waterUpRun(bot, ctx)
  const p = bot.entity.position
  const feetK = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  const headK = key(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z))
  const inWater = bot._waters.has(feetK) || bot._waters.has(headK) || bot.opts.inWater === true
  const jump = !!bot.controls.jump
  const fwd = !!bot.controls.forward
  if (jump && inWater && !bot.opts.freezeRise) {
    // Rise while the eye is under the local surface.
    let surface = null
    for (const k of bot._waters) {
      const [x, y, z] = k.split(',').map(Number)
      if (x === Math.floor(p.x) && z === Math.floor(p.z) && y + 1 > p.y) {
        if (surface === null || y + 1 > surface) surface = y + 1
      }
    }
    if (surface !== null && p.y + 1.62 < surface) p.y = Math.min(p.y + 0.5, surface - 1.62 + 0.4)
  } else if (!jump) {
    // Sink in water, fall in air, down to the floor top.
    let floorTop = 55
    for (let y = Math.floor(p.y); y >= 50; y--) {
      const b = bot.blockAt({ x: p.x, y, z: p.z })
      if (b && b.boundingBox !== 'empty') { floorTop = y + 1; break }
    }
    p.y = Math.max(floorTop, p.y - (inWater ? 0.3 : 0.5))
  }
  if (fwd && jump && !bot.opts.pinTraverse) {
    const aim = bot.aims.length > 0 ? bot.aims[bot.aims.length - 1] : null
    if (aim) {
      const dx = aim.x - p.x
      const dz = aim.z - p.z
      const d = Math.hypot(dx, dz)
      if (d > 0.05) {
        p.x += (dx / d) * Math.min(0.4, d)
        p.z += (dz / d) * Math.min(0.4, d)
      }
      // Jump-mount: swimming up against a standable ledge pops out onto it
      // (rig: the traverse stands at dest.y from a lower hover).
      const ac = { x: Math.floor(aim.x), y: Math.floor(aim.y), z: Math.floor(aim.z) }
      const under = bot.blockAt({ x: ac.x, y: ac.y - 1, z: ac.z })
      const at = bot.blockAt(ac)
      if (under && under.boundingBox !== 'empty' && at && at.boundingBox === 'empty' &&
        p.y < ac.y && p.y > ac.y - 1.6) p.y = ac.y
    }
  }
  const below = bot.blockAt({ x: p.x, y: p.y - 0.1, z: p.z })
  bot.entity.onGround = !!below && below.boundingBox !== 'empty' && p.y <= below.position.y + 1.05
  return out
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

async function runTicks(bot, ctx, n, hook) {
  let out = 'running'
  for (let i = 0; i < n; i++) {
    if (hook) hook(i, ctx)
    out = harness(bot, ctx)
    await flush()
    if (out !== 'running') break
  }
  return out
}

function countOf(items, name) {
  const it = items.find((i) => i.name === name)
  return it ? it.count : 0
}

describe('waterup scans', () => {
  it('finds the A+B combo in the shaft world', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    const combo = waterup.findCombo(bot)
    assert.ok(combo)
    assert.deepEqual(combo.A.dest, { x: 0, y: 66, z: 0 })
    assert.deepEqual(combo.B.dest, { x: 1, y: 67, z: 0 })
    assert.deepEqual(combo.B.below, { x: 1, y: 66, z: 0 })
  })

  it('no combo under a ceiling ( capped shaft)', () => {
    const solids = shaftWorld()
    for (let y = 63; y <= 66; y++) for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) solids.add(key(x, y, z))
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.findCombo(bot), null)
    assert.equal(waterup.openAbove(bot), false)
  })

  it('openAbove reads the open shaft true', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.openAbove(bot), true)
  })

  it('B below the A source is rejected (spread current pins)', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    // Ledge dest at/below srcAY must not offer, even with a perfect shape.
    assert.equal(waterup.ledgePourAt(bot, 0, 65, 0, 67, 67), null)
  })

  it('counts water buckets, 0 when the inventory is not ready', () => {
    assert.equal(waterup.countBuckets(worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])), 2)
    assert.equal(waterup.countBuckets(worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])), 0)
    assert.equal(waterup.countBuckets({}), 0)
  })
})

describe('waterup run', () => {
  it('climbs the shaft: done, +6, dry, both buckets back', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    const swimFwds = []
    const out = await runTicks(bot, ctx, 80, () => {
      if (ctx.recovery.st && ctx.recovery.st.phase === 'swim') swimFwds.push(!!bot.controls.forward)
    })
    assert.equal(out, 'done')
    assert.ok(swimFwds.length > 2, 'swim ran several ticks')
    assert.ok(swimFwds.every((f) => f === false), 'forward stays false through the swim')
    assert.equal(Math.floor(bot.entity.position.y), 67)
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
    assert.equal(countOf(items, 'bucket'), 0)
  })

  it('swim holds forward off against stuck keys', async () => {
    // A killed primitive leaves forward held: the swim re-asserts the guard
    // every tick (mutation: drop the guard and this fails).
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    let swimTicks = 0
    let out = 'running'
    for (let i = 0; i < 80; i++) {
      if (ctx.recovery.st && ctx.recovery.st.phase === 'swim') bot.setControlState('forward', true)
      out = harness(bot, ctx)
      await flush()
      if (ctx.recovery.st && ctx.recovery.st.phase === 'swim') {
        swimTicks++
        assert.equal(bot.controls.forward, false)
      }
      if (out !== 'running') break
    }
    assert.equal(out, 'done')
    assert.ok(swimTicks > 2, 'swim ran several ticks')
  })

  it('one bucket is not a climb: failed:no-bucket, nothing poured', async () => {
    const items = [{ name: 'water_bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    const out = await runTicks(bot, { recovery: {} }, 5)
    assert.equal(out, 'failed:no-bucket')
    assert.equal(bot.uses, 0)
    assert.equal(bot._waters.size, 0)
  })

  it('refused pour (spawn protection): failed:pour, no water left', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { refuseUse: true })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const out = await runTicks(bot, { recovery: {} }, 20)
    assert.equal(out, 'failed:pour')
    assert.equal(bot._waters.size, 0)
  })

  it('pinned swim scoops A back: failed:no-rise, dry, buckets back', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { freezeRise: true })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    const out = await runTicks(bot, ctx, 80)
    assert.equal(out, 'failed:no-rise')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('failed B pour strips A: failed:rim-pour, dry', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    const out = await runTicks(bot, ctx, 80, () => {
      // Transient refusal: the B activate fizzles, the strip still scoops.
      const ph = ctx.recovery.st && ctx.recovery.st.phase
      bot.opts.refuseUse = ph === 'pourB'
    })
    assert.equal(out, 'failed:rim-pour')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('lost ledge mid-swim: failed:no-ledge, A scooped back', async () => {
    const solids = shaftWorld()
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(solids, items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    let filled = false
    const out = await runTicks(bot, ctx, 80, () => {
      // The ledge caves while swimming: the live re-scan finds nothing.
      if (!filled && ctx.recovery.st && ctx.recovery.st.phase === 'swim') {
        filled = true
        solids.add(key(1, 67, 0))
      }
    })
    assert.equal(out, 'failed:no-ledge')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('pinned traverse strips from the hover: failed:traverse, dry', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { pinTraverse: true })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const out = await runTicks(bot, { recovery: {} }, 80)
    assert.equal(out, 'failed:traverse')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('one fizzled scoop still strips on retry: done', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { fizzleScoops: 1 })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const out = await runTicks(bot, { recovery: {} }, 80)
    assert.equal(out, 'done')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('unscoopable water fails honestly: failed:strip', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    const ctx = { recovery: {} }
    const out = await runTicks(bot, ctx, 80, () => {
      if (ctx.recovery.st && ctx.recovery.st.phase === 'strip') bot.opts.refuseUse = true
    })
    assert.equal(out, 'failed:strip')
  })

  it('settle honours the F2 rule: +1 is no-gain, +2 is done', async () => {
    const mk = (y) => {
      const items = []
      const bot = worldBot(shaftWorld(), items)
      bot.entity.position = pos(1.5, y, 0.5)
      bot.entity.onGround = true
      return bot
    }
    const st1 = { phase: 'settle', waited: 0, startFloor: 61, start: { x: 0.5, y: 61, z: 0.5 } }
    let out = ''
    for (let i = 0; i < 6; i++) { out = waterup.waterUpRun(mk(62), { recovery: { st: st1 } }); await flush() }
    assert.equal(out, 'failed:no-gain')
    const st2 = { phase: 'settle', waited: 0, startFloor: 61, start: { x: 0.5, y: 61, z: 0.5 } }
    out = waterup.waterUpRun(mk(63.2), { recovery: { st: st2 } })
    assert.equal(out, 'done')
  })

  it('missing look/use fails cleanly without touching controls', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    delete bot.lookAt
    assert.equal(waterup.waterUpRun(bot, { recovery: {} }), 'failed:no-look')
    const bot2 = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    delete bot2.activateItem
    assert.equal(waterup.waterUpRun(bot2, { recovery: {} }), 'failed:no-use')
  })
})
