'use strict'

// Bedroom follow-ups (idkcraft-4nx + idkcraft-jrp + idkcraft-ybt): rig jr2.2
// fallout — a roadside table on B-foot blocked bed placement, a stale
// placedByBot entry licensed a recover dig to pop a bedroom bed, and a home
// replacement dropped sleptA until the next sleep.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const beds = require('../src/behaviours/beds')
const equip = require('../src/behaviours/equip')
const stockpile = require('../src/behaviours/stockpile')
const { canBreak, denyReason } = require('../src/behaviours/util')
const memory = require('../src/memory')
const { createTicker } = require('../src/index')

// Rig m4 geometry: site (6,64,0), A-foot (7,64,4), A-head (8,64,4),
// B-foot (10,64,4), B-head (11,64,4).
const SITE = { x: 6, y: 64, z: 0 }
const A_FOOT = { x: 7, y: 64, z: 4 }
const A_HEAD = { x: 8, y: 64, z: 4 }
const B_FOOT = { x: 10, y: 64, z: 4 }
const B_HEAD = { x: 11, y: 64, z: 4 }

function v2home(over = {}) {
  return { site: { ...SITE }, built: true, v: 2, ...over }
}

function key(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
}

// Fake world: map key -> name, everything else air, solid dirt below y=64.
function worldBot(cells, at) {
  const world = new Map(Object.entries(cells || {}))
  return {
    world,
    entity: { position: new Vec3(at.x, at.y, at.z), onGround: true },
    blockAt: (p) => {
      const k = key(p.x, p.y, p.z)
      if (world.has(k)) {
        const n = world.get(k)
        return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
      }
      if (Math.floor(p.y) < 64) {
        return { name: 'dirt', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
      }
      return { name: 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
  }
}

describe('idkcraft-4nx: furniture avoids bedroom cells', () => {
  it('isBedroomCell pins the four bed cells of cellsOf', () => {
    const home = v2home()
    const cells = beds.cellsOf(home)
    assert.deepEqual({ x: cells.a.foot.x, y: cells.a.foot.y, z: cells.a.foot.z }, A_FOOT)
    assert.deepEqual({ x: cells.a.head.x, y: cells.a.head.y, z: cells.a.head.z }, A_HEAD)
    assert.deepEqual({ x: cells.b.foot.x, y: cells.b.foot.y, z: cells.b.foot.z }, B_FOOT)
    assert.deepEqual({ x: cells.b.head.x, y: cells.b.head.y, z: cells.b.head.z }, B_HEAD)
    for (const c of [A_FOOT, A_HEAD, B_FOOT, B_HEAD]) {
      assert.equal(beds.isBedroomCell(home, c.x, c.y, c.z), true, `${c.x},${c.y},${c.z}`)
    }
    // Neighbours, other heights, and the doorway are not bedroom cells.
    for (const c of [{ x: 9, y: 64, z: 4 }, { x: 7, y: 64, z: 3 }, { x: 7, y: 65, z: 4 },
      { x: 9, y: 64, z: 0 }, { x: 11, y: 64, z: 2 }]) {
      assert.equal(beds.isBedroomCell(home, c.x, c.y, c.z), false, `${c.x},${c.y},${c.z}`)
    }
    assert.equal(beds.isBedroomCell({ site: { ...SITE }, v: 1 }, A_FOOT.x, A_FOOT.y, A_FOOT.z), false, 'v1: no bedrooms')
    assert.equal(beds.isBedroomCell(null, A_FOOT.x, A_FOOT.y, A_FOOT.z), false, 'no home')
  })

  it('roadside table skips bedroom cells beside the body', async () => {
    // Bot between the bedrooms at (9,64,4): scan order hits B-foot (10,4)
    // first, then A-head (8,4) — both must be skipped for (9,64,5).
    const bot = worldBot({}, { x: 9, y: 64, z: 4 })
    bot.inventory = { items: () => [{ name: 'crafting_table', count: 1 }] }
    bot.pathfinder = { setGoal: () => {} }
    const placed = []
    bot.equip = async () => {}
    bot.placeBlock = async (ref, face) => {
      placed.push({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z })
      bot.world.set(key(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z), 'crafting_table')
    }
    const ctx = { home: v2home() }
    const t = await equip.tableFor(bot, ctx)
    assert.ok(t, 'table placed')
    assert.deepEqual({ x: t.pos.x, y: t.pos.y, z: t.pos.z }, { x: 9, y: 64, z: 5 })
    for (const c of [A_FOOT, A_HEAD, B_FOOT, B_HEAD]) {
      assert.notDeepEqual({ x: t.pos.x, y: t.pos.y, z: t.pos.z }, c, 'never on a bed cell')
    }
  })

  it('chest spots never cover a bedroom cell', () => {
    const home = v2home()
    for (const s of stockpile.spotsFor(home)) {
      assert.equal(beds.isBedroomCell(home, SITE.x + s.dx, SITE.y + s.dy, SITE.z + s.dz), false,
        `spot (${s.dx},${s.dy},${s.dz})`)
    }
    // And the live scan still opens on the first indoor spot.
    const bot = worldBot({}, { x: 0, y: 65, z: 0 })
    const spot = stockpile.chestSpotFor(bot, { home })
    assert.deepEqual({ x: spot.x, y: spot.y, z: spot.z }, { x: SITE.x + 5, y: SITE.y, z: SITE.z + 2 })
  })
})

describe('idkcraft-jrp: beds are never dug, even stale-placed', () => {
  function blk(name, x, y, z) {
    return { name, position: new Vec3(x, y, z) }
  }

  it('denyReason refuses *_bed over a stale placedByBot entry', () => {
    const bot = worldBot({}, { x: 0, y: 65, z: 0 })
    // The rig story: a table sat on B-foot (tracked), the owner cleared it,
    // the bed landed in the same cell — the stale entry must not license a dig.
    const ctx = { placedByBot: new Set([`${B_FOOT.x},${B_FOOT.y},${B_FOOT.z}`, '0,63,0']) }
    const bed = blk('white_bed', B_FOOT.x, B_FOOT.y, B_FOOT.z)
    assert.equal(denyReason(bot, bed, ctx), 'protected')
    assert.equal(canBreak(bot, bed, ctx), false)
    assert.equal(denyReason(bot, blk('red_bed', 3, 64, 3), { placedByBot: new Set(['3,64,3']) }), 'protected')
    // Untracked beds stay refused by default deny, and the exemption still
    // holds for real terrain (own-session pillars ladder through it).
    assert.equal(denyReason(bot, blk('white_bed', 5, 64, 5), {}), 'protected')
    assert.equal(denyReason(bot, blk('dirt', 0, 63, 0), ctx), null, 'tracked dirt still digs')
    assert.equal(denyReason(bot, blk('cobblestone', 1, 63, 1), { placedByBot: new Set(['1,63,1']) }), null, 'tracked cobble still ladders')
  })
})

describe('idkcraft-ybt: bed claims survive replacement and restart', () => {
  it('migrateClaims carries beds across a same-site swap, drops on a move', () => {
    const oldHome = v2home({ bedA: new Vec3(A_FOOT.x, A_FOOT.y, A_FOOT.z), bedB: new Vec3(B_FOOT.x, B_FOOT.y, B_FOOT.z), sleptA: true })
    const same = beds.migrateClaims(oldHome, v2home())
    assert.deepEqual({ x: same.bedA.x, y: same.bedA.y, z: same.bedA.z }, A_FOOT)
    assert.deepEqual({ x: same.bedB.x, y: same.bedB.y, z: same.bedB.z }, B_FOOT)
    assert.equal(same.sleptA, true)
    const moved = beds.migrateClaims(oldHome, { site: { x: 100, y: 64, z: 100 }, v: 2 })
    assert.ok(!('bedA' in moved) && !('bedB' in moved) && !('sleptA' in moved), 'new site: new bedrooms')
    // Never clobbers claims the new home already carries.
    const keep = v2home({ bedA: new Vec3(1, 2, 3) })
    beds.migrateClaims(oldHome, keep)
    assert.deepEqual({ x: keep.bedA.x, y: keep.bedA.y, z: keep.bedA.z }, { x: 1, y: 2, z: 3 })
    assert.equal(beds.migrateClaims(null, v2home()).sleptA, undefined, 'from-null: nothing rides')
  })

  it('setHome migrates same-site claims and drops them on a move', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ybt-'))
    const prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = path.join(dir, 'bot.json')
    try {
      const bot = { username: 'IdkBot', players: {}, entity: { position: new Vec3(0, 65, 0) }, chat: () => {} }
      const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
      ticker.setHome(v2home({ bedA: new Vec3(A_FOOT.x, A_FOOT.y, A_FOOT.z), sleptA: true }))
      assert.equal(ticker.home().sleptA, true)
      ticker.setHome(v2home()) // fresh adopt object, same site
      assert.deepEqual({ x: ticker.home().bedA.x, y: ticker.home().bedA.y, z: ticker.home().bedA.z }, A_FOOT)
      assert.equal(ticker.home().sleptA, true)
      ticker.setHome({ site: { x: 100, y: 64, z: 100 }, v: 2 }) // 'build here' elsewhere
      assert.ok(!ticker.home().sleptA && !ticker.home().bedA, 'moved: claims dropped')
    } finally {
      if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
      else process.env.BOT_MEMORY_FILE = prevEnv
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
    }
  })

  it('disk memory round-trips bed claims across a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ybt-'))
    const file = path.join(dir, 'bot.json')
    const prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
    try {
      const spawn = { x: 0, y: 64, z: 0 }
      const bot = { username: 'MemBot', spawnPoint: { ...spawn } }
      const now = Date.now()
      const ctx1 = { home: v2home({ bedA: new Vec3(A_FOOT.x, A_FOOT.y, A_FOOT.z), bedB: new Vec3(B_FOOT.x, B_FOOT.y, B_FOOT.z), sleptA: true }) }
      assert.equal(memory.save(bot, ctx1, file, now), true)
      const ctx2 = {}
      const back = memory.restore(bot, ctx2, file, now)
      assert.ok(back && back.homes > 0, 'home restored')
      assert.deepEqual({ x: ctx2.home.bedA.x, y: ctx2.home.bedA.y, z: ctx2.home.bedA.z }, A_FOOT)
      assert.deepEqual({ x: ctx2.home.bedB.x, y: ctx2.home.bedB.y, z: ctx2.home.bedB.z }, B_FOOT)
      assert.equal(ctx2.home.sleptA, true)
      assert.equal(typeof ctx2.home.bedA.floored, 'function', 'bedA revives as Vec3')
      // Old docs without the keys restore clean (additive, like gear).
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const h of legacy.homes) { delete h.bedA; delete h.bedB; delete h.sleptA }
      fs.writeFileSync(file, JSON.stringify(legacy))
      const ctx3 = {}
      assert.ok(memory.restore(bot, ctx3, file, now), 'legacy doc restores')
      assert.ok(!ctx3.home.sleptA && !ctx3.home.bedA, 'legacy: no claims, no crash')
    } finally {
      if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
      else process.env.BOT_MEMORY_FILE = prevEnv
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
    }
  })
})
