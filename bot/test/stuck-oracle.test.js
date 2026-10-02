'use strict'

// idkcraft-6x7.4: the stuck oracle gate — baseline comparison, baseline
// coverage, and rig-script pins. No physics here (no server): the pure
// compare, the file contracts, and the exit-code arms.

process.env.REPLAY_QUIET = '0' // keep the script's ticker-chatter filter off
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { compareBaseline, pickBrain, gateCode, makeExitGuard, matchOrderLine, loadSpots, windowReached, enclosed, shelterReached, SHELTER_CLOSE_SECS } = require('../tools/stuck-replay')

const TOOLS = path.join(__dirname, '..', 'tools')

function row(spot, reached, stuck, eps, call = 0) {
  return { spot, reached, stuck, eps, by: [], call, secs: 10, maxDisp: 1, minDist: 1, minGuide: 1, note: '' }
}

describe('compareBaseline verdicts (idkcraft-6x7.4)', () => {
  const base = { brain: 'stub', spots: { A: { reached: true, maxStuck: 2, maxEps: 1, maxCalls: 0 } } }

  it('exact match is ok', () => {
    const [d] = compareBaseline([row('A', true, 2, 1)], base)
    assert.equal(d.verdict, 'ok')
  })

  it('reached flipping true->false is regressed', () => {
    const [d] = compareBaseline([row('A', false, 0, 0)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /unreached/)
  })

  it('stuck over the ceiling is regressed', () => {
    const [d] = compareBaseline([row('A', true, 3, 0)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /stuck 3 > 2/)
  })

  it('episodes over the ceiling are regressed', () => {
    const [d] = compareBaseline([row('A', true, 0, 2)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /episodes 2 > 1/)
  })

  it('calls over the ceiling are regressed (the recover-budget tripwire)', () => {
    const [d] = compareBaseline([row('A', true, 0, 0, 1)], base)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /calls 1 > 0/)
  })

  it('under-ceiling runs are ok, not improved (green runs stay quiet)', () => {
    const [d] = compareBaseline([row('A', true, 0, 0)], base)
    assert.equal(d.verdict, 'ok')
  })

  it('reached flipping false->true is improved', () => {
    const b = { brain: 'stub', spots: { A: { reached: false, maxStuck: 5, maxEps: 2, maxCalls: 0 } } }
    const [d] = compareBaseline([row('A', true, 5, 2)], b)
    assert.equal(d.verdict, 'improved')
  })

  it('spot without a baseline entry fails the gate', () => {
    const [d] = compareBaseline([row('NEW', true, 0, 0)], base)
    assert.equal(d.verdict, 'no-baseline')
    assert.equal(d.was, 'none')
  })

  it('malformed entry counts as missing', () => {
    const b = { brain: 'stub', spots: { A: { reached: true } } }
    const [d] = compareBaseline([row('A', true, 0, 0)], b)
    assert.equal(d.verdict, 'no-baseline')
  })

  it('entry without maxCalls counts as missing (strict shape)', () => {
    const b = { brain: 'stub', spots: { A: { reached: true, maxStuck: 2, maxEps: 1 } } }
    const [d] = compareBaseline([row('A', true, 0, 0)], b)
    assert.equal(d.verdict, 'no-baseline')
  })

  it('was/now diff prints on every non-ok verdict', () => {
    const [d] = compareBaseline([row('A', false, 9, 3)], base)
    assert.match(d.was, /reached=true stuck<=2 eps<=1 calls<=0/)
    assert.match(d.now, /reached=false stuck=9 eps=3 calls=0/)
  })
})

describe('gateCode verdict reduction (idkcraft-6x7.4 round 2)', () => {
  const diff = (spot, verdict, why = 'x') => ({ spot, verdict, was: 'w', now: 'n', why })
  const rowWith = (note) => ({ spot: 'A', reached: false, stuck: 0, eps: 0, note })

  it('all ok exits 0', () => {
    const v = gateCode([rowWith('')], [diff('A', 'ok')])
    assert.deepEqual(v, { code: 0, ok: 1, better: 0, bad: 0, env: 0 })
  })

  it('regressed exits 1', () => {
    const v = gateCode([rowWith('')], [diff('A', 'regressed')])
    assert.equal(v.code, 1)
    assert.equal(v.bad, 1)
  })

  it('no-baseline exits 1 (the corpus rule fails the gate)', () => {
    const v = gateCode([rowWith('')], [diff('A', 'no-baseline')])
    assert.equal(v.code, 1)
    assert.equal(v.bad, 1)
  })

  it('improved exits 0', () => {
    const v = gateCode([rowWith('')], [diff('A', 'improved')])
    assert.deepEqual(v, { code: 0, ok: 0, better: 1, bad: 0, env: 0 })
  })

  it('GUIDE-BURIED skips the comparison and exits 2', () => {
    const v = gateCode([rowWith('GUIDE-BURIED')], [diff('A', 'regressed')])
    assert.deepEqual(v, { code: 2, ok: 0, better: 0, bad: 0, env: 1 })
  })

  it('GUIDE-DIED exits 2 like buried', () => {
    const v = gateCode([rowWith('GUIDE-DIED')], [diff('A', 'regressed')])
    assert.equal(v.code, 2)
    assert.equal(v.env, 1)
  })

  it('env dominates a co-occurring regression', () => {
    const v = gateCode([rowWith('GUIDE-BURIED'), rowWith('')], [diff('A', 'regressed'), diff('B', 'regressed')])
    assert.equal(v.code, 2)
    assert.equal(v.bad, 1)
    assert.equal(v.env, 1)
  })

  it('DIED stays judged (dying is behavior)', () => {
    const v = gateCode([rowWith('DIED')], [diff('A', 'regressed')])
    assert.equal(v.code, 1)
    assert.equal(v.env, 0)
  })
})

describe('pickBrain (idkcraft-6x7.4)', () => {
  it('defaults to stub', () => {
    delete process.env.REPLAY_BRAIN
    const p = pickBrain()
    assert.equal(p.label, 'stub')
    assert.equal(p.make().name, 'stub')
  })

  it('laya builds the shipped hybrid, never a copy', () => {
    process.env.REPLAY_BRAIN = 'laya'
    try {
      const p = pickBrain()
      assert.match(p.label, /^laya\(http/)
      const brain = p.make()
      assert.equal(brain.name, 'hybrid')
      assert.equal(typeof brain.decide, 'function')
    } finally {
      delete process.env.REPLAY_BRAIN
    }
  })

  it('unknown brain fails loud', () => {
    process.env.REPLAY_BRAIN = 'jev'
    try {
      assert.throws(() => pickBrain(), /REPLAY_BRAIN: want stub\|laya/)
    } finally {
      delete process.env.REPLAY_BRAIN
    }
  })
})

describe('stuck-baseline.json covers the corpus (idkcraft-6x7.4)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))

  it('baseline names the stub brain', () => {
    assert.equal(baseline.brain, 'stub')
  })

  it('every corpus spot has a well-formed entry', () => {
    const names = new Set(spots.map((s) => s.name))
    assert.ok(names.size === spots.length, 'duplicate spot names')
    for (const s of spots) {
      const e = baseline.spots[s.name]
      assert.ok(e, `spot ${s.name} has no baseline entry`)
      assert.equal(typeof e.reached, 'boolean', `${s.name}: reached must be boolean`)
      assert.ok(Number.isInteger(e.maxStuck) && e.maxStuck >= 0, `${s.name}: bad maxStuck`)
      assert.ok(Number.isInteger(e.maxEps) && e.maxEps >= 0, `${s.name}: bad maxEps`)
      assert.ok(Number.isInteger(e.maxCalls) && e.maxCalls >= 0, `${s.name}: bad maxCalls`)
    }
  })

  it('S6-PIT is the recover-budget tripwire: cites the bead, maxCalls 0 strict', () => {
    const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
    assert.ok(byName['S6-PIT'], 'missing recover-budget spot S6-PIT')
    assert.ok((byName['S6-PIT'].bead || '').includes('idkcraft-6x7.4'), 'S6-PIT must cite idkcraft-6x7.4')
    assert.equal(baseline.spots['S6-PIT'].maxCalls, 0, 'S6-PIT maxCalls must stay 0: slack would un-flip MAX_FAILS=0')
  })

  it('no baseline entry dangles off-corpus', () => {
    const names = new Set(spots.map((s) => s.name))
    for (const k of Object.keys(baseline.spots)) {
      assert.ok(names.has(k), `baseline entry ${k} has no corpus spot`)
    }
  })

  it('work-bug terrain spots carry their bead', () => {
    const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
    for (const [spot, bead] of [['ATL-SHAFT', 'idkcraft-atl.17'], ['JR-SLOPE', 'idkcraft-jr2.4'], ['Q0H-PIT', 'idkcraft-q0h']]) {
      assert.ok(byName[spot], `missing work-terrain spot ${spot}`)
      assert.ok((byName[spot].bead || '').includes(bead), `${spot} must cite ${bead}`)
    }
  })
})

describe('order spots (idkcraft-6x7.7)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
  // The corpus markers themselves judge these lines: the test pins the
  // committed contract against the real bring.js chat shapes, not a copy.
  const atl = byName['ATL-SHAFT']
  const EXP = atl.expect
  const FAIL = atl.fail

  it('ATL-SHAFT is the order-driven bring spot', () => {
    assert.equal(atl.mode, 'order')
    assert.match(atl.order, /^bring me iron_ore/)
    assert.ok(EXP.includes('here is ') && EXP.includes('here are '))
    assert.ok(FAIL.includes('could not '))
  })

  it('every order spot carries a well-formed order contract', () => {
    const orders = spots.filter((x) => x.mode === 'order')
    assert.ok(orders.length >= 1, 'want at least one order spot')
    for (const o of orders) {
      assert.equal(typeof o.order, 'string', `${o.name}: order must be chat text`)
      assert.ok(o.order.length > 0 && o.order.length <= 256, `${o.name}: bad order length`)
      for (const k of ['expect', 'fail']) {
        assert.ok(Array.isArray(o[k]) && o[k].length > 0 && o[k].length <= 16, `${o.name}: bad ${k}`)
        for (const m of o[k]) assert.ok(typeof m === 'string' && m.length > 0 && m.length <= 80 && m !== '=', `${o.name}: bad ${k} marker`)
      }
    }
  })

  it('loadSpots accepts the committed corpus', () => {
    const saved = process.argv[2]
    process.argv[2] = path.join(TOOLS, 'stuck-spots.json')
    try {
      const list = loadSpots()
      const a = list.find((x) => x.name === 'ATL-SHAFT')
      assert.equal(a.mode, 'order')
      assert.equal(a.order, atl.order)
      assert.deepEqual(a.expect, EXP)
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
    }
  })

  it('loadSpots rejects malformed order contracts', () => {
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-spots-'))
    const saved = process.argv[2]
    const bad = (spot, why) => {
      const f = path.join(dir, `${why}.json`)
      fs.writeFileSync(f, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], ...spot }]))
      process.argv[2] = f
      assert.throws(() => loadSpots(), new RegExp(why), `${why} must throw`)
    }
    try {
      bad({ mode: 'bogus' }, 'bad mode')
      bad({ mode: 'order' }, 'need a chat order')
      bad({ mode: 'order', order: 'bring me x', expect: [], fail: ['could not '] }, 'non-empty expect markers')
      bad({ mode: 'order', order: 'bring me x', expect: ['here is '], fail: [''] }, 'bad fail marker')
      bad({ order: 'bring me x' }, 'need mode=order')
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delivery lines are expect', () => {
    assert.equal(matchOrderLine('here are 2 iron_ore', EXP, FAIL), 'expect')
    assert.equal(matchOrderLine('here is 1 iron_ore', EXP, FAIL), 'expect')
  })

  it('terminal refusals are fail', () => {
    for (const line of [
      'could not reach iron_ore safely',
      'could not reach iron_ore (buried, no path in) at 59 56 -205',
      'could not break iron_ore',
      'could not bring iron_ore',
      'could not toss iron_ore',
      'could not pick up iron_ore',
      'only got 1 iron_ore \u2014 could not reach iron_ore safely',
      'need a stone pickaxe for iron_ore',
      'need an iron pickaxe for diamond_ore (my stone_pickaxe can\'t break it)',
      'searched 0 areas, no iron_ore',
      'searched 3 areas, no iron_ore \u2014 nearest known vein too deep at 59 52 -205',
      'only got 1 iron_ore',
      'no iron_ore within 48 blocks (loaded area)',
      'iron_ore at 59 52 -205 is 12 down \u2014 too deep to dig',
      'unknown block: iron_ore',
      'unknown item: iron_ore',
      'can\'t bring dirt \u2014 ores and logs only',
    ]) {
      assert.equal(matchOrderLine(line, EXP, FAIL), 'fail', line)
    }
  })

  it('non-terminal order chatter matches nothing', () => {
    for (const line of [
      'going for 2 iron_ore, 8 blocks away (digging)',
      'going for 2 iron_ore, 40 blocks away (exposed)',
      'nothing within 48, widening the search for iron_ore\u2026',
      'nothing within 48, searching for iron_ore\u2026',
      'only buried iron_ore within 48, checking further for open ore\u2026',
      'comparing open and buried iron_ore\u2026',
      'nearest iron_ore too deep to dig, looking for a diggable vein\u2026',
      'nearest iron_ore is underwater, checking for a dry one\u2026',
      'no iron_ore nearby, searching\u2026',
      'checking the home chest for iron_ore',
      'coming with 2 iron_ore',
      'I can\'t see you \u2014 I\'m at 59 54 -205 with your 2 iron_ore; come closer',
      'Following StuckGuider123',
    ]) {
      assert.equal(matchOrderLine(line, EXP, FAIL), null, line)
    }
  })
})

