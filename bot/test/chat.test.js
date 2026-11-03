'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat } = require('../src/chat')
const llmOrders = require('../src/llm-orders')

// Mineflayer chat surface: docs/api.md Bot.username, Bot.players and Bot.chat.
// Ticker methods match the chat dispatch contract in src/index.js/createTicker.
function rig(username) {
  const calls = []
  const bot = { username, players: { P: { username: 'P' } }, _tickerCtx: {}, chat: (text) => calls.push(['chat', text]) }
  const ticker = {
    setFlat: (order) => { calls.push(['flat', order]); return 'flattening' },
    setFollow: (name) => calls.push(['follow', name]),
  }
  return { calls, send: (text) => handleChat(bot, ticker, 'P', text) }
}

describe('chat addressing (idkcraft-gs5s)', () => {
  let savedOwner, originalEnabled, originalAsk, asks
  beforeEach(() => {
    savedOwner = process.env.OWNER_USERNAME
    delete process.env.OWNER_USERNAME
    originalEnabled = llmOrders.enabled
    originalAsk = llmOrders.ask
    asks = []
    llmOrders.enabled = () => true
    llmOrders.ask = (_bot, _ctx, options) => { asks.push(options.text); return true }
  })
  afterEach(() => {
    if (savedOwner === undefined) delete process.env.OWNER_USERNAME
    else process.env.OWNER_USERNAME = savedOwner
    llmOrders.enabled = originalEnabled
    llmOrders.ask = originalAsk
  })

  it('only the addressed bot executes flat among four unconfigured bots', () => {
    for (const name of ['IdkBotV2', 'IdkBotV2b', 'IdkBotV2c', 'IdkBotV2d']) {
      const r = rig(name)
      r.send('IdkBotV2b: flat 5')
      assert.equal(r.calls.filter(([kind]) => kind === 'flat').length, name === 'IdkBotV2b' ? 1 : 0, name)
      if (name !== 'IdkBotV2b') assert.deepEqual(r.calls, [], name)
    }
    assert.deepEqual(asks, [])
  })

  it('ignores every other address before handlers or LLM orders, even unknown names', () => {
    const r = rig('IdkBotV2')
    for (const name of ['UnknownBot', 'x', '.Guest_2', 'a'.repeat(32)]) {
      for (const command of ['flat 5', 'follow me', 'plan build a farm', 'please do something clever']) r.send(`${name}: ${command}`)
    }
    assert.deepEqual(r.calls, [])
    assert.deepEqual(asks, [])
    r.send('please do something clever')
    assert.deepEqual(asks, ['please do something clever'], 'broadcast control proves the model path was enabled')
  })

  it('accepts exact case-insensitive addresses across the specified name range', () => {
    for (const name of ['x', '.Guest_2', 'a'.repeat(32)]) {
      const r = rig(name)
      r.send(`${name.toUpperCase()}:flat 5`)
      assert.equal(r.calls[0][0], 'flat', name)
    }
    assert.deepEqual(asks, [])
  })

  it('preserves unprefixed flat and follow broadcasts for all bots', () => {
    for (const name of ['IdkBotV2', 'IdkBotV2b', 'IdkBotV2c', 'IdkBotV2d']) {
      const r = rig(name)
      r.send('flat 5')
      r.send('follow me')
      assert.equal(r.calls.filter(([kind]) => kind === 'flat').length, 1, name)
      assert.deepEqual(r.calls.find(([kind]) => kind === 'follow'), ['follow', 'P'], name)
    }
    assert.deepEqual(asks, [])
  })
})
