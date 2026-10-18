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

  it('fails loud on a bad blocked count (vmzq.27)', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-blocked-'))
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    const bad = run({ CASTLE_BLOCKED: 'many' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /blocked: want an integer/)
    const over = run({ CASTLE_BLOCKED: '99' })
    assert.equal(over.status, 2)
    assert.match(over.stdout, /blocked: want an integer/)
  })

  it('defaults RIG_PLANNER to jev, rejects anything but jev|laya|llm|stub', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    assert.ok(script.includes('RIG_PLANNER="${RIG_PLANNER:-jev}"'), 'jev no longer the rig default')
    assert.ok(script.includes('export RIG_PLANNER'), 'planner not exported to the replay')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-planner-'))
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), ...env } })
    const bad = run({ RIG_PLANNER: 'bogus' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /RIG_PLANNER: want jev\|laya\|llm\|stub/)
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

describe('castle-rig.sh --night and interrupt cleanup (idkcraft-ek69)', () => {
  const { spawnSync, spawn, execFileSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')

  it('parses --night first, rejects stray args, skips the day lock', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-night-'))
    const run = (args, env = {}) => spawnSync('sh', [sh, ...args], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    assert.match(run(['--night', '6']).stdout, /no START.sh/)
    assert.match(run(['--night']).stdout, /no START.sh/)
    const late = run(['6', '--night'])
    assert.equal(late.status, 2)
    assert.match(late.stdout, /usage: castle-rig.sh \[--night\] \[mins\]/)
    const bad = run([], { CASTLE_NIGHT: 'yes' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /CASTLE_NIGHT: want 0\|1/)
    const script = fs.readFileSync(sh, 'utf8')
    assert.ok(script.includes('if [ "$NIGHT" = 1 ]; then'), 'night does not bypass the day lock')
    assert.ok(script.includes('CASTLE_NIGHT="$NIGHT"'), 'night not exported to the replay')
  })

  it('parses --night prod and checks CASTLE_HOUSE (idkcraft-neuc.65.2)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-night-'))
    const run = (args, env = {}) => spawnSync('sh', [sh, ...args], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    assert.match(run(['--night', 'prod', '68']).stdout, /no START.sh/)
    assert.match(run(['--night', 'prod']).stdout, /no START.sh/)
    assert.match(run([], { CASTLE_NIGHT: 'prod' }).stdout, /no START.sh/)
    assert.equal(run(['--night', 'prod', '6', 'x']).status, 2)
    const lone = run(['--night'], { CASTLE_HOUSE: 'bump' })
    assert.equal(lone.status, 2)
    assert.match(lone.stdout, /CASTLE_HOUSE needs CASTLE_BARE=1/)
    assert.match(run(['--night'], { CASTLE_HOUSE: 'bump', CASTLE_BARE: '1' }).stdout, /no START.sh/)
    assert.match(run([], { CASTLE_HOUSE: 'tower', CASTLE_BARE: '1' }).stdout, /CASTLE_HOUSE: want/)
    const script = fs.readFileSync(sh, 'utf8')
    assert.ok(script.includes('if [ "$NIGHT" = prod ]; then'), 'prod night does not bypass the day lock')
  })

  // Fake rig: docker `run` stays alive like the Paper client (pid in
  // run.pid), rcon answers `ok` when up (else the rig sits in its boot
  // wait), a fake `node` replays NODE_MODE (hang: pid in node.pid; exit2).
  const fakeRig = ({ rconUp, nodeMode = 'hang' }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-int-'))
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    const f = { tmp, calls: path.join(tmp, 'docker.calls'), runPid: path.join(tmp, 'run.pid'), nodePid: path.join(tmp, 'node.pid'), lock: path.join(tmp, 'lock') }
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$*" >> "${f.calls}"
case "$1" in
  run) echo $$ > "${f.runPid}"; exec sleep 300 ;;
  exec) ${rconUp ? 'echo ok; exit 0' : 'exit 1'} ;;
esac
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'node'), nodeMode === 'hang'
      ? `#!/bin/sh\necho $$ > "${f.nodePid}"\nexec sleep 300\n`
      : '#!/bin/sh\necho "replay env failure"\nexit 2\n', { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, 'START.sh'), 'exec docker run --rm --name idk-replay -e EULA=TRUE -p 25571:25565 img\n', { mode: 0o755 })
    fs.mkdirSync(path.join(tmp, 'replay-data', 'paper-base', 'world'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'w', 'world'), { recursive: true })
    execFileSync('tar', ['-cf', path.join(tmp, 'world.tar'), '-C', path.join(tmp, 'w'), 'world'])
    const child = spawn('sh', [sh, '1'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRODWORLD: tmp, CASTLE_LOCK: f.lock, CASTLE_RIG_ID: 'q', RIG_PLANNER: 'stub', CASTLE_OUT: path.join(tmp, 'out.json') } })
    f.out = ''
    child.stdout.on('data', (d) => { f.out += d })
    f.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    f.child = child
    return f
  }
  const waitFile = async (p) => {
    for (let i = 0; i < 300 && !fs.existsSync(p); i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(fs.existsSync(p), `never appeared: ${p}`)
    return Number(fs.readFileSync(p, 'utf8'))
  }
  const assertReaped = (f, pids) => {
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `pid ${pid} still alive`)
    assert.ok(fs.readFileSync(f.calls, 'utf8').includes('rm -f idk-castle-q'), 'own container not removed')
    assert.ok(!fs.existsSync(`${f.lock}-q`), 'lock left behind')
  }

  it('kill -INT mid-boot reaps the server child, rm -f its container, drops the lock', async () => {
    const f = fakeRig({ rconUp: false })
    const srv = await waitFile(f.runPid)
    f.child.kill('SIGINT')
    assert.equal(await f.exited, 130, f.out)
    assert.match(f.out, /interrupted/)
    assertReaped(f, [srv])
  })

  it('kill -INT mid-window returns at once and reaps the replay too', async () => {
    const f = fakeRig({ rconUp: true })
    const srv = await waitFile(f.runPid)
    const node = await waitFile(f.nodePid)
    const t = Date.now()
    f.child.kill('SIGINT')
    assert.equal(await f.exited, 130, f.out)
    assert.ok(Date.now() - t < 20000, 'trap waited for the replay')
    assertReaped(f, [srv, node])
  })

  it('a replay exit 2 still reaches the caller as 2 (cycles.sh branches on it)', async () => {
    const f = fakeRig({ rconUp: true, nodeMode: 'exit2' })
    const srv = await waitFile(f.runPid)
    assert.equal(await f.exited, 2, f.out)
    assert.match(f.out, /replay env failure/)
    assertReaped(f, [srv])
  })
})