describe('order markers (idkcraft-6x7.8)', () => {
  it('exact markers match the full line only', () => {
    const EXP = ['=home']
    const FAIL = ['cannot reach home', 'cannot reach the common room', 'no home yet', 'home not built yet']
    assert.equal(matchOrderLine('home', EXP, FAIL), 'expect')
    for (const line of [
      'cannot reach home',
      'cannot reach home: no door',
      'cannot reach home: no home',
      'cannot reach the common room',
      'no home yet — say build here',
      'home not built yet — say go work',
    ]) {
      assert.equal(matchOrderLine(line, EXP, FAIL), 'fail', line)
    }
  })

  it('exact markers do not fire on longer lines containing them', () => {
    const EXP = ['=home']
    const FAIL = ['cannot reach home']
    for (const line of [
      'coming home',
      'my home is at -14 65 -217',
      'home for the night',
      'homeward bound',
      'on my own: heading home',
    ]) {
      assert.equal(matchOrderLine(line, EXP, FAIL), null, line)
    }
  })

  it('a bare = marker is rejected (it would match only the empty line)', () => {
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-exact-'))
    const saved = process.argv[2]
    try {
      const f = path.join(dir, 'bare.json')
      fs.writeFileSync(f, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], mode: 'order', order: 'come home', expect: ['='], fail: ['cannot reach home'] }]))
      process.argv[2] = f
      assert.throws(() => loadSpots(), /bad expect marker/)
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})

