'use strict'
// idkcraft-vf8e.9: tools/curriculum.js harvest + propose on a synthetic dump.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parse, rank, main } = require('../tools/curriculum')
const { loadSpots } = require('../tools/stuck-replay')

const DUMP = path.join(__dirname, 'fixtures', 'curriculum-dump.txt')
const text = fs.readFileSync(DUMP, 'utf8')
const ENV = {} // default feed: IdkBotV2 only
const list = rank(parse(text, ENV), 7)
const find = (reason) => list.find((c) => c.reason === reason)

// stuck-replay loadSpots reads process.argv[2].
function loads(file) {
  const saved = process.argv[2]
  process.argv[2] = file
  try { return loadSpots() } finally {
    if (saved === undefined) delete process.argv[2]
    else process.argv[2] = saved
  }
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-'))
  const saved = process.env.CURRICULUM_DIR
  const log = console.log
  const out = []
  process.env.CURRICULUM_DIR = dir
  console.log = (...a) => out.push(a.join(' '))
  try { return fn(dir, out) } finally {
    console.log = log
    if (saved === undefined) delete process.env.CURRICULUM_DIR
    else process.env.CURRICULUM_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('curriculum harvest (idkcraft-vf8e.9)', () => {
  it('ranks by count x weight: page outranks bring at equal count', () => {
    assert.deepEqual(list.map((c) => [c.family, c.reason, c.count, c.score]), [
      ['page', 'pillar_up:failed:place-error', 2, 6],
      ['bring', 'bone:no-recipe-no-source', 2, 4],
      ['page', 'sidestep:failed:no-progress', 1, 3], // the newer of the two count-1 pages first
      ['page', 'sidestep:failed:no-progress', 1, 3],
      ['bring', 'andesite:need-diorite', 1, 2],
    ])
    assert.equal(list[2].cell, '-11,8,-11')
    assert.equal(list[3].cell, '-6,8,-6') // the paged-then-done episode counts too
  })

  it('folds same-cell episodes and keeps the newest facts', () => {
    const c = find('pillar_up:failed:place-error')
    assert.equal(c.cell, '1,8,2')
    assert.deepEqual(c.pos, [12.5, 65, 22.5])
    assert.match(c.facts, /scaffold=10 /)
    assert.equal(c.chain, 'pillar_up>call_player')
    assert.equal(c.lastSeen, '2026-10-18 10:00:08')
  })

  it('days counts back from the newest line', () => {
    assert.equal(list.some((c) => c.reason === 'dig_up:failed:no-progress'), false)
    const wide = rank(parse(text, ENV), 30)
    assert.equal(wide.find((c) => c.reason === 'dig_up:failed:no-progress').lastSeen, '2026-10-10 08:00:12')
  })

  it('reads IdkBotV2 only by default; CURRICULUM_BOTS=all folds the swarm', () => {
    assert.ok(list.every((c) => c.bots.join() === 'IdkBotV2'))
    const all = rank(parse(text, { CURRICULUM_BOTS: 'all' }), 7)
    const dig = all.find((c) => c.reason === 'dig_up:failed:no-progress')
    assert.deepEqual([dig.count, dig.bots], [2, ['IdkBot', 'swarm']])
    assert.ok(all.some((c) => c.reason === 'dragon_egg:no-recipe-no-source'))
  })

  it('harvest writes curriculum.json and prints the table', () => {
    withDir((dir, out) => {
      assert.equal(main(['harvest', DUMP]), 0)
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'curriculum.json'), 'utf8'))
      assert.equal(saved.length, 5)
      assert.match(out[0], /^#\s+sig\s+family\s+count\s+score/)
      assert.match(out.at(-1), /^harvest events=8 signatures=5 page=3 bring=2 proposable=4 days=7/)
    })
  })
})

describe('curriculum propose (idkcraft-vf8e.9)', () => {
  const scenarioKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'skill-scenarios.json'), 'utf8'))[0]).sort()

  function propose(c) {
    return withDir((dir, out) => {
      main(['harvest', DUMP])
      const rc = main(['propose', c.sig])
      const work = path.join(dir, `AUTO-${c.sig}`)
      if (rc !== 0) return { rc, out }
      const spots = loads(path.join(work, 'spots.json'))
      const scenario = JSON.parse(fs.readFileSync(path.join(work, 'scenario.json'), 'utf8'))[0]
      return { rc, out, spot: spots[0], scenario }
    })
  }

  it('a page: goal along next, dy from the bucket, kit from the facts, no sabotage', () => {
    const { rc, out, spot, scenario } = propose(find('pillar_up:failed:place-error'))
    assert.equal(rc, 0)
    assert.deepEqual([spot.spawn, spot.goal], [[12.5, 65, 22.5], [20, 68, 23]]) // +x 7 blocks, goal=high +3
    assert.deepEqual([spot.secs, spot.scaffold, spot.pickaxe, spot.bucket, spot.sabotage, spot.mode], [90, 10, false, true, null, 'follow'])
    assert.deepEqual(Object.keys(scenario).sort(), scenarioKeys)
    assert.equal(scenario.spot, spot.name)
    assert.equal(scenario.kind, 'recover')
    assert.match(scenario.skill, /^gen_[0-9a-f]{8}$/)
    assert.match(scenario.task, /paged the owner 2x .*without paging/)
    assert.match(out.at(-1), /^gate: .*WITHOUT a skill.*RED/)
  })

  it('goal=low drops 3 and the heading follows next', () => {
    const c = list.filter((x) => x.reason === 'sidestep:failed:no-progress').find((x) => x.proposable)
    const { spot } = propose(c)
    assert.deepEqual(spot.goal, [-44, 67, -40])
    assert.deepEqual([spot.scaffold, spot.pickaxe], [64, true])
  })

  it('a level page with no next is not proposable', () => {
    const c = list.filter((x) => x.reason === 'sidestep:failed:no-progress').find((x) => !x.proposable)
    assert.equal(c.why, 'no-dir')
    assert.equal(propose(c).rc, 1)
  })

  it('a bring refusal: an order spot that replays the order with no recipe path', () => {
    const { rc, spot, scenario } = propose(find('bone:no-recipe-no-source'))
    assert.equal(rc, 0)
    assert.equal(spot.mode, 'order')
    assert.equal(spot.order, 'bring me bone')
    assert.ok(spot.fail.includes("can't get ") && spot.expect.includes('here is '))
    assert.deepEqual(Object.keys(scenario).sort(), scenarioKeys)
    assert.deepEqual([scenario.sabotage, scenario.kind], [null, 'step'])
    assert.match(scenario.task, /'bring me bone'.*refused 2x/)
  })
})
