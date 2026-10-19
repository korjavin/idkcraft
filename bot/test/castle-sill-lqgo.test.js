'use strict'

// idkcraft-lqgo: the house z591 sill rule on the castle gate. On the v2 body
// natural ground under the gate door is swapped for planks (Baritone break
// bans are names: groundCell never reached it, a mining leg broke the dirt
// and the door popped). Off-plan, the PLAN stays frozen; v1 is unchanged.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { denyReason } = require('../src/behaviours/util')

const SITE = { x: 100, y: 64, z: 200 }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
// The gate door (15,0,7) at rot 0; the sill below it.
const SILL = { x: SITE.x + 15, y: SITE.y - 1, z: SITE.z + 7 }

// Same fake-bot surface as castle-sweep-g0z61.test.js worldBot (mineflayer
// bot.blockAt -> Block {name, position, boundingBox}); dirt below the floor.
function worldBot(cells, items) {
  return {
    entity: { position: new Vec3(SITE.x + 15.5, SITE.y, SITE.z + 2.5), onGround: true },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const name = cells.has(key(x, y, z)) ? cells.get(key(x, y, z)) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
function painted() {
  const cells = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) cells.set(key(c.x, c.y, c.z), blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  for (const c of blueprint.decorPlan(SITE, 0, 2).cells) cells.set(key(c.x, c.y, c.z), c.kind === 'pane' ? 'glass_pane' : c.kind === 'fence' ? 'oak_fence' : 'white_wall_banner')
  return cells
}
const PLANKS = [{ name: 'oak_planks', count: 16 }]
const st = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false, visitedAt: Date.now(), ...extra })

const prev = process.env.BOT_BODY
afterEach(() => { if (prev === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = prev })

describe('lqgo v2 castle door sill', () => {
  it('the sill is off-plan, under the gate door; the plan is unchanged', () => {
    const door = blueprint.absPlan(SITE, 0, 2).cells.find((c) => c.kind === 'door')
    assert.deepEqual({ x: door.x, y: door.y - 1, z: door.z }, SILL)
    assert.equal(blueprint.absPlan(SITE, 0, 2).at.has(key(SILL.x, SILL.y, SILL.z)), false)
    assert.equal(blueprint.groundCell(st(), SILL), true, 'v1 keeps the groundCell guard on it')
  })

  it('v2, complete: a dirt sill is the repair word and the executor swaps it', () => {
    process.env.BOT_BODY = 'baritone'
    const cells = painted()
    const bot = worldBot(cells, PLANKS)
    const ctx = { castle: st() }
    assert.match(castle.menuFact(bot, ctx), /^planks-/)
    castle(bot, ctx)
    assert.equal(ctx.castle.status, 'laying the door sill')
    assert.ok(bot.pathfinder.goal, 'walks to dig it')
    // Only the sill dig may take the groundCell dirt.
    const b = bot.blockAt(SILL)
    assert.equal(denyReason(bot, b, { castle: ctx.castle }), 'protected')
    assert.equal(denyReason(bot, b, { castle: ctx.castle, castleSill: true, castleClear: true }), null)
    // Without planks a complete castle still asks for them (castlefetch).
    assert.equal(castle.menuFact(worldBot(cells, []), { castle: st() }), 'planks-none')
    // revmux 01: the off-plan sill counts 1, so reserve-only planks still fetch.
    const rctx = { castle: st() }
    const d = require('../src/behaviours/castlefetch').demand(worldBot(cells, [{ name: 'oak_planks', count: 2 }]), rctx)
    assert.equal(rctx.castleWord.left, 1)
    assert.ok(d && d.kind === 'planks' && d.short > 0, JSON.stringify(d))
  })

  it('v2: planks, laid rock or a built block is done; stone and holes are not', () => {
    process.env.BOT_BODY = 'baritone'
    const cells = painted()
    const bot = worldBot(cells, PLANKS)
    for (const [name, want] of [['spruce_planks', true], ['granite', true], ['cobblestone', true], ['stone', false], ['air', false], ['short_grass', false]]) {
      cells.set(key(SILL.x, SILL.y, SILL.z), name)
      const ctx = { castle: st() }
      castle(bot, ctx)
      assert.equal(ctx.castle.status === 'laying the door sill', !want, name)
    }
  })

  it('v2, body phase: the sill waits for planks on hand (a fresh build never fetches planks first)', () => {
    process.env.BOT_BODY = 'baritone'
    const cells = new Map() // nothing laid: the next cell is stone
    assert.notEqual(castle.menuFact(worldBot(cells, []), { castle: st({ phase: 'body' }) }), 'planks-none')
    assert.match(castle.menuFact(worldBot(cells, PLANKS), { castle: st({ phase: 'body' }) }), /^planks-/)
  })

  it('a retired sill is never picked again', () => {
    process.env.BOT_BODY = 'baritone'
    const bot = worldBot(painted(), PLANKS)
    const ctx = { castle: st({ blocked: { [`2:${4000000}`]: { tries: 8, until: 0, retired: true, why: 'x' } } }) }
    castle(bot, ctx)
    assert.notEqual(ctx.castle.status, 'laying the door sill')
    assert.ok(ctx.castle.blocked['2:4000000'], 'kept until done, not pruned on expiry')
  })

  it('v1: the dirt sill is left alone', () => {
    delete process.env.BOT_BODY
    const bot = worldBot(painted(), PLANKS)
    const ctx = { castle: st() }
    assert.doesNotMatch(castle.menuFact(bot, ctx), /^planks-/)
    castle(bot, ctx)
    assert.notEqual(ctx.castle.status, 'laying the door sill')
  })
})
