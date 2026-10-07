'use strict'

// Bead idkcraft-vmzq.27: blocked/protected castle cells stalled the whole
// build — prod flipped castle<->castlefetch ~62x in 30 min with 0 laid,
// because a blocked structural cell gated every layer above it. Fix:
// skip-and-continue past blocked cells (the rest lays at the normal rate),
// one chat line listing the holes, rare bounded retries. This file restores
// the vmzq.20 flip-repro (deleted in revmux 01 as goal-only) with blocked
// cells present, pins the skip + one-line report, and pins the rig's blocked
// seed picker.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
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

function makeBot({ items = [], at = pos(SITE.x - 4, 64, SITE.z - 4), timeOfDay = 6000, laid = null } = {}) {
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
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const name = (laid && laid.has(`${fx},${fy},${fz}`)) ? 'cobblestone' : (fy <= 63 ? 'dirt' : 'air')
      return { name, position: pos(fx, fy, fz), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] } },
    world: { getBlock: () => null },
    chat(m) { this.chats.push(String(m)) },
  }
}

function castleState(extra = {}) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

// Two low blocked cells with live backoffs (the rig seeds three; two is
// enough to pin the skip at decide level), the rest of their layer laid:
// the old layer gate reads this word 'blocked', skip-and-continue reads
// the workable layer above.
function blocked2() {
  const cells = blueprint.absPlan(SITE, 0, 1).cells
  const layer0 = cells.filter((c) => c.kind === 'stone' && c.dy === 0)
  const pair = layer0.slice(0, 2)
  const blocked = {}
  for (const c of pair) blocked[`1:${c.idx}`] = { tries: 1, until: Date.now() + 3600000, why: 'dig-refused' }
  const laid = new Set()
  for (const c of layer0.slice(2)) laid.add(`${c.x},${c.y},${c.z}`)
  return { cells, pair, blocked, laid }
}

async function quiet(fn) {
  const orig = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = orig }
}

