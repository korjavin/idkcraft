// idkcraft-7lb2: v2 stuck in leaves — a no-dig walk (canDig=false) mapped to
// a bare Baritone `allowBreak false`, so a crown between the body and its
// goal answered noPath forever while the bridge still reported moving=true
// (prod 2026-10-21 06:49:30–06:51:08: action=flee moving=true path=noPath
// every second, creeper dist glued at 6.0). The fix keeps leaves (and only
// leaves) breakable on no-dig routes via Baritone's `allowBreakAnyway`
// (stock 1.18.0: breakable even with allowBreak=false); dirt/stone stay
// banned so walks still never tunnel hills (vmzq.50).
//
// The FakeTransport cannot simulate real Baritone pathing through a crown,
// so no in-harness test can assert the outcome half of the bead's criterion
// 2 (movement, a dig, or an honest fail against a real crown). What the
// harness CAN pin is this fix's precondition: across 60 flee re-issues
// answered noPath every round (the prod 06:49:30–06:51:08 tick shape), the
// #set stream must carry the leaves exception from the first push and never
// globally enable break. Before the fix it fails: the stream is a bare
// `allowBreak false` with no exception. The outcome half stays open: it is
// covered by prod log signals (named in the PR body), and the non-leaves
// v2 noPath loop (the bead's fix option 2, medium confidence the
// obstruction was leaves at all) needs an owner decision + follow-up bead.
'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot, movementsToSettings } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { goals } = require('mineflayer-pathfinder')

const REGISTRY = {
  blocksByName: {
    air: { id: 0, diggable: false },
    dirt: { id: 1, diggable: true },
    stone: { id: 2, diggable: true },
    chest: { id: 10, diggable: true },
    oak_leaves: { id: 11, diggable: true },
    birch_leaves: { id: 12, diggable: true },
    spruce_leaves: { id: 13, diggable: true },
  },
  blocks: [],
  itemsByName: {},
  items: [],
}
REGISTRY.blocks[10] = { name: 'chest' }

const LEAVES = 'birch_leaves,oak_leaves,spruce_leaves' // sorted, deterministic

// A no-dig walk's Movements: shelter/castle-walk shape (body.js borrows
// canDig=false), with the default chest cant-break.
function walkMovs() {
  return {
    canDig: false,
    allowSprinting: false,
    allowParkour: true,
    blocksCantBreak: new Set([10]),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function leafBot() {
  const transport = new FakeTransport({
    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true },
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  return { transport, bot }
}

describe('7lb2: no-dig walks keep leaves breakable (allowBreakAnyway)', () => {
  it('maps canDig=false to allowBreak=false with leaves (and only leaves) excepted', () => {
    const set = movementsToSettings(walkMovs(), REGISTRY)
    assert.equal(set.allowBreak, 'false', 'no-dig still bans breaking in general (vmzq.50)')
    assert.equal(set.allowBreakAnyway, LEAVES)
    for (const n of ['dirt', 'stone', 'chest']) {
      assert.ok(!set.allowBreakAnyway.split(',').includes(n), `${n} stays banned`)
    }
    assert.equal(set.blocksToAvoidBreaking, 'chest', 'the default cant-break still crosses')
  })

  it('emits no exception when digging is allowed or no leaves are known', () => {
    assert.equal(movementsToSettings({ canDig: true }, REGISTRY).allowBreakAnyway, undefined)
    const noLeaves = { blocksByName: { dirt: { id: 1, diggable: true } }, blocks: [], itemsByName: {}, items: [] }
    assert.deepEqual(movementsToSettings(walkMovs(), noLeaves).allowBreakAnyway, undefined)
    assert.deepEqual(movementsToSettings({ canDig: false }, null), { allowBreak: 'false' })
  })

  it('precondition across 60 noPath re-issues: leaves exception from push 1, never allowBreak true', async () => {
    const { transport, bot } = leafBot()
    const seen = []
    bot.on('path_update', (r) => seen.push(r && r.status))
    await bot.start({ pollMs: 0 })
    try {
      bot.pathfinder.setMovements(walkMovs())
      for (let i = 0; i < 60; i++) {
        bot.pathfinder.setGoal(new goals.GoalNear(50, 64, 50, 2)) // the flee re-issue, every tick
        await sleep(10)
        transport.inject('baritone.event', { id: bot._goalId, status: 'noPath' }) // prod: noPath every second
      }
      assert.equal(seen.filter((s) => s === 'noPath').length, 60, 'the prod tick shape, reproduced')
      const sets = transport.state.baritoneSets || []
      assert.ok(sets.includes('#set allowBreak false'), 'the no-dig ban crosses on the first push')
      assert.ok(sets.includes(`#set allowBreakAnyway ${LEAVES}`), 'leaves ride the first push: no eternal bare ban')
      assert.ok(!sets.some((c) => c === '#set allowBreak true'), 'break is never globally enabled (vmzq.50)')
    } finally {
      await bot.stop()
    }
  })
})

