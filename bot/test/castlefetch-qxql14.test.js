'use strict'

// idkcraft-qxql.14 (synq follow-up, deferred from #631): every
// 'quarry side N unusable' line is followed within the leg by a named
// recovery line — the starved handover to the pit, or the named fail
// into the per-kind hold when the pit is dead too.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fetch = require('../src/behaviours/castlefetch')
require('../src/index') // BEHAVIOURS registration (goal.registered)

const SITE = { x: 100, y: 64, z: 200 }

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
}

function makeBot({ items = [], set = new Map(), at = pos(SITE.x, 64, SITE.z) } = {}) {
  const nameAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    if (set.has(k)) return set.get(k)
    const y = Math.floor(p.y)
    return y <= 63 ? 'dirt' : 'air'
  }
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    registry: {
      blocksByName: { stone: { id: 1 }, chest: { id: 2 } },
      itemsByName: { cobblestone: {}, dirt: {}, stone: {} },
    },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    findBlocks: () => [],
    equip: async () => {},
    dig: async () => {},
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function castleState() {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
}

function quiet(fn) {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  try { fn() } finally { console.log = orig }
  return lines
}

describe('qxql.14 quarry-side recovery line', () => {
  it('starved ground: unusable lines are followed by the pit handover and the named hold fail', () => {
    // Drown every trench probe and every pit probe below the surface.
    const set = new Map()
    const st = castleState()
    for (let ring = 0; ring < 2; ring++) {
      for (let s = 0; s < 4; s++) {
        const o = fetch.quarrySide(st, s, ring)
        for (let y = SITE.y - 8; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
      }
    }
    for (const o of fetch.pitSpots(st)) {
      for (let y = SITE.y - 8; y <= SITE.y + 3; y++) set.set(`${o.x},${y},${o.z}`, 'water')
    }
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], set })
    const ctx = { castle: st }
    const f = { kind: 'stone', skip: new Set(), target: null }
    let lines = []
    lines = quiet(() => fetch.digTick(bot, ctx, f))
    const unusable = lines.findIndex((m) => m.includes('quarry side 0 unusable') || m.includes('quarry side 0 ring 1 unusable') || /quarry side \d/.test(m) && m.includes('unusable'))
    assert.ok(unusable >= 0, `quarry sides log unusable, got: ${lines.join(' | ')}`)
    const handover = lines.findIndex((m) => m.includes('castlefetch quarry recovery: all sides dead/dug, trying pit'))
    assert.ok(handover > unusable, `pit handover follows the unusable lines, got: ${lines.join(' | ')}`)
    const holdFail = lines.findIndex((m) => m.includes('castlefetch quarry recovery: pit dead, failing no-stone into hold'))
    assert.ok(holdFail > handover, `pit-dead hold line follows the handover, got: ${lines.join(' | ')}`)
    assert.equal(ctx.stepStatus, 'failed:castlefetch-no-stone')
  })

  it('live pad: no recovery line fires (trench path untouched)', () => {
    const set = new Map()
    const st = castleState()
    const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], set })
    const ctx = { castle: st }
    const f = { kind: 'stone', skip: new Set(), target: null }
    const lines = quiet(() => fetch.digTick(bot, ctx, f))
    assert.ok(!lines.some((m) => m.includes('castlefetch quarry recovery:')), `no recovery on a live pad, got: ${lines.join(' | ')}`)
    assert.ok(f.target && f.target.quarry, 'first pick is still a trench cell')
  })
})
