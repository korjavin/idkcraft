const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// idkcraft-6x7.16: work-rig.sh is the offline work-cycle twin of the
// rw4.7/atl.3 prod acceptances. Behavioural where it can be (no docker:
// the run dies at "no START.sh" right after the lock), static elsewhere.
const sh = path.join(__dirname, '..', 'tools', 'work-rig.sh')
const script = fs.readFileSync(sh, 'utf8')

function rig(env = {}, args = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-rig-'))
  const lock = path.join(tmp, 'lock')
  // stub planner: hermetic, no secret-store touch.
  const r = spawnSync('sh', [sh, ...args], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, WORK_LOCK: lock, RIG_PLANNER: 'stub', ...env } })
  return { ...r, tmp, lock }
}

describe('work-rig.sh validation', () => {
  it('rejects bad mins, tickrate and kit before docker or world work', () => {
    for (const [env, args, re] of [
      [{}, ['0'], /mins: want a positive integer/],
      [{}, ['soon'], /mins: want a positive integer/],
      [{ WORK_TICKRATE: 'fast' }, [], /tickrate: want an integer 1\.\.100/],
      [{ WORK_TICKRATE: '200' }, [], /tickrate: want an integer 1\.\.100/],
      [{ WORK_KIT: 'full' }, [], /WORK_KIT: want empty\|chest\|seeded/],
      [{ RIG_PLANNER: 'laya' }, [], /RIG_PLANNER: want jev\|stub/],
      [{ WORK_MAX_MEMORY: 'huge' }, [], /memory: want/],
      [{ WORK_RIG_ID: 'abc' }, [], /must be one letter/],
    ]) {
      const r = rig(env, args)
      assert.equal(r.status, 2, `${JSON.stringify(env)} ${args}: ${r.stdout}`)
      assert.match(r.stdout, re)
      assert.doesNotMatch(r.stdout, /no START.sh|seed:/, 'reached the world before failing')
      assert.ok(!fs.existsSync(r.lock), 'lock released on exit')
    }
  })

  it('valid args sail past validation to the world check', () => {
    const r = rig({}, ['20'])
    assert.equal(r.status, 2)
    assert.match(r.stdout, /no START.sh/)
  })

  it('jev without a key fails before the world, the key is never printed', () => {
    const { TYPESAFE_API_KEY: _drop, ...rest } = process.env
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-nokey-'))
    const r = spawnSync('sh', [sh], { encoding: 'utf8', env: { ...rest, PRODWORLD: tmp, WORK_LOCK: path.join(tmp, 'lock'), RIG_PLANNER: 'jev', HOME: tmp } })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /RIG_PLANNER=jev needs TYPESAFE_API_KEY/)
    assert.doesNotMatch(r.stdout, /no START.sh/)
    for (const line of script.split('\n')) {
      if (/echo|printf/.test(line) && line.includes('$TYPESAFE_API_KEY')) assert.fail(`key value printed: ${line}`)
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'work-replay.js'), 'utf8')
    for (const line of src.split('\n')) {
      if (/origLog|origErr|console\.(log|error)|\.chat\(/.test(line) && line.includes('${key}')) assert.fail(`key value printed: ${line.trim()}`)
    }
  })
})