describe('castle-replay.js night driver (idkcraft-ek69)', () => {
  const { createNightDriver, classify, seen, resetSeen } = require('../tools/castle-replay')

  it('ignores setup crossings, runs each night, prints one verdict per dawn', async () => {
    resetSeen()
    const cmds = []
    const lines = []
    let deaths = 0
    const d = createNightDriver({ cmd: async (c) => { cmds.push(c); return 'ok' }, who: 'Bot', deaths: () => deaths, log: (l) => lines.push(l) })
    await d.onEvent({ event: 'nightfall' }) // before the window: stays peaceful
    assert.deepEqual(cmds, [])
    await d.open()
    assert.deepEqual(cmds, ['time set 0'])
    classify('goal step=castle prev=none source=x fsm=castle why=y menu=castle facts=z')
    await d.onEvent({ event: 'nightfall' })
    assert.deepEqual(cmds.slice(1), ['difficulty easy', 'execute at Bot run summon phantom ~ ~16 ~', 'execute at Bot run summon phantom ~ ~16 ~'])
    classify('goal step=shelter prev=castle source=x fsm=shelter why=y menu=shelter facts=z')
    deaths = 1
    await d.onEvent({ event: 'dawn' })
    assert.equal(cmds[cmds.length - 1], 'difficulty peaceful')
    assert.deepEqual(d.nights[0], { night: 1, deaths: 1, sheltered: true, steps: ['castle', 'shelter'], partial: false })
    assert.ok(lines.includes('CASTLE-RIG night 1: deaths=1, sheltered=yes, steps=castle,shelter'))
    // Second night ends with the window: partial, worked through.
    classify('goal step=castle prev=shelter source=x fsm=castle why=y menu=castle facts=z')
    await d.onEvent({ event: 'nightfall' })
    deaths = 3
    d.finish()
    assert.deepEqual(d.nights[1], { night: 2, deaths: 2, sheltered: false, steps: ['castle'], partial: true })
    assert.equal(d.tag(), ', nights=2, sheltered=1/2, night-deaths=3')
    assert.equal(seen.nightSteps, null)
  })

  it('a failed rcon logs loud and never throws', async () => {
    const lines = []
    const d = createNightDriver({ cmd: async () => { throw new Error('boom') }, who: 'Bot', deaths: () => 0, log: (l) => lines.push(l) })
    await d.open()
    assert.ok(lines.some((l) => l.includes('night-rcon FAILED [time set 0]: boom')))
    assert.equal(d.tag(), ', nights=0')
  })

  it('prod: easy + fall damage once at open, no flips, day-deaths and kitless (idkcraft-neuc.65.2)', async () => {
    resetSeen()
    const cmds = []
    const lines = []
    let deaths = 2 // setup deaths before open are not the window's
    const d = createNightDriver({ cmd: async (c) => { cmds.push(c); return 'ok' }, who: 'Bot', deaths: () => deaths, log: (l) => lines.push(l), prod: true, openCmds: ['difficulty easy', 'gamerule fall_damage true'] })
    classify('death health=0 hostiles=1 at 1 64 1 time=day inside=no step=forage owner=work sword=0 pickaxe=none dist_home=none dist_spawn=3')
    await d.open()
    assert.deepEqual(cmds, ['time set 0', 'difficulty easy', 'gamerule fall_damage true'])
    deaths = 3 // a day death, kitless
    classify('death health=0 hostiles=1 at 1 64 1 time=day inside=no step=forage owner=work sword=0 pickaxe=none dist_home=none dist_spawn=3')
    await d.onEvent({ event: 'nightfall' })
    deaths = 4 // a night death with a sword
    classify('death health=0 hostiles=1 at 1 64 1 time=night inside=no step=shelter owner=work sword=1 pickaxe=stone+ dist_home=none dist_spawn=3')
    await d.onEvent({ event: 'dawn' })
    assert.equal(cmds.length, 3, 'no difficulty flips or phantoms')
    assert.deepEqual(d.nights[0], { night: 1, deaths: 1, sheltered: false, steps: [], partial: false })
    assert.ok(lines.includes('CASTLE-RIG night 1: deaths=1, sheltered=no, steps=none'))
    assert.equal(d.tag(), ', nights=1, sheltered=0/1, night-deaths=1, day-deaths=1, kitless=1')
  })

  it('house-bump: door distance of the settled shelter per night (idkcraft-neuc.65.2)', async () => {
    resetSeen()
    const lines = []
    const door = { x: 10.5, z: 0.5 }
    const d = createNightDriver({ cmd: async () => 'ok', who: 'Bot', deaths: () => 0, log: (l) => lines.push(l), prod: true, door })
    await d.open()
    classify('goal step=shelter prev=gohome source=x fsm=shelter why=step-failed fail=failed:cannot-reach-home menu=m facts=f')
    classify('shelter phase=walk pos=10 64 -1 hostile=none')
    classify('shelter phase=dug-in pos=10 63 -10 hostile=none') // dusk: before nightfall
    await d.onEvent({ event: 'nightfall' })
    await d.onEvent({ event: 'dawn' })
    assert.equal(d.nights[0].doorDist, 10)
    assert.ok(lines.includes('CASTLE-RIG house-bump night 1: gohome-fails=1, shelter-at=10 63 -10, door-dist=10, deaths=0, PASS'))
    classify('shelter phase=pillar pos=10 64 -2 hostile=none') // night 2: pillars at the door
    await d.onEvent({ event: 'nightfall' })
    await d.onEvent({ event: 'dawn' })
    assert.ok(lines.includes('CASTLE-RIG house-bump night 2: gohome-fails=0, shelter-at=10 64 -2, door-dist=2, deaths=0, FAIL'))
    await d.onEvent({ event: 'nightfall' })
    d.finish()
    assert.ok(lines.includes('CASTLE-RIG house-bump night 3: gohome-fails=0, shelter-at=none, door-dist=none, deaths=0, FAIL (partial)'))
    assert.equal(d.tag(), ', nights=3, sheltered=3/3, night-deaths=0, day-deaths=0, kitless=0, bump=1/3')
  })

  it('v2 body: crossings from bot.time without a packet client (idkcraft-neuc.65.2)', () => {
    const { createTimeResync } = require('../tools/castle-replay')
    const events = []
    const r = createTimeResync({ write: false, onEvent: (e) => events.push(e) })
    // Fake mirrors the bridge contract: bot/src/bridge/index.js:549 writes
    // st.time.timeOfDay into bot.time.timeOfDay, then emits 'time'.
    const bot = { time: { timeOfDay: 11000 } }
    r.onBotTime(bot, 1) // first read arms, no event
    for (const [t, at] of [[12100, 2], [12500, 3], [13100, 4], [23999, 5], [10, 6], [13500, 7]]) { bot.time.timeOfDay = t; r.onBotTime(bot, at) }
    // 13500 straight from day (a forward set) is not a crossing
    assert.deepEqual(events.map((e) => [e.event, e.server, e.at]), [['dusk', 12100, 2], ['nightfall', 13100, 4], ['dawn', 10, 6]])
  })

  it('v2 clock hook runs only in night mode (idkcraft-neuc.65.2)', () => {
    const { EventEmitter } = require('node:events')
    const { createTimeResync, hookBotClock } = require('../tools/castle-replay')
    const run = (night) => {
      const events = []
      const r = createTimeResync({ write: false, onEvent: (e) => events.push(e) })
      const b = new EventEmitter() // bridge bot shape: bot.time + 'time' (bot/src/bridge/index.js:549)
      b.time = { timeOfDay: 11000 }
      const hooked = hookBotClock(b, r, night)
      for (const t of [11000, 12100, 13100]) { b.time.timeOfDay = t; b.emit('time') }
      return { hooked, events: events.map((e) => e.event) }
    }
    assert.deepEqual(run(false), { hooked: false, events: [] })
    assert.deepEqual(run(true), { hooked: true, events: ['dusk', 'nightfall'] })
  })

  it('prodSpawnPoint / rigHouseCommands (idkcraft-neuc.65.2)', () => {
    const { prodSpawnPoint, rigHouseCommands } = require('../tools/castle-replay')
    assert.deepEqual(prodSpawnPoint({ x: 250, z: 350 }, { x: -50, z: -50 }), { x: 160, z: 230 })
    assert.deepEqual(prodSpawnPoint({ x: 0, z: 0 }, { x: 0, z: 0 }), { x: 150, z: 0 })
    assert.deepEqual(prodSpawnPoint({ x: 0, z: 0 }, null), { x: 150, z: 0 })
    assert.equal(rigHouseCommands({ x: 0, y: 64, z: 0 }, 'clean').length, 2)
    assert.equal(rigHouseCommands({ x: 0, y: 64, z: 0 }, 'bump')[2], 'fill 3 64 1 3 65 1 bedrock')
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
    for (const seam of ['CASTLE_PORT', 'CASTLE_CONTAINER', 'CASTLE_TAG', 'CASTLE_MINS', 'CASTLE_PAD', 'CASTLE_PADSPOT', 'CASTLE_OUT', 'CASTLE_BLOCKED', 'CASTLE_DIAG']) {
      assert.ok(src.includes(seam), `missing env seam ${seam}`)
    }
    // Usernames cap at 16 chars (stuck-replay precedent): the length guard
    // must stay, or an overlong TAG dies in the hello decode server-side.
    assert.ok(src.includes('exceed 16 chars'), 'missing 16-char name guard')
    // Holes report (vmzq.27): the follower's `castle: ` chats land in the
    // log + OUT record, or the one-line acceptance has no rig evidence.
    assert.ok(src.includes('CASTLE-RIG say: '), 'missing holes say-capture')
    assert.ok(src.includes('said: seen.said'), 'missing said record field')
    assert.ok(src.includes('diag: DIAG'), 'DIAG not passed to componentLine')
    assert.ok(fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8').includes('export CASTLE_DIAG='), 'wrapper does not export CASTLE_DIAG')
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

describe('castle-replay.js time resync (idkcraft-vmzq.45)', () => {
  const { createTimeResync, timeDrift } = require('../tools/castle-replay')
  const mkBot = (dim = 'overworld', tod = 0) => ({
    game: { dimension: dim },
    registry: { dimensionsById: { 0: { name: 'overworld' }, 1: { name: 'overworld_caves' } } },
    time: { timeOfDay: tod, time: tod, day: 0, isDay: true, moonPhase: 0, bigTime: BigInt(tod), doDaylightCycle: true },
  })
  const full = (total, rate = 1, id = 0) => ({ clockUpdates: [{ id, totalTicks: total, partialTick: 0, rate }] })
  const empty = () => ({ clockUpdates: [] })

  it('anchors on the full packet and counts +20 game ticks per empty', () => {
    const bot = mkBot()
    const r = createTimeResync()
    r.onPacket(bot, full(1000), 0)
    assert.equal(r.daytime(), 1000)
    assert.equal(bot.time.timeOfDay, 0) // full: mineflayer's own write stands
    r.onPacket(bot, empty(), 200)
    assert.equal(bot.time.timeOfDay, 0) // onPacket never writes (mineflayer runs after it)
    assert.equal(r.daytime(), 1020)
    r.apply(bot) // the 'time' tap lands after mineflayer's write
    assert.equal(bot.time.timeOfDay, 1020)
    assert.equal(bot.time.time, 1020)
    assert.equal(bot.time.day, 0)
    assert.equal(bot.time.isDay, true)
    assert.equal(bot.time.moonPhase, 0)
    r.onPacket(bot, empty(), 400)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 1040)
  })

  it('re-anchors on the next full packet (time-set)', () => {
    const bot = mkBot()
    const r = createTimeResync()
    r.onPacket(bot, full(1000), 0)
    r.onPacket(bot, empty(), 200)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 1020)
    r.onPacket(bot, full(5000), 1000)
    assert.equal(r.daytime(), 5000)
    r.onPacket(bot, empty(), 1200)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 5020)
  })

  it('rate=0 (daylock) freezes: empties never advance the clock', () => {
    const bot = mkBot('overworld', 1000)
    const r = createTimeResync()
    r.onPacket(bot, full(1000, 0), 0)
    for (let i = 0; i < 97; i++) { r.onPacket(bot, empty(), 200 * (i + 1)); r.apply(bot) }
    assert.equal(bot.time.timeOfDay, 1000)
    assert.equal(r.daytime(), 1000)
  })

  it('track mode counts but never writes bot.time (the TICKRATE=1 gate path)', () => {
    const bot = mkBot()
    const r = createTimeResync({ write: false })
    r.onPacket(bot, full(1000), 0)
    r.onPacket(bot, empty(), 200)
    r.apply(bot)
    assert.equal(r.daytime(), 1020)
    assert.equal(bot.time.timeOfDay, 0)
  })

  it('stays hands-off on unknown dims, dim switches and pre-26.1 packets', () => {
    const bot = mkBot()
    const r = createTimeResync()
    r.onPacket(bot, full(1000, 1, 9), 0) // no registry entry for id 9
    assert.equal(r.daytime(), null)
    r.onPacket(bot, empty(), 200)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 0)
    r.onPacket(bot, full(1000), 400)
    bot.game.dimension = 'the_nether' // switched away: empties ignored, apply blocked
    r.onPacket(bot, empty(), 600)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 0)
    bot.game.dimension = 'overworld'
    r.onPacket(bot, {}, 800) // pre-26.1 shape: no clockUpdates
    r.onPacket(bot, empty(), 1000)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 1020)
  })

  it('defers write-mode events to the live tick with the brain-read clock (revmux 02)', () => {
    const bot = mkBot()
    const events = []
    const r = createTimeResync({ onEvent: (ev) => events.push(ev) })
    r.onPacket(bot, full(11990), 0)
    r.apply(bot)
    r.onTick(bot)
    assert.deepEqual(events, [])
    r.onPacket(bot, empty(), 200) // 12010: queued
    r.apply(bot) // writes, but reports nothing yet
    assert.deepEqual(events, [])
    r.onTick(bot)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'dusk')
    assert.equal(events[0].server, 12010)
    assert.equal(events[0].bot, 12010)
    assert.equal(events[0].at, 200)
    // The report can fail: a post-apply overwrite shows up on the line.
    r.onPacket(bot, full(12990), 1000)
    r.apply(bot)
    r.onPacket(bot, empty(), 1200) // 13010: nightfall queued
    r.apply(bot)
    bot.time.timeOfDay = 999 // a later listener overwrote the correction
    r.onTick(bot)
    assert.equal(events.length, 2)
    assert.equal(events[1].event, 'nightfall')
    assert.equal(events[1].server, 13010)
    assert.equal(events[1].bot, 999)
  })

  it('drops queued crossings on time-set jumps and fires dawn once', () => {
    const bot = mkBot()
    const events = []
    const r = createTimeResync({ onEvent: (ev) => events.push(ev) })
    r.onPacket(bot, full(12990), 0)
    r.apply(bot)
    r.onTick(bot)
    r.onPacket(bot, empty(), 200) // 13010: nightfall queued
    r.onPacket(bot, full(6000), 300) // jump before the flush: queued crossing dropped
    r.apply(bot)
    r.onTick(bot)
    assert.deepEqual(events, [])
    r.onPacket(bot, full(23990), 200000) // jump to night: silent
    r.apply(bot)
    r.onTick(bot)
    assert.deepEqual(events, [])
    r.onPacket(bot, empty(), 200200) // 24010 -> daytime 10: dawn
    r.apply(bot)
    r.onTick(bot)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'dawn')
    assert.equal(events[0].server, 10)
    assert.equal(events[0].bot, 10)
  })

  it('a forward jump out of the night is the sleep skip: one dawn (g0z.33 revmux 01)', () => {
    const bot = mkBot()
    const events = []
    const r = createTimeResync({ write: false, onEvent: (ev) => events.push(ev) })
    r.onPacket(bot, full(12990), 0)
    r.onPacket(bot, empty(), 200) // 13010: nightfall
    r.onPacket(bot, full(24000), 300) // everyone asleep: the server skips to morning
    assert.deepEqual(events.map((e) => [e.event, e.server, !!e.skip]), [['nightfall', 13010, false], ['dawn', 0, true]])
    r.onPacket(bot, full(36500), 400) // a forward set from day to night: silent
    r.onPacket(bot, full(30000), 500) // a backward set from night to day: silent
    assert.equal(events.length, 2)
    // Asleep by ~12600 the skip often lands while still dusk: a dawn too.
    const d = []
    const k = createTimeResync({ write: false, onEvent: (ev) => d.push(ev) })
    k.onPacket(bot, full(12590), 0)
    k.onPacket(bot, full(24000), 100)
    assert.deepEqual(d.map((e) => [e.event, !!e.skip]), [['dawn', true]])
    // Write mode queues it for the live tick like any crossing.
    const w = createTimeResync({ onEvent: (ev) => events.push(ev) })
    w.onPacket(bot, full(13500), 0)
    w.onPacket(bot, empty(), 100) // word = night
    w.onPacket(bot, full(48000), 200)
    w.apply(bot)
    w.onTick(bot)
    assert.deepEqual([events[2].event, events[2].skip], ['dawn', true])
  })

  it('track mode reports crossings immediately with the live clock', () => {
    const bot = mkBot('overworld', 11995) // mineflayer's own value, untouched by us
    const events = []
    const r = createTimeResync({ write: false, onEvent: (ev) => events.push(ev) })
    r.onPacket(bot, full(11990), 0)
    r.onPacket(bot, empty(), 200) // counted 12010, no apply needed
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'dusk')
    assert.equal(events[0].server, 12010)
    assert.equal(events[0].bot, 11995) // the live bot.time read, not the count
  })

  it('holds server truth through the real mineflayer time plugin at 5x packet rate (revmux 01)', () => {
    const { EventEmitter } = require('node:events')
    // Pinned-version internal path (mineflayer 4.39.0): breaks loudly on upgrade if moved.
    const timePlugin = require('../node_modules/mineflayer/lib/plugins/time.js')
    const client = new EventEmitter()
    const bot = Object.assign(new EventEmitter(), {
      _client: client,
      game: { dimension: 'overworld' },
      registry: { dimensionsById: { 0: { name: 'overworld' } } },
    })
    const events = []
    const r = createTimeResync({ onEvent: (ev) => events.push(ev) })
    client.on('update_time', (packet) => r.onPacket(bot, packet)) // rig tap first (mk order)
    timePlugin(bot) // mineflayer injects deferred: its tap lands second
    bot.on('time', () => r.apply(bot))
    bot.on('physicsTick', () => r.onTick(bot))
    const mfull = (total, rate = 1) => ({ age: [0, 0], clockUpdates: [{ id: 0, totalTicks: total, partialTick: 0, rate }] })
    const mempty = () => ({ age: [0, 0], clockUpdates: [] })
    client.emit('update_time', mfull(11990))
    assert.equal(bot.time.timeOfDay, 11990) // mineflayer's own full-packet write
    // One 5x wall-second at prod cadence: five empties, four physicsTicks each.
    for (let k = 0; k < 5; k++) {
      client.emit('update_time', mempty())
      for (let i = 0; i < 4; i++) bot.emit('physicsTick')
    }
    // Mineflayer alone would sit at 12010 (20/s wall); the rig holds server truth 12090.
    assert.equal(bot.time.timeOfDay, 12090)
    assert.equal(r.daytime(), 12090)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'dusk')
    assert.equal(events[0].server, 12010)
    assert.equal(events[0].bot, 12010)
  })

  it('timeDrift compares circularly and passes nulls through', () => {
    assert.equal(timeDrift(12000, 12020), 20)
    assert.equal(timeDrift(5, 23995), 10) // midnight straddle, not 23990
    assert.equal(timeDrift(null, 5), null)
    assert.equal(timeDrift(5, null), null)
    assert.equal(timeDrift(null, null), null)
  })

  it('small-delta fulls stay continuous (live-truth re-anchor)', () => {
    const bot = mkBot()
    const events = []
    const r = createTimeResync({ onEvent: (ev) => events.push(ev) })
    r.onPacket(bot, full(11990), 0)
    r.onPacket(bot, empty(), 200) // 12010: dusk
    r.apply(bot)
    r.onTick(bot)
    assert.equal(events.length, 1)
    r.onPacket(bot, full(12015), 400) // gamerule-flip shape: delta 5, same word
    r.apply(bot)
    r.onTick(bot)
    assert.equal(events.length, 1)
    assert.equal(r.daytime(), 12015)
    r.onPacket(bot, empty(), 600)
    r.apply(bot)
    assert.equal(bot.time.timeOfDay, 12035)
  })

  it('wires the follower update_time tap and the time report fields', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    assert.ok(src.includes("b._client.on('update_time'"), 'missing follower time tap')
    assert.ok(src.includes("b.on('time'"), 'missing follower time-apply tap')
    assert.ok(src.includes("b.on('physicsTick'"), 'missing follower tick-flush tap')
    assert.ok(src.includes('CASTLE-RIG time: '), 'missing dusk/dawn report line')
    assert.ok(src.includes('timeEvents: seen.timeEvents'), 'missing timeEvents record field')
    assert.ok(src.includes('CASTLE-RIG time-drift:'), 'missing drift breach line')
    assert.ok(src.includes('timeMaxDrift: seen.timeMaxDrift'), 'missing drift record field')
    assert.ok(src.includes("mode=${RESYNC_WRITE ? 'correct' : 'track'}"), 'missing resync mode line')
  })
})

