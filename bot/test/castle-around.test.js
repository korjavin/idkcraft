'use strict'

// Castle around a short kind (owner 2026-11-13): one missing material never
// stops the whole castle. Held kinds keep laying; only with nothing layable
// does the castle hand over to castlefetch, on a kind no fetch holds.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest', fence: 'oak_fence' }

function makeBot(items, set = new Map()) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: { x: SITE.x - 4, y: 64, z: SITE.z - 4 } },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    players: {},
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

// v3 castle, every place cell before the first stairs cell laid: the
// stairs cell is next in work order.
function stairsNext() {
  const { cells } = blueprint.absPlan(SITE, 0, 3)
  const first = cells.find((c) => c.kind === 'stairs')
  const set = new Map()
  for (const c of cells) if (c.idx < first.idx && LAID[c.kind]) set.set(`${c.x},${c.y},${c.z}`, LAID[c.kind])
  const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {}, parked: false } }
  return { set, ctx, first }
}

describe('castle around a short kind', () => {
  it('stairs short, cobble on hand: keeps laying stone cells', () => {
    const { set, ctx, first } = stairsNext()
    const withStairs = makeBot([{ name: 'cobblestone_stairs', count: 64 }], set)
    assert.equal(castleMod.peek(withStairs, ctx.castle, Date.now(), ctx).cell.idx, first.idx, 'stairs is the next cell')
    const bot = makeBot([{ name: 'cobblestone', count: 400 }], set)
    assert.equal(castleMod.peek(bot, ctx.castle, Date.now(), ctx).cell.kind, 'stone')
    assert.equal(castleMod.menuFact(bot, ctx), 'stone-batch')
    castleMod(bot, ctx)
    assert.notEqual(ctx.stepStatus, 'failed:no-stairs')
  })

  it('everything short, stairs held by a failed fetch: castlefetch targets another kind', () => {
    const { set, ctx } = stairsNext()
    const bot = makeBot([], set)
    assert.equal(castleMod.menuFact(bot, ctx), 'stairs-none', 'unheld: the first short kind')
    ctx.stepFail = { castlefetch: { kinds: { stairs: { at: Date.now() } } } }
    const w = castleMod.menuFact(bot, ctx)
    assert.match(w, /-none$/)
    assert.notEqual(w, 'stairs-none')
    assert.notEqual(ctx.castleWord.kind, 'stairs')
  })

  it('every short kind held, nothing layable: fails no-<kind> as before', () => {
    const { set, ctx } = stairsNext()
    const bot = makeBot([], set)
    ctx.castleFetchDry = new Set(Object.keys(LAID).concat(['stairs', 'torch', 'door']))
    assert.equal(castleMod.menuFact(bot, ctx), 'stairs-none')
    castleMod(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:no-stairs')
  })
})