describe('work-rig.sh lock and isolation', () => {
  it('busy lock (live holder) = exit 2, lock left intact', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-busy-'))
    const lock = path.join(tmp, 'lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const r = spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, WORK_LOCK: lock, RIG_PLANNER: 'stub', WORK_LOCK_WAIT: '0', RIG_LOCK_WAIT: '0' } })
    assert.equal(r.status, 2)
    assert.match(r.stdout, /rig busy/)
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid))
  })

  it('dead holder is reclaimed, the lock released on exit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-stale-'))
    const lock = path.join(tmp, 'lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), '1')
    const r = spawnSync('sh', [sh], { encoding: 'utf8', env: { ...process.env, PRODWORLD: tmp, WORK_LOCK: lock, RIG_PLANNER: 'stub' } })
    assert.match(r.stdout, /stale.*reclaiming/)
    assert.ok(!fs.existsSync(lock))
  })

  it('WORK_RIG_ID=a takes its own lock; own container, port and data dir beside the castle rig', () => {
    const r = rig({ WORK_RIG_ID: 'a' })
    assert.match(r.stdout, /no START.sh/)
    assert.ok(!fs.existsSync(`${r.lock}-a`), 'rig-a lock released on exit')
    assert.ok(script.includes('idk-work${RIG_ID:+-$RIG_ID}'), 'container not rig-scoped')
    assert.ok(script.includes('RIG_PORT=25611'), 'port base moved (castle owns 25581+)')
    assert.ok(script.includes('work-rigs/'), 'data dir not work-scoped')
    assert.ok(script.includes('/tmp/idkcraft-work-rig.lock'), 'lock path not work-scoped')
  })

  it('measures night and mobs: normal difficulty, the clock runs, exits 0/2/130', () => {
    for (const cmd of ['difficulty normal', 'gamerule advance_weather false', 'weather clear', 'time set 1000']) {
      assert.ok(script.includes(`rcon_assert "${cmd}"`), `not asserted: ${cmd}`)
    }
    assert.ok(script.includes('gamerule advance_time true'), 'clock not started')
    assert.ok(!script.includes('difficulty peaceful'), 'peaceful would hide the night')
    assert.ok(!/gamerule (fall_damage|keep_inventory)/.test(script), 'deaths/drops are the measurement')
    assert.ok(script.includes('TICKRATE="${WORK_TICKRATE:-60}"'), 'default tickrate drifted')
    assert.ok(script.includes('exit 130'), 'interrupt exit missing')
    assert.ok(script.includes('PRISTINE world.tar CHANGED'), 'pristine sha guard missing')
  })
})

describe('work-replay.js verdict', () => {
  const { verdict, siteCommands } = require('../tools/work-replay')

  it('counts the synthetic 40-min log into one line', () => {
    const lines = [
      'WORK-RIG time: nightfall server=13001 bot=13001 +400s',
      'say: home for the night',
      'say: sleeping in my bed',
      'WORK-RIG time: nightfall server=13002 bot=13000 +800s',
      'shelter dig-in done',
      'shelter dig-in failed:protected',
      'death health=0 hostiles=2 at 1 64 2 nearest=zombie 1.2',
      'death health=0 hostiles=1 at 1 64 2',
      'death health=0 hostiles=0 at 1 64 2',
      'forage done: banked 10 oak_log, 2 cobblestone',
      'forage done: banked 4 dirt (3 timeouts)',
      'forage failed:no-known (banked 9 dirt)',
      'say: stockpiled 10 oak_log',
      'say: brought 4 bread',
      'goal step=forage prev=none source=goal-fsm fsm=forage why=start menu=x facts=y',
      'goal step=rest prev=forage source=goal-fsm fsm=rest why=step-failed menu=x facts=y',
      'goal step=forage prev=rest source=goal-fsm fsm=forage why=step-done menu=x facts=y',
      'goal step=gohome prev=forage source=goal-fsm fsm=gohome why=step-failed fail=no-path menu=x facts=y',
    ]
    const v = verdict(lines, 40)
    assert.equal(v.line, 'work nights=2 slept=1 inside=1 dugin=1 deaths=3 banked=24/h brought=2 steps=forage:2,gohome:1,rest:1 fail=forage:1,forage:no-path:1')
  })

  it('reads an empty window as zeros, never NaN', () => {
    assert.equal(verdict([], 20).line, 'work nights=0 slept=0 inside=0 dugin=0 deaths=0 banked=0/h brought=0 steps=none fail=none')
  })

  it('raises the house, both beds and the kit chest at the canonical cells', () => {
    const { site, cmds, beds, chest } = siteCommands(0, 64, 0, 'chest')
    assert.deepEqual(site, { x: -3, y: 64, z: 3 })
    assert.ok(cmds.includes('setblock -2 64 7 white_bed[facing=east,part=foot]'))
    assert.ok(cmds.includes('setblock -1 64 7 white_bed[facing=east,part=head]'))
    assert.ok(cmds.includes('setblock 1 64 7 white_bed[facing=east,part=foot]'))
    assert.equal(beds.length, 4)
    assert.deepEqual(chest, { x: 2, y: 64, z: 5 })
    assert.equal(siteCommands(0, 64, 0, 'empty').chest, null)
    // The pad stays under the 32768-block fill cap.
    for (const c of cmds.filter((x) => x.startsWith('fill '))) {
      const n = c.split(' ').slice(1, 7).map(Number)
      assert.ok((Math.abs(n[3] - n[0]) + 1) * (Math.abs(n[4] - n[1]) + 1) * (Math.abs(n[5] - n[2]) + 1) <= 32768, c)
    }
  })
})
