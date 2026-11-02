'use strict'

// idkcraft-r8tl: neuc.65 H2 fix — kit spawns with food=0, health=low deaths lead at 34.3%
// Ensure kits spawn with food (and effective health) so post-respawn bodies
// are not low-HP starving and eatReflex can regenerate health.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { kitLine, EDIBLE_FOODS, eatReflex } = require('../src/index')

const composePath = path.join(__dirname, '..', '..', 'docker-compose.yml')
const composeContent = fs.readFileSync(composePath, 'utf8')

describe('kit-spawn food wiring (idkcraft-r8tl)', () => {
  it('docker-compose mc service gives bread to BOT_USERNAME and BOT2_USERNAME on connect', () => {
    // Both bot and bot2 must be seeded with bread on connect if missing
    assert.match(composeContent, /execute if entity @a\[name=\$\{BOT_USERNAME:-IdkBot\}\] unless items entity @a\[name=\$\{BOT_USERNAME:-IdkBot\}\] container\.\* minecraft:bread run give \$\{BOT_USERNAME:-IdkBot\} minecraft:bread (\d+)/)
    assert.match(composeContent, /execute if entity @a\[name=\$\{BOT2_USERNAME:-IdkBotV2\}\] unless items entity @a\[name=\$\{BOT2_USERNAME:-IdkBotV2\}\] container\.\* minecraft:bread run give \$\{BOT2_USERNAME:-IdkBotV2\} minecraft:bread (\d+)/)

    const m1 = /name=\$\{BOT_USERNAME:-IdkBot\}\].*run give \$\{BOT_USERNAME:-IdkBot\} minecraft:bread (\d+)/.exec(composeContent)
    const m2 = /name=\$\{BOT2_USERNAME:-IdkBotV2\}\].*run give \$\{BOT2_USERNAME:-IdkBotV2\} minecraft:bread (\d+)/.exec(composeContent)
    assert.ok(m1 && Number(m1[1]) > 0, 'BOT_USERNAME bread count > 0')
    assert.ok(m2 && Number(m2[1]) > 0, 'BOT2_USERNAME bread count > 0')
  })

  it('kitLine reports food > 0 when inventory holds bread or edible foods', () => {
    const bot = {
      inventory: {
        items: () => [
          { name: 'cobblestone', count: 64 },
          { name: 'stone_pickaxe', count: 1 },
          { name: 'stone_sword', count: 1 },
          { name: 'bread', count: 16 },
        ],
      },
    }
    const line = kitLine(bot)
    assert.match(line, /kit scaffold=64 pickaxe=yes sword=yes food=16/)
    const m = /food=(\d+)/.exec(line)
    assert.ok(m && Number(m[1]) > 0, 'kit line pins food > 0')
  })

  it('castle-replay seeded and lay kits include bread (food > 0)', () => {
    const replayPath = path.join(__dirname, '..', 'tools', 'castle-replay.js')
    const replayContent = fs.readFileSync(replayPath, 'utf8')
    assert.match(replayContent, /kit=seeded.*16 bread/)
    assert.match(replayContent, /kit=lay.*16 bread/)
  })

  it('work-replay seeded kit includes bread (food > 0)', () => {
    const replayPath = path.join(__dirname, '..', 'tools', 'work-replay.js')
    const replayContent = fs.readFileSync(replayPath, 'utf8')
    assert.match(replayContent, /\['bread',\s*16\]/)
  })

  it('bread is an edible food that eatReflex consumes when food < 18', async () => {
    assert.ok(EDIBLE_FOODS.has('bread'), 'bread is recognized in EDIBLE_FOODS')
    let consumed = false
    const bot = {
      food: 14,
      inventory: {
        items: () => [{ name: 'bread', count: 16 }],
      },
      consume: async () => { consumed = true },
      equip: async () => {},
    }
    const ctx = { eatInFlight: false }
    const state = { hostile: null }
    const res = eatReflex(bot, ctx, state)
    assert.equal(res, true, 'eatReflex fired')
    assert.equal(ctx.eatInFlight, true, 'eat in flight set')
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(consumed, true, 'bread consumed')
    assert.equal(ctx.eatInFlight, false, 'eat in flight reset')
  })
})
