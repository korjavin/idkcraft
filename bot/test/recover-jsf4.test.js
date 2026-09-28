'use strict'

// dig_step ladders stone pits with a pickaxe and mounts through the shared
// hop leap (idkcraft-jsf.4). Prod 2026-09-28: CLUSTER pit walls are
// andesite/granite/diorite/stone, but dig_step only dug HAND_DIG by hand —
// with a pick in hand no stone staircase was ever offered, and the
// mount-only step (above/cap already air, chosen 272x) jumped from wall
// contact, which Paper rejects (failed:no-progress, 123 gave-ups). Now
// PICK_DIG stone digs with a pick on hand, and the mount is hop_step's
// pressed→back-off→standstill-leap through the shared mountStep helper.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

function worldBot(solids, items, names) {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      const n = solidCell ? ((names && names.get(k)) || 'dirt') : 'air'
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async dig(block) {
      await Promise.resolve()
      solids.delete(key(block.position.x, block.position.y, block.position.z))
    },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
  }
  return bot
}

async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

// One stone wall east of the body: step + above + cap, named by the caller.
function wallSolids() {
  return new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0), key(1, 63, 0)])
}

function wallNames(above, cap) {
  return new Map([[key(1, 61, 0), 'andesite'], [key(1, 62, 0), above], [key(1, 63, 0), cap]])
}

describe('pickaxe ladder menu (jsf.4)', () => {
  const pick = [{ name: 'iron_pickaxe', count: 1 }]

  it('pickaxe + andesite above/cap: dig_step in the menu, FSM climbs it', async () => {
    // Removing the pickaxe branch from diggable fails this (menu loses the
    // only climber and the FSM falls to sidestep).
    const bot = worldBot(wallSolids(), pick, wallNames('andesite', 'granite'))
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null, // FSM reserve picks
    }
    const facts = recover.recoverFacts(bot, ctx, null, null)
    assert.deepEqual(facts.digStep, [1, 0], 'stone staircase offered with a pick')
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'dig_step', `FSM climbs, got ${r.action}`)
  })

  it('same stone wall, no pickaxe: dig_step stays out of the menu', async () => {
    const bot = worldBot(wallSolids(), [], wallNames('andesite', 'granite'))
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {}
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null,
    }
    const facts = recover.recoverFacts(bot, ctx, null, null)
    assert.equal(facts.digStep, null, 'stone staircase hidden bare-handed')
    const r = await recover.decide(bot, ctx, null, null)
    assert.notEqual(r.action, 'dig_step', `got ${r.action}`)
  })

  it('every PICK_DIG stone ladders with a pick; ores never do', () => {
    // Pins the bead's set: dropping a member hides that staircase; ores
    // stay forage's (a coal_ore above re-scans even with a pick).
    const stones = ['stone', 'andesite', 'granite', 'diorite', 'cobblestone',
      'deepslate', 'tuff', 'calcite', 'sandstone', 'dripstone_block']
    // Cap truly absent (air), only above varies.
    const openSolids = new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0)])
    for (const n of stones) {
      const bot = worldBot(openSolids, pick, new Map([[key(1, 61, 0), 'andesite'], [key(1, 62, 0), n]]))
      bot.entity.position = pos(0.5, 61, 0.5)
      const facts = recover.recoverFacts(bot, { stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 } } }, null, null)
      assert.deepEqual(facts.digStep, [1, 0], `${n} digs with a pick`)
    }
    for (const n of ['coal_ore', 'iron_ore', 'diamond_ore']) {
      const bot = worldBot(openSolids, pick, new Map([[key(1, 61, 0), 'andesite'], [key(1, 62, 0), n]]))
      bot.entity.position = pos(0.5, 61, 0.5)
      const facts = recover.recoverFacts(bot, { stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 } } }, null, null)
      assert.equal(facts.digStep, null, `${n} is not a staircase`)
    }
  })

  it('ore above a preset side re-scans instead of digging', () => {
    const bot = worldBot(wallSolids(), pick, wallNames('coal_ore', 'air'))
    bot.entity.position = pos(0.5, 61, 0.5)
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      recovery: {
        action: 'dig_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.dir, null, 'ore side dropped, never dug')
  })
})

