'use strict'

// pit fact: pillar_up/dig_up climb out of a pit with no goal (idkcraft-jsf.3).
// Prod 2026-09-25: backstop episodes (by=no-displacement) fire between walk
// legs with no live goal (goalDist null), and climb prims gated on goalDy>=1
// never reached the menu — a bot with 44 scaffold and a pickaxe gave up in
// a pit. A two-high wall on any side now reads as a pit, and pit + no goal
// climbs. A level goal with a KNOWN dist in a pit still never pillars (4jr:
// the goal sits inside the pit).

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

// 1x1 shaft: solid floor at y=60, solid walls on all 4 sides 61..66, air
// inside. The mouth is at 66: standing there the walls top out beside the
// feet (pit reads false, the climb is over).
function pitWorld() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 60, z))
  }
  for (let y = 61; y <= 66; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  return solids
}

function worldBot(solids, items) {
  const queue = [] // place acks: the slow server resolves every other tick
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
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async placeBlock(ref, face) {
      await new Promise((resolve) => queue.push(() => {
        const d = ref.position.plus(face)
        solids.add(key(d.x, d.y, d.z))
        const dirt = items.find((i) => i.name === 'dirt')
        if (dirt) dirt.count--
        resolve()
      }))
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
    _queue: queue,
  }
  return bot
}

// Harness physics: jump lifts 0.5/tick, gravity settles onto solid ground,
// place acks resolve every other tick.
function harness(bot) {
  const q = bot._queue
  let n = 0
  return () => {
    n++
    if (bot.getControlState('jump')) bot.entity.position.y += 0.5
    if (n % 2 === 0) {
      for (const r of q.splice(0, q.length)) r()
    }
    const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
    if ((!below || below.boundingBox === 'empty') && !bot.getControlState('jump')) {
      bot.entity.position.y = Math.max(60.5, bot.entity.position.y - 0.5)
    }
  }
}

async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function facts(over) {
  return {
    by: 'no-displacement', goalDy: 0, goalDist: null, scaffold: 0, pickaxe: false,
    water: false, headBlocked: false, throughBlocked: false, digStep: null, hopStep: null,
    walls: 3, pit: false, freeSides: [[1, 0]], lavaNear: false,
    playerOnline: false, playerDist: null, playerName: null, stuckTicks: 40,
    resetsStuck: 0, resetsPlaceError: 0, placeError: false, last: 'none', ...over,
  }
}

