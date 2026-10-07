'use strict'

// idkcraft-vmzq.41: rig CASTLE_BURY_NOWOOD — every hand-staircase step
// after the first failed the mount with failed:head-blocked. The leap backs
// off the face into the column behind, where the last step's dug head has
// rock over it (a lip); headBlockedAt vetoes the jump. dig_step now digs
// that lip before mounting.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

// Staircase climbing +x, one step already mounted: body at (1,38) drifted
// back to x=1.3; behind (0,38),(0,39) open with rock at (0,40); own head
// and the next step's above/cap already dug; step (2,38) is stone.
function stairBot(extra = {}) {
  const air = new Set(['0,38,0', '0,39,0', '1,38,0', '1,39,0', '1,40,0', '2,39,0', '2,40,0'])
  const dug = []
  const bot = {
    username: 'IdkBot', players: {}, entities: {}, health: 20, food: 20,
    entity: { position: new Vec3(1.3, 38, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) },
    inventory: { items: () => [] },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    look() {},
    blockAt(q) {
      const x = Math.floor(q.x); const y = Math.floor(q.y); const z = Math.floor(q.z)
      const k = `${x},${y},${z}`
      if (extra[k]) return { name: extra[k], position: new Vec3(x, y, z), boundingBox: 'empty' }
      const open = air.has(k)
      return { name: open ? 'air' : 'stone', position: new Vec3(x, y, z), boundingBox: open ? 'empty' : 'block' }
    },
    async dig(b) { await Promise.resolve(); const k = `${b.position.x},${b.position.y},${b.position.z}`; dug.push(k); air.add(k) },
  }
  return { bot, dug }
}
const tickDrain = async () => { for (let i = 0; i < 3; i++) await new Promise((res) => setImmediate(res)) }

describe('dig_step behind lip (vmzq.41)', () => {
  it('digs the lip behind instead of failing the mount head-blocked', async () => {
    const { bot, dug } = stairBot()
    const ctx = { recovery: {} }
    const run = recover.RECOVER_MENU.dig_step.run
    assert.equal(run(bot, ctx), 'running')
    await tickDrain()
    assert.deepEqual(dug, ['0,40,0'], 'the lip behind digs first')
    const r = run(bot, ctx)
    assert.equal(r, 'running', `then the mount drives, got ${r}`)
    assert.ok(ctx.recovery.st.stepPos, 'mount anchored on the step')
  })

  it('lava over the lip: no dig, the head veto stands', () => {
    const { bot, dug } = stairBot({ '0,41,0': 'lava' })
    const r = recover.RECOVER_MENU.dig_step.run(bot, { recovery: {} })
    assert.equal(r, 'failed:head-blocked')
    assert.deepEqual(dug, [])
  })

  it('a denied lip (water over it) falls through to the mount veto, not failed:submerged', () => {
    const { bot, dug } = stairBot({ '0,41,0': 'water' })
    const r = recover.RECOVER_MENU.dig_step.run(bot, { recovery: {} })
    assert.equal(r, 'failed:head-blocked')
    assert.deepEqual(dug, [])
  })
})
