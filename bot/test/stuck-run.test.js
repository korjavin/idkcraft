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

// idkcraft-jlda.3: worker ownership (revmux 01 core-1). teardown() stops
// the worker client only when THIS run started it (WORKER_STARTED): a
// guarded or failed start must never stop another run's client. Fake
// docker/START.sh/replay/client.sh — no real docker needed.
describe('stuck-run.sh worker ownership (idkcraft-jlda.3)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-own-'))
  const tools = path.join(tmp, 'tree', 'bot', 'tools')
  fs.mkdirSync(tools, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'tools', 'stuck-run.sh'), path.join(tools, 'stuck-run.sh'))
  fs.writeFileSync(path.join(tools, 'stuck-replay.js'), 'process.exit(0)\n')
  const baritone = path.join(tmp, 'tree', 'baritone')
  fs.mkdirSync(baritone, { recursive: true })
  // Fake client.sh: records its calls, start exits FAKE_CLIENT_RC.
  fs.writeFileSync(path.join(baritone, 'client.sh'), '#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\n[ "$1" = start ] && exit "${FAKE_CLIENT_RC:-0}"\nexit 0\n')
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = exec ]; then case "$4" in op*) echo "Made fake a server operator";; *) echo ok;; esac; fi\nexit 0\n', { mode: 0o755 })
  const pw = path.join(tmp, 'pw')
  fs.mkdirSync(path.join(pw, 'replay-data', 'paper-base', 'world'), { recursive: true })
  fs.writeFileSync(path.join(pw, 'START.sh'), '# --name idk-replay -p 25571:\nexec sleep 30\n', { mode: 0o755 })
  spawnSync('tar', ['-cf', path.join(pw, 'world.tar'), '-C', path.join(pw, 'replay-data', 'paper-base'), 'world'])
  let k = 0
  const run = (env) => {
    const calls = path.join(tmp, 'calls' + k++)
    const r = spawnSync('sh', [path.join(tools, 'stuck-run.sh'), 'paper-base'], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRODWORLD: pw, RIG_LOCK: path.join(tmp, 'lock'),
        REPLAY_WORKER: '1', BOT: 'FakeWorker', FAKE_CALLS: calls, ...env } })
    return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }

  it('a failed start (guard) stops nothing: exit 2, no stop call', () => {
    const r = run({ FAKE_CLIENT_RC: '2' })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['start 25571 FakeWorker'])
    assert.equal(fs.existsSync(path.join(tmp, 'lock')), false, 'lock leaked after exit')
  })

  it('a successful start stops the client at teardown: exit 0, start then stop', () => {
    const r = run({})
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['start 25571 FakeWorker', 'stop'])
    assert.equal(fs.existsSync(path.join(tmp, 'lock')), false, 'lock leaked after exit')
  })
})

