'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { stubBrain, jevBrain, makeBrain, hybridBrain, isHard, stateToText, numericStateToText } = require('../src/brain')

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
  it('yields follow for an unreachable hostile not near the player', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 10, player_moving: false, hostile_distance: 4, hostile_near_player: false, hostile_reachable: false, bot_health: 20 }), { action: 'follow', sprint: true, source: 'stub' })
  })
  it('still fights an unreachable hostile that threatens the player', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 10, player_moving: false, hostile_distance: 12, hostile_near_player: true, hostile_reachable: false, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
  })
  it('treats a missing reachable flag as reachable', () => {
    assert.deepEqual(stubBrain.decide({ distance_to_player: 10, hostile_distance: 4, hostile_near_player: false, bot_health: 20 }), { action: 'fight', sprint: false, source: 'stub' })
  })
})

describe('stateToText categorical buckets', () => {
  const base = { distance_to_player: 5, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 1, hostile_distance: 4, hostile_near_player: false }

  it('classifies player boundary 3: <= 3 is near, > 3 is far', () => {
    assert.match(stateToText({ ...base, distance_to_player: 3 }), /\bplayer=near\b/)
    assert.match(stateToText({ ...base, distance_to_player: 3.1 }), /\bplayer=far\b/)
  })

  it('classifies player boundary 6: <= 6 is far, > 6 is away', () => {
    assert.match(stateToText({ ...base, distance_to_player: 6 }), /\bplayer=far\b/)
    assert.match(stateToText({ ...base, distance_to_player: 6.1 }), /\bplayer=away\b/)
  })

  it('classifies player null/undefined/NaN as none', () => {
    assert.match(stateToText({ ...base, distance_to_player: null }), /\bplayer=none\b/)
    assert.match(stateToText({ ...base, distance_to_player: undefined }), /\bplayer=none\b/)
    assert.match(stateToText({ ...base, distance_to_player: NaN }), /\bplayer=none\b/)
  })

  it('classifies hostile boundary 3: <= 3 is adjacent, > 3 is near', () => {
    assert.match(stateToText({ ...base, hostile_distance: 3 }), /\bhostile=adjacent\b/)
    assert.match(stateToText({ ...base, hostile_distance: 3.1 }), /\bhostile=near\b/)
  })

  it('classifies hostile boundary 8: <= 8 is near, > 8 is far', () => {
    assert.match(stateToText({ ...base, hostile_distance: 8 }), /\bhostile=near\b/)
    assert.match(stateToText({ ...base, hostile_distance: 8.1 }), /\bhostile=far\b/)
  })

  it('classifies hostile boundary 16: < 16 is far, >= 16 is none', () => {
    assert.match(stateToText({ ...base, hostile_distance: 15.9 }), /\bhostile=far\b/)
    assert.match(stateToText({ ...base, hostile_distance: 16 }), /\bhostile=none\b/)
  })

  it('classifies hostile null/undefined/NaN as none', () => {
    assert.match(stateToText({ ...base, hostile_distance: null }), /\bhostile=none\b/)
    assert.match(stateToText({ ...base, hostile_distance: undefined }), /\bhostile=none\b/)
    assert.match(stateToText({ ...base, hostile_distance: NaN }), /\bhostile=none\b/)
  })

  it('classifies health boundary 6: < 6 is low, >= 6 is ok', () => {
    assert.match(stateToText({ ...base, bot_health: 5.9 }), /\bhealth=low\b/)
    assert.match(stateToText({ ...base, bot_health: 5 }), /\bhealth=low\b/)
    assert.match(stateToText({ ...base, bot_health: 6 }), /\bhealth=ok\b/)
    assert.match(stateToText({ ...base, bot_health: 20 }), /\bhealth=ok\b/)
  })

  it('classifies food boundary: < 6 is hungry, >= 6 is ok', () => {
    assert.match(stateToText({ ...base, bot_food: 5 }), /\bfood=hungry\b/)
    assert.match(stateToText({ ...base, bot_food: 6 }), /\bfood=ok\b/)
    assert.match(stateToText({ ...base, bot_food: 20 }), /\bfood=ok\b/)
  })

  it('classifies boolean flags correctly', () => {
    assert.match(stateToText({ ...base, player_moving: true }), /\bplayer_moving=yes\b/)
    assert.match(stateToText({ ...base, player_moving: false }), /\bplayer_moving=no\b/)
    assert.match(stateToText({ ...base, hostile_near_player: true }), /\bhostile_near_player=yes\b/)
    assert.match(stateToText({ ...base, hostile_near_player: false }), /\bhostile_near_player=no\b/)
  })

  it('classifies hostile_reachable latch: false is no, true/missing is yes', () => {
    assert.match(stateToText(base), /\bhostile_reachable=yes\b/)
    assert.match(stateToText({ ...base, hostile_reachable: true }), /\bhostile_reachable=yes\b/)
    assert.match(stateToText({ ...base, hostile_reachable: false }), /\bhostile_reachable=no\b/)
  })

  it('passes string state through unmodified', () => {
    assert.equal(stateToText('custom state text'), 'custom state text')
  })

  it('handles non-object states gracefully', () => {
    assert.match(stateToText(null), /\bplayer=none\b/)
    assert.match(stateToText(undefined), /\bplayer=none\b/)
  })
})

