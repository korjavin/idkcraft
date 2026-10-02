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

// idkcraft-3on: the script holds the rig lock itself (atomic mkdir, pid file,
// stale reclaim, released on every exit) — behavioural, no docker needed: the
// run dies at "no START.sh" right after the lock is taken.
describe('stuck-run.sh rig lock (idkcraft-3on)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'stuck-run.sh')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-'))
  const lock = path.join(tmp, 'lock')
  const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, RIG_LOCK: lock, ...env } })

  it('busy lock (live holder) = exit 2 before touching anything, lock left intact', () => {
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const r = run()
    assert.equal(r.status, 2)
    assert.match(r.stdout, /rig busy/)
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid))
    fs.rmSync(lock, { recursive: true })
  })

  it('lock dir without a pid (manual wrapper) counts as held', () => {
    fs.mkdirSync(lock)
    assert.match(run().stdout, /rig busy/)
    fs.rmdirSync(lock)
  })

  it('dead holder is reclaimed and the lock is released on exit', () => {
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), '999999')
    const r = run()
    assert.match(r.stdout, /stale/)
    assert.match(r.stdout, /no START\.sh/) // got past the lock
    assert.equal(fs.existsSync(lock), false, 'lock leaked after exit')
  })

  it("RIG_LOCK_HELD=1 skips the lock and never removes the caller's", () => {
    fs.mkdirSync(lock)
    const r = run({ RIG_LOCK_HELD: '1' })
    assert.match(r.stdout, /no START\.sh/)
    assert.equal(fs.existsSync(lock), true)
    fs.rmdirSync(lock)
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
