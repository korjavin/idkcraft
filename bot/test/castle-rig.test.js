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
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), ...env } })
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
    const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: path.join(tmp, 'lock'), ...env } })
    const bad = run({ CASTLE_BLOCKED: 'many' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /blocked: want an integer/)
    const over = run({ CASTLE_BLOCKED: '99' })
    assert.equal(over.status, 2)
    assert.match(over.stdout, /blocked: want an integer/)
  })
})

describe('castle-rig.sh rig lock', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const sh = path.join(__dirname, '..', 'tools', 'castle-rig.sh')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-rig-'))
  const lock = path.join(tmp, 'lock')
  const run = (env = {}) => spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, CASTLE_LOCK: lock, ...env } })

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

describe('castle-replay.js verdict contract', () => {
  it('prints the one-line verdict shape and names its env seams', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'castle-replay.js'), 'utf8')
    assert.ok(src.includes('castle ${done}/${total} in ${MINS} min, flips='), 'verdict line shape drifted')
    for (const seam of ['CASTLE_PORT', 'CASTLE_CONTAINER', 'CASTLE_TAG', 'CASTLE_MINS', 'CASTLE_PAD', 'CASTLE_OUT', 'CASTLE_BLOCKED']) {
      assert.ok(src.includes(seam), `missing env seam ${seam}`)
    }
    // Usernames cap at 16 chars (stuck-replay precedent): the length guard
    // must stay, or an overlong TAG dies in the hello decode server-side.
    assert.ok(src.includes('exceed 16 chars'), 'missing 16-char name guard')
    // Holes report (vmzq.27): the follower's `castle: ` chats land in the
    // log + OUT record, or the one-line acceptance has no rig evidence.
    assert.ok(src.includes('CASTLE-RIG say: '), 'missing holes say-capture')
    assert.ok(src.includes('said: seen.said'), 'missing said record field')
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
})
