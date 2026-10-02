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

// idkcraft-qd9s: parallel rigs. RIG_ID=<letter> suffixes lock, container,
// port and data dir; RIG_ID=auto takes the first free slot. A fake `docker`
// that reports the rig's container as running stops the run right after the
// rig is derived — no real docker needed.
describe('stuck-run.sh parallel rigs (idkcraft-qd9s)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'stuck-run.sh')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-'))
  const lock = path.join(tmp, 'lock')
  const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, RIG_LOCK: lock, ...env } })
  const hold = (p) => { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'pid'), String(process.pid)) }

  it('RIG_ID=a locks its own path, not the default rig', () => {
    hold(lock)
    assert.match(run({ RIG_ID: 'a' }).stdout, /no START\.sh/) // got past the lock
    assert.equal(fs.existsSync(lock + '-a'), false, 'rig a lock leaked')
    hold(lock + '-a')
    assert.match(run({ RIG_ID: 'a' }).stdout, /rig busy: .*lock-a/)
    fs.rmSync(lock + '-a', { recursive: true })
    fs.rmSync(lock, { recursive: true })
  })

  const fakeDocker = (name, ps) => { // a `docker` whose ps lists `ps`
    const bin = path.join(tmp, name)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "${ps}"\n`, { mode: 0o755 })
    return `${bin}:${process.env.PATH}`
  }

  it('RIG_ID=auto takes the first free slot and is busy only when all are held', () => {
    const PATH = fakeDocker('bin-none', '')
    hold(lock)
    assert.match(run({ RIG_ID: 'auto', RIG_SLOTS: '0 a', PATH }).stdout, /no START\.sh/)
    hold(lock + '-a')
    const b = run({ RIG_ID: 'auto', RIG_SLOTS: '0 a', PATH })
    assert.equal(b.status, 2)
    assert.match(b.stdout, /rig busy/)
    fs.rmSync(lock + '-a', { recursive: true })
    fs.rmSync(lock, { recursive: true })
  })

  it('RIG_ID=auto skips a free slot whose container still runs', () => {
    const r = run({ RIG_ID: 'auto', RIG_SLOTS: 'a b', PATH: fakeDocker('bin-orphan', 'idk-replay-a') })
    assert.match(r.stdout, /rig a: idk-replay-a still running without a lock — next slot/)
    assert.match(r.stdout, /no START\.sh/) // took b
    assert.equal(fs.existsSync(lock + '-a'), false, 'skipped slot lock leaked')
    assert.equal(fs.existsSync(lock + '-b'), false, 'rig b lock leaked')
  })

  it('derives the rig from START.sh: seeded data minus world, renamed container and port', () => {
    const src = path.join(tmp, 'replay-data', 'paper-base')
    fs.mkdirSync(path.join(src, 'world'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.properties'), 'x')
    fs.writeFileSync(path.join(tmp, 'world.tar'), '')
    fs.writeFileSync(path.join(tmp, 'START.sh'),
      'D="$(dirname "$0")/replay-data/$V"\nexec docker run --rm --name idk-replay -v "$D:/data" \\\n  -p 25571:25565 img\n', { mode: 0o755 })
    fs.mkdirSync(path.join(tmp, 'rigs', 'b', 'replay-data', '.paper-base.tmp', 'junk'), { recursive: true }) // killed half-seed
    const r = run({ RIG_ID: 'b', PATH: fakeDocker('bin-b', 'idk-replay-b') })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /rig b: container idk-replay-b, port 25573/)
    assert.match(r.stdout, /idk-replay-b already running/) // the guard checks the rig's container
    const rig = path.join(tmp, 'rigs', 'b')
    const start = fs.readFileSync(path.join(rig, 'START.sh'), 'utf8')
    assert.match(start, /--name idk-replay-b -v/)
    assert.match(start, /-p 25573:25565/)
    assert.ok(fs.existsSync(path.join(rig, 'replay-data', 'paper-base', 'server.properties')), 'not seeded')
    assert.equal(fs.existsSync(path.join(rig, 'replay-data', 'paper-base', 'world')), false, 'seed copied world/')
    assert.equal(fs.existsSync(path.join(rig, 'replay-data', 'paper-base', 'junk')), false, 'stale half-seed leaked in')
    assert.equal(fs.existsSync(path.join(rig, 'replay-data', '.paper-base.tmp')), false, 'seed tmp left behind')
    assert.equal(fs.existsSync(lock + '-b'), false, 'rig b lock leaked')
  })

  it('a START.sh without the expected tokens fails loud instead of booting the default rig', () => {
    fs.writeFileSync(path.join(tmp, 'START.sh'), 'exec docker run --name other -p 1:1 img\n', { mode: 0o755 })
    const r = run({ RIG_ID: 'c' })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /cannot derive rig c/)
  })

  it('rejects a RIG_ID that is not one letter', () => {
    const r = run({ RIG_ID: 'ab' })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /RIG_ID must be one letter/)
  })
})

// idkcraft-6x7.9: flake protocol. A regression gets ONE rerun of only the
// regressed spots on a freshly reset world: repeats = exit 1, holds = FLAKY
// exit 0. The script runs from a copy whose tools/stuck-replay.js is a fake
// (judged by the REAL compareBaseline/gateCode it re-exports); docker and
// START.sh are fakes too.
describe('stuck-run.sh flake rerun (idkcraft-6x7.9)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const real = path.join(__dirname, '..', 'tools', 'stuck-replay.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-'))
  const tools = path.join(tmp, 'tree', 'bot', 'tools')
  fs.mkdirSync(tools, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'tools', 'stuck-run.sh'), path.join(tools, 'stuck-run.sh'))
  // Fake replay: call n fails the spots in FAKE_FAIL_<n> (reached=false), or
  // exits FAKE_RC_<n> outright; logs the spots it was given per call.
  fs.writeFileSync(path.join(tools, 'stuck-replay.js'), `
const real = require(${JSON.stringify(real)})
if (require.main !== module) { module.exports = real; return }
const fs = require('fs'), dir = process.env.FAKE_DIR
const n = fs.readdirSync(dir).filter((f) => f.startsWith('call')).length + 1
const spots = JSON.parse(fs.readFileSync(process.env.REPLAY_SPOTS, 'utf8'))
fs.writeFileSync(dir + '/call' + n, spots.map((s) => s.name).join(','))
if (process.env['FAKE_RC_' + n]) process.exit(+process.env['FAKE_RC_' + n])
const fail = (process.env['FAKE_FAIL_' + n] || '').split(',')
const rows = spots.map((s) => ({ spot: s.name, reached: !fail.includes(s.name), stuck: 0, eps: 0, call: 0, note: '' }))
fs.writeFileSync(process.env.REPLAY_OUT || __dirname + '/last-replay.json', JSON.stringify(rows))
const diffs = real.compareBaseline(rows, real.loadBaseline().baseline)
diffs.forEach((d) => d.verdict !== 'ok' && console.log('BASELINE ' + d.spot + ': ' + d.verdict))
process.exit(real.gateCode(rows, diffs).code)
`)
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ncase "$1" in ps) ;; *) echo ok ;; esac\n', { mode: 0o755 })
  const pw = path.join(tmp, 'pw')
  fs.mkdirSync(path.join(pw, 'replay-data', 'paper-base', 'world'), { recursive: true })
  fs.writeFileSync(path.join(pw, 'START.sh'), '# --name idk-replay -p 25571:\nexec sleep 30\n', { mode: 0o755 })
  spawnSync('tar', ['-cf', path.join(pw, 'world.tar'), '-C', path.join(pw, 'replay-data', 'paper-base'), 'world'])
  const spotsFile = path.join(tmp, 'spots.json')
  fs.writeFileSync(spotsFile, JSON.stringify(['A', 'B', 'C', 'D'].map((name) => ({ name, spawn: [0, 0, 0], goal: [1, 0, 0] }))))
  const baseline = path.join(tmp, 'baseline.json')
  const entry = { reached: true, maxStuck: 0, maxEps: 0, maxCalls: 0 }
  fs.writeFileSync(baseline, JSON.stringify({ spots: { A: entry, B: entry, C: entry, D: entry } }))
  let k = 0
  const run = (env) => {
    const dir = path.join(tmp, 'calls' + k++)
    fs.mkdirSync(dir)
    const r = spawnSync('sh', [path.join(tools, 'stuck-run.sh'), 'paper-base', spotsFile], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRODWORLD: pw, RIG_ID: 'z', RIG_LOCK: path.join(tmp, 'lock'),
        REPLAY_BASELINE: baseline, REPLAY_OUT: path.join(tmp, 'out.json'), FAKE_DIR: dir, ...env } })
    const calls = fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    return { ...r, calls, resets: (r.stdout.match(/^reset:/gm) || []).length }
  }

  it('green corpus: one run, exit 0, no rerun', () => {
    const r = run({})
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['A,B,C,D'])
    assert.doesNotMatch(r.stdout, /RERUN|FLAKY/)
  })

  it('a flake (regressed once, held on the rerun) = FLAKY, exit 0; only the regressed spot reruns on a reset world', () => {
    const r = run({ FAKE_FAIL_1: 'B' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['A,B,C,D', 'B'])
    assert.equal(r.resets, 2)
    assert.match(r.stdout, /^FLAKY B:/m)
    assert.match(r.stdout, /verdict: FLAKY/)
  })

  it('a regression that repeats on the rerun (sabotage) = exit 1', () => {
    const r = run({ FAKE_FAIL_1: 'A,C', FAKE_FAIL_2: 'C' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['A,B,C,D', 'A,C'])
    assert.match(r.stdout, /verdict: REGRESSION \(repeated on the rerun\)/)
    assert.doesNotMatch(r.stdout, /FLAKY/)
  })

  it('env failure (exit 2) is never rerun', () => {
    for (const env of [{ FAKE_RC_1: '2' }, { FAKE_FAIL_1: 'A', FAKE_RC_2: '2' }]) {
      const r = run(env)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.equal(r.calls.length, env.FAKE_RC_1 ? 1 : 2)
    }
  })

  it('a spot without a baseline entry is deterministic: exit 1, no rerun', () => {
    fs.writeFileSync(baseline, JSON.stringify({ spots: { A: entry, B: entry, C: entry } }))
    const r = run({})
    fs.writeFileSync(baseline, JSON.stringify({ spots: { A: entry, B: entry, C: entry, D: entry } }))
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['A,B,C,D'])
    assert.match(r.stdout, /no rerun/)
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