describe('numericStateToText format', () => {
  const base = { distance_to_player: 5, player_visible: true, player_moving: false, bot_health: 20, bot_food: 20, nearby_hostiles: 1, hostile_distance: 4, hostile_near_player: false }

  it('preserves numeric format for logging', () => {
    const text = numericStateToText(base)
    assert.match(text, /distance_to_player=5\.0/)
    assert.match(text, /player_visible=true/)
    assert.match(text, /player_moving=false/)
    assert.match(text, /bot_health=20/)
    assert.match(text, /bot_food=20/)
    assert.match(text, /nearby_hostiles=1/)
    assert.match(text, /hostile_distance=4\.0/)
    assert.match(text, /hostile_near_player=false/)
    assert.match(text, /hostile_reachable=true/)
  })

  it('renders hostile_reachable=false from the give-up latch', () => {
    assert.match(numericStateToText({ ...base, hostile_reachable: false }), /hostile_reachable=false/)
  })

  it('passes string state through unmodified', () => {
    assert.equal(numericStateToText('already numeric string'), 'already numeric string')
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
    await jevBrain('k', spy).decide(state, 'crowd')
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.opts.method, 'POST')
    assert.equal(seen.opts.headers.Authorization, 'Bearer k')
    assert.equal(seen.opts.body.model, 'jev-latest')
    assert.deepEqual(Object.keys(seen.opts.body.questions), ['action'])
    assert.deepEqual(Object.keys(seen.opts.body.questions.action.criteria), ['fight', 'follow'])
    assert.equal(typeof seen.opts.body.state, 'string')
    assert.match(seen.opts.body.state, /^hard=crowd player=away player_moving=yes hostile=none hostile_near_player=no hostile_reachable=yes health=ok food=ok$/)
    assert.equal(seen.opts.body.questions.action.instructions, 'Choose fight or follow. Health decides: low health always means follow.')
    assert.equal(seen.opts.body.questions.action.criteria.fight, 'health is ok: attack the mob.')
    assert.equal(seen.opts.body.questions.action.criteria.follow, 'health is low: walk to the player and stay close.')
  })

  it('defaults to an empty reason on the wire', async () => {
    let seen = null
    const spy = async (url, opts) => {
      seen = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'follow' } } }) }
    }
    await jevBrain('k', spy).decide(state)
    assert.match(seen.state, /^hard= player=away/)
  })

  it('laya/test/request.json is byte-equal to what brain.js sends', async () => {
    const fs = require('node:fs')
    const path = require('node:path')
    let seen = null
    const spy = async (url, opts) => {
      seen = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'follow' } } }) }
    }
    const hardState = { distance_to_player: 26.8, player_visible: true, player_moving: true, bot_health: 15.8, bot_food: 20, nearby_hostiles: 1, hostile_distance: 0.7, hostile_near_player: false }
    await jevBrain('', spy, 1000, 'http://laya:8000/v1/systemone').decide(hardState, 'hostile-vs-far-player')
    const file = fs.readFileSync(path.join(__dirname, '..', '..', 'laya', 'test', 'request.json'), 'utf8')
    assert.equal(file, JSON.stringify(seen, null, 2) + '\n')
  })

  it('sprint comes from the FSM even when the model noul says sprint', async () => {
    const canned = async () => ({
      ok: true,
      json: async () => ({
        answers: {
          action: { type: 'choice', choice: 'follow' },
          sprint: { type: 'noul', noul: 0.95 }
        }
      })
    })
    // dist 5 moving: FSM says follow without sprint; the 0.95 noul must lose.
    const decision = await jevBrain('test-key', canned).decide({ distance_to_player: 5, player_moving: true })
    assert.deepEqual(decision, { action: 'follow', sprint: false, source: 'jev' })
  })

  it('sprint comes from the FSM even when the model noul says walk', async () => {
    const canned = async () => ({
      ok: true,
      json: async () => ({
        answers: {
          action: { type: 'choice', choice: 'follow' },
          sprint: { type: 'noul', noul: 0.05 }
        }
      })
    })
    // dist 12: FSM says follow with sprint; the 0.05 noul must lose.
    const decision = await jevBrain('test-key', canned).decide({ distance_to_player: 12, player_moving: true })
    assert.deepEqual(decision, { action: 'follow', sprint: true, source: 'jev' })
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
    const decision = await jevBrain('', fake, 1000, LAYA).decide(state, 'crowd')
    assert.equal(seen.url, LAYA)
    assert.ok(!('Authorization' in seen.headers))
    assert.equal(seen.headers['Content-Type'], 'application/json')
    assert.equal(seen.body.model, 'jev-latest')
    assert.deepEqual(Object.keys(seen.body.questions), ['action'])
    assert.equal(typeof seen.body.state, 'string')
    assert.match(seen.body.state, /^hard=crowd /)
    // dist 5 moving: the FSM walks, so sprint is false despite the 0.9 noul.
    assert.deepEqual(decision, { action: 'follow', sprint: false, source: 'laya' })
  })

  it('(b) makeBrain picks hybrid for BRAIN_URL, stub for empty env', () => {
    assert.equal(makeBrain({ BRAIN_URL: LAYA }).name, 'hybrid')
    assert.equal(makeBrain({}).name, 'stub')
  })

  it('(c) BRAIN_TIMEOUT_MS bounds a hanging call on a hard state', async () => {
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const origFetch = global.fetch
    global.fetch = hanging
    try {
      const brain = makeBrain({ BRAIN_URL: LAYA, BRAIN_TIMEOUT_MS: '50' })
      const t0 = Date.now()
      const decision = await brain.decide({ nearby_hostiles: 3, distance_to_player: 5.6, player_moving: false, bot_health: 20 })
      assert.ok(Date.now() - t0 < 1000, 'aborted near the 50 ms deadline')
      assert.equal(decision.source, 'stub-fallback')
    } finally {
      global.fetch = origFetch
    }
  })
  it('(d) easy states never touch the network', async () => {
    let calls = 0
    const origFetch = global.fetch
    global.fetch = async () => { calls++; throw new Error('must not be called') }
    try {
      const brain = makeBrain({ BRAIN_URL: LAYA, BRAIN_TIMEOUT_MS: '50' })
      const decision = await brain.decide({ distance_to_player: 12 })
      assert.equal(decision.source, 'stub')
      assert.equal(calls, 0)
    } finally {
      global.fetch = origFetch
    }
  })
})

