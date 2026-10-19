'use strict'
// idkcraft-2y8h: the v2 recover line carries next=x,y,z:block like v1 (log only).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { logRecover } = require('../src/behaviours/recover')

function line(bot, ctx) {
  const lines = []
  const orig = console.log
  console.log = (s) => lines.push(String(s))
  try { logRecover(bot, ctx, 'sidestep', 'fsm', 'chosen', null) } finally { console.log = orig }
  return lines
}

function chosen(bot, ctx) {
  const lines = []
  const orig = console.log
  console.log = (s) => lines.push(String(s))
  try {
    logRecover(bot, ctx, 'sidestep', 'fsm', 'chosen', {
      stuck: 'fresh', goal: 'level', dist: 3, scaffold: 0, pickaxe: false, bucket: false, water: false, head: 'free', walls: 0, pit: false, player: 'far', resets: '0/0', last: null,
    })
  } finally { console.log = orig }
  return lines[0]
}

const bot = (extra = {}) => ({ entity: { position: { x: 0.5, y: 64, z: 0.5 } }, blockAt: () => ({ name: 'air' }), ...extra })

describe('recover chosen line next= (v2 has no path nodes)', () => {
  it('v1: lastPathNext wins', () => {
    const l = chosen(bot(), { lastPathNext: { x: 3, y: 64, z: 4 }, stuck: { goal: { x: 99, y: 1, z: 99 } } })
    assert.match(l, / next=3,64,4:air$/)
  })
  it('v2: falls back to the stuck goal', () => {
    const l = chosen(bot(), { stuck: { goal: { x: 10, y: 65, z: -7 } } })
    assert.match(l, / next=10,65,-7:air$/)
  })
  it('v2: level goal reads the bot y; live pathfinder goal when no stuck goal', () => {
    const l = chosen(bot({ pathfinder: { goal: { x: 8, z: 2 } } }), {})
    assert.match(l, / next=8,64,2:air$/)
  })
  it('no goal at all stays ?:?', () => {
    assert.match(chosen(bot(), {}), / next=\?:\?$/)
  })
  it('terminal lines are untouched', () => {
    assert.ok(!/next=/.test(line(bot(), { stuck: { goal: { x: 1, y: 1, z: 1 } } })[0]))
  })
})
