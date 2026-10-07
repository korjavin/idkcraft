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

describe('vmzq.27 rig seeds: lowest stone cells, log/chest mix', () => {
  it('picks 3 lowest-(dy,idx) stone cells with alternating blocks', () => {
    const { pickBlockedSeeds } = require('../tools/castle-replay')
    for (const version of [1, 2]) {
      const seeds = pickBlockedSeeds(SITE, 0, version, 3)
      assert.equal(seeds.length, 3)
      assert.deepEqual(seeds.map((s) => s.block), ['oak_log', 'chest', 'oak_log'])
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
