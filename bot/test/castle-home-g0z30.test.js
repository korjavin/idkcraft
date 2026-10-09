'use strict'

// idkcraft-g0z.30: live in the castle. A complete v2 castle at each of the
// 4 rotations, selected as the residence: dusk gohome walks to the gate's
// outside stance, opens, enters, inside=yes, stay holds; a pack bed lands
// in the bedroom cell (foot/head/facing) and the night sleeps in it; the
// workbench lands on the descriptor's table cell; the castle still reads
// complete after the furniture; a zombie on the apron is no intruder, one
// on the hall floor is; build is infeasible; shelter never runs inside.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const castle = require('../src/castle')
const residence = require('../src/residence')
const goal = require('../src/goal')
const homeMod = require('../src/behaviours/home')
const beds = require('../src/behaviours/beds')
const build = require('../src/behaviours/build')
const equip = require('../src/behaviours/equip')
const castleMod = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const k3 = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]

// A complete castle: every plan cell painted, the door's upper half too;
// terrain below the site floor, air above.
function castleWorld(st) {
  const cells = new Map()
  for (const c of castle.absPlan(st.site, st.rot, 2).cells) {
    cells.set(k3(c.x, c.y, c.z), PAINT[c.kind])
    if (c.kind === 'door') cells.set(k3(c.x, c.y + 1, c.z), 'oak_door')
  }
  const doorOpen = new Map()
  return {
    cells,
    doorOpen,
    name(x, y, z) {
      const k = k3(x, y, z)
      return cells.has(k) ? cells.get(k) : (Math.floor(y) < SITE.y ? 'dirt' : 'air')
    },
    blockAt(p) {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = this.name(x, y, z)
      const b = { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
      if (name.endsWith('_door')) {
        const lower = this.name(x, y - 1, z).endsWith('_door') ? y - 1 : y
        b.getProperties = () => ({ open: doorOpen.get(k3(x, lower, z)) === true, facing: 'east', hinge: 'left' })
        b.lower = k3(x, lower, z)
      }
      return b
    },
  }
}

// A GoalNear ends on the first cell within its range, not on the goal cell:
// the free same-storey cell in range nearest the body (the A* stop).
function arrival(world, from, g) {
  const r = Math.floor(g.rangeSq != null ? Math.sqrt(g.rangeSq) : (g.range || 0))
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      const x = g.x + dx
      const z = g.z + dz
      if (world.name(x, g.y, z) !== 'air' || world.name(x, g.y + 1, z) !== 'air' || world.name(x, g.y - 1, z) === 'air') continue
      const p = new Vec3(x + 0.5, g.y, z + 0.5)
      if (!best || p.distanceTo(from) < best.distanceTo(from)) best = p
    }
  }
  return best || new Vec3(g.x + 0.5, g.y, g.z + 0.5)
}

// A body that walks perfectly: a pathfinder goal teleports onto its cell
// centre, a forward control steps onto the last look point.
function mockBot(world, at, items) {
  const calls = { goals: [], sleeps: [], places: [] }
  const bot = {
    username: 'CastleBot',
    calls,
    entity: { position: new Vec3(at.x, at.y, at.z) },
    time: { timeOfDay: 12500, day: 5 },
    players: {},
    entities: {},
    spawnPoint: new Vec3(0, 64, 0),
    isSleeping: false,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    pathfinder: {
      goal: null,
      movements: { canDig: true, exclusionAreasBreak: [] },
      isMoving: () => false,
      setGoal: (g) => {
        bot.pathfinder.goal = g
        if (!g) return
        calls.goals.push(g)
        if (typeof g.x === 'number') bot.entity.position = arrival(world, bot.entity.position, g)
      },
      stop: () => {},
    },
    lookAt: (p) => { bot.lastLook = p },
    look: async (yaw) => { bot.yaw = yaw },
    setControlState: (n, v) => {
      if (n === 'forward' && v && bot.lastLook) bot.entity.position = new Vec3(bot.lastLook.x, bot.entity.position.y, bot.lastLook.z)
    },
    clearControlStates: () => {},
    activateBlock: async (b) => { world.doorOpen.set(b.lower, !(world.doorOpen.get(b.lower) === true)) },
    equip: async (item) => { bot.held = item.name },
    _placeBlockWithOptions: async (ref, face) => {
      const p = ref.position.offset(face.x, face.y, face.z)
      calls.places.push({ x: p.x, y: p.y, z: p.z, item: bot.held })
      world.cells.set(k3(p.x, p.y, p.z), bot.held)
      if (bot.held.endsWith('_bed')) {
        const f = ((Math.round(-bot.yaw / (Math.PI / 2)) % 4) + 4) % 4
        world.cells.set(k3(p.x + DIRS[f][0], p.y, p.z + DIRS[f][1]), bot.held)
      }
    },
    placeBlock: async (ref, face) => bot._placeBlockWithOptions(ref, face),
    sleep: async (b) => { calls.sleeps.push(b.position); bot.isSleeping = true },
    chat: () => {},
  }
  return bot
}

