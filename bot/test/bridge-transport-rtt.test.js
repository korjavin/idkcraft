'use strict'
// idkcraft-neuc.67.1: BridgeTransport.takeRtt — per-method reply round trips for body.stats.
const { test } = require('node:test')
const assert = require('node:assert')
const { BridgeTransport } = require('../src/bridge/transport')

test('takeRtt counts replies per method, heaviest total first, then resets', async () => {
  const t = new BridgeTransport('ws://unused', { timeoutMs: 1000 })
  const sent = []
  t.ws = { send: (s) => sent.push(JSON.parse(s)) }
  const calls = [t.call('dig.start'), t.call('chunk.get'), t.call('chunk.get')]
  for (const m of sent) t._onMessage(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }))
  await Promise.all(calls)
  const s = t.takeRtt()
  assert.match(s, /^chunk\.get=2\/\d+\/\d+ dig\.start=1\/\d+\/\d+$|^dig\.start=1\/\d+\/\d+ chunk\.get=2\/\d+\/\d+$/)
  assert.strictEqual(t.takeRtt(), '')
})

test('takeRtt counts a timed-out call at timeoutMs', async () => {
  const t = new BridgeTransport('ws://unused', { timeoutMs: 20 })
  t.ws = { send: () => {} }
  await assert.rejects(t.call('dig.start'), /timeout/)
  assert.strictEqual(t.takeRtt(), 'dig.start=1/20/20')
})
