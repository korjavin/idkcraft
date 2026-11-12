'use strict'

// Castle scale (owner 2026-11-12): `build castle N` grows every outer
// dimension by N percent; floors/flights stay one block. Plain `build
// castle` and every saved castle keep their frozen plan.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bp = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const memory = require('../src/memory')
const { createTicker, handleChat } = require('../src/index')
const { makeGrid, apply, flood, standable } = require('./castle-reach')

function box(plan) {
  const m = (k, f) => f(...plan.map((c) => c[k]))
  return ['dx', 'dy', 'dz'].map((k) => [m(k, Math.min), m(k, Math.max)])
}

function pos(x, y, z) { const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) }; return p }
function makeBot(blockAt) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: { Steve: { username: 'Steve', entity: { position: pos(0.5, 64, 0.5), yaw: Math.PI } } },
    blockAt: blockAt || ((p) => {
      const name = Math.floor(p.y) <= 63 ? 'dirt' : 'air'
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    }),
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}
function order(msg) {
  const bot = makeBot()
  const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
  handleChat(bot, ticker, 'Steve', msg)
  return { bot, ticker, st: bot._tickerCtx.castle }
}

const base = bp.blueprintOf(bp.BLUEPRINT_VERSION)

// The finished castle on the reach grid; every walkable floor (stairs,
// slabs, tower landings, deck) must be reached from the entrance.
function passability(b) {
  const g = makeGrid(b.W, b.D)
  for (const c of b.PLAN) apply(g, c)
  const seen = flood(g, b.ENTRANCE)
  assert.ok(seen, 'entrance standable')
  const { floors: storeys, attic: A, towerLanding: S } = b.LEVELS
  // Stairs, storey slabs, the attic, lofts under the roof, tower landings.
  const roofTop = new Map()
  for (const c of b.PLAN) if (c.kind === 'planks' && c.dy > A) roofTop.set(c.dx + ',' + c.dz, Math.max(roofTop.get(c.dx + ',' + c.dz) || -99, c.dy))
  const floors = b.PLAN.filter((c) => c.kind === 'stairs' || (c.kind === 'planks' && (c.dy <= A || c.dy === S || c.dy < roofTop.get(c.dx + ',' + c.dz))))
  let checked = 0
  const missed = []
  for (const c of floors) {
    if (!standable(g, c.dx, c.dy + 1, c.dz)) continue // under a wall/partition, a well edge
    checked++
    if (!seen[g.at(c.dx, c.dy + 1, c.dz)]) missed.push(c)
  }
  assert.deepEqual(missed.slice(0, 5), [], `${missed.length} unreachable floor cells`)
  const levels = new Set(floors.filter((c) => c.kind === 'planks').map((c) => c.dy))
  for (const F of storeys.slice(1).concat([A + 1])) assert.ok(levels.has(F - 1), `floor level ${F - 1}`)
  assert.ok(levels.has(S), `tower landing ${S}`)
  return checked
}

