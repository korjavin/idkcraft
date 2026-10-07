'use strict'

// idkcraft-vmzq.31: castle quarry second ring + night-shelter scaffold floor.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')
const castleMod = require('../src/behaviours/castle')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot({ items = [], set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4), under = (y) => (y <= 63 ? 'dirt' : 'air') } = {}) {
  const calls = { goals: [], dig: [] }
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    return set.has(k) ? set.get(k) : under(Math.floor(p.y))
  }
  return {
    username: 'IdkBot',
    calls,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { stone: { id: 1 }, chest: { id: 2 } },
      itemsByName: { cobblestone: {}, dirt: {}, stone: {}, torch: {} },
    },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: ({ matching }) => {
      const out = []
      for (const [k, n] of set) {
        if ((matching === 1 && n !== 'stone') || (matching === 2 && n !== 'chest')) continue
        const [x, y, z] = k.split(',').map(Number)
        out.push(pos(x, y, z))
      }
      return out
    },
    equip: async () => {},
    dig: async (b) => {
      calls.dig.push(b.position)
      set.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air')
    },
    pathfinder: { isMoving: () => false, setGoal(g) { calls.goals.push(g) }, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

const TOOLS = () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }]

function quiet(fn) {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  try { fn() } finally { console.log = orig }
  return lines
}