describe('pit fact (jsf.3)', () => {
  it('two-high walls on 2+ sides read pit; open floor, +1 steps and lone walls do not', () => {
    const shaft = worldBot(pitWorld(), [])
    const f = recover.recoverFacts(shaft, { stuck: { by: 'no-displacement', goal: null } }, null, null)
    assert.equal(f.pit, true, '1x1 shaft is a pit')
    assert.equal(f.goalDist, null, 'goal-less backstop reads dist null')
    assert.equal(f.goalDy, 0)

    const open = worldBot(new Set([key(0, 60, 0)]), [])
    const fo = recover.recoverFacts(open, { stuck: { by: 'no-displacement', goal: null } }, null, null)
    assert.equal(fo.pit, false, 'open floor is not a pit')

    const step = worldBot(new Set([key(0, 60, 0), key(1, 61, 0)]), [])
    const fs = recover.recoverFacts(step, { stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 } } }, null, null)
    assert.equal(fs.pit, false, 'a +1 step (dy0 only) is not a pit')
    assert.equal(fs.walls, 1, 'sanity: the step still counts as a wall')

    // Revmux 01 major: one trunk / house wall / cliff face on open ground
    // is not a pit — the bot must sidestep around it, not pillar dirt
    // against it.
    const trunk = worldBot(new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0)]), [])
    const ft = recover.recoverFacts(trunk, { stuck: { by: 'no-displacement', goal: null } }, null, null)
    assert.equal(ft.pit, false, 'a lone 2-high wall is not a pit')
    assert.equal(ft.walls, 1, 'sanity: the wall still counts once')

    const slot = worldBot(new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0), key(-1, 61, 0), key(-1, 62, 0)]), [])
    const fl = recover.recoverFacts(slot, { stuck: { by: 'no-displacement', goal: null } }, null, null)
    assert.equal(fl.pit, true, 'a 1-wide slot (2 opposing 2-high walls) is a pit')
  })

  it('lone 2-high wall + no goal + scaffold: FSM sidesteps, never pillars', async () => {
    // Stone wall (never hand-diggable): no dig_step either, so the menu is
    // exactly the pre-fix open-ground answer — sidestep, then wait.
    function trunkBot() {
      const bot = worldBot(new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0)]), [{ name: 'dirt', count: 5 }])
      const raw = bot.blockAt.bind(bot)
      bot.blockAt = (p) => {
        const b = raw(p)
        const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
        if (b && (k === key(1, 61, 0) || k === key(1, 62, 0))) return { ...b, name: 'stone' }
        return b
      }
      return bot
    }
    const bot = trunkBot()
    const seen = []
    const ctx = {
      stuck: { by: 'no-displacement', goal: null, key: 'ticker' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return seen[0][0] } },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(seen.length, 1, 'asked once')
    assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
    assert.ok(!seen[0].includes('dig_up'), `menu: ${seen[0]}`)
    assert.equal(r.action, 'sidestep', `open ground shuffles past the wall, got ${r.action}`)
    const r2 = await recover.decide(trunkBot(), { stuck: { by: 'no-displacement', goal: null, key: 'ticker' }, brain: null }, null, null)
    assert.equal(r2.action, 'sidestep', `fsm got ${r2.action}`)
  })
})

describe('pit climb menu (jsf.3 acceptance trio)', () => {
  it('pit + no goal + scaffold: pillar_up feasible and the FSM takes it', () => {
    const f = facts({ pit: true, scaffold: 5, walls: 3 })
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), true)
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(f), true)
    const names = recover.RECOVER_ORDER.filter((n) => {
      try { return recover.RECOVER_MENU[n].feasible(f, {}) } catch (_) { return false }
    })
    assert.ok(names.includes('pillar_up'), `menu: ${names}`)
    assert.equal(recover.recoverFsm(f, names), 'pillar_up')
  })

  it('level goal with a known dist in a pit: no pillar_up (4jr veto stands)', () => {
    // The prod 2026-09-25 shape with a goal INSIDE the pit: climbing to it
    // is pointless, the veto is about the goal, not the walls.
    const f = facts({ goalDy: 0, goalDist: 12, pit: true, scaffold: 44, walls: 3 })
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), false)
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(f), false)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(facts({ goalDy: 0, goalDist: 12, pit: true, pickaxe: true, headBlocked: true })), false)
  })

  it('no pit and no goal: no pillar_up', () => {
    const f = facts({ goalDist: null, pit: false, scaffold: 5, walls: 1 })
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), false)
    assert.equal(recover.RECOVER_MENU.pillar_up.repeatable(f), false)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(facts({ goalDist: null, pit: false, pickaxe: true, headBlocked: true })), false)
  })

  it('dig_up mirrors pillar_up, head still gates (9sq F1)', () => {
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(facts({ pit: true, pickaxe: true, headBlocked: true })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.repeatable(facts({ pit: true, pickaxe: true, headBlocked: true })), true)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(facts({ pit: true, pickaxe: true, headBlocked: false })), false,
      'free headroom means nothing to dig, pit or not')
    const f = facts({ pit: true, pickaxe: true, headBlocked: true })
    const names = recover.RECOVER_ORDER.filter((n) => {
      try { return recover.RECOVER_MENU[n].feasible(f, {}) } catch (_) { return false }
    })
    assert.ok(names.includes('dig_up'), `menu: ${names}`)
    assert.equal(recover.recoverFsm(f, names), 'dig_up', 'no scaffold: the digger is the FSM climber')
  })
})