describe('pickaxe dig equips the tool (jsf.4)', () => {
  it('digs andesite above then cap with the pickaxe equipped', async () => {
    // Bare-handed stone takes ~7.5 s instead of ~1 s (revmux 01 body-1 on
    // pillar_up): digStepRun equips digTool before bot.dig, like dig_up.
    // Deleting the equip fails this (equips stays empty).
    const kit = [{ name: 'iron_pickaxe', count: 1 }]
    const bot = worldBot(wallSolids(), kit, wallNames('andesite', 'diorite'))
    bot.entity.position = pos(0.5, 61, 0.5)
    const equips = []
    const dug = []
    bot.pathfinder.bestHarvestTool = () => kit[0]
    bot.equip = async (item) => { equips.push(item.name) }
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(key(b.position.x, b.position.y, b.position.z)); return rawDig(b) }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      recovery: {
        action: 'dig_step', source: 'fsm', model: null, status: 'running',
        st: { dir: [1, 0], phase: 'dig', waited: 0, digInFlight: false, digError: false, startFloor: 61 },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    await flush()
    assert.deepEqual(dug, [key(1, 62, 0), key(1, 63, 0)], 'above first, then the mount head')
    assert.deepEqual(equips, ['iron_pickaxe', 'iron_pickaxe'], 'pick equipped for both stone digs')
  })
})

describe('shared mount leap (jsf.4)', () => {
  // The dig_step mount IS the hop_step leap (one mountStep helper): these
  // mirror the hop wqt pins tick for tick — breaking the helper's pressed
  // branch fails the hop tests AND these.
  function mountBot() {
    const bot = worldBot(new Set([key(0, 60, 0), key(1, 61, 0)]), [{ name: 'iron_pickaxe', count: 1 }])
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 61, 0)) {
        return { ...b, name: 'andesite' }
      }
      return b
    }
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    return bot
  }
  function mountCtx(stepPos) {
    return {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      recovery: {
        action: 'dig_step', source: 'fsm', model: null, status: 'running',
        st: {
          dir: [1, 0], stepPos, phase: 'step', waited: 0,
          digInFlight: false, digError: false, startFloor: 61,
          leapt: false, armed: false, stall: 0, settled: false,
        },
        attempts: 1, fails: 0, repeats: 0, last: null,
        calledPlayer: false, endEpisode: false, lastDy: null,
      },
    }
  }

  it('pressed dig mount backs to leap stance instead of leaping (wqt mirror)', () => {
    const bot = mountBot()
    bot.entity.position = pos(0.7, 61, 0.5) // pressed: 0.8 off the anchor
    const ctx = mountCtx({ x: 1, y: 61, z: 0 })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(!bot.getControlState('jump'), 'no leap into the face')
    assert.ok(bot.getControlState('back'), 'short back-off held')
    assert.equal(ctx.recovery.st.armed, true, 'standstill leap armed')
    assert.equal(bot.pathfinder.goal, null, 'no executor goal during the mount')
  })

  it('dig mount leaps from leap stance, never from a run-up', () => {
    const bot = mountBot()
    const ctx = mountCtx({ x: 1, y: 61, z: 0 })
    bot.entity.position = pos(-1.5, 61, 0.5) // open floor, 3m out
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.getControlState('forward'), 'walking to the edge')
    assert.ok(!bot.getControlState('jump'), 'no run-up leap from 3m out')
    bot.entity.position = pos(0.9, 61, 0.5) // pressed
    recover.run(bot, ctx)
    assert.ok(bot.getControlState('back'), 'backs instead of leaping pressed')
    assert.equal(ctx.recovery.st.armed, true, 'standstill leap armed')
    bot.entity.position = pos(0.4, 61, 0.5) // backed to stance
    recover.run(bot, ctx)
    assert.ok(bot.getControlState('forward'), 'leap drives forward')
    assert.ok(bot.getControlState('jump'), 'standstill leap fires')
    assert.equal(ctx.recovery.st.armed, false, 'leap consumes the arm')
    assert.equal(bot.pathfinder.goal, null, 'still no executor goal')
  })

  it('rising mid-leap keeps the anchor: no collapse, no re-dig', () => {
    // The relative step cell reads the dug above-cell once risen — the
    // mount validates the absolute anchor instead, and never digs mid-arc.
    const bot = mountBot()
    bot.entity.position = pos(1.0, 62.0, 0.5) // risen mid-arc, airborne
    bot.entity.onGround = false
    const dug = []
    const rawDig = bot.dig.bind(bot)
    bot.dig = async (b) => { dug.push(b.name); return rawDig(b) }
    const ctx = mountCtx({ x: 1, y: 61, z: 0 })
    ctx.recovery.st.leapt = true
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'mid-arc is neither done nor collapsed')
    assert.deepEqual(ctx.recovery.st.dir, [1, 0], 'side held through the arc')
    assert.deepEqual(dug, [], 'nothing dug mid-arc')
  })
})

