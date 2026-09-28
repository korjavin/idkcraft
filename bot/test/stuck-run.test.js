const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// idkcraft-3ro: stuck-run.sh anti-noise must use Paper 26.1 snake_case
// gamerules and assert every rcon call. The old camelCase rules
// (fallDamage, doWeatherCycle) fail with "Incorrect argument" on this
// Paper, and the silent >/dev/null hid the dead rules — every run
// measured a noisier game (fall damage on, weather cycling) while the
// script looked green.
describe('stuck-run.sh anti-noise (idkcraft-3ro)', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'stuck-run.sh'), 'utf8')

  it('sets snake_case gamerules', () => {
    assert.ok(script.includes('gamerule fall_damage false'), 'missing fall_damage')
    assert.ok(script.includes('gamerule advance_weather false'), 'missing advance_weather')
  })

  it('has no camelCase gamerule leftovers', () => {
    assert.ok(!script.includes('fallDamage'), 'camelCase fallDamage still present')
    assert.ok(!script.includes('doWeatherCycle'), 'camelCase doWeatherCycle still present')
  })

  it('asserts every anti-noise rcon call (no silent >/dev/null)', () => {
    assert.ok(script.includes('rcon_assert'), 'missing rcon_assert helper')
    for (const cmd of ['difficulty peaceful', 'gamerule fall_damage false', 'gamerule advance_weather false', 'weather clear']) {
      assert.ok(script.includes(`rcon_assert "${cmd}"`), `not asserted: ${cmd}`)
    }
    // The helper must reject failure output and fail the run, not just echo:
    // pin the rejection arm and its exit so a gutted helper fails here.
    assert.ok(script.includes('*Incorrect*|*Unknown*'), 'missing rejection patterns')
    assert.ok(script.includes('exit 2'), 'rejection must exit 2')
  })
})

// idkcraft-3ro root cause: every replay spot sits inside the
// spawn-protection radius (r=16 around (-48,65,-208)), and Paper enforces
// protection once ops.json is non-empty — one afternoon op armed it for
// every later run and the baseline collapsed to 3/10 with no code change
// (only the pure-walk spots pass unopped). The replay must op both bots
// after spawn — with an asserted rcon call, so a run that lost op fails
// loud instead of drifting the baseline again.
describe('stuck-replay.js self-op (idkcraft-3ro)', () => {
  const replay = fs.readFileSync(path.join(__dirname, '..', 'tools', 'stuck-replay.js'), 'utf8')

  it('ops both bots before the spot loop', () => {
    assert.ok(replay.includes('await rcon(`op ${GUIDE}`)'), 'guide op missing')
    assert.ok(replay.includes('await rcon(`op ${FOLLOWER}`)'), 'follower op missing')
    assert.ok(replay.indexOf('await rcon(`op ${GUIDE}`)') < replay.indexOf('for (const s of spots)'),
      'op must land before the first spot')
  })

  it('asserts the op call on its output text', () => {
    // Pin the full predicate: a substring-only check would still pass with
    // the negation dropped (throw-on-success) or the output match deleted.
    assert.ok(replay.includes("cmd.startsWith('op ') && !out.toLowerCase().includes('operator')"),
      'rcon op assert weakened')
  })
})
