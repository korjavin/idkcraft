const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// idkcraft-vmzq.20: castle-rig.sh is the unattended-build throughput
// harness. Like stuck-run.sh it asserts its anti-noise rcon calls and
// holds its own rig lock — behavioural, no docker needed: the run dies at
// "no START.sh" right after the lock is taken.
describe('castle-rig.sh anti-noise', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8')

  it('sets snake_case gamerules and asserts every rcon call', () => {
    for (const cmd of ['difficulty peaceful', 'gamerule fall_damage false', 'gamerule advance_weather false',
      'gamerule keep_inventory true', 'weather clear', 'time set 1000']) {
      assert.ok(script.includes(`rcon_assert "${cmd}"`), `not asserted: ${cmd}`)
    }
    assert.ok(script.includes('*Incorrect*|*Unknown*'), 'missing rejection patterns')
  })

  it('locks day by default with a Paper-name fallback, skippable via CASTLE_DAYLOCK=0', () => {
    assert.ok(script.includes('gamerule advance_time false'), 'missing advance_time attempt')
    assert.ok(script.includes('gamerule do_daylight_cycle false'), 'missing daylight fallback')
    assert.ok(script.includes('CASTLE_DAYLOCK'), 'missing daylock opt-out')
  })

  it('has no camelCase gamerule leftovers', () => {
    assert.ok(!script.includes('fallDamage'), 'camelCase fallDamage still present')
    assert.ok(!script.includes('doWeatherCycle'), 'camelCase doWeatherCycle still present')
  })

  it('validates the minutes argument before touching the world', () => {
    assert.ok(script.includes("mins: want a positive integer"), 'missing mins validation')
  })

  it('fails loud on a bad kit or tickrate', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-kit-'))
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    const badKit = run({ CASTLE_KIT: 'full' })
    assert.equal(badKit.status, 2)
    assert.match(badKit.stdout, /CASTLE_KIT: want empty\|seeded/)
    const badRate = run({ CASTLE_TICKRATE: 'fast' })
    assert.equal(badRate.status, 2)
    assert.match(badRate.stdout, /tickrate: want an integer/)
  })

  it('defaults RIG_PLANNER to jev, rejects anything but jev|stub', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    assert.ok(script.includes('RIG_PLANNER="${RIG_PLANNER:-jev}"'), 'jev no longer the rig default')
    assert.ok(script.includes('export RIG_PLANNER'), 'planner not exported to the replay')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-planner-'))
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), ...env } })
    const bad = run({ RIG_PLANNER: 'laya' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /RIG_PLANNER: want jev\|stub/)
    // A valid planner sails past validation to the world check (stub: no
    // secret-store touch, hermetic).
    const ok = run({ RIG_PLANNER: 'stub' })
    assert.match(ok.stdout, /no START.sh/)
  })

  it('jev without a key fails before any docker or world work', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-nokey-'))
    const lock = path.join(tmp, 'lock')
    // No key in env, no kv under HOME: the stash fallback cannot fill it.
    const { TYPESAFE_API_KEY: _drop, ...rest } = process.env
    const r = spawnSync('sh', [sh], {
      encoding: 'utf8',
      env: { ...rest, PRODWORLD: tmp, CASTLE_LOCK: lock, RIG_PLANNER: 'jev', HOME: tmp },
    })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /RIG_PLANNER=jev needs TYPESAFE_API_KEY/)
    assert.doesNotMatch(r.stdout, /no START.sh/, 'failed after the world check, not before')
    assert.doesNotMatch(r.stdout, /seed:/, 'touched the world before failing')
    assert.ok(!fs.existsSync(lock), 'lock released on exit')
  })

  it('reads the key from stash only as env, never prints it', () => {
    assert.ok(script.includes('kv" get secrets/jev-api-key'), 'missing stash fallback')
    assert.ok(script.includes('export TYPESAFE_API_KEY'), 'key not exported to the replay')
    // The key value is never expanded into a print: naming the env var in
    // an error is fine, `$TYPESAFE_API_KEY` in an echo/printf is a leak.
    for (const line of script.split('\n')) {
      if (/echo|printf/.test(line) && line.includes('$TYPESAFE_API_KEY')) {
        assert.fail(`key value printed: ${line}`)
      }
    }
    assert.ok(script.includes('export GOAL_WATCHDOG_MS'), 'watchdog window not forwarded')
    assert.ok(script.includes('export GOAL_COMMIT_MS'), 'commit window not forwarded')
  })

  it('fails loud on a bad memory or distance trim (idkcraft-vmzq.24)', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-trim-'))
    // stub planner: hermetic, no secret-store touch (the jev default
    // would read the stash here).
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    const badMax = run({ CASTLE_MAX_MEMORY: 'huge' })
    assert.equal(badMax.status, 2)
    assert.match(badMax.stdout, /memory: want <n>M\|<n>G/)
    const badInit = run({ CASTLE_INIT_MEMORY: '512' })
    assert.equal(badInit.status, 2)
    assert.match(badInit.stdout, /memory: want <n>M\|<n>G/)
    const inv = run({ CASTLE_INIT_MEMORY: '2G', CASTLE_MAX_MEMORY: '768M' })
    assert.equal(inv.status, 2)
    assert.match(inv.stdout, /INIT .* must be/)
    const badView = run({ CASTLE_VIEW_DISTANCE: 'far' })
    assert.equal(badView.status, 2)
    assert.match(badView.stdout, /view-distance: want an integer/)
    const badSim = run({ CASTLE_SIM_DISTANCE: '1' })
    assert.equal(badSim.status, 2)
    assert.match(badSim.stdout, /sim-distance: want an integer/)
  })

  it('derives the rig START.sh with the trimmed heap (idkcraft-vmzq.24)', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8')
    assert.ok(script.includes('INIT_MEMORY=$INIT_MEM -e MAX_MEMORY=$MAX_MEM'), 'heap not injected into derived START.sh')
    assert.ok(script.includes('MAX_MEMORY=$MAX_MEM'), 'heap injection not asserted')
    assert.ok(script.includes('CASTLE_SLOTS:-0 a b c'), 'auto slots missing the 4th rig')
  })
})