describe('castle-replay.js pad-spot pick', () => {
  const { pickPadSpot } = require('../tools/castle-replay')

  it('a pin wins without scanning (controlled pairs, vmzq.33 pair 2)', () => {
    const keep = process.env.CASTLE_PADSPOT
    process.env.CASTLE_PADSPOT = '250,350'
    try {
      let scanned = 0
      const pick = pickPadSpot(() => { scanned++; return { span: 1, liquid: 0, score: 1 } }, 300, 300)
      assert.deepEqual([pick.bx, pick.bz], [250, 350])
      assert.equal(pick.pinned, true)
      assert.equal(scanned, 0, 'the scan never runs: no chunk-timing flake')
    } finally {
      if (keep === undefined) delete process.env.CASTLE_PADSPOT
      else process.env.CASTLE_PADSPOT = keep
    }
  })

  it('a bad pin shape fails the run, never a silent probe', () => {
    const keep = process.env.CASTLE_PADSPOT
    process.env.CASTLE_PADSPOT = '250x350'
    try {
      assert.throws(() => pickPadSpot(() => null, 300, 300), /CASTLE_PADSPOT/)
    } finally {
      if (keep === undefined) delete process.env.CASTLE_PADSPOT
      else process.env.CASTLE_PADSPOT = keep
    }
  })

  it('unpinned: min score wins, unreadables skipped, all-null falls back', () => {
    const keep = process.env.CASTLE_PADSPOT
    delete process.env.CASTLE_PADSPOT
    try {
      const byKey = { '250,350': { span: 18, liquid: 0, score: 18 }, '250,300': { span: 11, liquid: 77, score: 165 } }
      const pick = pickPadSpot((x, z) => byKey[`${x},${z}`] || null, 300, 300)
      assert.deepEqual([pick.bx, pick.bz], [250, 350], '18 beats 165; nulls skipped')
      assert.equal(pick.pinned, false)
      const fallback = pickPadSpot(() => null, 300, 300)
      assert.deepEqual([fallback.bx, fallback.bz], [300, 300], 'preferred when nothing reads')
    } finally {
      if (keep === undefined) delete process.env.CASTLE_PADSPOT
      else process.env.CASTLE_PADSPOT = keep
    }
  })
})

