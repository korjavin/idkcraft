'use strict'

// Upkeep cells (fill, litter) failed 'unreachable' far more than they laid
// (prod bot4 after #908: fill fail:unreachable 70x vs 16 ok). Below/at the
// feet they now take the dig/step ladder, a fill hole the bot stands in is
// jump-placed, and a player in an upkeep cell defers instead of striking.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn() } finally { console.log = o } }

describe('castle upkeep reach', () => {
  it('a fill cell below the feet gets the dig-approach ladder before any strike', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2, blocked: {} }
    const ctx = { castle: st }
    const cell = { x: SITE.x + 9, y: SITE.y - 6, z: SITE.z, kind: 'stone', prep: 'fill', idx: castle.fillBase(st) + 7 }
    const bot = { entity: { position: new Vec3(SITE.x, SITE.y, SITE.z) } }
    const now = Date.now()
    quiet(() => { for (let i = 0; i <= castle.STRIKES; i++) castle.far(bot, ctx, st, cell, 4.5, now) })
    assert.deepEqual(st.blocked, {}, 'no unreachable strike yet')
    assert.ok(ctx.castleFar.dig, 'dig-approach armed')
  })

  it('standing in a fill hole jumps and places the filler under the feet', async () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2, blocked: {} }
    const ctx = { castle: st }
    const cell = { x: SITE.x, y: SITE.y - 3, z: SITE.z, kind: 'stone', prep: 'fill', idx: castle.fillBase(st) + 2 }
    const pos = new Vec3(SITE.x + 0.5, cell.y, SITE.z + 0.5)
    const placed = []
    const controls = {}
    const bot = {
      entity: { position: pos, height: 1.8, width: 0.6 },
      players: {},
      inventory: { items: () => [] },
      pathfinder: { setGoal() {}, isMoving: () => false, goal: null },
      blockAt(p) {
        const name = p.y < cell.y ? 'stone' : 'air'
        return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'stone' ? 'block' : 'empty' }
      },
      async equip() {},
      setControlState(k, v) { controls[k] = v; if (k === 'jump' && v) pos.y = cell.y + 1.1 },
      async placeBlock(ref, face) { placed.push([ref.position.y, face.y]) },
    }
    ctx.castleGoalIdx = cell.idx // approach already issued
    quiet(() => castle.placeCell(bot, ctx, st, cell, { name: 'cobblestone' }, Date.now()))
    await new Promise((res) => setTimeout(res, 20))
    assert.deepEqual(placed, [[cell.y - 1, 1]], 'placed on the floor under the feet')
    assert.equal(controls.jump, false, 'jump released')
    assert.deepEqual(st.blocked, {}, 'no self-stance strike')
  })

  it('another player in an upkeep cell defers it without spending a try; the bot itself never counts', () => {
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2, blocked: {} }
    const cell = { x: SITE.x + 3, y: SITE.y, z: SITE.z, kind: 'stone', prep: 'fill', idx: castle.fillBase(st) + 11 }
    const self = { position: new Vec3(SITE.x + 3.5, SITE.y, SITE.z + 0.5), height: 1.8, width: 0.6 }
    const bot = { entity: { position: new Vec3(SITE.x, SITE.y, SITE.z), height: 1.8, width: 0.6 }, players: { other: { entity: self } } }
    const ctx = { castle: st, castleUpkeep: cell }
    const now = Date.now()
    // place path: other player in the cell
    const placeBot = { ...bot, pathfinder: { setGoal() {}, isMoving: () => false, goal: null }, blockAt: () => null }
    ctx.castleGoalIdx = cell.idx
    quiet(() => castle.placeCell(placeBot, ctx, st, cell, { name: 'cobblestone' }, now))
    const e = st.blocked[Object.keys(st.blocked)[0]]
    assert.equal(e.why, 'occupied')
    assert.equal(e.tries, 0, 'no try spent')
    assert.ok(e.until > now && !e.retired)
    assert.equal(ctx.castleUpkeep, null, 'picker moves on')
  })
})