describe('castle-rig.sh rig lock', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-rig-'))
  const lock = path.join(tmp, 'lock')
  // stub planner: hermetic, no secret-store touch (revmux 01 core-1).
  const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: lock, RIG_PLANNER: 'stub', ...env } })

  it('busy lock (live holder) = exit 2 before touching anything, lock left intact', () => {
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const r = run()
    assert.equal(r.status, 2)
    assert.match(r.stdout, /rig busy/)
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid))
    fs.rmSync(lock, { recursive: true })
  })

  it('dead holder is reclaimed and the lock is released on exit', () => {
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), '1')
    const r = run()
    assert.match(r.stdout, /stale.*reclaiming/)
    assert.match(r.stdout, /no START.sh/)
    assert.ok(!fs.existsSync(lock), 'lock released on exit')
  })

  it('CASTLE_RIG_ID=a locks its own path with its own container and port', () => {
    const script = fs.readFileSync(sh, 'utf8')
    assert.ok(script.includes('idk-castle${RIG_ID:+-$RIG_ID}'), 'container not rig-scoped')
    assert.ok(script.includes('25581 +'), 'port not rig-scoped')
    const r = run({ CASTLE_RIG_ID: 'a' })
    assert.match(r.stdout, /no START.sh/)
    assert.ok(!fs.existsSync(`${lock}-a`), 'rig-a lock released on exit')
    assert.ok(!fs.existsSync(lock), 'default lock untouched')
  })

  it('rejects a CASTLE_RIG_ID that is not one letter', () => {
    const r = run({ CASTLE_RIG_ID: 'abc' })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /must be one letter/)
  })
})

describe('cycles.sh loop', () => {
  const { spawnSync } = require('node:child_process')
  const sh = path.join(__dirname, '..', 'tools', 'cycles.sh')

  it('validates N and mins before running anything', () => {
    const run = (args) => spawnSync('sh', [sh, ...args], { encoding: 'utf8' })
    assert.equal(run([]).status, 2)
    assert.match(run([]).stdout, /want a positive integer N/)
    assert.equal(run(['0']).status, 2)
    assert.equal(run(['2', 'fast']).status, 2)
    assert.match(run(['2', 'fast']).stdout, /positive integer mins/)
  })

  it('collects one table row per cycle from the verdict line', () => {
    const src = fs.readFileSync(sh, 'utf8')
    assert.ok(src.includes("grep -E '^castle [0-9]+/[0-9]+ in '"), 'verdict grep drifted')
    assert.ok(src.includes('cycle $i/$N:'), 'missing table row prefix')
    assert.ok(src.includes('cycles: done fails='), 'missing summary line')
  })
})

