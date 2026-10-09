'use strict'

// idkcraft-oqul.2: characterization net for the brain-structure moves
// (epic oqul). Pins current behaviour, right or wrong; a golden diff is a
// behaviour change for the reviewer to read (npm run golden:update).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const goal = require('../src/goal')
const memory = require('../src/memory')
const { golden } = require('./characterize-util')

// decide()'s choice stage over the eval fixtures. decide() reads its facts
// from the world (goalFacts(bot, ctx), goal.js:2145) and hands the feasible
// menu to chooseStep (goal.js:2598); the fixtures carry exactly that pair —
// facts text + menu — so the stage is driven directly, under four
// controlled brains: none (FSM), laya and jev answering the fixture's prod
// model, and a failing model.
function factsOf(text) {
  const facts = {}
  for (const kv of String(text).split(/\s+/)) {
    const i = kv.indexOf('=')
    if (i > 0) facts[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return facts
}

const answering = (source, label) => ({ source, async ask() { return label } })
const failing = { source: 'laya', async ask() { throw new Error('boom') } }

async function choiceRow(row) {
  const facts = factsOf(row.state_text || row.facts)
  const pick = async (brain) => {
    const c = await goal.chooseStep(brain, facts, row.menu, null)
    return `${c.step}/${c.source}`
  }
  const answer = row.prod_model || row.reviewer || row.fsm
  return {
    id: row.id,
    fsm: goal.goalFsm(facts, row.menu),
    none: await pick(null),
    laya: await pick(answering('laya', answer)),
    jev: await pick(answering('jev', answer)),
    failing: await pick(failing),
  }
}

describe('decide() choice stage over the eval fixtures (golden)', () => {
  for (const name of ['goal-eval', 'goal-context-eval']) {
    it(`${name}.json`, async () => {
      const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'))
      const quiet = console.error
      console.error = () => {} // disagreement lines
      const out = []
      try {
        for (const row of rows) out.push(await choiceRow(row))
      } finally {
        console.error = quiet
      }
      assert.equal(out.length, name === 'goal-eval' ? 32 : 44, 'fixture count')
      golden('decide', name, out)
    })
  }
})

// Memory tri-state (memory.js:351-356 follow, :397-403 castle): a value,
// null (explicit revoke/forget) or undefined (ctx never restored). The file
// holds Steve + a castle; one save from a ctx carrying each shape, then a
// restore into a fresh ctx.
describe('memory follow/castle tri-state (characterization)', () => {
  const bot = { username: 'TriBot', spawnPoint: { x: 0, y: 64, z: 0 } }
  const CASTLE = { site: { x: 100, y: 64, z: 200 }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
  const HOME = { site: { x: 1, y: 64, z: 1 }, built: true }

  function seeded() {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oqul2-')), 'TriBot.json')
    assert.equal(memory.save(bot, { followName: 'Steve', castle: { ...CASTLE }, home: HOME }, f), true)
    return f
  }

  function roundTrip(ctxFields) {
    const f = seeded()
    const wrote = memory.save(bot, { home: HOME, ...ctxFields }, f)
    const disk = JSON.parse(fs.readFileSync(f, 'utf8'))
    const ctx = {}
    memory.restore(bot, ctx, f)
    return { wrote, disk, ctx }
  }

  it("followName 'Alex' replaces the stored name", () => {
    const { wrote, disk, ctx } = roundTrip({ followName: 'Alex' })
    assert.equal(wrote, true)
    assert.equal(disk.follow, 'Alex')
    assert.equal(ctx.followName, 'Alex')
  })

  it('followName null (revoke) clears the stored name', () => {
    const { wrote, disk, ctx } = roundTrip({ followName: null })
    assert.equal(wrote, true)
    assert.equal(disk.follow, null)
    assert.equal(ctx.followName, undefined, 'restore leaves an unset name')
  })

  it('followName undefined (unrestored) keeps the stored name when other memory writes', () => {
    const { wrote, disk, ctx } = roundTrip({})
    assert.equal(wrote, true)
    assert.equal(disk.follow, 'Steve')
    assert.equal(ctx.followName, 'Steve')
  })

  it('castle record replaces the stored castle', () => {
    const { wrote, disk, ctx } = roundTrip({ castle: { ...CASTLE, rot: 2 } })
    assert.equal(wrote, true)
    assert.equal(disk.castle.rot, 2)
    assert.equal(ctx.castle.rot, 2)
  })

  it('castle null (forget) drops the stored castle', () => {
    const { wrote, disk, ctx } = roundTrip({ castle: null })
    assert.equal(wrote, true)
    assert.equal(disk.castle, null)
    assert.equal(ctx.castle, undefined)
  })

  it('castle undefined (unrestored) keeps the stored castle', () => {
    const { wrote, disk, ctx } = roundTrip({})
    assert.equal(wrote, true)
    assert.deepEqual(disk.castle, CASTLE)
    assert.deepEqual(ctx.castle, CASTLE)
  })
})
