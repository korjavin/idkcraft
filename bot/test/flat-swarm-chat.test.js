const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { handleChat } = require('../src/index')

// vewo.2: the chat sieve end to end through handleChat.
const bodyOf = (name) => ({ username: name, players: {}, chats: [], chat(m) { this.chats.push(String(m)) } })
const KEYS = ['BOT_SWARM_N', 'BOT_SWARM_PREFIX', 'BOT_SWARM_I', 'BOT2_USERNAME', 'BOT_PEER_USERNAME']
function withEnv(env, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
  try { return fn() } finally {
    for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] }
  }
}
const ticker = { setFlat: () => 'ok' }
const count = (env, bodyName, speakers, msg) => withEnv(env, () => {
  const bot = bodyOf(bodyName)
  for (const s of speakers) handleChat(bot, ticker, s, msg)
  return bot.chats.length
})
const swarm13 = Array.from({ length: 13 }, (_, i) => `IdkSwarm${i + 1}`)
// bot2's compose env after vewo.2
const bot2Env = { BOT_SWARM_N: '13', BOT_SWARM_PREFIX: 'IdkSwarm', BOT_SWARM_I: '-1' }

describe('flat swarm chat sieve (vewo.2)', () => {
  it('13 swarm progress lines: 13 replies before (no swarm env on bot2), 0 after', () => {
    const msg = 'flat 10/500 (level 64)'
    assert.equal(count({}, 'IdkV2', swarm13, msg), 13)
    assert.equal(count(bot2Env, 'IdkV2', swarm13, msg), 0)
  })
  it('bot2-shaped bot ignores flat done from IdkSwarm3', () => {
    assert.equal(count(bot2Env, 'IdkV2', ['IdkSwarm3'], 'flat done: filled 3 holes'), 0)
  })
  it('a helper ignores flat 12/300 from the bot2 name', () => {
    const env = { BOT_SWARM_N: '13', BOT_SWARM_I: '3', BOT2_USERNAME: 'IdkV2' }
    assert.equal(count(env, 'IdkSwarm3', ['IdkV2'], 'flat 12/300 (level 64)'), 0)
    assert.equal(count({}, 'IdkSwarm3', ['IdkV2'], 'flat 12/300 (level 64)'), 1)
  })
})