describe('recoverText carries pit=yes|no (jsf.3)', () => {
  it('the model sees the pit in the facts line', () => {
    assert.match(recover.recoverText(facts({ pit: true })), /pit=yes/)
    assert.match(recover.recoverText(facts({ pit: false })), /pit=no/)
    assert.match(recover.recoverText(facts({ pit: true, goalDist: null })), /dist=none/)
  })
})

describe('goal-less pit escape e2e (jsf.3)', () => {
  it('one goal-less episode chains REPEATS pillar blocks, then releases', async () => {
    // The 2026-09-25 gave-up replayed with the fix: scaffold on hand, no
    // goal, 2-high walls. First choice must be pillar_up (not a shuffle).
    // setStuck fires ONCE: the episode itself must chain the full REPEATS
    // budget on non-falling height alone — the goalDy closer arm would
    // stop it after one repeat (revmux 01 minors: 2 dones, 1 block).
    // Deeper pits need one more re-wedge in prod; the bound, not the
    // stall, paces the escape.
    const kit = [{ name: 'dirt', count: 10 }]
    const bot = worldBot(pitWorld(), kit)
    const ctx = { stuck: { by: 'no-displacement', goal: null, key: 'pit' }, brain: null }
    const step = harness(bot)
    const first = []
    let ticks = 0
    for (; ticks < 200 && (ctx.stuck || ctx.recovery); ticks++) {
      if (!ctx.recovery || ctx.recovery.status !== 'running') {
        await recover.decide(bot, ctx, null, null)
        if (ctx.recovery && ctx.recovery.action && first.length === 0) first.push(ctx.recovery.action)
      } else {
        recover.run(bot, ctx)
        step()
        // Honest jump (lzw): cap the rise at one block above the cycle
        // start floor — jump-held only, so a chain tick never drags a
        // gained height back down — and land falls on solid tops, so the
        // next cycle starts from the placed block instead of mid-air.
        // Real airtime between ticks: the +150 ms pillar timer fires on
        // wall clock, and 200 ticks take 200 s in prod, not 4 ms.
        if (bot.getControlState('jump')) {
          const st = ctx.recovery && ctx.recovery.st
          const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
          if (bot.entity.position.y > capY) bot.entity.position.y = capY
        } else {
          const top = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
          if (top && top.boundingBox !== 'empty') bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
        }
      }
      await flush()
      await sleep(25)
    }
    assert.equal(first[0], 'pillar_up', `first choice, got ${first}`)
    assert.ok(ticks < 200, 'episode ends')
    assert.equal(kit[0].count, 6, `one episode places exactly REPEATS new blocks, dirt left ${kit[0].count}`)
    assert.ok(Math.floor(bot.entity.position.y) >= 64, `chained to the top blocks, y=${bot.entity.position.y}`)
    assert.equal(ctx.stuck, null, 'episode released')
    assert.equal(ctx.recovery, null, 'episode released')
  })

  it('buried head + pickaxe, no goal: FSM digs up', async () => {
    const solids = pitWorld()
    solids.add(key(0, 62, 0))
    solids.add(key(0, 63, 0))
    const bot = worldBot(solids, [{ name: 'iron_pickaxe', count: 1 }])
    const ctx = { stuck: { by: 'no-displacement', goal: null, key: 'pit' }, brain: null }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'dig_up', `got ${r.action}`)
  })

  it('level goal in the same shaft: never pillars (4jr e2e)', async () => {
    const bot = worldBot(pitWorld(), [{ name: 'dirt', count: 5 }])
    const seen = []
    const ctx = {
      stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:P' },
      brain: { source: 'stub', ask: async (q) => { seen.push(Object.keys(q.criteria)); return seen[0][0] } },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(seen.length, 1, 'asked once')
    assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
    assert.ok(!seen[0].includes('dig_up'), `menu: ${seen[0]}`)
    assert.ok(r.action !== 'pillar_up' && r.action !== 'dig_up', `got ${r.action}`)
  })
})