describe('castle-replay.js pad landing (g0z.54)', () => {
  const { landingY, padFloats, acceptLanding, floatingPad } = require('../tools/castle-replay')

  it('landingY: a mid-fall read never lands, five stable reads do', () => {
    assert.equal(landingY([150, 147.2, 144.1, 141.3, 139.2]), null, 'falling: the 0/44 misread shape')
    assert.equal(landingY([150, 149.1, 148.2, 147.4, 146.5]), null, 'laggy fall still moves')
    assert.equal(landingY([63, 63, 63, 63, 63]), 63, 'landed: exact stand')
    assert.equal(landingY([62.1, 62.5, 62.9, 62.3, 62.7]), 62, 'landed: jitter inside one block')
    assert.equal(landingY([63, 63, 63, 63]), null, 'four reads are not enough')
    assert.equal(landingY([63, 63, null, 63, 63]), null, 'an unreadable read vetoes')
  })

  it('acceptLanding: a hover at the tp height keeps polling (revmux core-2)', () => {
    assert.equal(acceptLanding([150, 150, 150, 150, 150]), null, 'frozen at tp height: unloaded chunk')
    assert.equal(acceptLanding([141, 141, 141, 141, 141]), null, 'above the ceiling: keep waiting')
    assert.equal(acceptLanding([140, 140, 140, 140, 140]), 140, 'at the ceiling: a high mountain lands')
    assert.equal(acceptLanding([63, 63, 63, 63, 63]), 63, 'normal landing passes through')
  })

  it('padFloats: air/void/unreadable below fails, solid or liquid passes', () => {
    assert.equal(padFloats(null), true, 'unreadable')
    assert.equal(padFloats({ name: 'air' }), true, 'floating')
    assert.equal(padFloats({ name: 'cave_air' }), true)
    assert.equal(padFloats({ name: 'void_air' }), true)
    assert.equal(padFloats({ name: 'dirt' }), false, 'on terrain')
    assert.equal(padFloats({ name: 'stone' }), false)
    assert.equal(padFloats({ name: 'water' }), false, 'an ocean pad sits on water')
  })

  it('floatingPad: one air column is a cave, two is sky (revmux core-3)', () => {
    const air = { name: 'air' }
    const cave = { name: 'cave_air' }
    const dirt = { name: 'dirt' }
    assert.equal(floatingPad(air, air), true, '77-deep sky column')
    assert.equal(floatingPad(null, null), true, 'unreadable at both')
    assert.equal(floatingPad(cave, dirt), false, 'a cave under the pad is grounded')
    assert.equal(floatingPad(dirt, cave), false)
    assert.equal(floatingPad(dirt, dirt), false, 'on terrain')
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

describe('castle-replay.js seeded castle (idkcraft-g0z.33)', () => {
  const { seedCastleCells, seedMatches, createResidenceNights, classify, resetSeen } = require('../tools/castle-replay')
  const castle = require('../src/castle')

  it('seeds every v2 plan cell, the gate upper half, both beds and the table', () => {
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 2 }
    const cells = seedCastleCells(st)
    const plan = castle.absPlan(st.site, 0, 2).cells
    const placed = cells.filter((c) => castle.isPlaceTarget(c.kind) && c.kind !== 'extra')
    assert.equal(placed.length, 1722)
    assert.equal(cells.length, plan.length + 6)
    // Clear cells first, so no air setblock lands on a placed block.
    const firstPlace = cells.findIndex((c) => c.kind !== 'air' && c.kind !== 'dig')
    assert.ok(cells.slice(firstPlace).every((c) => c.kind !== 'air' && c.kind !== 'dig'))
    // Every painted block reads back as its plan kind.
    for (const c of placed) assert.ok(seedMatches(c, c.block.split('[')[0]), `${c.kind} ${c.block}`)
    const extra = cells.filter((c) => c.kind === 'extra').map((c) => c.block)
    assert.deepEqual(extra.map((b) => b.split('[')[0]), ['oak_door', 'red_bed', 'red_bed', 'red_bed', 'red_bed', 'crafting_table'])
    assert.ok(seedMatches({ kind: 'extra', block: 'red_bed[part=foot,facing=south]' }, 'red_bed'))
    assert.ok(!seedMatches({ kind: 'extra', block: 'crafting_table' }, 'air'))
  })

  it('judges each night: entered, slept, 0 shelter, 0 deaths, dawn exit', () => {
    resetSeen()
    const lines = []
    let deaths = 0
    const r = createResidenceNights({ deaths: () => deaths, log: (l) => lines.push(l) })
    r.onEvent({ event: 'dusk' }, 5) // before open: ignored
    r.open()
    r.onSample(10, false, false)
    r.onEvent({ event: 'dusk' }, 600)
    r.onSample(620, false, false)
    r.onSample(641, true, false)
    r.onSample(700, true, true)
    r.onEvent({ event: 'dawn' }, 1200)
    assert.ok(lines.includes('CASTLE-RIG residence night 1: entered=yes@41s, slept=yes, shelter=0, deaths=0, dawn-exit=pending'))
    r.onSample(1210, true, false)
    r.onSample(1233, false, false)
    assert.equal(r.nights[0].dawnExitS, 33)
    // Night 2: a shelter episode and a death, never inside.
    r.onEvent({ event: 'dusk' }, 1800)
    classify('goal step=shelter prev=gather source=x')
    classify('goal step=shelter prev=shelter source=x')
    deaths = 1
    r.onEvent({ event: 'dawn' }, 2400)
    // Night 3 cut by the window end.
    r.onEvent({ event: 'nightfall' }, 3000)
    r.finish(3100)
    assert.deepEqual(r.nights.map((n) => n.pass), [true, false, false])
    assert.equal(r.nights[1].shelter, 1)
    assert.equal(r.nights[1].deaths, 1)
    assert.equal(r.nights[2].partial, true)
    assert.ok(lines.includes('CASTLE-RIG residence night 1: entered=yes@41s, slept=yes, shelter=0, deaths=0, dawn-exit=33s, PASS'))
    assert.ok(lines.includes('CASTLE-RIG residence night 2: entered=no, slept=no, shelter=1, deaths=1, dawn-exit=n/a, FAIL'))
    assert.equal(r.tag(), ', residence=1/3')
  })

  it('castle-rig.sh rejects a bad CASTLE_SEED before any world work', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-seed-'))
    const r = spawnSync('sh', [path.join(__dirname, '..', 'tools', 'castle-rig.sh')], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', CASTLE_SEED: 'half' } })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /CASTLE_SEED: want ''\|complete/)
  })
})

describe('castle-replay.js upgrade run (idkcraft-g0z.48)', () => {
  const { parseSeedVersion, seedCastleCells } = require('../tools/castle-replay')
  const castle = require('../src/castle')

  it('parseSeedVersion: blank reads current, known versions pass, the rest throws', () => {
    assert.equal(parseSeedVersion(''), castle.BLUEPRINT_VERSION)
    assert.equal(parseSeedVersion(null), castle.BLUEPRINT_VERSION)
    assert.equal(parseSeedVersion('2'), 2)
    assert.equal(parseSeedVersion(' 3 '), 3)
    for (const bad of ['half', '0', '4', '9', '2.5']) {
      assert.throws(() => parseSeedVersion(bad), /CASTLE_SEED_VERSION: want ''\|1\|2\|3/)
    }
  })

  it('a v2 seed paints the 60 step cells as full blocks (the upgrade converts them)', () => {
    const st = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 2 }
    const v2 = seedCastleCells(st)
    assert.equal(v2.filter((c) => c.kind === 'stairs').length, 0, 'a v2 seed paints no stairs')
    const v3 = castle.absPlan(st.site, 0, 3).cells.filter((c) => c.kind === 'stairs')
    assert.equal(v3.length, 60)
    const paint = new Map(v2.map((c) => [`${c.x},${c.y},${c.z}`, c.block]))
    for (const c of v3) {
      const b = paint.get(`${c.x},${c.y},${c.z}`)
      assert.ok(b === 'cobblestone' || b === 'oak_planks', `${c.x} ${c.y} ${c.z}: ${b}`)
    }
  })

  it('castle-rig.sh rejects a bad CASTLE_SEED_VERSION; the upgrade pair passes validation', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const base = { ...process.env, PRODWORLD: fs.mkdtempSync(path.join(os.tmpdir(), 'castle-up-')), RIG_PLANNER: 'stub' }
    const bad = spawnSync('sh', [sh], { encoding: 'utf8', env: { ...base, CASTLE_LOCK: path.join(base.PRODWORLD, 'lock'), CASTLE_SEED_VERSION: 'half' } })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /CASTLE_SEED_VERSION: want ''\|1\|2\|3/)
    // Valid pair: past every validation, dies at the missing world copy.
    const good = spawnSync('sh', [sh], { encoding: 'utf8', env: { ...base, CASTLE_LOCK: path.join(base.PRODWORLD, 'lock2'), CASTLE_SEED: 'complete', CASTLE_SEED_VERSION: '2', CASTLE_KIT: 'stairs' } })
    assert.equal(good.status, 2)
    assert.match(good.stdout, /no START.sh/)
  })
})

