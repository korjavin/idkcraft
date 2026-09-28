'use strict'

// Bead idkcraft-jr2.1: the 7x6 house — common room-kitchen plus two bedrooms.
// Adopt tells v2 houses from old v1 huts, the door phases walk the new door,
// and table/chest/furnace/torch all target the common room.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')
const homeMod = require('../src/behaviours/home')
const light = require('../src/behaviours/light')
const stockpile = require('../src/behaviours/stockpile')
const furnace = require('../src/behaviours/furnace')
const memory = require('../src/memory')

const BLUEPRINT_V2 = build.BLUEPRINT_V2

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

function paintPlan(world, site, plan) {
  for (const cell of plan) {
    const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
    world.set(site.x + cell.dx, site.y + cell.dy, site.z + cell.dz, name)
  }
}

function mockBot(world, { items = [], doors = [], spawn = pos(0, 64, 0) } = {}) {
  const chats = []
  const calls = { goals: [], places: [], digs: [], equips: [] }
  const bot = {
    chats,
    calls,
    spawnPoint: spawn,
    entity: { position: pos(0, 65, 0) },
    world: { getBlock: () => null },
    players: {},
    time: { timeOfDay: 6000, day: 5 },
    held: null,
    inventory: { items: () => items },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => doors,
    pathfinder: {
      isMoving: () => false,
      setGoal: (g) => { calls.goals.push(g) },
    },
    equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      calls.places.push([ref, face])
      const rp = (ref && ref.position) || ref
      world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
    },
    chat: (m) => { chats.push(String(m)) },
  }
  return bot
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('jr2.1 phases lay in order: table, shell, roof, partition', () => {
  it('plan indexes rise table < ring0 < door < ring1 < roof < partition', () => {
    const door = BLUEPRINT_V2.findIndex((c) => c.kind === 'door')
    assert.equal(door, 22)
    const ring0 = BLUEPRINT_V2.slice(1, 22)
    assert.equal(ring0.length, 21)
    assert.ok(ring0.every((c) => c.kind === 'planks' && c.dy === 0))
    const ring1 = BLUEPRINT_V2.slice(23, 44)
    assert.equal(ring1.length, 21)
    assert.ok(ring1.every((c) => c.kind === 'planks' && c.dy === 1))
    const roof = BLUEPRINT_V2.slice(44, 86)
    assert.equal(roof.length, 42)
    assert.ok(roof.every((c) => c.kind === 'planks' && c.dy === 2))
    const part = BLUEPRINT_V2.slice(86)
    assert.deepEqual(part.map((c) => [c.dx, c.dy, c.dz]), [
      [1, 0, 3], [3, 0, 3], [5, 0, 3], [3, 0, 4],
      [1, 1, 3], [3, 1, 3], [5, 1, 3], [3, 1, 4],
    ])
  })

  it('rooms stay plan-free: path, openings and bedrooms hold no cells', () => {
    const room = (c) => {
      if (c.dy > 1) return false
      if (c.dx === 3 && c.dz === 0) return true // doorway column (door kind, not planks)
      if (c.dx >= 1 && c.dx <= 5 && c.dz >= 1 && c.dz <= 2) return true // common room
      if ((c.dx === 2 || c.dx === 4) && c.dz === 3) return true // openings
      if (c.dz === 4 && ((c.dx >= 1 && c.dx <= 2) || (c.dx >= 4 && c.dx <= 5))) return true // bedrooms
      return false
    }
    for (const cell of BLUEPRINT_V2) {
      if (cell.kind === 'planks') assert.ok(!room(cell), `planks in the room at ${cell.dx},${cell.dy},${cell.dz}`)
    }
    const door = BLUEPRINT_V2.find((c) => c.kind === 'door')
    assert.deepEqual([door.dx, door.dz], [3, 0])
    const table = BLUEPRINT_V2[0]
    assert.deepEqual([table.dx, table.dz], [5, 1], 'table inside the common room')
  })
})