describe('quarry second ring (vmzq.31)', () => {
  it('ring 1 works each edge from its opposite lateral end, disjoint lanes', () => {
    for (const v of [1, 2]) {
      const st = castleState({ blueprintVersion: v })
      for (let s = 0; s < 4; s++) {
        const a = fetch.quarrySide(st, s, 0)
        const b = fetch.quarrySide(st, s, 1)
        assert.deepEqual([b.dx, b.dz, b.lx, b.lz], [a.dx, a.dz, a.lx, a.lz], `v${v} side ${s} keeps axes`)
        // Same outward line, shifted along the width axis past the lanes.
        assert.equal((b.x - a.x) * a.dx + (b.z - a.z) * a.dz + 0, 0, `v${v} side ${s} not shifted outward`)
        const lat = Math.abs((b.x - a.x) * a.lx + (b.z - a.z) * a.lz)
        assert.ok(lat >= 2, `v${v} side ${s} lanes disjoint (lateral ${lat})`)
      }
    }
    assert.equal(fetch.QUARRY_RINGS, 2)
  })

  it('ring 0 stays first: a live inner side leaves ring 1 unprobed', () => {
    const o = fetch.quarrySide(castleState(), 0, 0)
    const bot = makeBot({ items: TOOLS() })
    const ctx = { castle: castleState() }
    const lines = quiet(() => fetch(bot, ctx))
    const t = ctx.castleFetch.target
    assert.ok(t && t.quarry, 'quarrying')
    assert.deepEqual([t.x, t.y, t.z], [o.x, 63, o.z], 'first cell is ring-0 side-0 ground')
    assert.deepEqual(ctx.castleFetch.quarry.dead, [])
    assert.equal(ctx.castle.quarryBase.length, 8, 'latch grows to 8 on first probe')
    assert.deepEqual(ctx.castle.quarryBase.slice(4), [null, null, null, null], 'ring 1 untouched')
    assert.ok(!lines.some((m) => m.includes('ring 1')), 'ring 1 stays silent')
  })

  it('ring 1 takes over when all ring-0 sides are wet; frames latch at 4..7', () => {
    const st = castleState()
    const set = new Map()
    for (let s = 0; s < 4; s++) { // drown every ring-0 origin column in the probe band
      const o = fetch.quarrySide(st, s, 0)
      for (let y = SITE.y - fetch.QUARRY_ADAPT; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
    }
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: st }
    const lines = quiet(() => fetch(bot, ctx))
    const o1 = fetch.quarrySide(st, 0, 1)
    const t = ctx.castleFetch.target
    assert.ok(t && t.quarry, 'quarrying on ring 1')
    assert.deepEqual([t.x, t.y, t.z], [o1.x, 63, o1.z], 'first cell is ring-1 side-0 ground')
    assert.deepEqual(ctx.castleFetch.quarry.dead.slice().sort(), [0, 1, 2, 3], 'ring 0 all dead')
    assert.equal(ctx.castleFetch.quarry.level[4], 64, 'ring-1 frame latches at index 4')
    assert.equal(ctx.castle.quarryBase[4], 64, 'persisted latch carries ring 1')
    assert.ok(lines.some((m) => m.includes('quarry side 0 ring 1 live')), `ring-1 live line, got: ${lines.join(' | ')}`)
  })

  it('a latched ring-1 side never re-probes across legs', () => {
    const st = castleState()
    const set = new Map()
    for (let s = 0; s < 4; s++) {
      const o = fetch.quarrySide(st, s, 0)
      for (let y = SITE.y - fetch.QUARRY_ADAPT; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
    }
    st.quarryBase = [null, null, null, null, 64, null, null, null]
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: st }
    const lines = quiet(() => {
      fetch(bot, ctx)
      assert.equal(ctx.castleFetch.quarry.level[4], 64, 'leg 1 reuses the latch')
      ctx.castleFetch = null
      fetch(bot, ctx)
      assert.equal(ctx.castleFetch.quarry.level[4], 64, 'leg 2 reuses the latch')
    })
    assert.ok(!lines.some((m) => m.includes('ring 1 live')), 'latched ring-1 reuse logs nothing')
  })

  it('all eight sides dead ends the leg with no-stone', () => {
    const st = castleState()
    const set = new Map()
    for (let ring = 0; ring < 2; ring++) {
      for (let s = 0; s < 4; s++) {
        const o = fetch.quarrySide(st, s, ring)
        for (let y = SITE.y - fetch.QUARRY_ADAPT; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
      }
    }
    const bot = makeBot({ items: TOOLS(), set })
    const ctx = { castle: st }
    quiet(() => fetch(bot, ctx))
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
    assert.equal(ctx.castle.quarryBase, undefined, 'dead sides stay unlatched')
  })
})

describe('castle night-shelter dirt floor (vmzq.31)', () => {
  const pack = (dirt, cobble, extra = []) => [
    ...(dirt > 0 ? [{ name: 'dirt', count: dirt }] : []),
    ...(cobble > 0 ? [{ name: 'cobblestone', count: cobble }] : []),
    ...extra,
  ]
  const botWith = (items) => makeBot({ items })

  it('dirtOnHand counts dirt only; the floor is 8', () => {
    assert.equal(castleMod.dirtOnHand(botWith(pack(5, 30, [{ name: 'stone', count: 20 }]))), 5)
    assert.equal(castleMod.SHELTER_RESERVE, 8)
  })

  it('fillItem keeps dirt above the floor and refuses at it, whatever the cobble', () => {
    const ok = castleMod.fillItem(botWith(pack(9, 0)))
    assert.ok(ok && ok.name === 'dirt', '9 dirt spends one')
    assert.equal(castleMod.fillItem(botWith(pack(8, 0))), null, '8 dirt is the floor')
    // Revmux 01 core-1: cobble at the stone reserve must not read as dirt
    // savings — the dirt would drain to zero and unlock cobble walking.
    assert.equal(castleMod.fillItem(botWith(pack(8, 16))), null, '8 dirt + 16 cobble still refuses')
    assert.equal(castleMod.fillItem(botWith(pack(5, 3))), null, '5 dirt refuses with any cobble')
    const mixed = castleMod.fillItem(botWith(pack(9, 16)))
    assert.ok(mixed && mixed.name === 'dirt', '9 dirt + 16 cobble spends one dirt')
  })

  it('fillItem still lays smelted stone at the floor (not pillar fuel)', () => {
    const it = castleMod.fillItem(botWith(pack(2, 0, [{ name: 'stone', count: 30 }])))
    assert.ok(it && it.name === 'stone', 'smelted stone above the reserve lays on')
  })

  it('the castle stops laying stone at 24 (revmux 02 core-1 walk buffer)', () => {
    assert.equal(castleMod.reserveOf('stone'), 24)
    assert.equal(castleMod.usable(botWith(pack(0, 24)), 'stone'), 0, '24 lays nothing')
    assert.equal(castleMod.findItem(botWith(pack(0, 24)), 'stone'), null, 'no item at the buffer')
    assert.ok(castleMod.findItem(botWith(pack(0, 25)), 'stone'), '25 lays one')
  })

  it('prep fill with only floor dirt reads stone-none, routing to castlefetch', () => {
    // Prep phase, one fill owed (a hole at the footprint corner): at the
    // floor the word is the material word (fetch more), never 'clear'.
    const set = new Map([[`${SITE.x},63,${SITE.z}`, 'air']])
    const gated = castleMod.menuFact(makeBot({ items: pack(8, 0), set }), { castle: castleState({ phase: 'prep' }) })
    assert.equal(gated, 'stone-none', `gated pack fetches, got ${gated}`)
    const open = castleMod.menuFact(makeBot({ items: pack(9, 0), set: new Map(set) }), { castle: castleState({ phase: 'prep' }) })
    assert.equal(open, 'clear', `funded pack works now, got ${open}`)
  })
})
