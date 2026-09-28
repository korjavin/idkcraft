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
  if (fwd && !bot.opts.pinTraverse && !bot.opts.pinWalk) {
    const aim = bot.aims.length > 0 ? bot.aims[bot.aims.length - 1] : null
    if (aim && (jump || bot.entity.onGround)) {
      const dx = aim.x - p.x
      const dz = aim.z - p.z
      const d = Math.hypot(dx, dz)
      if (d > 0.05) {
        // Fixed-length steps, like the real timed taps: sneak taps step
        // fine (~0.16), walk taps step coarse (~0.5, modelled 0.4). No
        // arrival cap — a coarse tap genuinely overshoots a fine window
        // (the rig pocket no-center), and arrival checks carry tolerance.
        // pinSneak {x,z} models a brink stance: within 0.15 of the point the
        // vanilla edge-guard refuses SNEAKED steps off, while one unsneaked
        // tap steps off (rig shaft y53); outside the point sneak walks free.
        const pin = bot.opts.pinSneak
        const glued = pin && Math.hypot(p.x - pin.x, p.z - pin.z) < 0.15
        if (bot.controls.sneak && glued) { /* edge-guard: glued */ } else {
          const step = bot.controls.sneak ? 0.15 : 0.4
          p.x += (dx / d) * step
          p.z += (dz / d) * step
        }
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

  it('no combo mid-air: the climb starts standing', () => {
    // The replay shaft fired water_up mid-hop: the center target fell away
    // (failed:no-center) and the follow-ups walked out of the shaft. An
    // airborne body offers nothing (mutation: drop the gate and this
    // offers), while standing under water still counts.
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    bot.entity.onGround = false
    assert.equal(waterup.findCombo(bot), null)
    bot.entity.onGround = true
    bot.entity.isInWater = true
    assert.ok(waterup.findCombo(bot))
  })

  it('no combo under a ceiling (capped shaft)', () => {
    const solids = shaftWorld()
    for (let y = 63; y <= 66; y++) for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) solids.add(key(x, y, z))
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.findCombo(bot), null)
  })

  it('a lip above the climb still combos (lane-precise, not dy2..5)', () => {
    // Own-column rock at 69, above the whole pair: A pours at 66 with a
    // clear lane and B sits at 67.
    const solids = shaftWorld()
    solids.add(key(0, 69, 0))
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    const combo = waterup.findCombo(bot)
    assert.ok(combo)
    assert.equal(combo.A.dest.y, 66)
    assert.deepEqual(combo.B.dest, { x: 1, y: 67, z: 0 })
  })

  it('a B above the mount budget is not an offer (the slope case)', () => {
    // Own-column rock at 66 forces A down to 65 (plateau 64.4) while the
    // only B sits at 67 — 2.6 above the plateau, past the traverse mount
    // (~1.2 of jump-out). The replay slope offered exactly this and died
    // mid-climb; the floor scan now rejects it outright.
    const solids = shaftWorld()
    solids.add(key(0, 66, 0))
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.findCombo(bot), null)
  })

  it('a blocked swim lane kills the combo', () => {
    // Rock at 64 fills the lane to every A that could reach the alcove.
    const solids = shaftWorld()
    solids.add(key(0, 64, 0))
    solids.add(key(0, 65, 0))
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.findCombo(bot), null)
  })

  it('wall2At reads one hemmed side true, open ground false', () => {
    assert.equal(waterup.wall2At(worldBot(shaftWorld(), [])), true)
    const open = new Set()
    for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 60; y++) open.add(key(x, y, z))
    assert.equal(waterup.wall2At(worldBot(open, [])), false)
  })

  it('B below the A source is rejected (spread current pins)', () => {
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    // Ledge dest at/below srcAY must not offer, even with a perfect shape.
    assert.equal(waterup.ledgePourAt(bot, 0, 65, 0, 67, 67), null)
  })

  it('B aims the squarest face, not the first solid side', () => {
    // Rig pocket: the scan picked a 16-deg grazing face and the Paper quirk
    // ate B; the square face on the same dest would have poured. The eye
    // sits south of the dest, so the NORTH ref — listed last in SIDES —
    // wins over the grazing south ref (mutation: first-solid picks south).
    const solids = new Set()
    for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    solids.add(key(1, 66, 0)) // below the dest
    solids.add(key(1, 67, -1)) // north ref (square to this eye)
    solids.add(key(1, 67, 1)) // south ref (grazing from this eye)
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    bot.entity.position = pos(0.9, 65.38, 0.9)
    const B = waterup.ledgePourAt(bot, 0, 65, 0, 67.0, 60, 66.0)
    assert.ok(B)
    assert.deepEqual(B.dest, { x: 1, y: 67, z: 0 })
    assert.deepEqual({ x: B.ref.position.x, y: B.ref.position.y, z: B.ref.position.z }, { x: 1, y: 67, z: -1 })
    assert.deepEqual(B.face, [0, 0, 1])
  })

  it('a backface-only B is not an offer (the pocket B)', () => {
    // Rig pocket: the scan offered dest (-58,58,-211) via the west ref's
    // EAST face — a backface from the lane (the normal points away), which
    // the server ray can never first-hit; the use ate B into the wrong
    // cell. A backface is unpourable from any eye on its blind side.
    const solids = new Set()
    for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 60; y++) solids.add(key(x, y, z))
    solids.add(key(1, 66, 0)) // below the dest
    solids.add(key(0, 67, 0)) // west ref: its east face is a backface here
    const bot = worldBot(solids, [{ name: 'water_bucket', count: 2 }])
    bot.entity.position = pos(0.5, 65.38, 0.5)
    assert.equal(waterup.ledgePourAt(bot, 0, 65, 0, 66.5, 60, 66.0), null)
  })

  it('an occluded front face is not an offer (drifted eye)', () => {
    // The shaft B via its south ref is FRONT from a drifted-out hover but
    // the ray enters the alcove wall first: the scan must skip it, not
    // offer a pour the server ray cannot make (mutation: drop the scan
    // visibility check and this offers).
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    bot.entity.position = pos(0.5, 65.4, -2.5)
    assert.equal(waterup.ledgePourAt(bot, 0, 65, 0, 67.02, 66, 65.4), null)
  })

  it('faceVisible: lane ray hits, drifted ray occludes, backface never', () => {
    // The shaft B face from the lane eye: clean first hit. From 3 south
    // the same ray enters the alcove wall first (the slope death shape).
    // A face whose normal points away is never first-hit (pocket shape).
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.faceVisible(bot, { x: 0.5, y: 67.02, z: 0.5 }, { x: 2, y: 67, z: 0 }, [-1, 0, 0]), true)
    assert.equal(waterup.faceVisible(bot, { x: 0.5, y: 67.02, z: -2.5 }, { x: 2, y: 67, z: 0 }, [-1, 0, 0]), false)
    assert.equal(waterup.faceVisible(bot, { x: 0.5, y: 67.02, z: 0.5 }, { x: 1, y: 66, z: 0 }, [1, 0, 0]), false)
  })

  it('the mount budget rides the predicted plateau, not the hover trough', () => {
    // B at 67 mounts from the 65.4 plateau (67.1 budget) but not from 65.1
    // (66.8): the floor scan rejects the trough case outright.
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    assert.equal(waterup.ledgePourAt(bot, 0, 65, 0, 67.02, 66, 65.1), null)
    const B = waterup.ledgePourAt(bot, 0, 65, 0, 67.02, 66, 65.4)
    assert.ok(B)
    assert.deepEqual(B.dest, { x: 1, y: 67, z: 0 })
  })

  it('the live B re-scan covers the drift disk around the hover', () => {
    // Rig pocket: the spread current pushed the hover a full block off the
    // lane while B waited in reach of the lane column — the own-column scan
    // saw nothing (failed:no-ledge). Drifting one column over must still
    // offer it (mutation: single-anchor scan returns null here).
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    bot.entity.position = pos(0.5, 65.4, -0.5)
    const B = waterup.findLedgePour(bot, 66, 65.4)
    assert.ok(B)
    assert.deepEqual(B.dest, { x: 1, y: 67, z: 0 })
  })

  it('the live B re-scan clamps a stale low hint to the live hover', () => {
    // The hover heaves ±0.5: a hint from the trough must not flicker an
    // offer the live hover would make (mutation: drop the max clamp and
    // this returns null).
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    bot.entity.position = pos(0.5, 65.4, 0.5)
    const B = waterup.findLedgePour(bot, 66, 64.9)
    assert.ok(B)
    assert.deepEqual(B.dest, { x: 1, y: 67, z: 0 })
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

  it('swim taps toward the lane middle when drifted off-center', async () => {
    // Open lanes drift the hover off the 1-wide column (replay slope): past
    // 0.3 out the swim faces the middle and taps forward 150 ms, then the
    // timer releases (mutation: drop the tap and forward never goes true).
    const items = [{ name: 'water_bucket', count: 1 }, { name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    // Mid-swim stance, drifted 0.8 east of the lane middle.
    bot.entity.position = pos(1.3, 63, 0.5)
    const st = {
      phase: 'swim', waited: 0, startFloor: 61, start: { x: 0.5, y: 61, z: 0.5 },
      combo: { A: { dest: { x: 0, y: 66, z: 0 } }, B: { dest: { x: 1, y: 67, z: 0 } } },
      sources: [{ x: 0, y: 66, z: 0 }], lastY: 62.9, lastGainTick: 0,
    }
    // Pour the column the swim rises through.
    bot._waters.add('0,66,0'); bot._waters.add('0,65,0'); bot._waters.add('0,64,0'); bot._waters.add('0,63,0')
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(bot.controls.forward, true)
    const aim = bot.aims[bot.aims.length - 1]
    assert.ok(Math.hypot(aim.x - 0.5, aim.z - 0.5) < 0.1, 'faces the lane middle')
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(bot.controls.forward, false, 'the tap releases between ticks')
  })

  it('pour past reach fails clean with the bucket kept (no quirk eat)', async () => {
    // The hover heaves between the scan and the activate: recheck reach at
    // activate time against server truth, and never activate past 4.5.
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    // Aimed at A, then heaved 5 blocks down (eye 5+ from the dest).
    bot.entity.position = pos(0.5, 59, 0.5)
    const st = {
      phase: 'pourA', waited: 0, startFloor: 61, start: { x: 0.5, y: 61, z: 0.5 },
      combo: { A: { dest: { x: 0, y: 66, z: 0 }, ref: { position: new Vec3(1, 66, 0) }, face: [-1, 0, 0] } },
      sources: [], aimed: true, used: false,
      equipDone: true, equipInFlight: false,
    }
    bot.heldItem = items[0]
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running') // routes to stripFail, which finds nothing…
    let end = out
    for (let i = 0; i < 10 && end === 'running'; i++) { end = waterup.waterUpRun(bot, { recovery: { st } }); await flush() }
    assert.equal(end, 'failed:pour')
    assert.equal(bot.uses, 0, 'never activated')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('off-center stance centers first, then climbs', async () => {
    // A wall-touching stance pins the swim on tick 1 (h04): the scan walks
    // to the cell middle before the first pour.
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    bot.entity.position = pos(0.9, 61, 0.5)
    const out = await runTicks(bot, { recovery: {} }, 80)
    assert.equal(out, 'done')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('a 0.22-off stance centers with sneak taps, then climbs', async () => {
    // The rig pocket spawn sits 0.22 off the cell middle: 120 ms WALK taps
    // step ~0.5 and limit-cycle around the 0.12 window (failed:no-center),
    // while sneak taps step ~0.16 and converge (mutation: drop the sneak
    // and this cycles 0.22<->0.18 to failed:no-center).
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    bot.entity.position = pos(0.6, 61, 0.7)
    const out = await runTicks(bot, { recovery: {} }, 80)
    assert.equal(out, 'done')
    assert.equal(bot.controls.sneak, false)
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('brink stance: sneak glues, one walk tap steps off, then climbs', async () => {
    // Replay shaft y53: the stance overhangs the open shaft on a corner of
    // support, and the vanilla edge-guard refuses every SNEAKED step off
    // (0.44->0.20 then frozen 6 ticks). After 3 stuck taps one unsneaked
    // walk tap steps off, sneak re-centers on the floor, the run re-scans
    // and climbs (mutation: always-sneak dies failed:no-center here).
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { pinSneak: { x: 0.6, z: 0.7 } })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    bot.entity.position = pos(0.6, 61, 0.7)
    const out = await runTicks(bot, { recovery: {} }, 80)
    assert.equal(out, 'done')
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
  })

  it('uncenterable cell fails fast without pouring', async () => {
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items, { pinWalk: true })
    bot.opts.sites = [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }]
    bot.entity.position = pos(0.9, 61, 0.5)
    const out = await runTicks(bot, { recovery: {} }, 20)
    assert.equal(out, 'failed:no-center')
    assert.equal(bot.uses, 0)
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
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

  it('occluded B ray aborts the pour with the bucket kept', async () => {
    // Rig pocket rim-pour: the hover drifted until the B ray entered rock
    // first, and the blind use ate B. The pour now re-verifies the ray
    // pre-use and times out clean — uses stays 0, both buckets back, dry.
    const items = [{ name: 'water_bucket', count: 2 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(0.5, 65.4, -2.5)
    const st = {
      phase: 'pourB',
      combo: {
        A: { dest: { x: 0, y: 66, z: 0 } },
        B: { dest: { x: 1, y: 67, z: 0 }, ref: { position: { x: 2, y: 67, z: 0 } }, face: [-1, 0, 0] },
        plateauY: 65.4,
      },
      sources: [{ x: 0, y: 66, z: 0 }],
      used: false,
      waited: 0,
    }
    const out = await runTicks(bot, { recovery: { st } }, 20)
    assert.equal(out, 'failed:rim-pour')
    assert.equal(bot.uses, 0)
    assert.equal(countOf(items, 'water_bucket'), 2)
    assert.equal(bot._waters.size, 0)
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

  it('traverse arrives inside 0.35 of the stand middle', () => {
    // The old 0.5 ring left no drift budget for the B window: arrived at
    // the edge, the hover walked off during the strip (replay no-gain).
    // 0.4 off still drives; 0.3 off arrives (mutation: 0.5 arrives both).
    const B = { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } }
    const mk = (x) => {
      const bot = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
      bot.entity.position = pos(x, 67, 0.5)
      const st = {
        phase: 'traverse', combo: { B }, faced: true, waited: 0,
        travSeen: { x, z: 0.5 }, travStall: 0,
        sources: [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }],
      }
      const out = waterup.waterUpRun(bot, { recovery: { st } })
      assert.equal(out, 'running')
      return st.phase
    }
    assert.equal(mk(1.1), 'traverse')
    assert.equal(mk(1.2), 'strip')
  })

  it('traverse pre-equips the scoop bucket without skewing its timeout', async () => {
    // The strip then scoops B on its first tick instead of its third,
    // halving the hover window the current gets (replay no-gain). equipStep
    // borrows st.waited: save/restore keeps the traverse timeout exact —
    // one tick advances it by exactly one (mutation: drop the restore and
    // waited jumps 7->9; drop the pre-equip and equipDone stays falsy).
    const bot = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
    bot.entity.position = pos(0.5, 65.4, 0.5)
    const st = {
      phase: 'traverse',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      faced: true, waited: 7, travSeen: { x: 0.5, z: 0.5 }, travStall: 0,
      sources: [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }],
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.waited, 8)
    await flush()
    await flush()
    assert.equal(st.equipDone, true)
  })

  it('arrival inside 0.25 scoops B the same tick when pre-equipped', () => {
    // The 1 s gap to the first strip tick floats the hover off the 1-wide
    // stand (replay no-gain: 0.19 in, 0.69 out, edge-slide in). Inside the
    // scoop ring with the bucket in hand, B goes back on the arrival tick
    // and the body drops straight onto the stand (mutation: drop the
    // arrival fire and used stays false, B stays wet).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(1.3, 67, 0.5) // 0.2 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'traverse',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      faced: true, waited: 3, travSeen: { x: 1.3, z: 0.5 }, travStall: 0,
      sources: [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }],
      equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.phase, 'strip')
    assert.equal(st.used, true)
    assert.equal(st.waited, 0)
    assert.deepEqual(st.stripLeft, [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }])
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 1)
    assert.equal(bot.controls.forward, false) // braked: the scoop drops straight
    assert.deepEqual(bot.aims[bot.aims.length - 1], { x: 1.5, y: 67.5, z: 0.5 })
  })

  it('arrival in the 0.25-0.35 band holds the scoop for the stance gate', () => {
    // The arrival ring (0.35) catches the pass; the scoop ring (0.25) fires.
    // Between them the gap coasts swimming (braking floats back north on
    // the current: replay 0.32 in, 0.97 out) and the strip re-centers first
    // (mutation: fire at 0.35 and used reads true from a drifted stance;
    // brake the gap and forward reads false).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(1.2, 67, 0.5) // 0.3 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'traverse',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      faced: true, waited: 3, travSeen: { x: 1.2, z: 0.5 }, travStall: 0,
      sources: [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }],
      equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.phase, 'strip')
    assert.equal(st.used, false)
    assert.equal(bot._waters.size, 1)
    assert.equal(bot.controls.forward, true) // coasting the gap, stand-faced
    assert.deepEqual(bot.aims[bot.aims.length - 1], { x: 1.5, y: 67, z: 0.5 })
  })

  it('arrival unequipped holds the scoop for the strip-side equip', () => {
    // A failed pre-equip resets at arrival: nothing fires without the empty
    // bucket in hand, and the gap still coasts (mutation: fire unequipped
    // and the use fizzles the verify into a wasted retry; brake the gap
    // and forward reads false).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(1.4, 67, 0.5) // 0.1 off the stand middle
    bot.entity.onGround = false
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'traverse',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      faced: true, waited: 3, travSeen: { x: 1.4, z: 0.5 }, travStall: 0,
      sources: [{ x: 0, y: 66, z: 0 }, { x: 1, y: 67, z: 0 }],
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.phase, 'strip')
    assert.equal(st.used, false)
    assert.equal(bot._waters.size, 1)
    assert.equal(bot.controls.forward, true) // coasting the gap, stand-faced
    assert.deepEqual(bot.aims[bot.aims.length - 1], { x: 1.5, y: 67, z: 0.5 })
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

  it('strip taps station toward the scoop cell only at marginal range', () => {
    // The hover decays under sustained strip aims (rig): drifted to 4.0
    // range the strip fires a station tap before the aim. In easy reach it
    // must NOT tap, and a stood body never taps for range (walking off the
    // stand cannot help — A sits below it). Range taps are hover-only.
    const bot = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
    bot.entity.position = pos(4.5, 65.4, 0.5)
    bot.entity.onGround = false
    bot._waters.add(key(0, 66, 0))
    const st = { phase: 'strip', stripLeft: [{ x: 0, y: 66, z: 0 }], stripTries: 0, used: false }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(bot.controls.forward, true)
    const near = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
    near.entity.position = pos(0.0, 65.4, 0.5)
    near._waters.add(key(0, 66, 0))
    const st2 = { phase: 'strip', stripLeft: [{ x: 0, y: 66, z: 0 }], stripTries: 0, used: false }
    assert.equal(waterup.waterUpRun(near, { recovery: { st: st2 } }), 'running')
    assert.equal(near.controls.forward, false)
  })

  it('strip lands ASAP: jump off stood, on hovering', () => {
    // The old code hovered (jump held) through the whole strip and drifted
    // off the 1-wide stand during the B window (replay no-gain). Jump now
    // follows support: stood scoops grounded (no drift), hover scoops
    // swimming (mutation: jump always on, stood reads true).
    const mk = (onGround) => {
      const bot = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
      bot.entity.position = pos(1.5, 67, 0.5)
      bot.entity.onGround = onGround
      bot._waters.add(key(1, 67, 0))
      const st = {
        phase: 'strip',
        combo: { B: { below: { x: 1, y: 66, z: 0 } } },
        stripLeft: [{ x: 1, y: 67, z: 0 }],
        stripTries: 0,
        used: false,
      }
      const out = waterup.waterUpRun(bot, { recovery: { st } })
      assert.equal(out, 'running')
      return bot.controls.jump
    }
    assert.equal(mk(true), false)
    assert.equal(mk(false), true)
  })

  it('strip holds station over the stand, silent once stood on it', () => {
    // Drifted a block off the stand mid-strip, the hover taps back toward
    // it (mutation: drop the station hold and drifted reads false); stood
    // on the stand middle it never taps (no ledge-jumps). The deadband
    // value itself is guarded by the fizzle climb (shrink it to 0 and the
    // strip drags the bot off the stand to failed:no-gain there).
    const bot = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
    bot.entity.position = pos(0.5, 65.4, 0.5)
    bot.entity.onGround = false
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'strip',
      combo: { B: { below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }],
      stripTries: 0,
      used: false,
    }
    assert.equal(waterup.waterUpRun(bot, { recovery: { st } }), 'running')
    assert.equal(bot.controls.forward, true)
    const stood = worldBot(shaftWorld(), [{ name: 'bucket', count: 1 }])
    stood.entity.position = pos(1.5, 67, 0.5)
    stood._waters.add(key(1, 67, 0))
    const st2 = {
      phase: 'strip',
      combo: { B: { below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }],
      stripTries: 0,
      used: false,
    }
    assert.equal(waterup.waterUpRun(stood, { recovery: { st: st2 } }), 'running')
    assert.equal(stood.controls.forward, false)
  })

  it('strip withholds the B scoop while the hover is off-stand', () => {
    // B is the support water: scooping it off-stand drops the body past the
    // edge into the shaft (replay no-gain). The hover taps back and waits
    // out the drift (mutation: drop the gate and used reads true, B
    // drains, the stance is lost).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(0.5, 65.4, 0.5) // 1.0 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'strip',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }],
      stripTries: 0, used: false, equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.used, false)
    assert.equal(st.stanceWaited, 1)
    assert.equal(bot._waters.size, 1)
    assert.equal(bot.controls.forward, true) // station tap back
  })

  it('strip fires B once the hover re-centers over the stand', () => {
    // Inside the scoop ring the stance is safe and the scoop fires
    // (mutation: shrink the ring to 0.05 and this withholds).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(1.4, 67, 0.5) // 0.1 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'strip',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }],
      stripTries: 0, used: false, equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.used, true)
    assert.equal(bot._waters.size, 0)
    assert.equal(countOf(items, 'water_bucket'), 1)
  })

  it('strip fires B stood off-stand (grounded bypasses the gate)', () => {
    // A stood body has already landed: the stance risk the gate guards does
    // not exist (mutation: gate the stood body and used reads false).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(0.5, 67, 0.5) // 1.0 off the stand middle
    bot.entity.onGround = true
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'strip',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }],
      stripTries: 0, used: false, equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.used, true)
    assert.equal(bot._waters.size, 0)
  })

  it('strip fires A from anywhere (the gate is B-only)', () => {
    // B is back and the hover sits off-stand: A is not support water, the
    // scoop fires without a stance (mutation: gate every scoop and this
    // withholds to the budget instead of firing).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(0.5, 65.4, 0.5) // 1.0 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(0, 66, 0))
    const st = {
      phase: 'strip',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 0, y: 66, z: 0 }],
      stripTries: 0, used: false, equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.used, true)
    assert.equal(bot._waters.size, 0)
  })

  it('exhausted stance budget fires B best-effort', () => {
    // A stance the current wins is still buckets-first: past the budget the
    // scoop fires anyway, never hangs (mutation: < for <= fires the
    // boundary tick early; drop the budget and the first tick fires).
    const mk = (stanceWaited) => {
      const items = [{ name: 'bucket', count: 1 }]
      const bot = worldBot(shaftWorld(), items)
      bot.entity.position = pos(0.5, 65.4, 0.5) // 1.0 off the stand middle
      bot.entity.onGround = false
      bot.heldItem = items[0]
      bot._waters.add(key(1, 67, 0))
      const st = {
        phase: 'strip',
        combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
        stripLeft: [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }],
        stripTries: 0, used: false, equipDone: true, stanceWaited,
      }
      const out = waterup.waterUpRun(bot, { recovery: { st } })
      assert.equal(out, 'running')
      return st.used
    }
    assert.equal(mk(waterup.STRIP_STANCE_TICKS - 1), false)
    assert.equal(mk(waterup.STRIP_STANCE_TICKS), true)
  })

  it('stripFail scoops B ungated (failure paths stay buckets-first)', () => {
    // The gate needs a live stand stance; a failure-path hover scoops from
    // anywhere (mutation: gate stripFail and this withholds).
    const items = [{ name: 'bucket', count: 1 }]
    const bot = worldBot(shaftWorld(), items)
    bot.entity.position = pos(0.5, 65.4, 0.5) // 1.0 off the stand middle
    bot.entity.onGround = false
    bot.heldItem = items[0]
    bot._waters.add(key(1, 67, 0))
    const st = {
      phase: 'stripFail',
      pendingFail: 'failed:x',
      combo: { B: { dest: { x: 1, y: 67, z: 0 }, below: { x: 1, y: 66, z: 0 } } },
      stripLeft: [{ x: 1, y: 67, z: 0 }, { x: 0, y: 66, z: 0 }],
      stripTries: 0, used: false, equipDone: true,
    }
    const out = waterup.waterUpRun(bot, { recovery: { st } })
    assert.equal(out, 'running')
    assert.equal(st.used, true)
    assert.equal(bot._waters.size, 0)
  })

  it('entry takes the body: drops the follow goal, clears latched keys', () => {
    // Replay shaft: a live follow goal + a latched jump from follow's last
    // parkour press survived into recover and drifted the bot guideward
    // through 8 center taps (failed:no-center). The first tick kills both
    // (mutation: drop the entry clear and the goal/keys survive).
    const bot = worldBot(shaftWorld(), [{ name: 'water_bucket', count: 2 }])
    bot.pathfinder.goal = { x: -59, y: 58, z: -205 }
    bot.controls = { jump: true, forward: true, sprint: true }
    const out = waterup.waterUpRun(bot, { recovery: {} })
    assert.equal(out, 'running')
    assert.equal(bot.pathfinder.goal, null)
    assert.ok(!bot.controls.jump)
    assert.ok(!bot.controls.sprint)
    assert.equal(bot.controls.forward, false)
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