const settle = async (ms = 0) => { await new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const xyz = (p) => ({ x: p.x, y: p.y, z: p.z })
function feasibleNames(bot, ctx) {
  const facts = goal.goalFacts(bot, ctx)
  return Object.keys(goal.MENU).filter((n) => { try { return !!goal.MENU[n].feasible(facts, bot, ctx) } catch (_) { return false } })
}
function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  return Promise.resolve().then(fn).finally(() => { console.log = orig })
}

describe('g0z.30 live in the castle (4 rotations)', () => {
  assert.equal(residence.RESIDENCE_CASTLE, true, 'the residence flag is on')

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: gohome -> inside -> stay, bed placed and slept in, table, castle still complete`, () => quiet(async () => {
      const st = { site: { ...SITE }, rot, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false }
      const hut = { site: new Vec3(0, 64, 0), interior: null, door: new Vec3(1, 64, 0), table: null, built: true, v: 1 }
      const want = residence.wanted({ home: hut, castle: st })
      assert.equal(want.kind, 'castle', 'a complete v2 castle is selected')
      const home = want
      const world = castleWorld(st)
      const d = residence.of(home)
      const e = d.entrance(home)
      // Dusk, 20 blocks out from the gate, on the castle's approach.
      const [ox, oz] = DIRS[e.facing]
      const items = [{ name: 'white_bed', count: 1 }, { name: 'white_bed', count: 1 }, { name: 'crafting_table', count: 1 }]
      const bot = mockBot(world, { x: e.outside.x + 0.5 + ox * 20, y: e.outside.y, z: e.outside.z + 0.5 + oz * 20 }, items)
      const ctx = { home, castle: st, castleWord: null }

      assert.equal(goal.goalFacts(bot, ctx).inside, 'no')
      let names = feasibleNames(bot, ctx)
      assert.ok(names.includes('gohome'), `dusk outside: gohome feasible (${names})`)
      assert.ok(!names.includes('shelter'), 'no shelter at its own castle')
      assert.ok(!names.includes('build'), 'build is infeasible for a castle residence')

      // gohome: walk to the outside stance, open the gate, step in, shut it.
      for (let i = 0; i < 12 && ctx.stepStatus !== 'done'; i++) {
        homeMod.gohome(bot, ctx)
        await settle()
        if (ctx.gohome) ctx.gohome.lastToggle = 0
      }
      assert.equal(ctx.stepStatus, 'done', `gohome done (phase ${ctx.gohome && ctx.gohome.phase})`)
      assert.deepEqual(xyz(bot.calls.goals[0]), xyz(e.outside), 'walked to the entrance pose')
      assert.equal(world.doorOpen.get(k3(e.door.x, e.door.y, e.door.z)), false, 'gate shut behind')
      assert.equal(goal.goalFacts(bot, ctx).inside, 'yes')
      bot.time.timeOfDay = 18000
      names = feasibleNames(bot, ctx)
      assert.ok(names.includes('stay'), 'stay holds inside')
      assert.ok(!names.includes('gohome') && !names.includes('shelter'), `no gohome/shelter inside (${names})`)

      // Intruders: the apron outside the gate no, the hall floor yes.
      const zombie = (p) => ({ entity: { position: new Vec3(p.x + 0.5, p.y, p.z + 0.5) } })
      assert.equal(homeMod.isInside(zombie(e.outside), home), false)
      assert.equal(homeMod.isInside(zombie(e.inside), home), true)

      // Day: the beds step places the pack bed in bedroom A, facing asserted.
      bot.time.timeOfDay = 6000
      ctx.beds = { phase: 'place' }
      const [a] = d.beds(home)
      for (let i = 0; i < 4 && !home.bedA; i++) {
        beds(bot, ctx)
        await settle(550)
      }
      assert.ok(home.bedA, 'bed A claimed')
      assert.deepEqual(xyz(home.bedA), xyz(a.foot))
      assert.equal(world.name(a.foot.x, a.foot.y, a.foot.z), 'white_bed')
      assert.equal(world.name(a.head.x, a.head.y, a.head.z), 'white_bed', `head at facing ${a.facing}`)
      assert.ok(beds.bedAt(bot, a.foot, a.facing))

      // The workbench on the descriptor's table cell.
      bot.entity.position = new Vec3(e.inside.x + 0.5, e.inside.y, e.inside.z + 0.5)
      ctx.lastGoalKey = ''
      let got = null
      for (let i = 0; i < 4 && !got; i++) got = await equip.tableFor(bot, ctx)
      const t = d.table(home)
      assert.deepEqual(xyz(got.pos), xyz(t))
      assert.deepEqual(xyz(home.table), xyz(t))

      // Night: stay sleeps in the castle bed.
      bot.time.timeOfDay = 18000
      bot.entity.position = new Vec3(e.inside.x + 0.5, e.inside.y, e.inside.z + 0.5)
      ctx.stay = null
      ctx.lastGoalKey = ''
      for (let i = 0; i < 4 && bot.calls.sleeps.length === 0; i++) {
        homeMod.stay(bot, ctx)
        await settle()
      }
      assert.equal(bot.calls.sleeps.length, 1, `slept (stay ${ctx.stay && ctx.stay.phase} ${ctx.stepStatus})`)
      assert.deepEqual(xyz(bot.calls.sleeps[0]), xyz(a.foot))

      // Dawn: wake in the bedroom, walk down to the inside stance (the
      // gate is out of click reach upstairs), out past the outside stance
      // along the gate's own axis (not a z-only read), shut it.
      bot.time.timeOfDay = 1000
      bot.wake = async () => { bot.isSleeping = false }
      homeMod.stay(bot, ctx)
      await settle()
      for (let i = 0; i < 12 && ctx.stepStatus !== 'done'; i++) {
        homeMod.stay(bot, ctx)
        await settle()
        if (ctx.stay) ctx.stay.lastToggle = 0
      }
      assert.equal(ctx.stepStatus, 'done', `stay exit done (phase ${ctx.stay && ctx.stay.phase})`)
      assert.ok(bot.calls.goals.some((g) => g.x === e.inside.x && g.y === e.inside.y && g.z === e.inside.z), 'walked down to the inside stance')
      assert.equal(homeMod.isInside(bot, home), false)
      const bp = bot.entity.position
      assert.ok(Math.hypot(bp.x - (e.outside.x + 0.5), bp.z - (e.outside.z + 0.5)) < 0.01, 'out at the outside stance')
      assert.equal(world.doorOpen.get(k3(e.door.x, e.door.y, e.door.z)), false, 'gate shut behind')

      // The castle still reads complete with the furniture in.
      const prog = castleMod.progressByKind(bot, st)
      const done = Object.values(prog).reduce((n, v) => n + v.done, 0)
      const total = Object.values(prog).reduce((n, v) => n + v.total, 0)
      assert.equal(done, total) // place cells + the moat gauge
      let laid = 0
      for (const c of castle.absPlan(st.site, st.rot, 2).cells) {
        assert.ok(castle.matches(c.kind, world.name(c.x, c.y, c.z)), `plan cell ${c.kind}@${c.x},${c.y},${c.z}`)
        if (castle.isPlaceTarget(c.kind)) laid++
      }
      assert.equal(laid, 1722, 'castle 1722/1722')
      // The roadside table guard covers the castle's own plan: a bedroom
      // doorway (keep-clear) and a wall yes, the storeroom table cell and a
      // hall floor no.
      const rel = (c) => { const r = castle.rotatePlan([{ ...c, kind: 'air' }], rot, 2)[0]; return [SITE.x + r.dx, SITE.y + r.dy, SITE.z + r.dz] }
      assert.equal(build.isPlanCell(home, ...rel({ dx: 13, dy: 4, dz: 14 })), true, 'bedroom doorway')
      assert.equal(build.isPlanCell(home, ...rel({ dx: 7, dy: 0, dz: 13 })), true, 'west wall')
      assert.equal(build.isPlanCell(home, t.x, t.y, t.z), false, 'table cell')
      assert.equal(build.isPlanCell(home, e.inside.x, e.inside.y, e.inside.z), false, 'hall floor')
      // Mid-stair step edge: the feet floor over the open stairwell, still inside.
      const edge = rel({ dx: 10, dy: 4, dz: 12 })
      assert.equal(homeMod.isInside({ entity: { position: new Vec3(edge[0] + 0.5, edge[1], edge[2] + 0.5) } }, home), true)
      // No hut plan at castle coords.
      assert.deepEqual(build.blueprintFor(home), [])
      ctx.stepStatus = 'running'
      build(bot, ctx)
      assert.equal(ctx.stepStatus, 'failed:castle-residence')
    }))
  }
})