describe('makeBrain', () => {
  it('picks stub without a key and hybrid with a key', () => {
    assert.equal(makeBrain({}).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: '' }).name, 'stub')
    assert.equal(makeBrain({ TYPESAFE_API_KEY: 'x' }).name, 'hybrid')
  })
  it('picks hybrid for BRAIN_URL', () => {
    assert.equal(makeBrain({ BRAIN_URL: 'http://laya:8000/v1/systemone' }).name, 'hybrid')
  })
})

describe('isHard', () => {
  it('low-health-hostile for the prod H1 state', () => {
    assert.equal(isHard({ hostile_distance: 9.5, hostile_near_player: true, bot_health: 4.9, distance_to_player: 9.9 }), 'low-health-hostile')
  })
  it('crowd for the prod H2 state', () => {
    assert.equal(isHard({ nearby_hostiles: 3, distance_to_player: 5.6, player_moving: false }), 'crowd')
  })
  it('hostile-vs-far-player for the prod H3 state', () => {
    assert.equal(isHard({ hostile_distance: 0.7, distance_to_player: 26.8, bot_health: 15.8 }), 'hostile-vs-far-player')
  })
  it('unreachable-hostile for the H4 latch state', () => {
    assert.equal(isHard({ hostile_reachable: false, hostile_distance: 4, distance_to_player: 10 }), 'unreachable-hostile')
  })
  it('null for every existing easy stub case', () => {
    const easies = [
      { distance_to_player: 1, player_moving: false },
      { distance_to_player: 2, player_moving: true },
      { distance_to_player: 5, player_moving: true },
      { distance_to_player: 7, player_moving: false },
      { distance_to_player: 12 },
      { distance_to_player: null },
      { hostile_distance: 4, bot_health: 20, distance_to_player: 5 },
      { hostile_distance: 8, bot_health: 6, distance_to_player: 5 }
    ]
    for (const s of easies) assert.equal(isHard(s), null)
  })
  it('precedence: low-health-hostile beats crowd', () => {
    assert.equal(isHard({ hostile_distance: 4, bot_health: 5, nearby_hostiles: 3, distance_to_player: 5 }), 'low-health-hostile')
  })
})

