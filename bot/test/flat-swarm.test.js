'use strict'

// lhg2: flat swarm — N bots split one flat square into disjoint strips.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { swarmTile, stripOf, startEpisode, scanRecord, spiralColumns } = require('../src/behaviours/flat')
const { selectBody } = require('../src/index')

const OK = { status: 'ok', topY: 63, walkable: true, liquidTop: null }

describe('flat swarm tiles', () => {
  it('N bots get disjoint strips covering the square', () => {
    for (const n of [2, 3, 8, 9, 33]) {
      for (const r of [4, 8, 16, 48, 64]) {
        const cx = 100
        const cz = -40
        const seen = new Map()
        for (let i = 0; i < n; i++) {
          const f = startEpisode(cx, cz, r, 70, 'p', { i, n })
          for (const c of spiralColumns(cx, cz, r)) {
            // a flat ok column: every bot keeps only its own strip
            const before = f.cands.length
            scanRecord(f, c, OK)
            if (f.cands.length > before) {
              const k = `${c.x},${c.z}`
              assert.ok(!seen.has(k), `n=${n} r=${r} ${k} taken twice`)
              seen.set(k, i)
            }
          }
          // the level vote is the whole square on every bot
          assert.equal(f.tops.length, (2 * r + 1) ** 2)
        }
        assert.equal(seen.size, (2 * r + 1) ** 2, `n=${n} r=${r} covers the square`)
        if (n <= 2 * r + 1) for (let i = 0; i < n; i++) assert.ok([...seen.values()].includes(i), `n=${n} r=${r} strip ${i} non-empty`)
      }
    }
  })

  it('stripOf maps the square edges to the first and last strip', () => {
    assert.equal(stripOf(-8, 0, 8, 8), 0)
    assert.equal(stripOf(8, 0, 8, 8), 7)
  })

  it('swarmTile: unset/1/bad index = whole square (single-bot behaviour)', () => {
    assert.equal(swarmTile({}), null)
    assert.equal(swarmTile({ BOT_SWARM_N: '1' }), null)
    assert.equal(swarmTile({ BOT_SWARM_N: '9', BOT_SWARM_I: '9' }), null)
    assert.equal(swarmTile({ BOT_SWARM_N: 'x', BOT_SWARM_I: '1' }), null)
    assert.deepEqual(swarmTile({ BOT_SWARM_N: '9' }), { i: 0, n: 9 })
    assert.deepEqual(swarmTile({ BOT_SWARM_N: '9', BOT_SWARM_I: '8' }), { i: 8, n: 9 })
  })

  it('no tile = every column queued (unchanged single bot)', () => {
    const f = startEpisode(0, 0, 4, 70, 'p')
    for (const c of spiralColumns(0, 0, 4)) scanRecord(f, c, OK)
    assert.equal(f.cands.length, 81)
  })
})

describe('flat swarm: helpers are never players', () => {
  const { isSwarmBot } = require('../src/worker')
  it('swarm off = no-op', () => {
    assert.equal(isSwarmBot('IdkSwarm1', {}), false)
  })
  it('swarm on drops <prefix>1..32 only', () => {
    const env = { BOT_SWARM_N: '9' }
    assert.equal(isSwarmBot('IdkSwarm1', env), true)
    assert.equal(isSwarmBot('IdkSwarm8', env), true)
    assert.equal(isSwarmBot('IdkSwarm32', env), true)
    assert.equal(isSwarmBot('IdkSwarm33', env), false)
    assert.equal(isSwarmBot('IdkSwarm0', env), false)
    assert.equal(isSwarmBot('IdkSwarm9', env), true)
    assert.equal(isSwarmBot('IdkSwarm', env), false)
    assert.equal(isSwarmBot('Owner', env), false)
    assert.equal(isSwarmBot('Flat3', { ...env, BOT_SWARM_PREFIX: 'Flat' }), true)
  })
  it('bot2 name is dropped with or without the swarm; bot2 env shape does not split', () => {
    assert.equal(isSwarmBot('IdkV2', { BOT2_USERNAME: 'IdkV2' }), true)
    assert.equal(isSwarmBot('IdkV2', {}), false)
    const b2 = { BOT_SWARM_N: '13', BOT_SWARM_PREFIX: 'IdkSwarm', BOT_SWARM_I: '-1', BOT2_USERNAME: 'IdkV2' }
    assert.equal(isSwarmBot('IdkSwarm3', b2), true)
    assert.equal(require('../src/behaviours/flat').swarmTile(b2), null)
  })
  it('a helper also drops the main bot; the main bot keeps seeing itself as itself', () => {
    assert.equal(isSwarmBot('IdkBot', { BOT_SWARM_N: '9', BOT_SWARM_I: '2', BOT_PEER_USERNAME: 'IdkBot' }), true)
    assert.equal(isSwarmBot('IdkBot', { BOT_SWARM_N: '9' }), false)
  })
})

describe('flat swarm: selectBody idles swarm bots past BOT_SWARM_N', () => {
  it('swarm bot idles when the swarm is off or its index is out of range', () => {
    assert.ok(selectBody({ BOT_SWARM_I: '1' }).idle)
    assert.ok(selectBody({ BOT_SWARM_I: '1' }).swarmIdle)
    assert.ok(!selectBody({ BOT_BODY: 'baritone' }).swarmIdle) // v2 idle keeps holding
    assert.ok(selectBody({ BOT_SWARM_I: '5', BOT_SWARM_N: '5' }).idle)
    assert.ok(!selectBody({ BOT_SWARM_I: '4', BOT_SWARM_N: '5' }).idle)
    assert.ok(!selectBody({ BOT_SWARM_I: '8', BOT_SWARM_N: '9' }).idle)
  })
  it('the main bot (index 0/unset) never idles', () => {
    assert.ok(!selectBody({}).idle)
    assert.ok(!selectBody({ BOT_SWARM_N: '' }).idle)
    assert.ok(!selectBody({ BOT_SWARM_I: '0' }).idle)
  })
})
