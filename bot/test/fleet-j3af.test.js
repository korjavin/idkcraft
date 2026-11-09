'use strict'
// idkcraft-j3af: four v2 bots — siblings are bots to each other, never players/owners.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const worker = require('../src/worker')

const env = { BOT_USERNAME: 'IdkBotV2b', BOT_PEER_USERNAME: 'IdkBot', BOT_FLEET: 'IdkBotV2,IdkBotV2b,IdkBotV2c,IdkBotV2d' }

describe('v2 fleet (j3af)', () => {
  it('botNames covers every fleet sibling', () => {
    for (const n of ['IdkBotV2', 'IdkBotV2c', 'IdkBotV2d', 'IdkBot']) assert.ok(worker.botNames(env).includes(n), n)
    assert.ok(!worker.botNames(env).includes('Owner'))
  })
  it('a sibling is a bot (its chat is never an order); the bot itself and players are not', () => {
    assert.equal(worker.isSwarmBot('IdkBotV2c', env), true)
    assert.equal(worker.isSwarmBot('IdkBotV2b', env), false)
    assert.equal(worker.isSwarmBot('Owner', env), false)
  })
  it('empty fleet slots add no names', () => {
    assert.deepEqual(worker.botNames({ BOT_USERNAME: 'A', BOT_FLEET: 'A,,,' }), ['A', 'A'])
  })
  it('compose: bot3..5/body3..5 inherit bot2/body2 with only name and bridge host changed', () => {
    const y = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8')
    for (const n of [3, 4, 5]) {
      assert.match(y, new RegExp(`  bot${n}:\\n    <<: \\*v2bot\\n[\\s\\S]*?      <<: \\*v2env\\n      BOT_USERNAME: \\$\\{BOT${n}_USERNAME:-\\}\\n      BRIDGE_HOST: body${n}\\n`))
      assert.match(y, new RegExp(`  body${n}:\\n    <<: \\*v2body\\n[\\s\\S]*?      <<: \\*v2bodyenv\\n      BOT: \\$\\{BOT${n}_USERNAME:-\\}\\n`))
    }
  })
})