describe('vmzq.27 flip-repro with blocked cells: flaps never preempt, the word never reads blocked', () => {
  it('fluctuating stone counts keep the running leg either way (no ping-pong)', async () => {
    await quiet(async () => {
      const { blocked, laid } = blocked2()
      const items = [
        { name: 'cobblestone', count: 20 }, // some: usable 4
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
      ]
      const bot = makeBot({ items, laid })
      for (const leg of ['castlefetch', 'castle']) {
        const ctx = { castle: castleState({ blocked: { ...blocked } }), work: true, step: leg, stepStatus: 'running' }
        ctx.goalText = goal.goalText(goal.goalFacts(bot, ctx), ctx.home)
        assert.equal((await goal.decide(bot, ctx)).action, leg, `${leg}: steady start`)
        for (let i = 0; i < 6; i++) {
          setCount(items, 'cobblestone', i % 2 === 0 ? 40 : 20) // batch <-> some
          assert.notEqual(castleMod.menuFact(bot, ctx), 'blocked', `${leg}: flap ${i} skips the holes`)
          assert.equal((await goal.decide(bot, ctx)).action, leg, `${leg}: flap ${i} must not switch`)
        }
        assert.equal(bot.chats.length, 0, `${leg}: no step-change chat on a flap`)
      }
    })
  })

  it('one handover cycle with blocked cells switches exactly twice', async () => {
    await quiet(async () => {
      const { blocked } = blocked2()
      const fetch = require('../src/behaviours/castlefetch')
      const items = [
        { name: 'cobblestone', count: 20 },
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
      ]
      const bot = makeBot({ items })
      const ctx = {
        castle: castleState({ blocked: { ...blocked } }), work: true, step: 'castlefetch', stepStatus: 'running',
        castleFetch: { kind: 'stone', t0: Date.now() - fetch.LEG_MAX_MS - 1, skips: 0 },
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
      assert.equal(await decide(), 'castle', 'switch 1: the castle lays past the holes')
      setCount(items, 'cobblestone', 16) // the castle drained the batch (reserve only)
      assert.equal(await decide(), 'castlefetch', 'switch 2: drained, fetching resumes')
      assert.equal(switches, 2, 'one cycle is exactly two switches — bounded')
    })
  })
})

describe('vmzq.27 skip-and-continue: three holes, material word, one report line', () => {
  it('three blocked cells read a material word and list in one chat line', async () => {
    await quiet(async () => {
      const cells = blueprint.absPlan(SITE, 0, 1).cells
      const trio = cells.filter((c) => c.kind === 'stone').slice(0, 3)
      const blocked = {}
      const whys = ['protected', 'kept-chest', 'dig-refused']
      trio.forEach((c, i) => { blocked[`1:${c.idx}`] = { tries: i + 1, until: Date.now() + 60000, why: whys[i] } })
      const bot = makeBot({ items: [{ name: 'cobblestone', count: 40 }, { name: 'stone_pickaxe', count: 1 }] })
      const ctx = { castle: castleState({ blocked }) }
      assert.equal(castleMod.menuFact(bot, ctx), 'stone-batch', 'workable rest, not blocked')
      const holes = castleMod.holesOf(bot, ctx.castle, cells)
      assert.equal(holes.length, 3)
      assert.ok(castleMod.sayHoles(bot, ctx, ctx.castle, holes, Date.now()))
      assert.equal(bot.chats.length, 1, `chats: ${JSON.stringify(bot.chats)}`)
      assert.match(bot.chats[0], /^castle: 3 holes: .*, retry in \d+s — remove those blocks or say castle stop$/)
      for (const w of whys) assert.ok(bot.chats[0].includes(`(stone: ${w})`), `why ${w} listed`)
      for (const c of trio) assert.ok(bot.chats[0].includes(`${c.x} ${c.y} ${c.z}`), `hole ${c.x} ${c.y} ${c.z} listed`)
      // Same set again: silent.
      assert.ok(castleMod.sayHoles(bot, ctx, ctx.castle, castleMod.holesOf(bot, ctx.castle, cells), Date.now()))
      assert.equal(bot.chats.length, 1, 'no re-chat without a new hole')
    })
  })
})

describe('vmzq.27 interactable refs: a placement click never opens a GUI', () => {
  const Vec3 = require('vec3')
  const buildMod = require('../src/behaviours/build')
  const flatMod = require('../src/behaviours/flat')
  const bedsMod = require('../src/behaviours/beds')
  const { isInteractRef } = require('../src/behaviours/util')

  function refBot(world) {
    return {
      blockAt: (p) => {
        const n = world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || 'air'
        return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
      },
    }
  }

  it('flags GUI/toggle/use blocks, not plain solids', () => {
    for (const n of ['chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
      'hopper', 'dropper', 'dispenser', 'crafter', 'crafting_table', 'oak_door', 'oak_button',
      'oak_fence_gate', 'oak_trapdoor', 'red_bed', 'oak_sign', 'shulker_box', 'cauldron',
      'water_cauldron', 'campfire', 'soul_campfire', 'lever', 'cake', 'respawn_anchor', 'vault']) {
      assert.equal(isInteractRef(n), true, n)
    }
    for (const n of ['cobblestone', 'stone', 'dirt', 'oak_planks', 'oak_log', 'glass', 'torch', 'air', null, 42]) {
      assert.equal(isInteractRef(n), false, String(n))
    }
  })

  it('build.findRef steps around a chest to a side cobble, null when alone', () => {
    const bot = refBot(new Map([['0,0,0', 'chest'], ['1,1,0', 'cobblestone']]))
    const r = buildMod.findRef(bot, new Vec3(0, 1, 0))
    assert.ok(r, 'a ref exists')
    assert.equal(r.ref.name, 'cobblestone', 'the chest below is skipped')
    assert.deepEqual([r.face.x, r.face.y, r.face.z], [-1, 0, 0])
    const lone = refBot(new Map([['0,0,0', 'furnace']]))
    assert.equal(buildMod.findRef(lone, new Vec3(0, 1, 0)), null, 'lone furnace: no ref, honestly')
    // Pre-existing exclusions still hold.
    const door = refBot(new Map([['0,0,0', 'oak_door'], ['1,1,0', 'dirt']]))
    assert.equal(buildMod.findRef(door, new Vec3(0, 1, 0)).ref.name, 'dirt')
  })

  it('flat.findRef and beds.fillRef skip interactables too', () => {
    const bot = refBot(new Map([['0,0,0', 'chest'], ['1,1,0', 'dirt']]))
    const f = flatMod.findRef(bot, new Vec3(0, 1, 0))
    assert.ok(f && f.ref.name === 'dirt', `flat ref: ${f && f.ref.name}`)
    const lone = refBot(new Map([['0,0,0', 'barrel']]))
    assert.equal(flatMod.findRef(lone, new Vec3(0, 1, 0)), null)
    const bedBot = refBot(new Map([['0,-1,0', 'dirt'], ['1,0,0', 'chest'], ['-1,0,0', 'dirt']]))
    const b = bedsMod.fillRef(bedBot, { x: 0, y: 0, z: 0 })
    assert.ok(b, 'a fill ref exists')
    assert.equal(b.ref.name, 'dirt')
    assert.deepEqual([b.face.x, b.face.y, b.face.z], [1, 0, 0], 'the chest side is stepped around')
  })
})

describe('vmzq.27 revmux 01: the latch is per cell, transient no-ref stays silent', () => {
  it('a why-change stays silent, a new cell and a retire re-chat', () => {
    const chats = []
    const bot = { chats, chat(m) { chats.push(String(m)) } }
    const ctx = {}
    const st = { status: '' }
    const hole = (x, why, retired = false) => ({ x, y: 64, z: 200, kind: 'stone', why, until: Date.now() + 30000, retired })
    assert.ok(castleMod.sayHoles(bot, ctx, st, [hole(100, 'protected')], Date.now()))
    assert.equal(chats.length, 1)
    assert.match(chats[0], /^castle: 1 hole at 100 64 200 \(stone: protected\), retry in \d+s$/)
    assert.ok(castleMod.sayHoles(bot, ctx, st, [hole(100, 'below-feet')], Date.now()))
    assert.equal(chats.length, 1, 'same cell, new why: silent')
    assert.ok(castleMod.sayHoles(bot, ctx, st, [hole(100, 'below-feet'), hole(101, 'dig-refused')], Date.now()))
    assert.equal(chats.length, 2, 'new cell re-chats the full list')
    assert.match(chats[1], /^castle: 2 holes: .*\(stone: below-feet\), .*\(stone: dig-refused\), retry in \d+s$/)
    assert.ok(castleMod.sayHoles(bot, ctx, st, [hole(100, 'below-feet', true), hole(101, 'dig-refused')], Date.now()))
    assert.equal(chats.length, 3, 'retire re-chats once')
    assert.match(chats[2], /100 64 200 \(stone: below-feet, retired\)/)
  })

  it('holesOf skips first-try no-ref but lists it from try 2 and when retired', () => {
    const cells = blueprint.absPlan(SITE, 0, 1).cells
    const stones = cells.filter((c) => c.kind === 'stone').slice(0, 3)
    const bot = makeBot({})
    const st = castleState({
      blocked: {
        [`1:${stones[0].idx}`]: { tries: 1, until: Date.now() + 30000, why: 'no-ref' },
        [`1:${stones[1].idx}`]: { tries: 2, until: Date.now() + 60000, why: 'no-ref' },
        [`1:${stones[2].idx}`]: { tries: 1, until: Date.now() + 30000, why: 'protected' },
      },
    })
    let holes = castleMod.holesOf(bot, st, cells)
    assert.deepEqual(holes.map((h) => h.x).sort((a, b) => a - b),
      [stones[1].x, stones[2].x].sort((a, b) => a - b), 'try-1 no-ref filtered')
    st.blocked[`1:${stones[0].idx}`] = { tries: 9, until: 0, why: 'no-ref', retired: true }
    holes = castleMod.holesOf(bot, st, cells)
    assert.equal(holes.length, 3, 'retired no-ref listed')
    assert.ok(holes.find((h) => h.x === stones[0].x).retired)
  })
})

describe('vmzq.27 rig seeds: lowest stone cells, log/chest mix', () => {
  it('picks 3 lowest-(dy,idx) stone cells with alternating blocks', () => {
    const { pickBlockedSeeds } = require('../tools/castle-replay')
    for (const version of [1, 2]) {
      const seeds = pickBlockedSeeds(SITE, 0, version, 3)
      assert.equal(seeds.length, 3)
      assert.deepEqual(seeds.map((s) => s.block), ['oak_log', 'chest', 'oak_planks'])
      assert.ok(seeds.every((s) => s.kind === 'stone'))
      const cells = blueprint.absPlan(SITE, 0, version).cells
      const at = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, c]))
      for (const s of seeds) {
        const c = at.get(`${s.x},${s.y},${s.z}`)
        assert.ok(c && c.kind === 'stone', `seed on a stone plan cell: ${s.x} ${s.y} ${s.z}`)
      }
      const dys = seeds.map((s) => at.get(`${s.x},${s.y},${s.z}`).dy)
      const minDy = Math.min(...cells.filter((c) => c.kind === 'stone').map((c) => c.dy))
      assert.ok(dys.every((d) => d === minDy), `lowest stone layer (dy=${minDy}): ${dys}`)
      assert.equal(new Set(seeds.map((s) => `${s.x},${s.y},${s.z}`)).size, 3, 'distinct cells')
    }
  })
})