describe('castle scale: geometry', () => {
  it('plain build castle is unchanged (same plan object)', () => {
    const { bot, st } = order('build castle')
    assert.ok(st, bot.chats.join('|'))
    assert.equal(st.blueprintVersion, bp.BLUEPRINT_VERSION)
    assert.equal(bp.blueprintOf(st.blueprintVersion), base)
    assert.equal(bp.siteTop(st.blueprintVersion), 16)
    assert.equal(bp.apronR(3), bp.CASTLE_APRON)
    assert.equal(bp.nightR(3), bp.NIGHT_BAND)
  })

  for (const [n, f] of [[2, 1.02], [50, 1.5], [100, 2]]) {
    it(`build castle ${n}: every dimension x${f}, every floor walkable`, () => {
      const { bot, st } = order(`build castle ${n}`)
      assert.ok(st, bot.chats.join('|'))
      const s = bp.blueprintOf(st.blueprintVersion)
      assert.equal(s.version, st.blueprintVersion)
      assert.deepEqual([s.W, s.D], [Math.round(31 * f), Math.round(27 * f)])
      const [bx, by, bz] = box(s.PLAN)
      assert.deepEqual(bx, [0, s.W - 1])
      assert.deepEqual(bz, [0, s.D - 1])
      assert.equal(by[1] + 1, Math.round(15 * f), 'tower height (v3: 15)')
      assert.equal(-by[0], Math.round(2 * f), 'moat depth (v3: 2)')
      assert.ok(Math.abs(by[1] - by[0] + 1 - Math.round(17 * f)) <= 1, 'bounding-box height (v3: 17)')
      const X = (i) => Math.round(i * f)
      const body = s.PLAN.filter((c) => c.dx >= X(12) && c.dx < X(19) && c.dz >= X(12) && c.dz < X(15) && c.kind !== 'air' && c.kind !== 'dig')
      assert.equal(Math.max(...body.map((c) => c.dy)) + 1, Math.round(12 * f), 'body height (v3: 12)')
      const tower = s.PLAN.filter((c) => c.dx >= X(7) && c.dx < X(12) && c.dz >= X(7) && c.dz < X(12) && c.kind === 'stone')
      assert.equal(box(tower)[0][1] - box(tower)[0][0] + 1, X(12) - X(7), 'tower width (v3: 5)')
      assert.ok(bp.siteTop(st.blueprintVersion) > by[1], 'site top over the crenellations')
      assert.ok(passability(s) > 50)
      // Doors stay 1x2: one door cell.
      assert.equal(s.PLAN.filter((c) => c.kind === 'door').length, 1)
    })
  }

  it('every N in 1..100 builds a walkable plan', () => {
    for (let n = 1; n <= 100; n++) passability(bp.blueprintOf(bp.scaledVersion(3, n)))
  })

  it('over 100 percent is refused', () => {
    const { bot, st } = order('build castle 101')
    assert.equal(st, undefined)
    assert.match(bot.chats.pop(), /castle scale is 0\.\.100/)
  })
})

describe('castle scale: protection and site checks', () => {
  const v = bp.scaledVersion(3, 100)
  const s = bp.blueprintOf(v)
  const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: v, phase: 'complete' }
  const at = (c) => ({ x: st.site.x + c.dx, y: st.site.y + c.dy, z: st.site.z + c.dz })

  it('protects the top crenellation, the outer fence ring and its second row', () => {
    const top = s.PLAN.filter((c) => c.kind === 'stone').reduce((a, c) => (c.dy > a.dy ? c : a))
    assert.ok(top.dy >= 29)
    assert.equal(bp.protects(st, at(top), 'cobblestone'), true)
    const corner = { dx: s.W - 1, dy: 0, dz: s.D - 1 }
    assert.equal(bp.protects(st, at(corner), 'oak_fence'), true)
    assert.equal(bp.protects(st, at({ ...corner, dy: 1 }), 'oak_fence'), true, 'decor fence row 2')
    assert.equal(bp.protects(st, at({ dx: s.W, dy: 0, dz: 0 }), 'oak_fence'), false, 'outside the site')
  })

  it('yard, night band, apron and fetch box reach the scaled top', () => {
    const y = st.site.y + 30
    const inside = { x: st.site.x + 5, y, z: st.site.z + 5 }
    assert.equal(bp.yardRing(st, inside), true)
    assert.equal(bp.onSite(st, inside), true)
    assert.equal(bp.apronOf(st, { x: st.site.x - 30, y: st.site.y, z: st.site.z }), true, 'apron 32 at x2')
    assert.equal(bp.nightBand(st, { x: st.site.x - 10, y: st.site.y, z: st.site.z }), true, 'band 12 at x2')
    const plain = { ...st, blueprintVersion: 3 }
    assert.equal(bp.yardRing(plain, inside), false)
    assert.equal(bp.apronOf(plain, { x: st.site.x - 30, y: st.site.y, z: st.site.z }), false)
  })

  it('the site check reads the full scaled footprint and height', () => {
    // A foreign block at dy 25 over the far corner: above the unscaled
    // top, inside the scaled footprint and height.
    const site = { x: 0, y: 64, z: 0 }
    const odd = { x: s.W - 2, y: 64 + 25, z: s.D - 2 }
    const bot = makeBot((p) => {
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
      const name = x === odd.x && y === odd.y && z === odd.z ? 'oak_planks' : (y <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    })
    assert.equal(castleMod.siteCheck(bot, site, 0, 3), null, 'v3 box is smaller and lower')
    assert.match(String(castleMod.siteCheck(bot, site, 0, v)), /oak_planks|built|house/)
  })
})

