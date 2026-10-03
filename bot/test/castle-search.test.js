'use strict'

// idkcraft-g0z.19: on 'build castle' the bot searches the nearest valid
// site itself — bounded per tick, loaded chunks only, cancellable — and
// refuses honestly with the most common reason when nothing fits.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const castle = require('../src/behaviours/castle')
const { createTicker, handleChat } = require('../src/index')
const { advancePendingSearch } = require('../src/chat')

const V = 2
const LOADED = 80 // chunks around the origin; further reads null

// Dirt up to y=63; `wet(x, z)` puts water on top (y=63, 2 deep).
function makeBot(wet) {
  const reads = { n: 0 }
  const pos = (x, y, z) => { const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) }; return p }
  const bot = {
    username: 'IdkBot',
    reads,
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: { Steve: { username: 'Steve', entity: { position: pos(0.5, 64, 0.5), yaw: Math.PI } } },
    blockAt: (p) => {
      reads.n++
      const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
      if (Math.abs(x) > LOADED || Math.abs(z) > LOADED) return null
      const name = wet(x, z) && (y === 63 || y === 62) ? 'water' : (y <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

async function searchToEnd(bot, ticker, max = 400) {
  const ctx = bot._tickerCtx
  let ticks = 0
  while (ctx.pendingSearch && ticks < max) {
    const before = bot.reads.n
    await advancePendingSearch(bot, ticker, ctx)
    const p = ctx.pendingSearch
    if (p) assert.ok(p.cursor.lastScans <= castle.SEARCH_SCANS, `tick ${ticks}: ${p.cursor.lastScans} columns`)
    // A column read is <= 2 blockAt per y over the site volume (26 y).
    assert.ok(bot.reads.n - before <= castle.SEARCH_SCANS * 52, `tick ${ticks}: ${bot.reads.n - before} reads`)
    ticks++
  }
  return ticks
}

describe('castle site search (g0z.19)', () => {
  it('speaker in a pond: the bot picks the nearest dry clearing, bounded per tick, and announces it', async () => {
    const pond = (x, z) => Math.abs(x) <= 24 && Math.abs(z) <= 24
    const bot = makeBot(pond)
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.match(bot.chats.pop(), /^not right here \(there is water at .*\) — looking for a castle spot within 48 blocks/)
    assert.equal(bot._tickerCtx.castle, undefined)
    const ticks = await searchToEnd(bot, ticker)
    assert.ok(ticks > 1, `spread over ticks (${ticks})`)
    const st = bot._tickerCtx.castle
    assert.ok(st, bot.chats.join('|'))
    assert.equal(castle.siteCheck(bot, st.site, st.rot, V), null)
    assert.equal(st.site.y, 64)
    assert.equal(st.phase, 'prep')
    assert.equal(st.announce, true)
    assert.equal(bot._tickerCtx.work, true, 'work mode: the castle executor walks there')
    assert.match(bot.chats.pop(), new RegExp(`^found a castle spot \\d+ blocks away, going there; castle at ${st.site.x} 64 ${st.site.z}, ~\\d+ blocks`))
    // Arrival: the executor tick on the site announces it once.
    bot.entity.position = { x: st.site.x + 10, y: 64, z: st.site.z + 10 }
    castle(bot, bot._tickerCtx)
    assert.ok(bot.chats.some((m) => m.startsWith(`building the castle here at ${st.site.x} 64 ${st.site.z} (~`)), bot.chats.join('|'))
    assert.equal(st.announce, false)
  })

  it('the spot in front is taken at once, on the ground median, not the speaker\'s feet (g0z.20)', () => {
    const bot = makeBot(() => false)
    bot.players.Steve.entity.position.y = 66 // on a 2-high bump
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    const st = bot._tickerCtx.castle
    assert.ok(st, bot.chats.join('|'))
    assert.equal(st.site.y, 64)
    assert.equal(st.announce, false)
    assert.match(bot.chats.pop(), new RegExp(`^castle at ${st.site.x} 64 ${st.site.z}, `))
  })

  it('no valid spot in range: honest refusal with the majority reason', async () => {
    const bot = makeBot(() => true) // all water
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    await searchToEnd(bot, ticker)
    assert.equal(bot._tickerCtx.castle, undefined)
    assert.match(bot.chats.pop(), /^I found no castle spot within 48 blocks — mostly water \(\d+ of \d+ spots\)/)
  })

  it('unloaded ground never passes: the search refuses it', () => {
    const bot = makeBot(() => false)
    bot.blockAt = () => null
    const cur = castle.startSiteSearch({ x: 0, y: 64, z: 0 }, V)
    let r
    for (let i = 0; i < 1000 && !(r && r.done); i++) r = castle.stepSiteSearch(bot, cur)
    assert.equal(r.site, null)
    assert.equal(r.why, 'unloaded')
  })

  it('stop and castle forget cancel a running search', async () => {
    const pond = (x, z) => Math.abs(x) <= 24 && Math.abs(z) <= 24
    for (const cmd of ['stop', 'castle forget', 'follow me']) {
      const bot = makeBot(pond)
      const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
      handleChat(bot, ticker, 'Steve', 'build castle')
      await advancePendingSearch(bot, ticker, bot._tickerCtx)
      assert.ok(bot._tickerCtx.pendingSearch, 'still searching')
      handleChat(bot, ticker, 'Steve', cmd)
      assert.equal(bot._tickerCtx.pendingSearch, null, cmd)
      if (cmd === 'castle forget') assert.equal(bot.chats.pop(), 'castle search cancelled')
      await searchToEnd(bot, ticker)
      assert.ok(!bot._tickerCtx.castle, `${cmd}: no late castle`)
    }
  })
})
