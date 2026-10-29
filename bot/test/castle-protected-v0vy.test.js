'use strict'

// idkcraft-v0vy: a 'protected' hole (an owner's bed or build in the cell,
// a guarded block) never heals, so it retires fast — three consecutive
// protected blocks retire it permanently — instead of riding the 8-try
// (~35 min) ladder and re-arming on every tidy return. Transient fails
// keep the ordinary ladder, and the word releases once only retired legs
// remain.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const { failReason } = require('../src/step')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
function completeSet() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  }
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) {
    set.set(`${c.x},${c.y},${c.z}`, { pane: 'glass_pane', fence: 'oak_fence', gate: 'oak_fence_gate', banner: 'white_banner', bookshelf: 'bookshelf', enchanting_table: 'enchanting_table', blast_furnace: 'blast_furnace' }[c.kind] || 'air')
  }
  return set
}
// creeper damage: four wall stones knocked out
function damaged() {
  const set = completeSet()
  const cells = blueprint.absPlan(SITE, 0, V).cells.filter((c) => c.kind === 'stone' && c.y === SITE.y + 1).slice(0, 4)
  for (const c of cells) set.set(`${c.x},${c.y},${c.z}`, 'air')
  return { set, cells }
}
function worldBot(set, items = []) {
  return {
    chats: [],
    entity: { position: { x: SITE.x + 15.5, y: SITE.y, z: SITE.z + 13.5 } },
    inventory: { items: () => items },
    players: {},
    pathfinder: { goal: null },
    setControlState() {}, clearControlStates() {},
    chat(m) { this.chats.push(String(m)) },
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = set.has(k) ? set.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const state = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })
const retired = (cells, why) => Object.fromEntries(cells.map((c) => [`2:${c.idx}`, { tries: 8, until: 0, why, retired: true }]))
const openCell = () => blueprint.absPlan(SITE, 0, V).cells.find((c) => c.kind === 'stone')

