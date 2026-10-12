'use strict'

// Rich stall state (idkcraft-vhlb.3): a known fake world renders to the
// expected slice; attempts ring; inventory tiers; size budget.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stallState, voxelSlice, recordAttempt, markAttemptStart, ATTEMPTS_KEPT } = require('../src/stall-state')

const B = (name, boundingBox = 'block') => ({ name, boundingBox })

function world(fn) {
  return {
    entity: { position: { x: 10.5, y: 64, z: 20.5 } },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'oak_log', count: 5 }, { name: 'cobblestone', count: 12 }] },
    blockAt: (v) => fn(v.x - 10, v.y - 64, v.z - 20),
  }
}

describe('stall-state', () => {
  it('renders a known world into the expected slice', () => {
    const bot = world((dx, dy, dz) => {
      if (dy < 0) return B('stone') // floor
      if (dy === 0 && dx === 1 && dz === 0) return B('lava')
      if (dy === 0 && dx === -1 && dz === 0) return B('oak_door')
      if (dy === 1 && dx === 0 && dz === -1) return B('stone')
      if (dy === 0 && dx === 3 && dz === 3) return null // unloaded
      return B('air', 'empty')
    })
    const ctx = { placedByBot: new Set(['10,63,20']) }
    const layers = voxelSlice(bot, ctx)
    assert.equal(layers.length, 5)
    assert.equal(layers[0], 'dy+2: aaaaaaa/aaaaaaa/aaaaaaa/aaaaaaa/aaaaaaa/aaaaaaa/aaaaaaa')
    assert.equal(layers[1], 'dy+1: aaaaaaa/aaaaaaa/aaasaaa/aaaaaaa/aaaaaaa/aaaaaaa/aaaaaaa')
    assert.equal(layers[2], 'dy+0: aaaaaaa/aaaaaaa/aaaaaaa/aad@laa/aaaaaaa/aaaaaaa/aaaaaa?')
    assert.equal(layers[3], 'dy-1: sssssss/sssssss/sssssss/sssxsss/sssssss/sssssss/sssssss')
  })

  it('attempts ring keeps the last 8 with outcome and delta; inventory tiers', () => {
    const bot = world(() => B('air', 'empty'))
    const ctx = { stepStatus: 'failed:no-path' }
    markAttemptStart(ctx, bot)
    bot.entity.position = { x: 13.5, y: 64, z: 20.5 }
    recordAttempt(ctx, 'castlefetch', bot)
    assert.deepEqual(ctx.attempts[0], { step: 'castlefetch', out: 'failed:no-path', moved: [3, 0, 0] })
    for (let i = 0; i < 12; i++) recordAttempt(ctx, 'gather', bot)
    assert.equal(ctx.attempts.length, ATTEMPTS_KEPT)
    const s = stallState(bot, ctx)
    assert.equal(s.inventory.pickaxe, 'iron')
    assert.equal(s.inventory.axe, 'none')
    assert.equal(s.inventory.logs, 5)
    assert.equal(s.inventory.cobble, 12)
  })

  it('stays under the token budget', () => {
    const bot = world(() => B('stone'))
    const s = stallState(bot, { attempts: new Array(8).fill({ step: 'castlefetch', out: 'failed:no-path', moved: [0, 0, 0] }) })
    const n = JSON.stringify(s).length
    assert.ok(n < 3000, `state json ${n} chars`) // ~800 tokens worst case, cap is 1.5k
  })
})