describe('castle-replay.js idle-alone oracle (idkcraft-6x7.24)', () => {
  const { createIdleTrack, IDLE_MAXDIST, IDLE_HOME } = require('../tools/castle-replay')
  const { surfaceFloor } = require('../src/resources')
  const home = { kind: 'castle', site: { x: 100, y: 70, z: 200 } }

  it('tracks max XZ distance, min y and seconds under home.y-20', () => {
    const t = createIdleTrack(home)
    assert.equal(t.floor, surfaceFloor({ home }))
    t.onSample(0, { x: 100, y: 70, z: 200 })
    t.onSample(10, { x: 130, y: 49, z: 240 }) // dist 50, y 49 < 50: under from here
    t.onSample(25, { x: 100, y: 45, z: 200 }) // +15 s under
    t.onSample(30, { x: 100, y: 70, z: 200 }) // +5 s under, back up
    t.onSample(40, { x: 100, y: 70, z: 200 })
    assert.equal(t.tag(), ', idle-maxdist=50, idle-miny=45, idle-underground-s=20')
    const v = t.verdict(0)
    assert.equal(v.pass, false)
    assert.match(v.line, /^CASTLE-RIG idle: FAIL \(miny 45<54\) floor=54$/)
  })

  it('passes inside the leash and floor with no deaths; names every failure', () => {
    const ok = createIdleTrack(home)
    ok.onSample(0, { x: 100 + IDLE_MAXDIST, y: 60, z: 200 })
    ok.onSample(1, { x: 100 + IDLE_HOME, y: 60, z: 200 }) // far excursion, back home at the end
    assert.deepEqual(ok.verdict(0, [{ night: 1, partial: false, pass: true }, { night: 2, partial: true, pass: false }]),
      { pass: true, line: 'CASTLE-RIG idle: PASS floor=54' })
    const bad = createIdleTrack(home)
    bad.onSample(0, { x: 100 + IDLE_MAXDIST + 1, y: 60, z: 200 })
    assert.equal(bad.verdict(2, [{ night: 1, partial: false, pass: false }]).line,
      'CASTLE-RIG idle: FAIL (maxdist 201>200, not home at the end, deaths 2>0, residence night 1 FAIL) floor=54')
    assert.match(createIdleTrack(home).verdict(0).line, /no position samples/)
  })

  it('return home: mid-trip at the cutoff but home <5 min before passes; away the whole last 5 min fails', () => {
    const away = { x: 100 + 150, y: 60, z: 200 }
    const trip = createIdleTrack(home)
    trip.onSample(0, { x: 100, y: 60, z: 200 })
    trip.onSample(100, away)
    trip.onSample(280, away)
    assert.equal(trip.verdict(0).pass, true)
    const gone = createIdleTrack(home)
    gone.onSample(0, { x: 100, y: 60, z: 200 })
    gone.onSample(100, away)
    gone.onSample(401, away)
    assert.match(gone.verdict(0).line, /not home at the end/)
  })

  it('forced death (6x7.25): the respawn walk is not judged, tracking resumes inside the leash, never-back FAILs', () => {
    const t = createIdleTrack(home)
    t.onSample(0, { x: 100, y: 70, z: 200 })
    t.pause()
    t.onSample(179, { x: 325, y: 150, z: 200 }) // respawn read before died(): not judged
    t.died(180)
    t.onSample(181, { x: 700, y: 30, z: 800 }) // world spawn: not judged
    t.onSample(300, { x: 100 + IDLE_HOME + 1, y: 70, z: 200 })
    assert.equal(t.tag(), ', idle-maxdist=0, idle-miny=70, idle-underground-s=0, idle-death=180s, idle-rehome=never')
    assert.equal(t.verdict(0).line, 'CASTLE-RIG idle: FAIL (never back within the leash after the forced death) floor=54')
    t.onSample(400, { x: 100 + IDLE_HOME, y: 60, z: 200 })
    t.onSample(500, { x: 100, y: 45, z: 200 }) // back home, then a dive: judged
    assert.equal(t.tag(), ', idle-maxdist=80, idle-miny=45, idle-underground-s=0, idle-death=180s, idle-rehome=400s')
    assert.equal(t.verdict(0).line, 'CASTLE-RIG idle: FAIL (miny 45<54) floor=54')
  })

  it('idleRespawnPoint: 225 from home toward the world spawn, the spawn itself when closer', () => {
    const { idleRespawnPoint } = require('../tools/castle-replay')
    assert.deepEqual(idleRespawnPoint({ x: 0, z: 0 }, { x: 600, z: 0 }), { x: 225, y: 150, z: 0 })
    assert.deepEqual(idleRespawnPoint({ x: 0, z: 0 }, { x: -60, z: 80 }), { x: -60, y: 150, z: 80 })
    assert.deepEqual(idleRespawnPoint({ x: 5, z: 7 }, { x: 5, z: 7 }), { x: 5, y: 150, z: 7 })
  })

  it('yard litter (g0z.44): the count tags the verdict, PASS requires 0', () => {
    const t = createIdleTrack(home)
    t.onSample(0, { x: 100, y: 60, z: 200 })
    assert.equal(t.tag(), ', idle-maxdist=0, idle-miny=60, idle-underground-s=0', 'unset: the old shape')
    assert.equal(t.verdict(0).pass, true, 'unset: unjudged')
    t.setYardLitter(0)
    assert.equal(t.tag(), ', idle-maxdist=0, idle-miny=60, idle-underground-s=0, yard-litter=0')
    assert.deepEqual(t.verdict(0), { pass: true, line: 'CASTLE-RIG idle: PASS floor=54' })
    t.setYardLitter(2)
    assert.equal(t.verdict(0).line, 'CASTLE-RIG idle: FAIL (yard-litter 2>0) floor=54')
  })

  it('castle-rig.sh validates CASTLE_IDLE and only exports it (default output untouched)', () => {
    const { spawnSync } = require('node:child_process')
    const os = require('node:os')
    const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-idle-'))
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    const bad = run({ CASTLE_IDLE: 'yes' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /CASTLE_IDLE: want ''\|0\|1/)
    assert.match(run({ CASTLE_IDLE: '1' }).stdout, /no START.sh/)
    assert.match(run({ CASTLE_IDLE_DEATH: 'x' }).stdout, /CASTLE_IDLE_DEATH: want minutes/)
    assert.match(run({ CASTLE_IDLE_DEATH: '3' }).stdout, /CASTLE_IDLE_DEATH needs CASTLE_IDLE=1/)
    assert.match(run({ CASTLE_IDLE: '1', CASTLE_IDLE_DEATH: '3' }).stdout, /no START.sh/)
    const src = fs.readFileSync(sh, 'utf8')
    assert.ok(src.includes('1) SEED=complete ;;'), 'CASTLE_IDLE no longer implies the seeded castle')
    const rsrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    assert.ok(rsrc.includes("+ (idle ? idle.tag() : '')"), 'idle tail not on the verdict line')
    assert.ok(rsrc.includes('process.exit(idleV && !idleV.pass ? 1 : 0)'), 'idle FAIL no longer exits 1')
    // 6x7.25: under set -e a bare `node ...; echo $?` never wrote the rc — a FAIL exited 2.
    assert.ok(src.includes('node tools/castle-replay.js 2>&1 || _rc=$?'), 'replay rc capture is not set -e safe')
  })
})

describe('castle rig speed (idkcraft-neuc.60)', () => {
  const { componentLine } = require('../tools/castle-replay')
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')

  it('lay rate = cells per game minute, judged against the baseline', () => {
    const l = componentLine('lay', { laid: 300, gameMin: 10, wallMin: 3.33, legs: [], tick: '60', baseline: { rate: 28 } })
    assert.equal(l, 'lay-rate 30.0/game-min: laid=300 in 10.0 game-min, tick=60, baseline 28 -> 30.0 (+7%, within ±15%)')
    assert.match(componentLine('lay', { laid: 100, gameMin: 10, wallMin: 10, legs: [], tick: '1', baseline: { rate: 20 } }), /-50%, OUTSIDE ±15%/)
  })

  it('diag window prints the rate with the DIAG tag and no judge (6x7.26)', () => {
    const l = componentLine('lay', { laid: 72, gameMin: 3, wallMin: 3, tick: '1', baseline: { rate: 28 }, diag: true })
    assert.equal(l, 'lay-rate 24.0/game-min (DIAG, no baseline verdict): laid=72 in 3.0 game-min, tick=1')
    assert.doesNotMatch(componentLine('mine', { laid: 0, gameMin: 3, wallMin: 3, series: [], tick: '1', baseline: { rate: 5 }, diag: true }), /±15%/)
  })

  it('mine rate = stone banked per game minute of castlefetch, from the first gain', () => {
    const series = [
      { t: 0, step: null, stone: 0 },
      { t: 15, step: 'castlefetch', stone: 0 }, // the walk: first=, not rate
      { t: 30, step: 'castlefetch', stone: 10 },
      { t: 45, step: 'castle', stone: 4 }, // laying: neither banked nor timed
      { t: 60, step: 'castlefetch', stone: 14 },
      { t: 75, step: 'castlefetch', stone: 12 }, // a loss counts 0
    ]
    // 45 wall s of castlefetch at a measured 3x = 2.25 game min, +20 banked.
    const l = componentLine('mine', { laid: 0, gameMin: 3.75, wallMin: 1.25, series, tick: '60', baseline: null })
    assert.equal(l, 'mine-rate 8.9/game-min: banked=+20 in 2.3 game-min of castlefetch, first=45s, window=3.8 game-min, tick=60')
    assert.match(componentLine('mine', { laid: 0, gameMin: 9, wallMin: 3, series: series.slice(0, 2), tick: '60', baseline: { rate: 5 } }), /^mine-rate -\/game-min: banked=\+0 .*first=-/)
  })

  it('validates CASTLE_COMPONENT / CASTLE_TICK_RATE before touching the world', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-comp-'))
    const run = (env, args = []) => spawnSync('sh', [sh, ...args], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'stub', ...env } })
    const bad = run({ CASTLE_COMPONENT: 'fly' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /CASTLE_COMPONENT: want ''\|mine\|lay/)
    const seeded = run({ CASTLE_COMPONENT: 'lay', CASTLE_SEED: 'complete' })
    assert.equal(seeded.status, 2)
    assert.match(seeded.stdout, /CASTLE_COMPONENT orders a castle/)
    const rate = run({ CASTLE_TICK_RATE: 'fast' })
    assert.equal(rate.status, 2)
    assert.match(rate.stdout, /tickrate: want an integer/)
    const ok = run({ CASTLE_COMPONENT: 'mine', CASTLE_TICK_RATE: '60' })
    assert.match(ok.stdout, /neither body follows a server above 20 tps/)
    assert.match(ok.stdout, /no START.sh/)
    assert.match(run({ CASTLE_COMPONENT: 'lay' }, ['3']).stdout, /DIAG leg: 3 game-min lay component — diagnosis only, NOT a gate verdict/)
    assert.doesNotMatch(run({ CASTLE_COMPONENT: 'lay' }, ['10']).stdout, /DIAG/)
    assert.doesNotMatch(run({ CASTLE_COMPONENT: 'lay' }).stdout, /DIAG/)
    assert.doesNotMatch(run({}, ['3']).stdout, /DIAG/)
  })

  it('component-baseline.json: v2 lay + mine, two runs each within ±15% of the rate', () => {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'component-baseline.json'), 'utf8'))
    for (const k of ['lay', 'mine']) {
      const e = b.v2 && b.v2[k]
      assert.ok(e && e.rate > 0 && Array.isArray(e.runs) && e.runs.length >= 2, `v2.${k} malformed`)
      for (const r of e.runs) assert.ok(Math.abs(r / e.rate - 1) <= 0.15, `v2.${k} run ${r} outside ±15% of ${e.rate}`)
    }
  })
})