// idkcraft-neuc.5: v2 body ownership. REPLAY_BODY=baritone pre-ops the
// follower name, boots the offline client under it (a distinct container
// from the worker's), and exports the adapter addresses for the replay;
// teardown stops only a client THIS run started. Fake
// docker/START.sh/replay/client.sh — no real docker needed.
describe('stuck-run.sh body ownership (idkcraft-neuc.5)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'body-own-'))
  const tools = path.join(tmp, 'tree', 'bot', 'tools')
  fs.mkdirSync(tools, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'tools', 'stuck-run.sh'), path.join(tools, 'stuck-run.sh'))
  // Fake replay: records the adapter env the wrapper exported for it.
  fs.writeFileSync(path.join(tools, 'stuck-replay.js'),
    'require(\'fs\').writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ ' +
    'BOT_BODY: process.env.BOT_BODY || null, BRIDGE_HOST: process.env.BRIDGE_HOST || null, ' +
    'BRIDGE_PORT: process.env.BRIDGE_PORT || null, BRIDGE_CONSOLE_PORT: process.env.BRIDGE_CONSOLE_PORT || null }))\n')
  const baritone = path.join(tmp, 'tree', 'baritone')
  fs.mkdirSync(baritone, { recursive: true })
  // Fake client.sh: records args + the launch env, start exits FAKE_CLIENT_RC.
  fs.writeFileSync(path.join(baritone, 'client.sh'), '#!/bin/sh\necho "$@" >> "$FAKE_CALLS"\n' +
    'echo "client=${BARITONE_CLIENT:-idk-baritone-client} console=${BRIDGE_PORT:-7777} mod=$MOD_PORT log=$CLIENT_LOG" >> "$FAKE_CALLS"\n' +
    '[ "$1" = start ] && exit "${FAKE_CLIENT_RC:-0}"\nexit 0\n')
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = exec ]; then case "$4" in op*) echo "Made fake a server operator";; *) echo ok;; esac; fi\nexit 0\n', { mode: 0o755 })
  const pw = path.join(tmp, 'pw')
  fs.mkdirSync(path.join(pw, 'replay-data', 'paper-base', 'world'), { recursive: true })
  fs.writeFileSync(path.join(pw, 'START.sh'), '# --name idk-replay -p 25571:\nexec sleep 30\n', { mode: 0o755 })
  spawnSync('tar', ['-cf', path.join(pw, 'world.tar'), '-C', path.join(pw, 'replay-data', 'paper-base'), 'world'])
  let k = 0
  const run = (env) => {
    const calls = path.join(tmp, 'calls' + k)
    const envOut = path.join(tmp, 'env' + k)
    k++
    const r = spawnSync('sh', [path.join(tools, 'stuck-run.sh'), 'paper-base'], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRODWORLD: pw, RIG_LOCK: path.join(tmp, 'lock'),
        REPLAY_BODY: 'baritone', REPLAY_TAG: 't1', FAKE_CALLS: calls, FAKE_ENV_OUT: envOut, ...env } })
    return { ...r,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
      envOut: fs.existsSync(envOut) ? JSON.parse(fs.readFileSync(envOut, 'utf8')) : null }
  }

  it('a failed start stops nothing: exit 2, no stop call', () => {
    const r = run({ FAKE_CLIENT_RC: '2' })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['start 25571 StuckReplayt1',
      'client=idk-baritone-body console=7779 mod=7778 log=/tmp/stuck-body-paper-base.log'])
    assert.equal(fs.existsSync(path.join(tmp, 'lock')), false, 'lock leaked after exit')
  })

  it('a successful start stops the client at teardown and exports the adapter addresses', () => {
    const r = run({})
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.calls, ['start 25571 StuckReplayt1',
      'client=idk-baritone-body console=7779 mod=7778 log=/tmp/stuck-body-paper-base.log',
      // stop inherits the exported BRIDGE_PORT (the mod ws by then); the
      // launch-only vars (MOD_PORT/CLIENT_LOG) were never exported.
      'stop', 'client=idk-baritone-body console=7778 mod= log='])
    assert.deepEqual(r.envOut,
      { BOT_BODY: 'baritone', BRIDGE_HOST: 'localhost', BRIDGE_PORT: '7778', BRIDGE_CONSOLE_PORT: '7779' })
    assert.equal(fs.existsSync(path.join(tmp, 'lock')), false, 'lock leaked after exit')
  })

  it('BODY_CONSOLE_PORT/MOD_PORT overrides reach the client and the replay', () => {
    const r = run({ BODY_CONSOLE_PORT: '17779', MOD_PORT: '17778' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(r.calls.includes('client=idk-baritone-body console=17779 mod=17778 log=/tmp/stuck-body-paper-base.log'),
      r.calls.join('\n'))
    assert.deepEqual(r.envOut,
      { BOT_BODY: 'baritone', BRIDGE_HOST: 'localhost', BRIDGE_PORT: '17778', BRIDGE_CONSOLE_PORT: '17779' })
  })

  it('the body console defaults off the worker port (shared box, revmux 01 core-4)', () => {
    const r = run({})
    assert.equal(r.status, 0, r.stdout + r.stderr)
    // The worker block publishes the console on ${BRIDGE_PORT:-7777}; the
    // body must not default to the same host port.
    assert.ok(!r.calls.join('\n').includes('console=7777'), r.calls.join('\n'))
  })

  it('v1 (REPLAY_BODY unset): no client launch, no adapter env', () => {
    const r = run({ REPLAY_BODY: '' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.calls, [])
    assert.deepEqual(r.envOut,
      { BOT_BODY: null, BRIDGE_HOST: null, BRIDGE_PORT: null, BRIDGE_CONSOLE_PORT: null })
  })

  it('REPLAY_WORKER=1 + REPLAY_BODY=baritone: distinct names, ports and logs (revmux 02 core-3)', () => {
    const r = run({ REPLAY_WORKER: '1', BOT: 'FakeWorker', MOD_PORT: '17778' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    // The worker launch clears MOD_PORT (its client publishes the console
    // only); the body publishes the console + the mod ws. No shared publish.
    assert.ok(r.calls.includes('client=idk-baritone-client console=7777 mod= log=/tmp/stuck-worker-paper-base.log'),
      r.calls.join('\n'))
    assert.ok(r.calls.includes('client=idk-baritone-body console=7779 mod=17778 log=/tmp/stuck-body-paper-base.log'),
      r.calls.join('\n'))
    assert.deepEqual(r.envOut,
      { BOT_BODY: 'baritone', BRIDGE_HOST: 'localhost', BRIDGE_PORT: '17778', BRIDGE_CONSOLE_PORT: '7779' })
    assert.equal(fs.existsSync(path.join(tmp, 'lock')), false, 'lock leaked after exit')
  })
})

// idkcraft-neuc.5: client.sh MOD_PORT publishes the in-container mod ws
// (7778) on the host; unset = not published, so run.sh/REPLAY_WORKER are
// unchanged. The REAL client.sh with fake docker/node — no real docker.
describe('client.sh MOD_PORT (idkcraft-neuc.5)', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modport-'))
  const script = path.join(tmp, 'client.sh')
  fs.copyFileSync(path.join(__dirname, '..', '..', 'baritone', 'client.sh'), script)
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  // Fake docker: run records its args, logs shows a started client, exec
  // lists the joining bot, ps shows no collision.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  run) echo "$@" >> "$FAKE_CALLS" ;;\n' +
    '  logs) echo "HMC-Specifics initialized" ;;\n' +
    '  exec) echo "$FAKE_JOIN has joined" ;;\n' +
    '  ps) ;; \n' +
    'esac\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  let k = 0
  const start = (env) => {
    const calls = path.join(tmp, 'calls' + k++)
    const r = spawnSync('sh', [script, 'start', '25571', 'FakeBody'], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BARITONE_OFFLINE: '1',
        RIG_CONTAINER: 'fake-rig', CLIENT_LOG: path.join(tmp, 'client.log'), FAKE_CALLS: calls, FAKE_JOIN: 'FakeBody', ...env } })
    return { ...r, runArgs: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' }
  }

  it('MOD_PORT unset: only the console bridge is published', () => {
    const r = start({})
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.runArgs, /-p 7777:7777/)
    assert.doesNotMatch(r.runArgs, /7778/)
  })

  it('MOD_PORT set: the mod ws is published beside the console bridge', () => {
    const r = start({ MOD_PORT: '7778' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.runArgs, /-p 7777:7777/)
    assert.match(r.runArgs, /-p 7778:7778/)
  })

  it('RIG_BIND binds both publishes', () => {
    const r = start({ MOD_PORT: '7778', RIG_BIND: 'localhost' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.runArgs, /-p localhost:7777:7777/)
    assert.match(r.runArgs, /-p localhost:7778:7778/)
  })

  it('a non-numeric MOD_PORT fails loud before touching docker', () => {
    const r = start({ MOD_PORT: 'abc' })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.equal(r.runArgs, '')
  })
})

// idkcraft-neuc.5: the replay builds the FOLLOWER on the bridge adapter
// under BOT_BODY=baritone; the guide stays mineflayer either way.
describe('stuck-replay.js v2 body factory (idkcraft-neuc.5)', () => {
  const replay = fs.readFileSync(path.join(__dirname, '..', 'tools', 'stuck-replay.js'), 'utf8')

  it('BOT_BODY=baritone picks the bridge adapter for the follower', () => {
    assert.ok(replay.includes("process.env.BOT_BODY === 'baritone'"), 'BOT_BODY switch missing')
    assert.ok(replay.includes("require('../src/bridge').createBot({ ...opts, host: process.env.REPLAY_BODY_MC_HOST || 'host.docker.internal', username: FOLLOWER })"),
      'follower bridge factory missing')
  })

  it('the bridge follower gets a container-reachable MC host (revmux 01 core-2)', () => {
    // The adapter sends `connect <host> <port>` from inside its container,
    // where the replay's loopback is unreachable — the mk line must not
    // pass the replay HOST through.
    const mkLine = replay.split('\n').find((l) => l.includes("require('../src/bridge').createBot"))
    assert.ok(mkLine && mkLine.includes("host: process.env.REPLAY_BODY_MC_HOST || 'host.docker.internal'"),
      'container-reachable MC host missing from the bridge factory call')
  })

  it('the guide stays mineflayer', () => {
    assert.ok(replay.includes('const guide = mineflayer.createBot('), 'guide factory changed')
  })

  it('the bridge module loads lazily inside mk, never at require time', () => {
    assert.equal(replay.split("require('../src/bridge')").length - 1, 1, 'bridge require must appear exactly once')
    assert.ok(replay.indexOf('const mk = (opts)') < replay.indexOf("require('../src/bridge')"),
      'bridge require must sit inside mk')
  })

  it('the chat patch stays spawn-gated', () => {
    assert.ok(replay.includes("b.once('spawn', () => {"), 'spawn-gated chat patch missing')
  })
})