describe('jr2.1 adopt tells the v2 house from the v1 hut', () => {
  it('adopts a full v2 house: origin door-(3,0,0), built, table claimed inside', () => {
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    paintPlan(world, site, BLUEPRINT_V2)
    const bot = mockBot(world, { doors: [{ x: 13, y: 64, z: 10 }] })
    const home = goal.adoptHome(bot)
    assert.deepEqual(home.site, site)
    assert.equal(home.v, 2)
    assert.equal(home.built, true)
    assert.deepEqual(home.door, { x: 13, y: 64, z: 10 })
    assert.deepEqual({ x: home.table.x, y: home.table.y, z: home.table.z }, { x: 15, y: 64, z: 11 })
    assert.deepEqual(bot.chats, ['my home is at 10 64 10'])
  })

  it('a lone v1 hut still adopts v1: origin door-(1,0,0)', () => {
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    paintPlan(world, site, build.BLUEPRINT)
    const bot = mockBot(world, { doors: [{ x: 11, y: 64, z: 10 }] })
    const home = goal.adoptHome(bot)
    assert.deepEqual(home.site, site)
    assert.equal(home.v, 1)
    assert.equal(home.built, true)
    assert.deepEqual({ x: home.table.x, y: home.table.y, z: home.table.z }, { x: 14, y: 64, z: 11 })
  })

  it('a mid-build v2 (ring0 + door, no roof) adopts v2 unbuilt', () => {
    // Restart with the disk memory also gone: the corner columns still read
    // v2, the missing roof reads unbuilt, build resumes the plan.
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    const isPost = (c) => c.kind === 'planks' && ((c.dz === 3 && (c.dx === 1 || c.dx === 3 || c.dx === 5)) || (c.dx === 3 && c.dz === 4))
    for (const cell of BLUEPRINT_V2) {
      if (cell.dy === 2 || cell.dy === 1) continue
      if (isPost(cell)) continue
      const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
      world.set(site.x + cell.dx, site.y + cell.dy, site.z + cell.dz, name)
    }
    const bot = mockBot(world, { doors: [{ x: 13, y: 64, z: 10 }] })
    const home = goal.adoptHome(bot)
    assert.ok(home)
    assert.equal(home.v, 2)
    assert.equal(home.built, false)
    assert.equal(build.nextCellIdx(bot, home, []), BLUEPRINT_V2.findIndex((c) => c.kind === 'planks' && c.dy === 1))
  })

  it('dark probe cells abort the adopt instead of misreading the version', () => {
    // A v2 house read as v1 would aim the door phases at a wall: when the
    // corner columns are unreadable (null blockAt, dark chunk) adoptHome
    // returns null and the callers retry once chunks stream in.
    const world = makeWorld()
    const site = { x: 10, y: 64, z: 10 }
    paintPlan(world, site, BLUEPRINT_V2)
    const bot = mockBot(world, { doors: [{ x: 13, y: 64, z: 10 }] })
    const seen = bot.blockAt
    bot.blockAt = (p) => {
      if (Math.floor(p.x) === 10 && Math.floor(p.z) === 10) return null // front-west corner dark
      return seen(p)
    }
    assert.equal(goal.adoptHome(bot), null)
  })
})