describe('order corpus (idkcraft-6x7.8)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
  const jr = byName['JR-SLOPE']
  const q0h = byName['Q0H-PIT']

  it('JR-SLOPE is the order-driven slope bring spot', () => {
    // The slope bring predates the build-here spot (JR-BUILD, below): a
    // 'build here' order stalled and paged every run until idkcraft-d7i.
    // The bring stays: same terrain, a short deterministic verdict.
    assert.equal(jr.mode, 'order')
    assert.match(jr.order, /^bring me acacia_log/)
    assert.ok(jr.expect.includes('here is ') && jr.expect.includes('here are '))
    assert.ok(jr.fail.includes('could not '))
    assert.ok(jr.fail.includes('no acacia_log within'))
  })

  it('JR acacia lines judge against the committed markers', () => {
    assert.equal(matchOrderLine('here is 1 acacia_log', jr.expect, jr.fail), 'expect')
    assert.equal(matchOrderLine('here are 2 acacia_log', jr.expect, jr.fail), 'expect')
    for (const line of [
      'could not reach acacia_log safely',
      'could not reach acacia_log (no path in) at -167 71 -71',
      'only got 1 acacia_log',
      'no acacia_log within 48 blocks (loaded area)',
      'searched 2 areas, no acacia_log',
    ]) {
      assert.equal(matchOrderLine(line, jr.expect, jr.fail), 'fail', line)
    }
    for (const line of [
      'going for 1 acacia_log, 5 blocks away (exposed)',
      'coming with 1 acacia_log',
      "I can't see you — I'm at -149 72 -77 with your 1 acacia_log; come closer",
      'building 45/99',
    ]) {
      assert.equal(matchOrderLine(line, jr.expect, jr.fail), null, line)
    }
  })

  it('Q0H-PIT is the order-driven come-home spot (rig-built house)', () => {
    assert.equal(q0h.mode, 'order')
    assert.equal(q0h.order, 'come home')
    assert.deepEqual(q0h.expect, ['=home'])
    assert.deepEqual(q0h.fail, ['cannot reach home', 'cannot reach the common room', 'no home yet', 'home not built yet'])
    assert.deepEqual(q0h.house, [-25, 65, -210])
  })

  it('come-home lines judge against the committed markers', () => {
    assert.equal(matchOrderLine('home', q0h.expect, q0h.fail), 'expect')
    for (const line of [
      'cannot reach home',
      'cannot reach home: no door',
      'cannot reach the common room',
      'no home yet — say build here',
      'home not built yet — say go work',
    ]) {
      assert.equal(matchOrderLine(line, q0h.expect, q0h.fail), 'fail', line)
    }
    for (const line of [
      'coming home',
      'my home is at -25 65 -210',
      'building a home at -25 65 -210',
      'on my own: heading home',
    ]) {
      assert.equal(matchOrderLine(line, q0h.expect, q0h.fail), null, line)
    }
  })

  it('loadSpots accepts the converted corpus entries', () => {
    const saved = process.argv[2]
    process.argv[2] = path.join(TOOLS, 'stuck-spots.json')
    try {
      const list = loadSpots()
      const j = list.find((x) => x.name === 'JR-SLOPE')
      assert.equal(j.mode, 'order')
      assert.match(j.order, /^bring me acacia_log/)
      assert.deepEqual(j.fail, jr.fail)
      const q = list.find((x) => x.name === 'Q0H-PIT')
      assert.equal(q.mode, 'order')
      assert.equal(q.order, 'come home')
      assert.deepEqual(q.house, { x: -25, y: 65, z: -210 })
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
    }
  })

  it('follow-revoking orders stay after all follow spots', () => {
    // 'build here'/'come home'/'go work' clear the live followName (index.js
    // startWork, orders.js setComehome) with no per-spot re-arm — a follow
    // spot after one would walk with no target. The corpus keeps that order.
    let seenRevoke = false
    for (const s of spots) {
      // Shelter spots chat 'go work' (idkcraft-ed88): revoking too.
      const revokes = s.mode === 'shelter' || (s.mode === 'order' && ['build here', 'come home', 'go work', 'free'].includes(s.order))
      if (revokes) seenRevoke = true
      else if (s.mode !== 'order') assert.ok(!seenRevoke, `follow spot ${s.name} after a follow-revoking order`)
    }
  })

  it('JR-BUILD is the slope build-here spot (idkcraft-d7i)', () => {
    // From scratch on the jr2.4 slope: gather, craft, station, build until
    // 'home done at'. Pre-d7i the standing door sealed the interior (the
    // pathfinder never opens doors) and the partition was never reached.
    const b = byName['JR-BUILD']
    assert.ok(b, 'JR-BUILD in the corpus')
    assert.equal(b.mode, 'order')
    assert.equal(b.order, 'build here')
    assert.equal(b.bead, 'idkcraft-d7i')
    assert.equal(matchOrderLine('home done at -144 72 -77', b.expect, b.fail), 'expect')
    assert.equal(matchOrderLine("I can't see you, come closer", b.expect, b.fail), 'fail')
    for (const line of [
      'building a home at -144 72 -77',
      'building 92/99',
      'crafted 4 acacia_planks (planks 4, logs 0)',
      "I'm stuck at -138 72 -75, /tp StuckReplayr1 StuckGuider1",
    ]) {
      assert.equal(matchOrderLine(line, b.expect, b.fail), null, line)
    }
  })

  it('GATHER-CLIFF judges the gather step of a build-here (idkcraft-m7ke)', () => {
    // No scaffold under acacias whose upper logs are 7+ up: gather chops what
    // it reaches, drops the rest on the first planner timeout, and refuses
    // honestly — the ceilings (eps, calls 0) catch the old recover detour.
    const g = byName['GATHER-CLIFF']
    assert.ok(g, 'GATHER-CLIFF in the corpus')
    assert.equal(g.order, 'build here')
    assert.equal(g.scaffold, 0)
    assert.equal(matchOrderLine(`got ${require('../src/goal').NEED_LOGS} logs`, g.expect, g.fail), 'expect')
    assert.equal(matchOrderLine('cannot reach the trees', g.expect, g.fail), 'fail')
    assert.equal(matchOrderLine('no trees within 48 blocks', g.expect, g.fail), 'fail')
    for (const line of ['building a home at -19 64 -248', 'chopping acacia_log 4/14', 'going for acacia_log, 20 blocks away']) {
      assert.equal(matchOrderLine(line, g.expect, g.fail), null, line)
    }
  })
})

