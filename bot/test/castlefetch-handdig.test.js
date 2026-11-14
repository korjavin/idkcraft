// Prod 2026-11-14 (bot3): a dead quarry armed bot.mine in place, Baritone
// found no rock (mine-noPath) and the leg failed no-stone with dug=0. The
// in-place recovery now hand-digs the nearest rock in reach, never the
// feet column straight down.
'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const castlefetch = require('../src/behaviours/castlefetch')
require('../src/behaviours/bring')

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

it('mine-noPath in place hand-digs the nearest rock, not straight down', async () => {
  const dug = []
  const rock = new Set(['502,63,500', '500,63,500']) // under the feet is closer but forbidden
  const bot = {
    entity: { position: { x: 500.5, y: 64, z: 500.5 }, onGround: true },
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
    blockAt: (p) => ({ name: rock.has(`${p.x},${p.y},${p.z}`) ? 'stone' : (p.y >= 64 ? 'air' : 'dirt'), position: p, boundingBox: p.y >= 64 ? 'empty' : 'block' }),
    findBlocks: () => [],
    pathfinder: {},
    chat: () => {},
    mine: async () => { throw new Error('mine-noPath') },
    dig: async (b) => { dug.push(`${b.position.x},${b.position.y},${b.position.z}`) },
  }
  const ctx = {
    stepStatus: 'running', lastGoalKey: '', castleFetchInFlight: false,
    castle: { site: { x: 0, y: 64, z: 0 }, rot: 0, blueprintVersion: 1 },
    castleFetch: { kind: 'stone', chestWaits: 0, skips: 0, noGain: 0, t0: Date.now(), blocks0: 0 },
  }
  const f = ctx.castleFetch
  const d = { kind: 'stone', word: 'batch', short: 8 }
  castlefetch.digTick(bot, ctx, f, d)
  await flush()
  assert.equal(ctx.stepStatus, 'running')
  assert.equal(f.handDig, true)
  castlefetch.digTick(bot, ctx, f, d)
  await flush()
  assert.deepEqual(dug, ['502,63,500'])
  assert.equal(f.dug, 1)
})