// idkcraft-6x7.27: shared BEFORE cache — key, staleness and write-through
// rules are pure, fed shas/dates (no docker, no git).
describe('castle-before.js shared before cache', () => {
  const cb = require('../tools/castle-before.js')
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const C = 'c'.repeat(40)
  const now = Date.parse('2026-10-17T12:00:00Z')
  const day = 24 * 3600 * 1000
  const at = (d) => new Date(now - d * day).toISOString()
  const opts = (o = {}) => ({ base: B, now, isAncestor: () => true, rigChanged: () => false, ...o })
  const v2 = { CASTLE_BODY: 'baritone', CASTLE_PADSPOT: '250,350', BARITONE_IMAGE: 'idkcraft-baritone:abc' }

  it('key = <sha>-<component>-<image tag>-<settings hash>; every gate setting moves it', () => {
    const s = cb.settingsOf(v2)
    assert.deepEqual(s, { body: 'baritone', padspot: '250,350', mins: '10', tick: '1', image: 'idkcraft-baritone:abc' })
    const k = cb.cacheKey(A, 'lay', s)
    assert.match(k, new RegExp(`^${A}-lay-idkcraft-baritone_abc-[0-9a-f]{10}$`))
    for (const ch of [{ CASTLE_PADSPOT: '1,2' }, { CASTLE_MINS: '15' }, { CASTLE_TICK_RATE: '20' }, { BARITONE_IMAGE: 'idkcraft-baritone:def' }, { CASTLE_BODY: '' }]) {
      assert.notEqual(cb.cacheKey(A, 'lay', cb.settingsOf({ ...v2, ...ch })), k, JSON.stringify(ch))
    }
    assert.notEqual(cb.cacheKey(A, 'mine', s), k)
    assert.equal(cb.settingsOf({}).image, '-', 'v1 body has no image')
    assert.equal(cb.settingsOf({ CASTLE_BODY: 'baritone' }, '1a2b3c4d').image, 'idkcraft-baritone:1a2b3c4d', 'default = client.sh tree-hash tag at the measured sha')
    assert.equal(cb.settingsOf({ CASTLE_BODY: 'baritone' }).image, 'idkcraft-baritone:local', 'no git = client.sh :local')
  })

  it('exact sha hits; stale (>7 d), ancestor-with-rig-changes and miss each give a one-line reason', () => {
    assert.equal(cb.pickBefore([{ sha: B, date: at(1), line: 'x' }], opts()).hit.line, 'x')
    const stale = cb.pickBefore([{ sha: B, date: at(8), line: 'x' }], opts())
    assert.match(stale.reason, /^stale: /)
    const anc = [{ sha: A, date: at(1), line: 'old' }]
    assert.equal(cb.pickBefore(anc, opts()).hit.line, 'old', 'docs-only ancestor is valid')
    assert.match(cb.pickBefore(anc, opts({ rigChanged: () => true })).reason, /^changed: .*ancestor.*rig files moved/)
    assert.match(cb.pickBefore([{ sha: A, date: at(9), line: 'old' }], opts()).reason, /^stale: /)
    assert.match(cb.pickBefore(anc, opts({ isAncestor: () => false })).reason, /^miss: /)
    assert.match(cb.pickBefore([], opts()).reason, /^miss: /)
    for (const r of [stale.reason, cb.pickBefore([], opts()).reason]) assert.ok(!r.includes('\n'))
  })

  it('prefers the exact sha, then the newest valid ancestor', () => {
    const es = [{ sha: A, date: at(0.5), line: 'anc' }, { sha: B, date: at(2), line: 'exact' }]
    assert.equal(cb.pickBefore(es, opts()).hit.line, 'exact')
    const two = [{ sha: A, date: at(3), line: 'older' }, { sha: C, date: at(1), line: 'newer' }]
    assert.equal(cb.pickBefore(two, opts()).hit.line, 'newer')
    assert.equal(cb.pickBefore(two, opts({ rigChanged: (s) => s === C })).hit.line, 'older')
  })

  it('stores only a clean, non-DIAG component leg on origin/master with this run\'s record', () => {
    const env = { ...v2, CASTLE_COMPONENT: 'lay', CASTLE_TAG: 'c1', CASTLE_MINS: '10', CASTLE_TICKRATE: '1' }
    const record = { tag: 'c1', date: at(0), component: 'lay-rate 24.2/game-min: laid=242 in 10.0 game-min, tick=1, baseline 24.2 -> 24.2 (+0%, within ±15%)' }
    const ok = { env, record, head: A, master: A, clean: true }
    const e = cb.storeEntry(ok)
    assert.equal(e.key, cb.cacheKey(A, 'lay', cb.settingsOf(env)))
    assert.equal(e.rate, 24.2)
    assert.equal(e.line, record.component)
    assert.equal(cb.storeEntry({ ...ok, head: B }), null, 'not origin/master')
    assert.equal(cb.storeEntry({ ...ok, clean: false }), null, 'dirty tree')
    assert.equal(cb.storeEntry({ ...ok, env: { ...env, CASTLE_DIAG: '1' } }), null, 'DIAG leg')
    assert.equal(cb.storeEntry({ ...ok, env: { ...env, CASTLE_COMPONENT: '' } }), null, 'no component')
    assert.equal(cb.storeEntry({ ...ok, record: { ...record, tag: 'old' } }), null, 'stale record file')
    for (const k of [{ CASTLE_NIGHT: '1' }, { CASTLE_KIT: 'empty' }, { CASTLE_BLOCKED: '4' }, { CASTLE_PAD: '1,2' }, { RIG_PLANNER: 'stub' }, { GOAL_WATCHDOG_MS: '1' }, { CASTLE_MAX_MEMORY: '2G' }, { BARITONE_MEM: '3g' }, { CASTLE_DAYLOCK: '0' }, { CASTLE_BASELINE_RATE: '20' }, { CASTLE_FAR: '40' }]) {
      assert.equal(cb.storeEntry({ ...ok, env: { ...env, ...k } }), null, `off-gate ${JSON.stringify(k)} must not cache`)
      assert.deepEqual(cb.offGate({ ...env, ...k }), Object.keys(k))
    }
    assert.ok(cb.storeEntry({ ...ok, env: { ...env, CASTLE_KIT: 'lay', RIG_PLANNER: 'jev', CASTLE_NIGHT: '0' } }), 'explicit gate defaults still cache')
    assert.ok(cb.storeEntry({ ...ok, env: { ...env, CASTLE_COMPONENT: 'mine', CASTLE_KIT: 'pick' } }), 'mine kit default caches')
  })

  it('the wrapper writes through only after a measured non-DIAG component leg; replay honours CASTLE_BASELINE_RATE', () => {
    const rig = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-rig.sh'), 'utf8')
    assert.ok(rig.includes('[ "$_rc" = 0 ] && [ -n "$COMPONENT" ] && [ -z "$DIAG" ]'), 'write-through guard drifted')
    assert.ok(rig.includes('node tools/castle-before.js store || true'), 'write-through must never fail the run')
    const { baselineFor, componentLine } = require('../tools/castle-replay.js')
    const file = { rate: 24.2 }
    assert.deepEqual(baselineFor(file, { CASTLE_BASELINE_RATE: '20.5' }), { rate: 20.5 })
    for (const v of [undefined, '', '0', 'abc', '-3']) assert.equal(baselineFor(file, { CASTLE_BASELINE_RATE: v }), file, `override ${v}`)
    assert.match(componentLine('lay', { laid: 205, gameMin: 10, wallMin: 10, series: [], tick: 1, baseline: baselineFor(file, { CASTLE_BASELINE_RATE: '20.5' }) }), /baseline 20\.5 -> 20\.5 \(\+0%, within ±15%\)/)
    assert.ok(fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8').includes('baseline: baselineFor(base, process.env)'), 'replay does not judge through baselineFor')
    assert.match(cb.rigCommand('mine', cb.settingsOf(v2), true), /CASTLE_BODY=baritone BARITONE_IMAGE=idkcraft-baritone:abc CASTLE_PADSPOT=250,350 CASTLE_COMPONENT=mine .*castle-rig\.sh$/)
    assert.doesNotMatch(cb.rigCommand('mine', cb.settingsOf({ CASTLE_BODY: 'baritone' }, 'abc'), false), /BARITONE_IMAGE/, 'default tag stays implicit: client.sh builds it')
  })
})