describe('raise-house (idkcraft-6x7.8)', () => {
  const { houseCommands } = require('../tools/raise-house')
  const buildMod = require('../src/behaviours/build')

  // Expand fill runs back to cells: the generator must cover the plan.
  function covered(cmds) {
    const cells = new Map() // `x,y,z` -> block
    for (const c of cmds) {
      let m = c.match(/^setblock (-?\d+) (-?\d+) (-?\d+) (\S+)$/)
      if (m) { cells.set(`${m[1]},${m[2]},${m[3]}`, m[4]); continue }
      m = c.match(/^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/)
      assert.ok(m, `unparseable command: ${c}`)
      const [, x1, y1, z1, x2, y2, z2, block] = m
      for (let x = Math.min(+x1, +x2); x <= Math.max(+x1, +x2); x++) {
        for (let y = Math.min(+y1, +y2); y <= Math.max(+y1, +y2); y++) {
          for (let z = Math.min(+z1, +z2); z <= Math.max(+z1, +z2); z++) {
            cells.set(`${x},${y},${z}`, block)
          }
        }
      }
    }
    return cells
  }

  it('covers every plan cell exactly once (fill cells read the slab)', () => {
    const site = { x: -23, y: 64, z: -215 }
    const cells = covered(houseCommands(site))
    const plan = buildMod.blueprintFor({ v: 2 })
    for (const c of plan) {
      const k = `${site.x + c.dx},${site.y + c.dy},${site.z + c.dz}`
      if (c.kind === 'fill') {
        // Fill cells sit at dy=-1: the slab itself reads solid (their done).
        assert.equal(cells.get(k), 'dirt', k)
        continue
      }
      const want = c.kind === 'table' ? 'crafting_table' : c.kind === 'door' ? 'oak_door[facing=north,half=lower,hinge=left]' : 'oak_planks'
      assert.equal(cells.get(k), want, k)
    }
    // The door upper half rides above the plan cell.
    const door = plan.find((c) => c.kind === 'door')
    assert.equal(cells.get(`${site.x + door.dx},${site.y + door.dy + 1},${site.z + door.dz}`), 'oak_door[facing=north,half=upper,hinge=left]')
  })

  it('levels the pad and grooms the doorstep', () => {
    const cells = covered(houseCommands({ x: 0, y: 64, z: 0 }))
    for (let ix = 0; ix < 7; ix++) {
      for (let iz = 0; iz < 6; iz++) {
        assert.equal(cells.get(`${ix},63,${iz}`), 'dirt', `slab ${ix},${iz}`)
        assert.equal(cells.get(`${ix},64,${iz}`) === 'air' || cells.get(`${ix},64,${iz}`).startsWith('oak_') || cells.get(`${ix},64,${iz}`) === 'crafting_table', true, `room ${ix},${iz}`)
      }
    }
    // Doorstep air + slab in front of the north-wall door (dx=3, z=-1..-2).
    assert.equal(cells.get('3,63,-1'), 'dirt')
    assert.equal(cells.get('3,64,-1'), 'air')
    assert.equal(cells.get('3,66,-2'), 'air')
  })

  it('rejects a non-integer site', () => {
    assert.throws(() => houseCommands({ x: 0.5, y: 64, z: 0 }), /integer/)
    assert.throws(() => houseCommands(null), /integer/)
  })

  it('loadSpots passes house through and rejects malformed sites', () => {
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-house-'))
    const saved = process.argv[2]
    try {
      const good = path.join(dir, 'good.json')
      fs.writeFileSync(good, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], house: [-23, 64, -215] }]))
      process.argv[2] = good
      assert.deepEqual(loadSpots()[0].house, { x: -23, y: 64, z: -215 })
      const nohouse = path.join(dir, 'nohouse.json')
      fs.writeFileSync(nohouse, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0] }]))
      process.argv[2] = nohouse
      assert.equal(loadSpots()[0].house, null)
      for (const house of [[0, 64], [0.5, 64, 0], 'x', [0, 64, 0, 1]]) {
        const f = path.join(dir, `${Date.now()}-${Math.random()}.json`)
        fs.writeFileSync(f, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], house }]))
        process.argv[2] = f
        assert.throws(() => loadSpots(), /bad house/, `${JSON.stringify(house)} must throw`)
      }
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('windowReached (idkcraft-6x7.7 revmux 01 core-2)', () => {
  it('order spots ignore position: only the chat verdict judges', () => {
    // Fail-open pin: the bot starts within guide range (gd<=6 at t=0 on
    // ATL-SHAFT) — judging by position would end the window before any
    // marker and pass the spot no matter what the order did.
    assert.equal(windowReached('order', true, 0, 0, null), null)
    assert.equal(windowReached('order', true, 2.4, 3.2, null), null)
    assert.equal(windowReached('order', true, 0, 0, 'expect'), true)
    assert.equal(windowReached('order', true, 0, 0, 'fail'), false)
    assert.equal(windowReached('order', false, 999, 999, 'expect'), true)
    assert.equal(windowReached('order', false, 999, 999, 'fail'), false)
    assert.equal(windowReached('order', false, 999, 999, null), null)
  })

  it('follow spots end on position (goal shell or guide arrival)', () => {
    assert.equal(windowReached('follow', true, 1.0, 99, null), true)
    assert.equal(windowReached('follow', false, 1.0, 99, null), null) // spawn inside the goal shell: guide arrival only
    assert.equal(windowReached('follow', false, 99, 5, null), true)
    assert.equal(windowReached('follow', true, 99, 99, null), null)
    assert.equal(windowReached('follow', true, 2.5, 6.1, null), null) // boundary: reach is strict
  })

  it('a failed sample keeps the window open (no verdict on nulls)', () => {
    assert.equal(windowReached('follow', true, null, null, null), null)
    assert.equal(windowReached('follow', true, 1.0, null, null), true) // partial sample still judges
    assert.equal(windowReached('follow', true, null, 5, null), true)
  })
})

