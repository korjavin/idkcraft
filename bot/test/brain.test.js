'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain } = require('../src/brain')

describe('stubBrain', () => {
  it('idles when the player is close (dist 1)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1 }), { action: 'idle', sprint: false, source: 'stub' })
  })
  it('follows without sprint at mid range (dist 5)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 5 }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('follows with sprint when far (dist 12)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 12 }), { action: 'follow', sprint: true, source: 'stub' })
  })
  it('idles when there is no target', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: null }), { action: 'idle', sprint: false, source: 'stub' })
  })
})

describe('jevBrain', () => {
  const state = { distance_to_player: 12, player_visible: true, player_moving: true, bot_health: 20, bot_food: 20, nearby_hostiles: 0 }

  it('maps a canned JEV answer to follow/sprint with source jev', async () => {
    const canned = async () => ({
      ok: true,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          action: { type: 'choice', choice: 'follow', probabilities: { follow: 0.9, idle: 0.1 }, confidence: 0.8 },
          sprint: { type: 'noul', noul: 0.95 }
        },
        usage: {}
      })
    })
    const decision = await jevBrain('test-key', canned).decide(state)
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'jev' })
  })

  it('falls back to stub with source stub-fallback when the call throws', async () => {
    const failing = async () => { throw new Error('boom 429') }
    const decision = await jevBrain('test-key', failing).decide(state)
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'stub-fallback' })
  })

  it('falls back to stub with source stub-fallback on http error', async () => {
    const denied = async () => ({ ok: false, status: 401 })
    const decision = await jevBrain('bogus', denied).decide({ distance_to_player: 1 })
    assert.deepEqual(decision, { action: 'idle', sprint: false, source: 'stub-fallback' })
  })

  it('sends the expected request shape', async () => {
    let seen = null
    const spy = async (url, opts) => {
      seen = { url, opts: { ...opts, body: JSON.parse(opts.body) } }
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'idle' }, sprint: { type: 'noul', noul: 0.1 } } }) }
    }
    await jevBrain('k', spy).decide(state)
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.opts.method, 'POST')
    assert.equal(seen.opts.headers.Authorization, 'Bearer k')
    assert.equal(seen.opts.body.model, 'jev-latest')
    assert.deepEqual(Object.keys(seen.opts.body.questions).sort(), ['action', 'sprint'])
    assert.equal(typeof seen.opts.body.state, 'string')
    assert.match(seen.opts.body.state, /distance_to_player=12\.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0/)
  })
})

describe('jevBrain timeout', () => {
  it('stalled fetch aborts -> stub-fallback within the deadline', async () => {
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const t0 = Date.now()
    const decision = await jevBrain('k', hanging, 50).decide({ distance_to_player: 12 })
    assert.ok(Date.now() - t0 < 1000, 'fell back promptly')
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'stub-fallback' })
  })
})

describe('makeBrain', () => {
  it('picks stub without a key and jev with a key', () => {
    assert.equal(makeBrain({}).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: '' }).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: 'x' }).name, 'jev')
  })
})