describe('castle scale: storage compatibility', () => {
  const v = bp.scaledVersion(3, 100)

  it('memory save/restore keeps the scaled version and a plain one', () => {
    for (const ver of [3, v, 2]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-scale-'))
      const file = path.join(dir, 'IdkBot.json')
      const bot = makeBot()
      const castle = { site: { x: 1, y: 64, z: 2 }, rot: 1, blueprintVersion: ver, phase: 'body', blocked: { [`${ver}:5`]: { tries: 1, until: 0 } }, parked: false }
      assert.ok(memory.save(bot, { castle }, file, 1e12))
      const ctx = {}
      memory.restore(bot, ctx, file, 1e12)
      assert.equal(ctx.castle.blueprintVersion, ver)
      assert.deepEqual(Object.keys(ctx.castle.blocked), [`${ver}:5`], 'blocked keys keep their version prefix')
    }
  })

  it('a peer bot reads a complete scaled castle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-scale-peer-'))
    const bot = makeBot()
    bot.username = 'IdkBotV2'
    const castle = { site: { x: 1, y: 64, z: 2 }, rot: 0, blueprintVersion: v, phase: 'complete', blocked: {}, parked: false }
    fs.writeFileSync(path.join(dir, 'IdkBot.json'), JSON.stringify({ v: 1, world: memory.worldKey(bot), castle }))
    const ctx = {}
    memory.refreshKnownCastles(bot, ctx, 4e12, { BOT_MEMORY_FILE: path.join(dir, 'IdkBotV2.json'), BOT_CASTLE_PEER: 'IdkBot' })
    assert.ok(ctx.peerCastle)
    assert.equal(ctx.peerCastle.blueprintVersion, v)
    assert.equal(bp.siteDimensions(0, ctx.peerCastle.blueprintVersion).w, 62)
  })

  it('castle upgrade refuses a scaled castle; counters count the scaled plan', () => {
    const { bot, ticker, st } = order('build castle 100')
    st.phase = 'complete'
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.match(bot.chats.pop(), /already on the latest blueprint/)
    assert.equal(st.blueprintVersion, v)
    const sum = (o) => Object.values(o).reduce((a, e) => a + e.total, 0)
    const scaled = sum(castleMod.progressByKind(bot, st))
    const plain = sum(castleMod.progressByKind(bot, { ...st, blueprintVersion: 3 }))
    assert.ok(scaled > plain * 3, `${scaled} vs ${plain}`)
  })

  it('saved castles keep their plan: plain versions are unscaled', () => {
    assert.equal(bp.blueprintOf(3), base)
    assert.equal(bp.blueprintOf(2).W, 31)
    assert.equal(bp.blueprintOf(undefined).version, 1)
    assert.equal(bp.scaleOf(3), 1)
    assert.equal(bp.blueprintOf(5002).version, 1, 'only v3 scales; others read v1 as before')
  })
})

