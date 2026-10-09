'use strict'

// idkcraft-vmzq.62: the re-decide forces table — one firing and one
// non-firing trace per entry, plus the force= field on the step line.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { FORCES, decide, goalFacts, goalText, CASTLEFETCH_RETRY_MS, BUILD_RETRY_MS } = require('../src/goal')

const pos = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) })
function bot(extra = {}) {
  return { entity: { position: pos(0, 64, 0) }, inventory: { items: () => [] }, time: { timeOfDay: 6000 }, spawnPoint: pos(0, 64, 0), chat: () => {}, ...extra }
}
const flatBot = () => bot({ blockAt: (p) => ({ name: Math.floor(p.y) <= 63 ? 'dirt' : 'air' }) })
const F = Object.fromEntries(FORCES.map((f) => [f.name, f]))
const fire = (name, { prev = 'castle', facts = {}, ctx = {}, status = 'running', b = bot(), text = 'time=day' } = {}) =>
  F[name].fires(prev, facts, ctx, status, b, text)

const BASE = 'time=day logs=none health=ok food=ok known=none'

describe('FORCES table (vmzq.62)', () => {
  it('every entry names itself, its bead and its kind', () => {
    for (const f of FORCES) {
      assert.match(f.name, /^[a-z-]+$/)
      assert.match(f.bead, /^idkcraft-[a-z0-9.]+$/)
      assert.ok(f.kind === 'gate' || f.kind === 'word', f.name)
      assert.equal(typeof f.fires, 'function')
    }
    assert.equal(new Set(FORCES.map((f) => f.name)).size, FORCES.length)
  })

  it('chain: fires on the chain-owned step only', () => {
    assert.equal(fire('chain', { prev: 'retreat', ctx: { retreat: { action: 'retreat' } } }), true)
    assert.equal(fire('chain', { prev: 'castle', ctx: { retreat: { action: 'retreat' } } }), false)
  })

  it('fetch-retry: an expired castlefetch hold retires and fires; a fresh one stands', () => {
    const ctx = { stepFail: { castlefetch: { at: Date.now() - CASTLEFETCH_RETRY_MS - 1 } } }
    assert.equal(fire('fetch-retry', { ctx }), true)
    assert.equal(ctx.stepFail.castlefetch, undefined)
    const fresh = { stepFail: { castlefetch: { at: Date.now() } } }
    assert.equal(fire('fetch-retry', { ctx: fresh }), false)
    assert.ok(fresh.stepFail.castlefetch)
  })

  it('gate-opened: fires on the gated->open edge only, writing the latch', () => {
    const ctx = { lowHpWasGated: true }
    assert.equal(fire('gate-opened', { ctx, facts: { health: 20 } }), true)
    assert.equal(ctx.lowHpWasGated, false)
    assert.equal(fire('gate-opened', { ctx, facts: { health: 20 } }), false)
    const gated = { lowHpWasGated: false }
    assert.equal(fire('gate-opened', { ctx: gated, facts: { health: 2 } }), false)
    assert.equal(gated.lowHpWasGated, true)
  })

  it('build-retry: an expired non-no-site hold fires once and voids its key', () => {
    const rec = { status: 'failed:no-path', at: Date.now() - BUILD_RETRY_MS - 1, text: 't', pos: { x: 0, y: 0, z: 0 }, n: 2 }
    const ctx = { stepFail: { build: rec } }
    assert.equal(fire('build-retry', { ctx }), true)
    assert.deepEqual([rec.retryFired, rec.text, rec.pos, rec.n], [true, null, null, 2])
    assert.equal(fire('build-retry', { ctx }), false, 'one-shot')
    const noSite = { stepFail: { build: { status: 'failed:no-site', at: 0 } } }
    assert.equal(fire('build-retry', { ctx: noSite }), false)
  })

  it('site-retry: a no-site hold retires when a spawn site validates now', () => {
    const ctx = { stepFail: { build: { status: 'failed:no-site', text: BASE } } }
    assert.equal(fire('site-retry', { ctx, b: flatBot(), text: BASE }), true)
    assert.equal(ctx.stepFail.build, undefined)
    const unloaded = { stepFail: { build: { status: 'failed:no-site', text: BASE } } }
    assert.equal(fire('site-retry', { ctx: unloaded, b: bot(), text: BASE }), false)
    const moved = { stepFail: { build: { status: 'failed:no-site', text: 'other' } } }
    assert.equal(fire('site-retry', { ctx: moved, b: flatBot(), text: BASE }), false)
    assert.ok(moved.stepFail.build)
  })

  it('gear-yield: gear done fires; gear running or another done does not', () => {
    assert.equal(fire('gear-yield', { prev: 'gear', status: 'done' }), true)
    assert.equal(fire('gear-yield', { prev: 'gear', status: 'running' }), false)
    assert.equal(fire('gear-yield', { prev: 'craft', status: 'done' }), false)
  })

  it('order: no step with a standing text fires; first boot does not', () => {
    assert.equal(fire('order', { prev: null, ctx: { goalText: BASE } }), true)
    assert.equal(fire('order', { prev: null, ctx: {} }), false)
    assert.equal(fire('order', { prev: 'castle', ctx: { goalText: BASE } }), false)
  })

  const words = [
    ['time', BASE, BASE.replace('time=day', 'time=dusk')],
    ['health', BASE, BASE.replace('health=ok', 'health=low')],
    ['food', BASE, BASE.replace('food=ok', 'food=hungry')],
    ['castle-word', `${BASE} castle=stone`, `${BASE} castle=wait`],
    ['kit', `${BASE} pickaxe=no`, BASE],
  ]
  for (const [name, old, next] of words) {
    it(`${name}: fires on its word flip, not on another word's`, () => {
      assert.equal(fire(name, { ctx: { goalText: old }, text: next }), true)
      assert.equal(fire(name, { ctx: { goalText: old }, text: old.replace('known=none', 'known=near') }), false)
    })
  }
})

describe('force= on the goal step line (vmzq.62)', () => {
  let origLog
  let lines
  beforeEach(() => {
    origLog = console.log
    lines = []
    console.log = (l) => { lines.push(String(l)) }
  })
  afterEach(() => { console.log = origLog })
  const stepLine = () => lines.find((l) => l.startsWith('goal step=')) || ''

  it('a gate force names itself after why=', async () => {
    const b = bot()
    const ctx = {}
    const text = goalText(goalFacts(b, ctx))
    Object.assign(ctx, { step: 'rest', stepStatus: 'running', goalText: text, stepFail: { castlefetch: { at: Date.now() - CASTLEFETCH_RETRY_MS - 1 } } })
    await decide(b, ctx)
    assert.match(stepLine(), /^goal step=gather prev=rest .* why=facts-changed force=fetch-retry menu=/)
  })

  it('a word flip names its word', async () => {
    const b = bot()
    const ctx = {}
    const text = goalText(goalFacts(b, ctx))
    Object.assign(ctx, { step: 'rest', stepStatus: 'running', goalText: text.replace('time=day', 'time=night') })
    await decide(b, ctx)
    assert.match(stepLine(), / why=facts-changed force=time menu=/)
  })

  it('an order-cleared step reads force=order; no force, no field', async () => {
    const b = bot()
    await decide(b, { goalText: 'time=day' })
    assert.match(stepLine(), / why=start force=order menu=/)
    lines.length = 0
    await decide(b, {})
    assert.doesNotMatch(stepLine(), /force=/)
  })
})
