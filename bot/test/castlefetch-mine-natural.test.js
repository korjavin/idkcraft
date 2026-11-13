'use strict'
// owner 2026-11-13: the castle stone mine never targets what the walls are made of.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const { MINE_ROCK } = require('../src/behaviours/castlefetch')
it('mine targets natural rock only', () => {
  assert.ok(MINE_ROCK.includes('stone'))
  for (const n of ['cobblestone', 'cobbled_deepslate', 'polished_andesite', 'deepslate_bricks']) assert.ok(!MINE_ROCK.includes(n), n)
})