describe('castle scale: build order', () => {
  const { checkPlan } = require('./castle-reach')
  for (const n of [2, 50, 100]) {
    it(`build castle ${n}: every step of the lay order has a reachable stance and a visible reference face`, () => {
      const b = bp.blueprintOf(bp.scaledVersion(3, n))
      const r = checkPlan(b, bp.isPlaceTarget)
      assert.ok(r.ok, JSON.stringify({ idx: r.idx, cell: r.cell, reason: r.reason }))
      assert.equal(r.checked, b.PLAN.filter((c) => bp.isPlaceTarget(c.kind)).length)
    })
  }

  // A fake world the executor's arbiter (peek) reads; lay() writes a cell.
  const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', stairs: 'oak_stairs', fence: 'oak_fence', torch: 'torch', door: 'oak_door', chest: 'chest' }
  function world() {
    const w = new Map()
    const bot = makeBot((p) => {
      const e = w.get(`${p.x},${p.y},${p.z}`)
      const name = e ? e.name : (p.y <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => (e && e.props) || {} }
    })
    bot.inventory = { items: () => [{ name: 'torch', count: 64, type: 1 }] }
    const lay = (c) => w.set(`${c.x},${c.y},${c.z}`, { name: c.kind === 'dig' ? 'air' : NAME[c.kind], props: c.face ? { facing: bp.faceName(c.face), half: 'bottom' } : null })
    return { bot, lay }
  }
  const next = (bot, st, ctx) => { const r = castleMod.peek(bot, st, 1e12, ctx); return r.cell && r.cell.idx }

  for (const n of [2, 100]) {
    it(`build castle ${n}: a mid-build save reloads and continues on the same cells`, () => {
      const v = bp.scaledVersion(3, n)
      const { bot, lay } = world()
      const st = { site: { x: 0, y: 64, z: 0 }, rot: 2, blueprintVersion: v, phase: 'body', blocked: {}, parked: false }
      const cells = bp.absPlan(st.site, st.rot, v).cells
      const ctx = {}
      for (let i = 0; i < 400; i++) lay(cells[next(bot, st, ctx)])
      // A hole in backoff: the arbiter skips it, before and after the restart.
      const hole = next(bot, st, ctx)
      st.blocked[`${v}:${hole}`] = { tries: 2, until: 1e12 + 60000 }
      const before = next(bot, st, ctx)
      assert.notEqual(before, hole)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-scale-resume-'))
      const file = path.join(dir, 'IdkBot.json')
      assert.ok(memory.save(bot, { castle: st }, file, 1e12))
      const ctx2 = {}
      memory.restore(bot, ctx2, file, 1e12)
      const st2 = ctx2.castle
      assert.equal(st2.blueprintVersion, v)
      assert.equal(st2.phase, 'body')
      assert.equal(st2.rot, 2)
      assert.ok(st2.blocked[`${v}:${hole}`], 'the hole survives the restart')
      assert.equal(next(bot, st2, {}), before, 'same next cell after the restart')
      // Both continue identically; the progress count matches too.
      for (let i = 0; i < 200; i++) {
        const a = next(bot, st, ctx)
        assert.equal(next(bot, st2, ctx2), a, `step ${i}`)
        lay(cells[a])
      }
      const sum = (o) => Object.values(o).reduce((s, e) => s + e.done, 0)
      assert.equal(sum(castleMod.progressByKind(bot, st2)), sum(castleMod.progressByKind(bot, st)))
      assert.ok(sum(castleMod.progressByKind(bot, st2)) >= 600)
    })
  }
})

describe('castle scale: review 01 (ids, residence)', () => {
  const residence = require('../src/residence')

  it('litter band ids stay below the fill ids, fills below decor, at every N', () => {
    assert.equal(castleMod.fillBase({ blueprintVersion: 3 }), castleMod.FILL_BASE, 'unscaled ids unchanged')
    for (const n of [0, 50, 66, 100]) {
      const v = bp.scaledVersion(3, n)
      const st = { site: { x: 0, y: 64, z: 0 }, rot: 1, blueprintVersion: v }
      const { w, d } = bp.siteDimensions(st.rot, v)
      const R = bp.apronR(v)
      const bandMax = castleMod.litterCell(st, d, w - 1 + R, 64 + bp.siteTop(v), d - 1 + R).idx
      const fb = castleMod.fillBase(st)
      assert.ok(bandMax < fb, `N=${n}: band ${bandMax} < fill ${fb}`)
      assert.ok(fb + (w + 2) * (d + 2) * 4 < bp.DECOR_BASE, `N=${n}: fills below decor`)
      assert.equal(castleMod.bandOf(st, fb), null, 'a fill id never decodes as band litter')
      const corner = castleMod.bandOf(st, bandMax)
      assert.deepEqual([corner.x, corner.y, corner.z], [w - 1 + R, 64 + bp.siteTop(v), d - 1 + R])
    }
  })

  it('a complete scaled castle is not the residence (own or peer); an unscaled one is', () => {
    const complete = (v) => ({ site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: v, phase: 'complete', blocked: {}, parked: false })
    const scaled = complete(bp.scaledVersion(3, 100))
    assert.equal(residence.wanted({ home: null, castle: scaled }), undefined, 'scaled: home unchanged, not adopted')
    assert.equal(residence.nightHome({ home: null, castle: scaled }, { x: 5, y: 64, z: 5 }), null)
    assert.equal(residence.nightHome({ home: null, castle: null, peerCastle: scaled }, { x: 5, y: 64, z: 5 }), null, 'peer scaled castle')
    const plain = complete(3)
    assert.equal(residence.wanted({ home: null, castle: plain }).kind, 'castle')
    assert.equal(residence.nightHome({ home: null, castle: plain }, { x: 5, y: 64, z: 5 }).kind, 'castle')
  })
})
