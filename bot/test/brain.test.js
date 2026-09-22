'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain } = require('../src/brain')

describe('stubBrain', () => {
  it('roams when the player is close and still with no hostile (dist 1)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1, player_moving: false }), { action: 'roam', sprint: false, source: 'stub' })
  })
  it('idles when the player is close but moving (dist 1)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1, player_moving: true }), { action: 'idle', sprint: false, source: 'stub' })
  })
  it('idles when close and still but a hostile is near (no roam into danger)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1, player_moving: false, hostile_distance: 4, bot_health: 5 }), { action: 'idle', sprint: false, source: 'stub' })
  })
  it('fight wins over roam when a hostile is in range (dist 1, still)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1, player_moving: false, hostile_distance: 4, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
  })
  it('fight wins over roam on hostile_near_player alone (dist 1, still)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 1, player_moving: false, hostile_near_player: true, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
  })
  it('follow wins over roam once the player is beyond the envelope (dist 7, still)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 7, player_moving: false }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('follows without sprint at mid range while the player moves (dist 5)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 5, player_moving: true }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('roams the stroll envelope while the player is still (dist 5)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 5, player_moving: false }), { action: 'roam', sprint: false, source: 'stub' })
  })
  it('idles when the player is close and moving (dist 2)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 2, player_moving: true }), { action: 'idle', sprint: false, source: 'stub' })
  })
  it('falls back to the legacy rule on hostile facts at low health (dist 5, still)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 5, player_moving: false, hostile_distance: 4, bot_health: 5 }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('follows with sprint when far (dist 12)', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 12 }), { action: 'follow', sprint: true, source: 'stub' })
  })
  it('idles when there is no target', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: null }), { action: 'idle', sprint: false, source: 'stub' })
  })
  it('fights when hostile is in range and healthy (hostile 4 blocks, health 20)', () => {
    assert.deepEqual(stubBrain.decide({ hostile_distance: 4, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
  })
  it('fights at exact boundary (hostile 8 blocks, health 6)', () => {
    assert.deepEqual(stubBrain.decide({ hostile_distance: 8, bot_health: 6 }), { action: 'fight', sprint: false, source: 'stub' })
  })
  it('does not fight when hostile is just beyond radius (hostile 8.1 blocks)', () => {
    assert.deepEqual(stubBrain.decide({ hostile_distance: 8.1, hostile_near_player: false, bot_health: 20, distance_to_player: 5 }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('does not fight when health is low (health 5)', () => {
    assert.deepEqual(stubBrain.decide({ hostile_distance: 4, bot_health: 5, distance_to_player: 5 }), { action: 'follow', sprint: false, source: 'stub' })
  })
  it('fights with hostile_near_player only', () => {
    assert.deepEqual(stubBrain.decide({ hostile_near_player: true, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
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

  it('maps a canned JEV answer to fight with source jev', async () => {
    const canned = async () => ({
      ok: true,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          action: { type: 'choice', choice: 'fight', probabilities: { fight: 0.9, follow: 0.05, idle: 0.05 }, confidence: 0.8 },
          sprint: { type: 'noul', noul: 0.1 }
        },
        usage: {}
      })
    })
    const decision = await jevBrain('test-key', canned).decide({ hostile_distance: 4, bot_health: 20 })
    assert.deepEqual(decision, { action: 'fight', sprint: false, source: 'jev' })
  })

  it('falls back to stub with source stub-fallback when the call throws', async () => {
    const failing = async () => { throw new Error('boom 429') }
    const decision = await jevBrain('test-key', failing).decide(state)
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'stub-fallback' })
  })

  it('falls back to stub with source stub-fallback on http error', async () => {
    const denied = async () => ({ ok: false, status: 401 })
    const decision = await jevBrain('bogus', denied).decide({ distance_to_player: 1 })
    assert.deepEqual(decision, { action: 'roam', sprint: false, source: 'stub-fallback' })
  })

  it('sends the expected request shape', async () => {
    let seen = null
    const spy = async (url, opts) => {
      seen = { url, opts: { ...opts, body: JSON.parse(opts.body) } }
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'follow' }, sprint: { type: 'noul', noul: 0.1 } } }) }
    }
    await jevBrain('k', spy).decide(state)
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.opts.method, 'POST')
    assert.equal(seen.opts.headers.Authorization, 'Bearer k')
    assert.equal(seen.opts.body.model, 'jev-latest')
    assert.deepEqual(Object.keys(seen.opts.body.questions).sort(), ['action', 'sprint'])
    assert.deepEqual(Object.keys(seen.opts.body.questions.action.criteria), ['fight', 'follow', 'idle', 'roam'])
    assert.equal(typeof seen.opts.body.state, 'string')
    assert.match(seen.opts.body.state, /distance_to_player=12\.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false/)
  })

  it('maps a canned remote answer to roam with source jev', async () => {
    const canned = async () => ({
      ok: true,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          action: { type: 'choice', choice: 'roam', probabilities: { roam: 0.9, idle: 0.1 }, confidence: 0.8 },
          sprint: { type: 'noul', noul: 0.1 }
        },
        usage: {}
      })
    })
    const origError = console.error
    const logs = []
    console.error = (msg) => logs.push(msg)
    try {
      const decision = await jevBrain('test-key', canned).decide({ distance_to_player: 1, player_moving: false })
      assert.deepEqual(decision, { action: 'roam', sprint: false, source: 'jev' })
      assert.equal(logs.length, 0) // stub agrees: roam
    } finally {
      console.error = origError
    }
  })

  it('logs brain disagree when the model idles where the stub roams', async () => {
    const origError = console.error
    const logs = []
    console.error = (msg) => logs.push(msg)
    try {
      const canned = async () => ({
        ok: true,
        json: async () => ({
          answers: {
            action: { type: 'choice', choice: 'idle' },
            sprint: { type: 'noul', noul: 0.1 }
          }
        })
      })
      const decision = await jevBrain('test-key', canned).decide({ distance_to_player: 1, player_moving: false })
      assert.deepEqual(decision, { action: 'idle', sprint: false, source: 'jev' })
      assert.equal(logs.length, 1)
      assert.match(logs[0], /^brain disagree source=jev model=idle stub=roam state=.*distance_to_player=1\.0/)
    } finally {
      console.error = origError
    }
  })

  it('logs brain disagree when model action differs from stub reference', async () => {
    const origError = console.error
    const logs = []
    console.error = (msg) => logs.push(msg)
    try {
      const canned = async () => ({
        ok: true,
        json: async () => ({
          answers: {
            action: { type: 'choice', choice: 'follow' },
            sprint: { type: 'noul', noul: 0.1 }
          }
        })
      })
      const hostileState = {
        distance_to_player: 12,
        player_visible: true,
        player_moving: false,
        bot_health: 20,
        bot_food: 20,
        nearby_hostiles: 1,
        hostile_distance: 4,
        hostile_near_player: false
      }
      const decision = await jevBrain('test-key', canned).decide(hostileState)
      assert.deepEqual(decision, { action: 'follow', sprint: false, source: 'jev' })
      assert.equal(logs.length, 1)
      assert.match(logs[0], /^brain disagree source=jev model=follow stub=fight state=.*hostile_distance=4\.0 hostile_near_player=false/)
    } finally {
      console.error = origError
    }
  })

  it('does not log brain disagree when model and stub agree', async () => {
    const origError = console.error
    const logs = []
    console.error = (msg) => logs.push(msg)
    try {
      const canned = async () => ({
        ok: true,
        json: async () => ({
          answers: {
            action: { type: 'choice', choice: 'follow' },
            sprint: { type: 'noul', noul: 0.1 }
          }
        })
      })
      const agreeState = { distance_to_player: 5, player_moving: true, bot_health: 20 }
      const decision = await jevBrain('test-key', canned).decide(agreeState)
      assert.deepEqual(decision, { action: 'follow', sprint: false, source: 'jev' })
      assert.equal(logs.length, 0)
    } finally {
      console.error = origError
    }
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

describe('configurable brain endpoint (laya sidecar)', () => {
  const LAYA = 'http://laya:8000/v1/systemone'
  const state = { distance_to_player: 5, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 0 }

  it('(a) empty key sends no Authorization, same body shape, source laya', async () => {
    let seen = null
    const fake = async (url, opts) => {
      seen = { url, headers: opts.headers, body: JSON.parse(opts.body) }
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'follow' }, sprint: { type: 'noul', noul: 0.9 } } }) }
    }
    const decision = await jevBrain('', fake, 1000, LAYA).decide(state)
    assert.equal(seen.url, LAYA)
    assert.ok(!('Authorization' in seen.headers))
    assert.equal(seen.headers['Content-Type'], 'application/json')
    assert.equal(seen.body.model, 'jev-latest')
    assert.deepEqual(Object.keys(seen.body.questions).sort(), ['action', 'sprint'])
    assert.equal(typeof seen.body.state, 'string')
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'laya' })
  })

  it('(b) makeBrain picks remote for BRAIN_URL, stub for empty env', () => {
    assert.equal(makeBrain({ BRAIN_URL: LAYA }).name, 'laya')
    assert.equal(makeBrain({}).name, 'stub')
  })

  it('(c) BRAIN_TIMEOUT_MS bounds a hanging call', async () => {
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const origFetch = global.fetch
    global.fetch = hanging
    try {
      const brain = makeBrain({ BRAIN_URL: LAYA, BRAIN_TIMEOUT_MS: '50' })
      const t0 = Date.now()
      const decision = await brain.decide({ distance_to_player: 12 })
      assert.ok(Date.now() - t0 < 1000, 'aborted near the 50 ms deadline')
      assert.equal(decision.source, 'stub-fallback')
    } finally {
      global.fetch = origFetch
    }
  })
})

describe('makeBrain', () => {
  it('picks stub without a key and jev with a key', () => {
    assert.equal(makeBrain({}).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: '' }).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: 'x' }).name, 'jev')
  })
})
