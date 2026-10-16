'use strict'

// Bead idkcraft-vmzq.20: castle<->castlefetch ping-pong livelock — prod
// flipped every 10-40 s for 30 min (62 flips, 0 laid, stone ~55 short)
// because a started fetch never handed over: the 80-cobble target ran
// past every batch while the castle starved. Fix: a fetch leg that reached
// a layable batch yields after LEG_MAX_MS ('done', never failed — no hold
// parks the re-pick), so the castle lays the partial; below a batch the
// leg keeps fetching. The running-leg exemptions pin the rest: a
// some<->batch word flap never preempts either leg.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')
const LEG_MAX_MS = fetch.LEG_MAX_MS
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone: () => pos(x, y, z),
    floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)),
  }
  return p
}

function setCount(items, name, n) {
  const it = items.find((i) => i.name === name)
  if (n <= 0) {
    const i = items.findIndex((o) => o.name === name)
    if (i >= 0) items.splice(i, 1)
  } else if (it) it.count = n
  else items.push({ name, count: n })
}

function makeBot({ items = [], at = pos(SITE.x - 4, 64, SITE.z - 4), timeOfDay = 6000 } = {}) {
  return {
    chats: [],
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    health: 20,
    food: 20,
    registry: {
      blocksByName: { stone: { id: 1 }, chest: { id: 2 } },
      itemsByName: { oak_planks: {}, birch_planks: {}, oak_log: {}, oak_fence: {}, oak_door: {}, torch: {}, cobblestone: {}, stick: {} },
    },
    blockAt: (p) => {
      const fy = Math.floor(p.y)
      const name = fy <= 63 ? 'dirt' : 'air'
      return { name, position: pos(Math.floor(p.x), fy, Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
    world: { getBlock: () => null },
    chat(m) { this.chats.push(String(m)) },
  }
}

function castleState() {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
}

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

// Minimal tableFor double: below layer from a map (name + optional
// boundingBox), y=64 reads air unless a placement landed there.
function tableBot({ below = {}, placeImpl }) {
  const calls = { place: [] }
  let placed = null
  const bot = {
    calls,
    entity: { position: pos(0, 64, 0) },
    inventory: { items: () => [{ name: 'crafting_table', count: 2 }] },
    blockAt: (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (placed && x === placed.x && y === placed.y && z === placed.z) {
        return { name: 'crafting_table', position: pos(x, y, z), boundingBox: 'block' }
      }
      if (y === 64) return { name: 'air', position: pos(x, y, z), boundingBox: 'empty' }
      if (y === 63) {
        const b = below[`${x},${z}`] || { name: 'dirt' }
        return { name: b.name, position: pos(x, y, z), boundingBox: b.boundingBox }
      }
      return { name: 'air', position: pos(x, y, z), boundingBox: 'empty' }
    },
    equip: async () => {},
    placeBlock: async (ref, face) => placeImpl(calls, (at) => { placed = at }, ref, face),
  }
  return bot
}

describe('vmzq.20 batch yield: a leg with a batch hands over, below it keeps fetching', () => {
  it('expired leg with a batch yields done (the castle lays the partial next)', async () => {
    await quiet(async () => {
      const items = [{ name: 'cobblestone', count: 40 }, { name: 'stone_pickaxe', count: 1 }]
      const bot = makeBot({ items })
      const ctx = { castle: castleState(), work: true, step: 'castlefetch', stepStatus: 'running', castleFetch: { kind: 'stone', t0: Date.now() - LEG_MAX_MS - 1, skips: 0 } }
      assert.equal(castleMod.menuFact(bot, ctx), 'stone-batch')
      fetch(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(ctx.castleFetch, null)
    })
  })

  it('fresh leg with a batch keeps fetching (commitment, no instant handover)', async () => {
    await quiet(async () => {
      const items = [{ name: 'cobblestone', count: 40 }, { name: 'stone_pickaxe', count: 1 }]
      const bot = makeBot({ items })
      const ctx = { castle: castleState(), work: true, step: 'castlefetch', stepStatus: 'running', castleFetch: { kind: 'stone', t0: Date.now(), skips: 0 } }
      fetch(bot, ctx)
      assert.equal(ctx.stepStatus, 'running')
    })
  })

  it('expired leg below a batch keeps fetching (yielding would flip straight back)', async () => {
    await quiet(async () => {
      for (const cobble of [20, 0]) {
        const items = cobble > 0 ? [{ name: 'cobblestone', count: cobble }] : []
        items.push({ name: 'stone_pickaxe', count: 1 })
        const bot = makeBot({ items })
        const ctx = { castle: castleState(), work: true, step: 'castlefetch', stepStatus: 'running', castleFetch: { kind: 'stone', t0: Date.now() - LEG_MAX_MS - 1, skips: 0 } }
        assert.match(castleMod.menuFact(bot, ctx), /^stone-(some|none)$/)
        fetch(bot, ctx)
        assert.equal(ctx.stepStatus, 'running', `cobble=${cobble} must keep fetching`)
      }
    })
  })
})

// (revmux 01: the goal-only flap test lived here. It exercised goal.js,
// which this branch never changes, so it passed on master and proved
// nothing about the batch yield. The handover test below pins the new
// mechanism (expired batch leg yields done); the prod 10–40 s word flap
// needs the gated-cell repro, which is follow-up scope.)
describe('vmzq.20 bounded switching: one handover cycle switches exactly twice', () => {
  it('one handover cycle: fetch yields once, castle lays, fetch resumes — exactly two switches', async () => {
    await quiet(async () => {
      const items = [
        { name: 'cobblestone', count: 20 },
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
      ]
      const bot = makeBot({ items })
      const ctx = {
        castle: castleState(), work: true, step: 'castlefetch', stepStatus: 'running',
        castleFetch: { kind: 'stone', t0: Date.now() - LEG_MAX_MS - 1, skips: 0 },
      }
      let switches = 0
      const decide = async () => {
        const before = ctx.step
        const action = (await goal.decide(bot, ctx)).action
        if (action !== before) switches++
        return action
      }
      assert.equal(await decide(), 'castlefetch', 'some: fetching')
      setCount(items, 'cobblestone', 40) // batch reached mid-leg
      assert.equal(await decide(), 'castlefetch', 'batch: the running leg is not preempted')
      fetch(bot, ctx) // the leg notices its expired clock and yields
      assert.equal(ctx.stepStatus, 'done', 'expired batch leg yields')
      assert.equal(await decide(), 'castle', 'switch 1: the castle lays the partial')
      assert.match(bot.chats.join('\n'), /building the castle/, 'the handover is announced')
      setCount(items, 'cobblestone', 16) // the castle drained the batch (reserve only)
      assert.equal(await decide(), 'castlefetch', 'switch 2: drained, fetching resumes')
      assert.equal(switches, 2, 'one cycle is exactly two switches — bounded')
      fetch(bot, ctx) // fresh leg clock: no instant re-yield
      assert.equal(ctx.stepStatus, 'running', 'the resumed leg commits again')
    })
  })
})

describe('vmzq.20 table footing: refused cells are skipped, water takes no placement', () => {
  const equipMod = require('../src/behaviours/equip')

  it('a refused cell is skipped next pick; a later success clears the set', async () => {
    await quiet(async () => {
      let n = 0
      const bot = tableBot({
        placeImpl: async (calls, land, ref, face) => {
          calls.place.push({ x: ref.position.x, z: ref.position.z })
          n++
          if (n === 1) throw new Error('Server refused to place crafting_table at (1, 64, 0): the block is still air')
          land({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z })
        },
      })
      const ctx = {}
      await assert.rejects(equipMod.tableFor(bot, ctx), /Server refused/)
      assert.ok(ctx.equipTableSkip instanceof Set && ctx.equipTableSkip.has('1,64,0'), 'refused cell skipped')
      const r = await equipMod.tableFor(bot, ctx)
      assert.deepEqual(bot.calls.place, [{ x: 1, z: 0 }, { x: -1, z: 0 }], 'second pick tries the next neighbour')
      assert.equal(r.pos.x, -1)
      assert.equal(ctx.equipTableSkip.size, 0, 'success clears the set')
    })
  })

  it('a refused cell is still retried when it is the only viable spot (TABLE_TRIES)', async () => {
    await quiet(async () => {
      const bot = tableBot({
        below: { '1,0': { name: 'dirt' }, '-1,0': { name: 'air' }, '0,1': { name: 'air' }, '0,-1': { name: 'air' } },
        placeImpl: async (calls, land, ref, face) => {
          calls.place.push({ x: ref.position.x, z: ref.position.z })
          throw new Error('no room')
        },
      })
      const ctx = {}
      for (let i = 0; i < 3; i++) await assert.rejects(equipMod.tableFor(bot, ctx), /no room/)
      assert.deepEqual(bot.calls.place, [{ x: 1, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }], 'tried cell falls back, three attempts')
      assert.ok(ctx.equipTableSkip.has('1,64,0'), 'still marked refused')
    })
  })

  it('non-solid footing (water) is never attempted; unknown shapes still place (fail-open)', async () => {
    await quiet(async () => {
      const bot = tableBot({
        below: { '1,0': { name: 'water', boundingBox: 'empty' }, '-1,0': { name: 'dirt', boundingBox: 'block' } },
        placeImpl: async (calls, land, ref, face) => {
          calls.place.push({ x: ref.position.x, z: ref.position.z })
          land({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z })
        },
      })
      const r = await equipMod.tableFor(bot, {})
      assert.deepEqual(bot.calls.place, [{ x: -1, z: 0 }], 'water footing skipped outright')
      assert.equal(r.pos.x, -1)
    })
    await quiet(async () => {
      const bot = tableBot({ // old doubles carry no boundingBox: old behavior
        placeImpl: async (calls, land, ref, face) => {
          calls.place.push({ x: ref.position.x, z: ref.position.z })
          land({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z })
        },
      })
      const r = await equipMod.tableFor(bot, {})
      assert.deepEqual(bot.calls.place, [{ x: 1, z: 0 }])
      assert.equal(r.pos.x, 1)
    })
  })
})

// neuc.58: on v2 (BOT_BODY=baritone) a stone leg's target is the forecast
// min(blueprint remainder + reserve - held, pack room, pick budget), not
// FETCH=64; the LEG_MAX_MS yield waits for LEG_MAX_MS without a gain.
describe('neuc.58 v2 stone haul = forecast', () => {
  async function v2(fn) {
    const prev = process.env.BOT_BODY
    process.env.BOT_BODY = 'baritone'
    try { return await quiet(fn) } finally { if (prev === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prev }
  }
  const pick = (name, max, used) => ({ name, count: 1, maxDurability: max, durabilityUsed: used })
  const fill = (n) => Array.from({ length: n }, (_, i) => ({ name: `junk${i}`, count: 1 }))
  const short = (items) => {
    const bot = makeBot({ items })
    const ctx = { castle: castleState(), work: true }
    const d = fetch.demand(bot, ctx)
    return { d, left: ctx.castleWord.left }
  }

  it('pick-bound: one stone pick with 31 uses left caps the leg at 31', async () => {
    await v2(async () => {
      const { d, left } = short([pick('stone_pickaxe', 131, 100)])
      assert.ok(left + 24 > 31)
      assert.equal(d.kind, 'stone')
      assert.equal(d.short, 31)
    })
  })

  it('room-bound: 34 slots used (2 kept) leave only the partial stone headroom', async () => {
    await v2(async () => {
      const items = [pick('diamond_pickaxe', 1561, 0), { name: 'cobblestone', count: 40 }, ...fill(32)]
      const { d, left } = short(items)
      assert.ok(left + 24 - 40 > 24)
      assert.equal(d.short, 24) // 2 empty minus 2 kept; 64-40 headroom
    })
  })

  it('remainder-bound: big picks and an empty pack ask for exactly the remainder + reserve', async () => {
    await v2(async () => {
      const items = [pick('diamond_pickaxe', 1561, 0), pick('netherite_pickaxe', 2031, 0)]
      const { d, left } = short(items)
      assert.ok(left + 24 < 32 * 64, `left=${left} must fit the pack for this case`)
      assert.equal(d.short, left + 24)
      assert.ok(d.short > fetch.FETCH.stone + 24, 'bigger than the v1 FETCH haul')
    })
  })

  it('missing durability fields read as a fresh pick (131 stone)', async () => {
    await v2(async () => {
      assert.equal(short([{ name: 'stone_pickaxe', count: 1 }]).d.short, 131)
    })
  })

  it('v1 (BOT_BODY unset) keeps FETCH: 64 + reserve', async () => {
    await quiet(async () => {
      assert.equal(process.env.BOT_BODY, undefined)
      assert.equal(short([pick('diamond_pickaxe', 1561, 0)]).d.short, 64 + 24)
    })
  })

  it('an expired batch leg still gaining keeps going; one with no gain for LEG_MAX_MS yields', async () => {
    await v2(async () => {
      const items = [{ name: 'cobblestone', count: 40 }, pick('stone_pickaxe', 131, 0)]
      const bot = makeBot({ items })
      const t0 = Date.now() - LEG_MAX_MS - 1
      const ctx = { castle: castleState(), work: true, step: 'castlefetch', stepStatus: 'running', castleFetch: { kind: 'stone', t0, blocks0: 30, skips: 0 } }
      assert.equal(castleMod.menuFact(bot, ctx), 'stone-batch')
      fetch(bot, ctx) // 40 > 30: a gain this leg, the clock restarts
      assert.equal(ctx.stepStatus, 'running')
      assert.ok(ctx.castleFetch.lastGainAt >= t0 + LEG_MAX_MS)
      ctx.castleFetch.lastGainAt = Date.now() - LEG_MAX_MS - 1 // no gain since
      fetch(bot, ctx)
      assert.equal(ctx.stepStatus, 'done')
    })
  })
})