describe('jr2.1 v2 door phases walk the new door', () => {
  const SITE = { x: 10, y: 64, z: 20 }
  const DOOR = { x: 13, y: 64, z: 20 }
  const OUTSIDE = { x: 13, y: 64, z: 19 }
  const INSIDE = { x: 13, y: 64, z: 21 }
  function doorBot({ at, doorOpen = false }) {
    const chats = []
    const calls = { goals: [], activates: 0, looks: [], controls: [], clears: 0 }
    const state = { doorOpen }
    const bot = {
      chats,
      calls,
      entity: { position: { x: at.x, y: at.y, z: at.z } },
      time: { timeOfDay: 14000, day: 5 },
      pathfinder: {
        goal: null,
        movements: { canDig: true },
        isMoving: () => false,
        setGoal: (g) => { calls.goals.push(g); bot.pathfinder.goal = g },
        stop: () => {},
      },
      inventory: { items: () => [] },
      blockAt: (p) => {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        if (fx === DOOR.x && (fy === DOOR.y || fy === DOOR.y + 1) && fz === DOOR.z) {
          return { name: 'oak_door', position: { x: fx, y: fy, z: fz }, getProperties: () => ({ open: state.doorOpen }) }
        }
        return { name: 'air', boundingBox: 'empty', position: { x: fx, y: fy, z: fz } }
      },
      activateBlock: async () => { calls.activates++; state.doorOpen = !state.doorOpen },
      chat: (m) => { chats.push(String(m)) },
      lookAt: (p) => { calls.looks.push({ x: p.x, y: p.y, z: p.z }) },
      setControlState: (name, val) => { calls.controls.push([name, val]) },
      clearControlStates: () => { calls.clears++ },
    }
    return bot
  }
  function v2home() {
    return {
      site: { ...SITE },
      built: true,
      v: 2,
      interior: { min: { x: 11, y: 64, z: 21 }, max: { x: 15, y: 65, z: 24 } },
    }
  }

  it('gohome aims the v2 outside cell and closes the night inside', async () => {
    const bot = doorBot({ at: { x: 20, y: 64, z: 14 } })
    const ctx = { home: v2home() }
    homeMod.gohome(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    const g = bot.calls.goals[0]
    assert.deepEqual({ x: g.x, y: g.y, z: g.z }, OUTSIDE)
    bot.entity.position = { ...OUTSIDE }
    homeMod.gohome(bot, ctx) // arrived -> open
    await settle()
    assert.equal(bot.calls.activates, 1)
    homeMod.gohome(bot, ctx) // door open -> enter by direct control
    assert.equal(ctx.gohome.phase, 'enter')
    bot.entity.position = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z + 0.5 }
    ctx.gohome.lastToggle = 0
    homeMod.gohome(bot, ctx) // inside -> close
    await settle()
    assert.equal(bot.calls.activates, 2)
    homeMod.gohome(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, true)
    assert.ok(bot.chats.includes('home for the night'))
  })

  it('stay holds anywhere inside: common room and both bedrooms', () => {
    for (const at of [{ x: 12, y: 64, z: 21 }, { x: 11, y: 64, z: 24 }, { x: 14, y: 64, z: 24 }]) {
      const bot = doorBot({ at })
      const ctx = { home: v2home() }
      homeMod.stay(bot, ctx)
      assert.equal(ctx.stepStatus, 'running', `holds at ${at.x},${at.z}`)
      assert.equal(ctx.inShelter, true)
    }
  })

  it('stay outside fails not-inside on a v2 home too', () => {
    const bot = doorBot({ at: { ...OUTSIDE } })
    const ctx = { home: v2home() }
    homeMod.stay(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:not-inside')
  })
})

describe('jr2.1 stations target the common room', () => {
  it('build claims the indoor table the tick it stands', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'oak_planks', count: 40 }] })
    const ctx = { home: goal.siteFor(bot, pos(0, 64, 0)), step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    assert.equal(ctx.home.v, 2)
    const s = ctx.home.site
    world.set(s.x + 5, s.y, s.z + 1, 'crafting_table')
    bot.entity.position = pos(s.x + 5, s.y, s.z + 2)
    build(bot, ctx, null, null) // claims the table, approaches the ring
    assert.deepEqual({ x: ctx.home.table.x, y: ctx.home.table.y, z: ctx.home.table.z }, { x: s.x + 5, y: s.y, z: s.z + 1 })
  })

  it('chest adopts and places at (5,0,2), never on the path or approaches', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const ctx = { home }
    const s = home.site
    assert.deepEqual(stockpile.spotsFor(home)[0], { dx: 5, dy: 0, dz: 2 })
    for (const spot of stockpile.spotsFor(home)) {
      assert.ok(!(spot.dx === 3 && (spot.dz === 1 || spot.dz === 2)), 'off the door path')
      assert.ok(!((spot.dx === 2 || spot.dx === 4) && spot.dz === 2), 'off the bedroom approaches')
    }
    const empty = stockpile.chestSpotFor(bot, ctx)
    assert.deepEqual({ x: empty.x, y: empty.y, z: empty.z, adopt: empty.adopt }, { x: s.x + 5, y: s.y, z: s.z + 2, adopt: false })
    world.set(s.x + 5, s.y, s.z + 2, 'chest')
    assert.equal(stockpile.chestTodo(bot, ctx, 0), 'adopt')
    const sight = stockpile.chestSpotFor(bot, ctx)
    assert.equal(sight.adopt, true)
  })

  it('v1 homes keep the outdoor chest spots', () => {
    const home = { site: { x: 6, y: 64, z: 0 }, v: 1 }
    assert.deepEqual(stockpile.spotsFor(home)[0], { dx: 5, dy: 0, dz: 1 })
    assert.deepEqual(stockpile.spotsFor(null)[0], { dx: 5, dy: 0, dz: 1 })
  })

  it('furnace adopts a standing indoor furnace without needing items', () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [] }) // empty hands: no spare gets crafted
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const ctx = { home, furnace: { phase: 'ensure', walkTicks: 0 } }
    const s = home.site
    world.set(s.x + 4, s.y, s.z + 1, 'furnace')
    furnace(bot, ctx, null, {})
    assert.deepEqual(ctx.home.furnace, { x: s.x + 4, y: s.y, z: s.z + 1 })
  })

  it('furnace places at (4,0,1) from outside through the wall', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'furnace', count: 1 }] })
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const ctx = { home, furnace: { phase: 'place', walkTicks: 0 }, lastGoalKey: '' }
    const s = home.site
    bot.entity.position = pos(s.x + 7, s.y, s.z + 1) // outside the east wall, in reach
    furnace(bot, ctx, null, {})
    await settle()
    assert.deepEqual(ctx.home.furnace, { x: s.x + 4, y: s.y, z: s.z + 1 })
    assert.equal(world.get(s.x + 4, s.y, s.z + 1), 'furnace')
  })

  it('v1 homes keep the roadside furnace', async () => {
    const world = makeWorld()
    const bot = mockBot(world, { items: [{ name: 'furnace', count: 1 }] })
    const home = { site: { x: 6, y: 64, z: 0 }, v: 1 }
    const ctx = { home, furnace: { phase: 'place', walkTicks: 0 }, lastGoalKey: '' }
    bot.entity.position = pos(30, 64, 30) // far from home: roadside, beside the body
    furnace(bot, ctx, null, {})
    await settle()
    assert.ok(ctx.home.furnace, 'placed')
    assert.ok(Math.abs(ctx.home.furnace.x - 30) <= 1 && Math.abs(ctx.home.furnace.z - 30) <= 1, 'beside the body')
  })
})