describe('shelter spots (idkcraft-ed88)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))
  const sb = spots.find((s) => s.name === 'SPAWN-BARE')

  it('SPAWN-BARE is the world-spawn empty-kit night shelter spot', () => {
    assert.equal(sb.mode, 'shelter')
    assert.equal(sb.bead, 'idkcraft-ed88')
    assert.deepEqual(sb.spawn, [-57.5, 61, -213.5], 'prod respawn body (bead log 04:13:54), on bare stone')
    assert.equal(sb.scaffold, 0, 'empty kit: the pillar cannot run')
    assert.equal(sb.pickaxe, false)
    assert.ok(Math.hypot(sb.home[0] - sb.spawn[0], sb.home[2] - sb.spawn[2]) > 96, 'home past the night walk range')
    assert.ok(Math.hypot(sb.goal[0] - sb.spawn[0], sb.goal[2] - sb.spawn[2]) > 128, 'guide out of entity range: the bot works alone')
    assert.ok(sb.secs >= 90, 'alive at 90 s is part of the verdict')
    assert.deepEqual(baseline.spots['SPAWN-BARE'], { reached: true, maxStuck: 2, maxEps: 1, maxCalls: 0 })
  })

  it('loadSpots validates the shelter contract', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ed88-'))
    const saved = process.argv[2]
    const load = (list) => {
      const f = path.join(dir, 'spots.json')
      fs.writeFileSync(f, JSON.stringify(list))
      process.argv[2] = f
      return loadSpots()
    }
    const base = { name: 'X', mode: 'shelter', spawn: [0, 64, 0], goal: [0, 90, 150], home: [300, 64, 0] }
    try {
      assert.deepEqual(load([base])[0].home, { x: 300, y: 64, z: 0 })
      assert.throws(() => load([{ ...base, home: null }]), /integer home/)
      assert.throws(() => load([{ ...base, home: [1.5, 64, 0] }]), /integer home/)
      assert.throws(() => load([{ ...base, mode: undefined }]), /home needs mode=shelter/)
      assert.throws(() => load([{ ...base, order: 'go work' }]), /need mode=order/)
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enclosed needs floor, cap and all four sides at feet and head', () => {
    const pit = (missing) => (dx, dy, dz) => !(dx === 0 && dz === 0 && (dy === 0 || dy === 1)) && `${dx},${dy},${dz}` !== missing
    assert.equal(enclosed(pit(null)), true)
    for (const m of ['0,-1,0', '0,2,0', '1,0,0', '-1,1,0', '0,0,1', '0,1,-1']) {
      assert.equal(enclosed(pit(m)), false, `open at ${m}`)
    }
  })

  it('shelterReached: closed within the limit and alive at the end', () => {
    assert.equal(SHELTER_CLOSE_SECS, 15)
    assert.equal(shelterReached(9, false), true)
    assert.equal(shelterReached(15, false), true)
    assert.equal(shelterReached(15.5, false), false, 'too slow')
    assert.equal(shelterReached(null, false), false, 'never closed (the ground hold)')
    assert.equal(shelterReached(9, true), false, 'died in the pit')
    assert.equal(windowReached('shelter', true, 0, 0, null), null, 'position never ends a shelter window')
  })
})

