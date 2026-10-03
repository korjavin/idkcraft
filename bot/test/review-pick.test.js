const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// idkcraft-111r: .revmux/review.sh picks idkcraft-risky for a diff that
// touches Movements settings (body.js movementsFor) — PR #284 added
// scafoldingBlocks there and got the plain profile, because the user's
// diff.external (difft) printed no `+` lines for the content pattern.
const script = path.join(__dirname, '..', '..', '.revmux', 'review.sh')
const pick = (diff) => execFileSync('sh', [script, '--pick'], { input: diff, encoding: 'utf8' }).trim()
const patch = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n ${'//'}\n${lines}\n`

describe('review.sh profile pick (idkcraft-111r)', () => {
  it('a Movements setting on an added bot/src line is risky (any file)', () => {
    for (const k of ['scafoldingBlocks', 'canDig', 'allow1by1towers', 'allowParkour', 'blocksCantBreak', 'exclusionAreas', 'canOpenDoors']) {
      assert.strictEqual(pick(patch('bot/src/behaviours/castle.js', `+  mov.${k} = x`)), 'idkcraft-risky', k)
    }
  })

  it('a risky file is risky whatever the content', () => {
    assert.strictEqual(pick(patch('bot/src/goal.js', '+  x()')), 'idkcraft-risky')
    assert.strictEqual(pick(patch('bot/src/body.js', '+  if (castleWalk(ctx)) x = false')), 'idkcraft-risky', 'movementsFor condition naming no flag')
    assert.strictEqual(pick(patch('laya/app.py', '+x = 1')), 'idkcraft-risky')
  })

  it('anything else is the plain profile', () => {
    assert.strictEqual(pick(patch('bot/src/behaviours/castle.js', '+  x()')), 'idkcraft')
    assert.strictEqual(pick(patch('bot/src/danger.js', '-  mov.canDig = x')), 'idkcraft', 'a removed line is not a new setting')
    assert.strictEqual(pick(patch('CLAUDE.md', '+ any `Movements` setting, canDig')), 'idkcraft', 'docs/tooling naming the words')
    assert.strictEqual(pick(patch('bot/test/body.test.js', '+  mov.canDig = true') + patch('bot/src/behaviours/castle.js', '+  x()')), 'idkcraft', 'a test fixture is not a setting')
  })

  it('every patch the script reads bypasses diff.external', () => {
    const src = fs.readFileSync(script, 'utf8')
    for (const line of src.split('\n').filter((l) => /git diff (?!--name-only|--shortstat)/.test(l))) {
      assert.ok(line.includes('--no-ext-diff'), line)
    }
  })
})