describe('stone pit ladder e2e (jsf.4)', () => {
  // The 9sh dirt climb replayed in andesite with a pickaxe: menu offers the
  // stone staircase, the pick digs it, the leap mounts it — out in chained
  // cycles, never paged.
  function stonePit() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    solids.delete(key(0, 64, 1)) // the 9sh notch: headroom over the second step
    return solids
  }

  it('andesite pit + pickaxe: dig_step first, ladders out itself', async () => {
    const solids = stonePit()
    const names = new Map()
    for (const k of solids) {
      if (k !== key(0, 60, 0)) names.set(k, 'andesite')
    }
    const bot = worldBot(solids, [{ name: 'stone_pickaxe', count: 1 }], names)
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = {} // autonomous: call_player infeasible, self-exit only
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' },
      brain: null, // FSM reserve picks
    }
    const first = []
    const stepBody = () => {
      const bp = bot.entity.position
      const yaw = bot._yaw || 0
      if (bot.getControlState('forward')) {
        bot.entity.position = pos(bp.x - Math.sin(yaw) * 0.4, bp.y, bp.z - Math.cos(yaw) * 0.4)
      } else if (bot.getControlState('back')) {
        bot.entity.position = pos(bp.x + Math.sin(yaw) * 0.4, bp.y, bp.z + Math.cos(yaw) * 0.4)
      }
      const st = ctx.recovery && ctx.recovery.st
      const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      const jumping = bot.getControlState('jump')
      if (jumping && bot.entity.onGround && bot.entity.position.y < capY) bot.entity.position.y += 1.0
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if (below && below.boundingBox !== 'empty') {
        bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
        bot.entity.onGround = true
      } else if (!jumping || !bot.entity.onGround) {
        bot.entity.position.y -= 0.5
        bot.entity.onGround = false
        const land = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
        if (land && land.boundingBox !== 'empty') {
          bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
          bot.entity.onGround = true
        }
      } else {
        bot.entity.onGround = false
      }
    }
    for (let t = 0; t < 200 && (ctx.stuck || ctx.recovery); t++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
        if (ctx.recovery && ctx.recovery.action && first.length === 0) first.push(ctx.recovery.action)
      } else {
        recover.run(bot, ctx)
        stepBody()
      }
      await flush()
    }
    assert.equal(first[0], 'dig_step', `first choice, got ${first}`)
    assert.ok(Math.floor(bot.entity.position.y) >= 65, `laddered out, y=${bot.entity.position.y}`)
    assert.equal(ctx.stuck, null, 'episode over')
    assert.deepEqual(bot.chats.filter((m) => m.startsWith("I'm stuck at")), [], 'no call_player needed')
  })
})