describe('stuck-replay.js gate wiring (idkcraft-6x7.4)', () => {
  const replay = fs.readFileSync(path.join(TOOLS, 'stuck-replay.js'), 'utf8')

  it('REPLAY_OUT defaults to tools/last-replay.json', () => {
    assert.ok(replay.includes("process.env.REPLAY_OUT || path.join(__dirname, 'last-replay.json')"),
      'REPLAY_OUT default missing')
  })

  it('no unconditional exit 0 survives (the always-green bug)', () => {
    assert.ok(!replay.includes('process.exit(0)'), 'unconditional exit 0 is back')
    assert.ok(replay.includes('process.exit(code)'), 'gate code must reach the exit')
    assert.ok(replay.includes('process.exit(2)'), 'harness errors must exit 2')
  })

  it('laya runs never judge against the stub baseline', () => {
    assert.ok(replay.includes("brainName !== 'stub'"), 'brain guard missing')
    assert.ok(replay.includes('stub baseline does not apply'), 'skip message missing')
  })

  it('overlong bot names fail fast with the real cause', () => {
    assert.ok(replay.includes('bot names exceed 16 chars'), 'name-length guard missing')
  })

  it('exit guard installs before index loads and arms right before the verdict exit', () => {
    const lines = replay.split('\n')
    const lineNo = (s) => lines.findIndex((l) => l.includes(s))
    const install = lineNo('process.exit = exitGuard.exit')
    const load = lineNo("require('../src/index')")
    assert.ok(install !== -1 && load !== -1 && install < load,
      'guard must install before index loads (else a fatal exit 1 reads as regression)')
    const arm = lineNo('exitGuard.arm()')
    const verdict = lineNo('process.exit(code)')
    assert.ok(arm !== -1 && verdict !== -1 && verdict - arm <= 2 && arm < verdict,
      'gate must arm just before its verdict exit (else regressions exit 2)')
  })
})

describe('makeExitGuard (idkcraft-6x7.4 round 2)', () => {
  it('maps a pre-arm exit 1 to exit 2', () => {
    const calls = []
    const origErr = console.error
    console.error = () => {}
    try {
      makeExitGuard((c) => calls.push(c)).exit(1)
    } finally {
      console.error = origErr
    }
    assert.deepEqual(calls, [2])
  })

  it('passes exit 1 through after arm (the gate verdict)', () => {
    const calls = []
    const g = makeExitGuard((c) => calls.push(c))
    g.arm()
    g.exit(1)
    assert.deepEqual(calls, [1])
  })

  it('passes other codes through pre- and post-arm', () => {
    const calls = []
    const g = makeExitGuard((c) => calls.push(c))
    g.exit(0)
    g.exit(2)
    g.arm()
    g.exit(0)
    g.exit(2)
    assert.deepEqual(calls, [0, 2, 0, 2])
  })
})