describe('castle-replay.js verdict contract', () => {
  it('prints the one-line verdict shape and names its env seams', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    assert.ok(src.includes('castle ${done}/${total} in ${MINS} min, flips='), 'verdict line shape drifted')
    for (const seam of ['CASTLE_PORT', 'CASTLE_CONTAINER', 'CASTLE_TAG', 'CASTLE_MINS', 'CASTLE_PAD', 'CASTLE_OUT']) {
      assert.ok(src.includes(seam), `missing env seam ${seam}`)
    }
    // Usernames cap at 16 chars (stuck-replay precedent): the length guard
    // must stay, or an overlong TAG dies in the hello decode server-side.
    assert.ok(src.includes('exceed 16 chars'), 'missing 16-char name guard')
  })

  it('counts castle<->castlefetch flips in both directions (one-char join bug)', () => {
    const { classify, seen } = require('../tools/castle-replay')
    seen.flips = 0
    classify('goal step=castlefetch prev=castle source=castle-rule fsm=castlefetch why=facts-changed menu=castlefetch facts=a')
    classify('goal step=castle prev=castlefetch source=castle-rule fsm=castle why=step-done menu=castle facts=b')
    classify('goal step=equip prev=castle source=goal-fsm fsm=equip why=facts-changed menu=equip facts=c')
    assert.equal(seen.flips, 2)
    seen.flips = 0
  })

  it('reports watchdog calls, choices and outcomes on the verdict line', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    assert.ok(src.includes('watchdog=${seen.wdCalls}, first=${first}, choices='), 'watchdog tail drifted')
    assert.ok(src.includes('outcomes=progress:${seen.outcomes.progress},flat:${seen.outcomes.flat},preempted:${seen.outcomes.preempted}'), 'outcomes tail drifted')
    assert.ok(src.includes("'/^goal watchdog /'") || src.includes('/^goal watchdog /'), 'watchdog lines not printed')
    assert.ok(src.includes('/^goal outcome /'), 'outcome lines not printed')
  })

  it('never prints the JEV key value (names the var at most)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    for (const line of src.split('\n')) {
      if (/origLog|origErr|console\.(log|error)|b\.chat|\.chat\(/.test(line) && line.includes('${key}')) {
        assert.fail(`key value printed: ${line.trim()}`)
      }
    }
  })
})

describe('castle-replay.js watchdog classify', () => {
  const { classify, seen, resetSeen } = require('../tools/castle-replay')

  it('counts every resolution as a call, only real choices as choices', () => {
    resetSeen()
    classify('goal watchdog kind=castle id=1 progress=0/1722 stall=61s round=1 step=castlefetch options=a choice=none conf=? source=http why=timeout', 1000)
    classify('goal watchdog kind=castle id=1 progress=0/1722 stall=125s round=1 step=castle options=a choice=castlefetch conf=0.72 source=jev why=stone', 65000)
    classify('goal watchdog kind=castle id=1 progress=0/1722 stall=200s round=2 step=castlefetch options=a choice=castle conf=0.51 source=jev why=stone', 130000)
    assert.equal(seen.wdCalls, 3)
    assert.deepEqual(seen.wdChoices, { castlefetch: 1, castle: 1 })
    assert.equal(seen.wdFirstAt, 65000)
  })

  it('buckets outcomes progress/flat+failed/preempted', () => {
    resetSeen()
    classify('goal outcome kind=castle choice=castle dur=30s delta=+12 result=progress')
    classify('goal outcome kind=castle choice=castlefetch dur=120s delta=+0 result=flat')
    classify('goal outcome kind=castle choice=gear dur=60s delta=+0 result=failed:craft-stall')
    classify('goal outcome kind=castle choice=equip dur=5s delta=? result=preempted:death')
    assert.deepEqual(seen.outcomes, { progress: 1, flat: 2, preempted: 1 })
  })

  it('no intervention leaves first unset (verdict prints -)', () => {
    resetSeen()
    classify('goal watchdog kind=castle id=1 progress=0/1722 stall=61s round=1 step=x options=a choice=none conf=? source=http why=timeout', 1000)
    assert.equal(seen.wdCalls, 1)
    assert.deepEqual(seen.wdChoices, {})
    assert.equal(seen.wdFirstAt, 0)
  })
})