describe('jr2.1 v2 torches ring the shell and light the common room', () => {
  it('door-front first, roof and interior staged from the doorway', () => {
    const spots = light.spotsFor({ v: 2 })
    assert.equal(spots.length, 10)
    assert.deepEqual({ dx: spots[0].dx, dz: spots[0].dz }, { dx: 3, dz: -2 })
    const roof = spots.find((sp) => sp.dy === 3)
    assert.deepEqual([roof.dx, roof.dz], [3, 1])
    assert.deepEqual(roof.stage, { dx: 3, dz: -1 })
    const inner = spots.filter((sp) => !sp.dy && sp.stage)
    assert.equal(inner.length, 1)
    assert.deepEqual([inner[0].dx, inner[0].dz], [1, 1])
    assert.deepEqual(inner[0].stage, { dx: 3, dz: -1 })
  })

  it('v1 homes keep the frozen ring', () => {
    assert.equal(light.spotsFor({ v: 1 }).length, 10)
    assert.deepEqual(light.spotsFor(null)[0], { dx: 1, dz: -2 })
  })

  it('spotSkipped guards the v2 path, stations and furnace', () => {
    const home = { site: { x: 0, y: 64, z: 0 }, v: 2, table: { x: 5, y: 64, z: 1 }, chest: { x: 5, y: 64, z: 2 }, furnace: { x: 4, y: 64, z: 1 } }
    assert.equal(light.spotSkipped(home, { dx: 3, dz: 0 }), true, 'doorway')
    assert.equal(light.spotSkipped(home, { dx: 3, dz: -1 }), true, 'walk column')
    assert.equal(light.spotSkipped(home, { dx: 3, dz: 1 }), true, 'door path')
    assert.equal(light.spotSkipped(home, { dx: 5, dz: 1 }), true, 'table')
    assert.equal(light.spotSkipped(home, { dx: 5, dz: 2 }), true, 'chest')
    assert.equal(light.spotSkipped(home, { dx: 4, dz: 1 }), true, 'furnace')
    assert.equal(light.spotSkipped(home, { dx: 1, dz: 1 }), false, 'common torch cell stays')
    assert.equal(light.spotSkipped(home, { dx: 3, dy: 3, dz: 1 }), false, 'roof spot above the path stays')
  })

  it('countUnlit scans the v2 plan: 10 dark, 0 lit', () => {
    const world = makeWorld()
    const bot = mockBot(world)
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.equal(light.countUnlit(bot, home, []), 10)
    for (const sp of light.spotsFor(home)) {
      world.set(home.site.x + sp.dx, home.site.y + (sp.dy || 0), home.site.z + sp.dz, 'torch')
    }
    assert.equal(light.countUnlit(bot, home, []), 0)
  })
})

describe('jr2.1 memory keeps the house version', () => {
  let dir = null
  let file = null
  let prevEnv = null
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr2-'))
    file = path.join(dir, 'bot.json')
    prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
    else process.env.BOT_MEMORY_FILE = prevEnv
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
  })

  it('round-trips v2 with its rooms', () => {
    const bot = { username: 'Jr2Bot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const ctx = { home: goal.siteFor({ blockAt: () => null, spawnPoint: bot.spawnPoint }, { x: 0, y: 64, z: 0 }) }
    ctx.home.built = true
    assert.equal(memory.save(bot, ctx), true)
    const ctx2 = {}
    const restored = memory.restore(bot, ctx2)
    assert.ok(restored && restored.homes === 1)
    assert.equal(ctx2.home.v, 2)
    assert.equal(ctx2.home.built, true)
    assert.deepEqual({ x: ctx2.home.door.x, z: ctx2.home.door.z }, { x: ctx.home.site.x + 3, z: ctx.home.site.z })
  })

  it('a version-less file restores as v1 (pre-patch prod homes)', () => {
    const bot = { username: 'Jr2Bot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const ctx = { home: goal.siteFor({ blockAt: () => null, spawnPoint: bot.spawnPoint }, { x: 0, y: 64, z: 0 }) }
    assert.equal(memory.save(bot, ctx), true)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const h of raw.homes) delete h.v
    fs.writeFileSync(file, JSON.stringify(raw))
    const ctx2 = {}
    const restored = memory.restore(bot, ctx2)
    assert.ok(restored && restored.homes === 1)
    assert.equal(ctx2.home.v, 1)
  })
})