describe('stuck-run.sh oracle wiring (idkcraft-6x7.4)', () => {
  const script = fs.readFileSync(path.join(TOOLS, 'stuck-run.sh'), 'utf8')

  it('exports a stable REPLAY_TAG and pre-ops both bots', () => {
    assert.ok(script.includes('_ptail=$(( $$ % 1000 ))'), 'TAG pid-tail missing')
    assert.ok(script.includes('export REPLAY_TAG="${REPLAY_TAG:-r$_ptail}"'), 'TAG default missing')
    assert.ok(script.includes('rcon_assert "op StuckGuide$REPLAY_TAG"'), 'guide pre-op missing')
    assert.ok(script.includes('rcon_assert "op StuckReplay$REPLAY_TAG"'), 'follower pre-op missing')
  })

  it('pristine sha mismatch fails the run with exit 2', () => {
    assert.ok(script.includes('PRISTINE world.tar CHANGED'), 'mismatch message missing')
    assert.ok(script.includes('exit 2 # env failure dominates'), 'mismatch must exit 2')
  })

  it('the replay verdict passes through, signals never pass', () => {
    assert.ok(script.includes('exit "$rc"'), 'verdict passthrough missing')
    assert.ok(script.includes('exit 130'), 'interrupted runs must not exit 0')
  })

  it('last-replay.json is gitignored', () => {
    const rootIgnore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8')
    assert.ok(rootIgnore.includes('bot/tools/last-replay.json'), 'results file must be gitignored')
  })
})

describe('prep arenas (idkcraft-jsf.7)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))
  const byName = Object.fromEntries(spots.map((s) => [s.name, s]))
  const withPrep = spots.filter((s) => s.prep != null)
  const ctl = { brain: 'stub', spots: { V: { reached: false, maxStuck: 2, maxEps: 2, maxCalls: 1, minCalls: 1 } } }

  it('committed prep is fill/setblock strings only', () => {
    assert.ok(withPrep.length >= 2, 'want the DUGPIT pair')
    for (const s of withPrep) {
      assert.ok(Array.isArray(s.prep) && s.prep.length > 0, `${s.name}: prep must be a non-empty array`)
      for (const c of s.prep) {
        assert.equal(typeof c, 'string', `${s.name}: prep entries are rcon strings`)
        assert.match(c, /^(fill|setblock) /, `${s.name}: prep allows fill/setblock only: ${c}`)
      }
    }
  })

  it('every prep spot has a baseline entry', () => {
    for (const s of withPrep) assert.ok(baseline.spots[s.name], `prep spot ${s.name} has no baseline entry`)
  })

  it('the water_up spot has its no-kit control on the identical arena', () => {
    const bare = byName['DUGPIT-BARE']
    const val = byName['DUGPIT-VALIDATE']
    assert.ok(bare && val, 'missing DUGPIT-BARE / DUGPIT-VALIDATE')
    assert.deepEqual(val.prep, bare.prep, 'control must rebuild the same arena')
    assert.deepEqual([val.spawn, val.goal], [bare.spawn, bare.goal])
    assert.equal(bare.bucket, true)
    assert.equal(val.bucket, false)
    for (const s of [bare, val]) {
      assert.equal(s.pickaxe, false, `${s.name}: a pickaxe opens a dig path`)
      assert.equal(s.scaffold, 0, `${s.name}: scaffold opens a pillar path`)
      assert.ok((s.bead || '').includes('idkcraft-jsf.7'), `${s.name} must cite idkcraft-jsf.7`)
    }
    assert.equal(baseline.spots['DUGPIT-BARE'].reached, true)
    const v = baseline.spots['DUGPIT-VALIDATE']
    assert.equal(v.reached, false, 'the control trap holds')
    assert.ok(Number.isInteger(v.minCalls) && v.minCalls >= 1, 'the control must page (minCalls >= 1)')
  })

  it('a control that pages is ok', () => {
    assert.equal(compareBaseline([row('V', false, 0, 2, 1)], ctl)[0].verdict, 'ok')
  })

  it('a silent control trap regresses (detector broke)', () => {
    const [d] = compareBaseline([row('V', false, 0, 0, 0)], ctl)
    assert.equal(d.verdict, 'regressed')
    assert.match(d.why, /calls 0 < 1/)
  })

  it('a leaking control trap regresses, not improves (its twin proves nothing)', () => {
    const [d] = compareBaseline([row('V', true, 0, 0, 0)], ctl)
    assert.equal(d.verdict, 'regressed')
    const [p] = compareBaseline([row('V', true, 0, 1, 1)], ctl) // paged, then walked out
    assert.equal(p.verdict, 'regressed')
    assert.match(p.why, /leaked/)
  })

  it('loadSpots passes prep through and rejects non-world commands', () => {
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-spots-'))
    const saved = process.argv[2]
    const load = (prep) => {
      const f = path.join(dir, 'p.json')
      fs.writeFileSync(f, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], prep }]))
      process.argv[2] = f
      return loadSpots()
    }
    try {
      assert.deepEqual(load(['fill 0 0 0 1 1 1 air', 'setblock 0 0 0 stone'])[0].prep, ['fill 0 0 0 1 1 1 air', 'setblock 0 0 0 stone'])
      assert.deepEqual(load(undefined)[0].prep, [])
      for (const bad of [['give @a water_bucket 1'], ['op X'], ['tp X 0 0 0'], [' fill 0 0 0 1 1 1 air'], [7], 'fill 0 0 0 1 1 1 air']) {
        assert.throws(() => load(bad), /bad prep|fill\/setblock only/, JSON.stringify(bad))
      }
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prep runs after both tps and before the kit', () => {
    const replay = fs.readFileSync(path.join(TOOLS, 'stuck-replay.js'), 'utf8')
    const at = (needle) => { const i = replay.indexOf(needle); assert.ok(i >= 0, needle); return i }
    const prep = at('for (const cmd of s.prep) await rcon(cmd)')
    assert.ok(at('await rcon(`tp ${FOLLOWER}') < prep, 'prep must follow the tps (chunks loaded)')
    assert.ok(prep < at('await rcon(`clear ${FOLLOWER}`)'), 'prep must precede the kit')
  })
})