describe('hybridBrain', () => {
  const LAYA = 'http://laya:8000/v1/systemone'
  const canned = (choice, noul = 0.1) => async () => ({
    ok: true,
    json: async () => ({ answers: { action: { type: 'choice', choice }, sprint: { type: 'noul', noul } } })
  })
  async function capture(fn) {
    const origLog = console.log
    const origErr = console.error
    const logs = []
    const errs = []
    console.log = (m) => logs.push(m)
    console.error = (m) => errs.push(m)
    try {
      const r = await fn()
      return { r, logs, errs }
    } finally {
      console.log = origLog
      console.error = origErr
    }
  }

  it('easy: zero fetch calls, deep-equals stub, route line', async () => {
    let calls = 0
    const spy = async () => {
      calls++
      return { ok: true, json: async () => ({ answers: { action: { type: 'choice', choice: 'follow' }, sprint: { type: 'noul', noul: 0.1 } } }) }
    }
    const brain = hybridBrain(jevBrain('k', spy, 1000, LAYA))
    const state = { distance_to_player: 7, player_moving: false }
    const { r, logs } = await capture(() => brain.decide(state))
    assert.equal(calls, 0)
    assert.deepEqual(r, stubBrain.decide(state))
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^brain route=easy fsm=follow$/)
  })

  it('hard low-health: model wins, route carries both answers, disagree still emitted', async () => {
    const state = { hostile_distance: 9.5, hostile_near_player: true, bot_health: 4.9, distance_to_player: 9.9 }
    assert.equal(stubBrain.decide(state).action, 'follow')
    const brain = hybridBrain(jevBrain('', canned('fight', 0.1), 1000, LAYA))
    const { r, logs, errs } = await capture(() => brain.decide(state))
    assert.equal(r.action, 'fight')
    assert.equal(r.source, 'laya')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /brain route=hard reason=low-health-hostile model=fight fsm=follow/)
    assert.equal(errs.length, 1)
    assert.match(errs[0], /^brain disagree/)
  })

  it('hard far-player: FSM fight loses to model follow', async () => {
    const state = { hostile_distance: 0.7, distance_to_player: 26.8, bot_health: 15.8 }
    assert.equal(stubBrain.decide(state).action, 'fight')
    assert.equal(isHard(state), 'hostile-vs-far-player')
    const brain = hybridBrain(jevBrain('', canned('follow', 0.1), 1000, LAYA))
    const { r, logs, errs } = await capture(() => brain.decide(state))
    assert.equal(r.action, 'follow')
    assert.equal(r.source, 'laya')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /brain route=hard reason=hostile-vs-far-player model=follow fsm=fight/)
    assert.equal(errs.length, 1)
    assert.match(errs[0], /^brain disagree/)
  })

  it('passes the isHard reason to the remote brain', async () => {
    let gotReason = null
    const remote = {
      name: 'spy',
      async decide(state, reason) {
        gotReason = reason
        return { action: 'fight', sprint: false, source: 'spy' }
      }
    }
    const brain = hybridBrain(remote)
    const state = { hostile_distance: 9.5, hostile_near_player: true, bot_health: 4.9, distance_to_player: 9.9 }
    await brain.decide(state)
    assert.equal(gotReason, 'low-health-hostile')
  })

  it('fallback: fetch rejects -> FSM answer, source stub-fallback, route line carries it', async () => {
    const state = { nearby_hostiles: 3, distance_to_player: 5.6, player_moving: false, bot_health: 20 }
    const expected = stubBrain.decide(state)
    const failing = async () => { throw new Error('boom') }
    const brain = hybridBrain(jevBrain('', failing, 1000, LAYA))
    const { r, logs } = await capture(() => brain.decide(state))
    assert.equal(r.action, expected.action)
    assert.equal(r.source, 'stub-fallback')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /brain route=hard reason=crowd.*source=stub-fallback/)
  })
})

describe('brain metrics', () => {
  it('counts remote brain outcomes and serves them in the exposition', async () => {
    const metrics = require('../src/metrics')
    const ok = async () => ({ ok: true, json: async () => ({ answers: { action: { choice: 'follow' }, sprint: { noul: 0 } } }) })
    const down = async () => ({ ok: false, status: 503 })
    await jevBrain('k', ok, 1000, 'http://laya:8000/v1/systemone').decide({ distance_to_player: 12 })
    await jevBrain('k', down, 1000, 'http://laya:8000/v1/systemone').decide({ distance_to_player: 12 })
    const text = await metrics.client.register.metrics()
    assert.match(text, /idkcraft_bot_brain_requests_total\{source="laya",outcome="ok"\} [1-9]/)
    assert.match(text, /idkcraft_bot_brain_requests_total\{source="laya",outcome="http"\} [1-9]/)
    assert.match(text, /idkcraft_bot_brain_request_duration_seconds_count\{source="laya"\} [2-9]/)
  })
})