describe('v0vy protected retirement', () => {
  it('protected retires at 3 consecutive tries with a permanent why', () => {
    const st = state()
    const ctx = { castle: st }
    const c = openCell()
    const now = Date.now()
    castle.blockCell(ctx, st, c, 'protected', now)
    assert.equal(st.blocked[`2:${c.idx}`].retired, undefined, 'try 1 still backing off')
    castle.blockCell(ctx, st, c, 'protected', now + 1000)
    assert.equal(st.blocked[`2:${c.idx}`].retired, undefined, 'try 2 still backing off')
    castle.blockCell(ctx, st, c, 'protected', now + 2000)
    const e = st.blocked[`2:${c.idx}`]
    assert.equal(e.retired, true, 'try 3 retires')
    assert.equal(e.why, 'protected', 'permanent why kept')
    assert.match(String(e.why), /^(kept-|refilled|liquid|no-tool-|protected)/, 'why matches the permanent regex')
  })
  it('transient fails keep the ordinary 8-try ladder', () => {
    const st = state()
    const ctx = { castle: st }
    const c = openCell()
    const now = Date.now()
    for (let i = 0; i < 3; i++) castle.blockCell(ctx, st, c, 'unreachable', now + i * 1000)
    assert.equal(!!st.blocked[`2:${c.idx}`].retired, false, '3 transient tries do not retire')
    for (let i = 3; i < 7; i++) castle.blockCell(ctx, st, c, 'no-path', now + i * 1000)
    assert.equal(!!st.blocked[`2:${c.idx}`].retired, false, '7 transient tries do not retire')
    castle.blockCell(ctx, st, c, 'no-path', now + 7000)
    assert.equal(st.blocked[`2:${c.idx}`].retired, true, '8th transient try retires as before')
  })
  it('a transient fail between protected ones resets the fast streak', () => {
    const st = state()
    const ctx = { castle: st }
    const c = openCell()
    const now = Date.now()
    castle.blockCell(ctx, st, c, 'protected', now)
    castle.blockCell(ctx, st, c, 'protected', now + 1000)
    castle.blockCell(ctx, st, c, 'unreachable', now + 2000)
    castle.blockCell(ctx, st, c, 'protected', now + 3000)
    castle.blockCell(ctx, st, c, 'protected', now + 4000)
    assert.equal(!!st.blocked[`2:${c.idx}`].retired, false, 'streak broken: no fast retire')
    castle.blockCell(ctx, st, c, 'protected', now + 5000)
    assert.equal(st.blocked[`2:${c.idx}`].retired, true, '3 consecutive protected retires')
  })
  it('reopenRepairs never re-arms a protected-retired cell, in either mode', () => {
    const { set, cells } = damaged()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const st = state({
      blocked: {
        ...retired(cells.slice(0, 1), 'protected'),
        ...retired(cells.slice(1, 2), 'no-ref'),
        ...retired(cells.slice(2, 3), 'kept-chest'),
      },
    })
    const ctx = { castle: st }
    const n = castle.reopenRepairs(bot, ctx, st, true)
    assert.equal(n, 1, 'only the transient cell reopens on a tidy return')
    assert.ok(st.blocked[`2:${cells[0].idx}`].retired, 'protected-retired stays')
    assert.ok(st.blocked[`2:${cells[2].idx}`].retired, 'kept-chest stays')
    assert.equal(st.blocked[`2:${cells[1].idx}`], undefined, 'transient re-armed')
    // Explicit repair order: everything else reopens, protected still stays.
    const m = castle.reopenRepairs(bot, ctx, st, false)
    assert.equal(m, 1, 'only the kept cell reopens on explicit repair')
    assert.ok(st.blocked[`2:${cells[0].idx}`].retired, 'protected-retired stays even on explicit repair')
    assert.equal(st.blocked[`2:${cells[2].idx}`], undefined, 'kept-chest re-armed by the owner order')
  })
  it('word releases when only retired legs remain', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now, blocked: retired(cells, 'protected') }) }
    assert.equal(castle.menuFact(bot, ctx, now), 'done', 'complete castle with only retired holes words done')
    assert.deepEqual(ctx.castleWord, { word: 'done' }, 'no repair fetch latched')
    // Body phase over a fully-dug world (no decor laid yet — decor cells
    // sit on plan keep-clear cells): no fetch word for retired holes.
    const bodySet = new Map()
    for (const c of blueprint.absPlan(SITE, 0, V).cells) {
      bodySet.set(`${c.x},${c.y},${c.z}`, blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
    }
    for (const c of cells) bodySet.set(`${c.x},${c.y},${c.z}`, 'air')
    const airBot = worldBot(bodySet, [{ name: 'cobblestone', count: 64 }])
    airBot.blockAt = (p) => {
      const k = key(p.x, p.y, p.z)
      const name = bodySet.has(k) ? bodySet.get(k) : 'air'
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    }
    const ctx2 = { castle: state({ visitedAt: now, blocked: retired(cells, 'protected') }) }
    ctx2.castle.phase = 'body'
    assert.equal(castle.menuFact(airBot, ctx2, now), 'finish', 'incomplete castle with only retired holes words finish')
  })
  it('control: one unblocked hole still words the repair', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now, blocked: retired(cells.slice(0, 3), 'protected') }) }
    assert.equal(castle.menuFact(bot, ctx, now), 'stone-batch', 'live hole still words the repair')
    assert.deepEqual(ctx.castleWord, { kind: 'stone', left: 4, repair: true }, 'repair fetch latched')
  })
  it('control: one backing-off hole still holds the word and the step', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const blocked = retired(cells.slice(0, 3), 'protected')
    blocked[`2:${cells[3].idx}`] = { tries: 1, until: now + 60000, why: 'unreachable' }
    const ctx = { castle: state({ visitedAt: now, blocked }) }
    assert.equal(castle.menuFact(bot, ctx, now), 'blocked', 'backing-off hole still words blocked')
    castle(bot, ctx)
    assert.equal(failReason(ctx.stepStatus), 'blocked', 'step fails blocked via the step protocol')
  })
  it('retired-only completion writes done via the step protocol', () => {
    const { set, cells } = damaged()
    const now = Date.now()
    const bot = worldBot(set, [{ name: 'cobblestone', count: 64 }])
    const ctx = { castle: state({ visitedAt: now, blocked: retired(cells, 'protected') }) }
    castle(bot, ctx)
    assert.equal(ctx.stepStatus, 'done', 'step done')
    assert.equal(failReason(ctx.stepStatus), null, 'no failure reason parses')
  })
  it('the protected streak rides the memory file across a restart', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const memory = require('../src/memory')
    const bot = worldBot(new Map(), [])
    bot.username = 'Prot'
    bot.spawnPoint = { x: 0, y: 64, z: 0 }
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v0vy-')), 'Prot.json')
    assert.equal(memory.save(bot, { castle: state({ blocked: { '2:5': { tries: 2, until: Date.now() + 1000, why: 'protected', prot: 2 } } }) }, f), true)
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
    assert.equal(doc.castle.blocked['2:5'].prot, 2, 'streak rides the file')
    const ctx = {}
    memory.restore(bot, ctx, f)
    assert.equal(ctx.castle.blocked['2:5'].prot, 2, 'streak survives the rejoin')
    assert.equal(ctx.castle.blocked['2:5'].why, 'protected')
  })
  it("'castle repair' says nothing-to-repair when only protected-retired damage remains", () => {
    const { createTicker, handleChat } = require('../src/index')
    const { set, cells } = damaged()
    const bot = worldBot(set)
    bot.username = 'IdkBot'
    bot.registry = { itemsByName: {} }
    bot.time = { timeOfDay: 6000, day: 1 }
    bot.spawnPoint = { x: 0, y: 64, z: 0 }
    bot.on = () => {}
    bot.once = () => {}
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.castle = state({ blocked: retired(cells, 'protected') })
    handleChat(bot, ticker, 'Steve', 'castle repair')
    const line = bot.chats.pop()
    assert.match(line, /nothing to repair/, 'honest line instead of repairing')
    assert.equal(Object.keys(ctx.castle.blocked).length, 4, 'protected entries stay retired')
  })
})