describe('recover-budget order carrier (idkcraft-au4j)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))
  const names = spots.map((s) => s.name)
  const lead = spots.find((s) => s.name === 'S6-LEAD')

  it('S6-LEAD is a find-me lead to a prep-placed block, pinned reached with no page', () => {
    // A lead gave-up (recover release, by=lead) drops the order silently:
    // with MAX_FAILS=0 the failed dig_up pages and 'here:' never comes.
    assert.ok(lead, 'S6-LEAD in the corpus')
    assert.equal(lead.mode, 'order')
    assert.equal(lead.order, 'find me emerald_block')
    assert.equal(lead.bead, 'idkcraft-au4j')
    // The prep restores the pristine brow (S6/S6-PIT dig it earlier in the
    // run) and plants the target last, so the lead wedges in any corpus order.
    assert.ok(lead.prep.length >= 2)
    assert.match(lead.prep[0], /^fill -50 61 -232 -43 66 -224 /)
    assert.equal(lead.prep[lead.prep.length - 1], 'setblock -47 63 -231 emerald_block')
    const e = baseline.spots['S6-LEAD']
    assert.equal(e.reached, true, 'the reached pin is the sabotage flip')
    assert.equal(e.maxCalls, 0, 'a page is the sabotage signature, no slack')
  })

  it('S6-LEAD runs after S6-PIT (its lead dig would walk S6-PIT out of the wedge)', () => {
    assert.ok(names.indexOf('S6-PIT') >= 0 && names.indexOf('S6-LEAD') > names.indexOf('S6-PIT'))
  })

  it('the window cut drops a live lead (a timed-out lead would own the next spot)', () => {
    const replay = fs.readFileSync(path.join(TOOLS, 'stuck-replay.js'), 'utf8')
    assert.ok(replay.includes('c.lead = null'), 'cut must clear ctx.lead')
  })

  it('real lead lines judge against the committed markers', () => {
    const leadFn = require('../src/behaviours/lead')
    const said = []
    const pos = { x: -47, y: 63, z: -231 }
    const mkBot = (p) => ({
      entity: { position: p, onGround: true },
      chat: (m) => said.push(m),
      pathfinder: { isMoving: () => false, goal: null, setGoal() {}, stop() {} },
    })
    // arrival, then the wait-budget give-up — the shipped finish() lines
    leadFn(mkBot({ x: -46.5, y: 63, z: -229.5 }), { lead: { name: 'emerald_block', pos }, lastGoalKey: '' }, null, {})
    leadFn(mkBot({ x: -40, y: 63, z: -220 }), { lead: { name: 'emerald_block', pos, waiting: true, waitTicks: leadFn.WAIT_BUDGET_TICKS }, lastGoalKey: '' }, null, { distance_to_player: 99 })
    assert.equal(said.length, 2, said.join(' | '))
    assert.equal(matchOrderLine(said[0], lead.expect, lead.fail), 'expect', said[0])
    assert.equal(matchOrderLine(said[1], lead.expect, lead.fail), 'fail', said[1])
    for (const line of [
      'cannot reach emerald_block at -47 63 -231; following you again',
      'no emerald_block within 48 blocks (loaded area)',
      'unknown block: emerald_block',
      'emerald_block is 9 blocks down, dig carefully',
    ]) {
      assert.equal(matchOrderLine(line, lead.expect, lead.fail), 'fail', line)
    }
    for (const line of [
      'leading you to emerald_block, 5 blocks, follow me',
      'waiting for you, come to me (13 blocks)',
      'going on, 3 blocks left',
      'emerald_block: 3 blocks left',
      "I'm stuck at -47 61 -227, /tp StuckReplayr1 StuckGuider1",
    ]) {
      assert.equal(matchOrderLine(line, lead.expect, lead.fail), null, line)
    }
  })
})

describe('dry-moat exit spot (idkcraft-g0z.6)', () => {
  const spots = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-spots.json'), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.join(TOOLS, 'stuck-baseline.json'), 'utf8'))
  const moat = spots.find((s) => s.name === 'MOAT-EXIT')

  it('MOAT-EXIT: castle moat geometry in obsidian, no tool or scaffold — the corner step is the only way out', () => {
    // Rig control (not committed): the same arena without the step pages
    // (call_player from the trench), so reaching proves the step.
    assert.ok(moat, 'MOAT-EXIT in the corpus')
    assert.equal(moat.mode, 'order')
    assert.equal(moat.bead, 'idkcraft-g0z.6')
    assert.equal(moat.scaffold, 0)
    assert.equal(moat.pickaxe, false)
    assert.equal(moat.bucket, false)
    assert.ok(moat.prep.includes('setblock -15 28 -265 obsidian'), 'the 1-deep corner exit step')
    assert.equal(moat.prep[moat.prep.length - 1], 'setblock -18 30 -258 lapis_block')
    const e = baseline.spots['MOAT-EXIT']
    assert.equal(e.reached, true)
    assert.equal(e.maxCalls, 0)
  })
})
