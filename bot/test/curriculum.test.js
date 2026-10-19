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
      ['page', 'pillar_up:failed:no-scaffold', 1, 3], // equal score: newest first
      ['page', 'sidestep:failed:no-progress', 1, 3],
      ['page', 'sidestep:failed:no-progress', 1, 3],
      ['bring', 'andesite:need-diorite', 1, 2],
    ])
    assert.equal(list[3].cell, '-11,8,-11')
    assert.equal(list[4].cell, '-6,8,-6') // the paged-then-done episode counts too
  })

  it('a paged episode with no terminal line still counts; the next episode starts clean', () => {
    const c = find('pillar_up:failed:no-scaffold')
    assert.deepEqual([c.cell, c.chain, c.lastSeen], ['25,8,25', 'pillar_up>call_player', '2026-10-18 12:30:06'])
    // 13:00 (sidestep, done, never paged) is no page.
    assert.equal(list.some((x) => x.lastSeen.startsWith('2026-10-18 13:')), false)
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
      assert.equal(saved.length, 6)
      assert.match(out[0], /^#\s+sig\s+family\s+count\s+score/)
      assert.match(out.at(-1), /^harvest events=9 signatures=6 page=4 bring=2 proposable=5 days=7/)
    })
  })
})

describe('curriculum docker timestamps + empty-night why (idkcraft-vf8e.16)', () => {
  const { survey } = require('../tools/curriculum')
  const NOPAGE = path.join(__dirname, 'fixtures', 'curriculum-dump-nopage.txt')
  const nopage = fs.readFileSync(NOPAGE, 'utf8')
  const RAW = path.join(__dirname, 'fixtures', 'curriculum-dump-raw.txt')
  const rawText = fs.readFileSync(RAW, 'utf8')
  // `docker logs --timestamps` in front of already-stamped bot lines, with
  // and without fractional seconds.
  const prefixed = text.split('\n').filter((l) => l)
    .map((l, i) => `${i % 2 ? '2026-10-18T16:00:00Z' : '2026-10-18T16:00:00.123456789Z'} ${l}`).join('\n')

  it('a docker-prefixed dump of stamped lines parses exactly like the bot lines', () => {
    assert.deepEqual(parse(prefixed, ENV), parse(text, ENV))
    assert.deepEqual(rank(parse(prefixed, ENV), 7), list)
  })

  it('true raw lines (daemon stamp + bare stdout) date and attribute from the stamp', () => {
    const ev = parse(rawText, ENV)
    assert.equal(ev.length, 1)
    assert.deepEqual([ev[0].family, ev[0].reason, ev[0].bot, ev[0].day], ['page', 'pillar_up:failed:no-scaffold', 'IdkBotV2', '2026-10-19'])
    // A multi-bot filter cannot attribute a bare line: skipped, not mislabelled.
    assert.equal(parse(rawText, { CURRICULUM_BOTS: 'all' }).length, 0)
  })

  it('multiplexed framing (Portainer logs API, no TTY) strips anywhere', () => {
    const frame = (s) => {
      const b = Buffer.from(s, 'utf8')
      const h = Buffer.alloc(8)
      h[0] = 1
      h.writeUInt32BE(b.length, 4)
      return Buffer.concat([h, b])
    }
    const lines = rawText.split('\n').filter((l) => l)
    const framed = Buffer.concat([frame(`${lines[0]}\n`), frame(`${lines[1]}\n${lines[2]}\n`), frame(`${lines[3]}\n`)]).toString('utf8')
    assert.deepEqual(parse(framed, ENV), parse(rawText, ENV))
  })

  it('survey mirrors the filter: kept lines only, refusals by chat name', () => {
    assert.deepEqual(survey(text, ENV), { lines: 40, parsed: 31, recover: 28, refusals: 3 })
    assert.deepEqual(survey(prefixed, ENV), survey(text, ENV))
    assert.deepEqual(survey(nopage, ENV), { lines: 3, parsed: 3, recover: 2, refusals: 0 })
    assert.deepEqual(survey(rawText, ENV), { lines: 4, parsed: 4, recover: 4, refusals: 0 })
  })

  it('harvest on the prefixed dump writes the same curriculum.json', () => {
    withDir((dir, out) => {
      const f = path.join(dir, 'prefixed.txt')
      fs.writeFileSync(f, prefixed)
      assert.equal(main(['harvest', f]), 0)
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'curriculum.json'), 'utf8'))
      assert.equal(saved.length, 6)
      assert.match(out.at(-1), /^harvest events=9 signatures=6 page=4 bring=2 proposable=5 days=7 parsed=31\/40 recover=28 refusals=3 -> /)
    })
  })

  it('harvest on the true raw dump finds the paged episode', () => {
    withDir((dir, out) => {
      assert.equal(main(['harvest', RAW]), 0)
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'curriculum.json'), 'utf8'))
      assert.equal(saved.length, 1)
      assert.deepEqual([saved[0].family, saved[0].reason, saved[0].proposable], ['page', 'pillar_up:failed:no-scaffold', true])
    })
  })

  it('a night with 0 signatures says why: recover seen, no pages, bring excluded', () => {
    withDir((dir, out) => {
      assert.equal(main(['harvest', NOPAGE]), 0)
      assert.match(out.at(-2), /^harvest events=0 signatures=0 page=0 bring=0 proposable=0 days=7 parsed=3\/3 recover=2 refusals=0 -> /)
      assert.match(out.at(-1), /^harvest why: recover=2 but 0 page events \(no call_player\/gave-up episode\); bring=excluded/)
    })
  })

  it('a night that parsed nothing says the dump or filter is wrong', () => {
    withDir((dir, out) => {
      const f = path.join(dir, 'junk.txt')
      fs.writeFileSync(f, 'hello world\nstill no timestamps\n')
      assert.equal(main(['harvest', f]), 0)
      assert.match(out.at(-1), /^harvest why: nothing parsed \(0 of 2 lines; wrong dump or bot filter 'IdkBotV2'\?\); bring=excluded/)
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
