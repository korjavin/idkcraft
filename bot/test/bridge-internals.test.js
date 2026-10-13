// idkcraft-neuc.14: mineflayer-internals on the bridge body. The packet taps
// (unpin/decontact) and deep's raw block_dig burst install/fire nothing on
// a bot without _client; the Movements customisations run on the bridge
// bot through the real ticker.setMovements path and the body tripwire stays
// quiet. Table: baritone/bridge/PROTOCOL.md "mineflayer-internals on v2".
// Run: `cd bot && npm test`.
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')
const { createTicker } = require('../src/index')
const unpin = require('../src/unpin')
const decontact = require('../src/decontact')
const deep = require('../src/behaviours/deep')
const body = require('../src/body')

const registry = require('minecraft-data')('26.1.2')

async function bridgeBot() {
  const transport = new FakeTransport({ pos: { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, onGround: false } })
  const bot = new BaritoneBot(transport, { Vec3, registry, username: 'IdkBody' })
  await bot.start({ pollMs: 0 })
  return { transport, bot }
}

// Collects every console line while fn runs (log + warn).
async function captured(fn) {
  const lines = []
  const orig = { log: console.log, warn: console.warn }
  console.log = (...a) => lines.push(a.join(' '))
  console.warn = (...a) => lines.push(a.join(' '))
  try { await fn() } finally { Object.assign(console, orig) }
  return lines
}

describe('mineflayer-internals on the bridge body (idkcraft-neuc.14)', () => {
  let bot
  afterEach(async () => { if (bot) await bot.stop() })

  it('the bridge bot has no _client (the field every guard keys on)', async () => {
    ({ bot } = await bridgeBot())
    assert.equal(bot._client, undefined)
  })

  it('unpin/decontact taps install nothing and unpinTick stays idle', async () => {
    ({ bot } = await bridgeBot())
    const ctx = {}
    const lines = await captured(async () => {
      assert.doesNotThrow(() => unpin.installUnpinTap(bot, ctx))
      assert.equal(decontact.installFaceEpsilon(bot), false)
      for (let t = 0; t < 20; t++) assert.equal(unpin.unpinTick(bot, ctx, 10000 + t * 100), 'idle')
    })
    assert.equal(bot._unpinTapInstalled, undefined, 'no partial install flag')
    assert.equal(bot._faceEpsInstalled, undefined)
    assert.ok(!(ctx.unpin && ctx.unpin.sendNudge), 'no nudge writer')
    assert.equal(lines.filter((l) => /unpin|faceeps/.test(l)).length, 0)
  })

  it('a later _client (never on v2) still installs: the guard is not a latch', async () => {
    ({ bot } = await bridgeBot())
    unpin.installUnpinTap(bot, {})
    bot._client = { on() {}, write() {} }
    const w = bot._client.write
    unpin.installUnpinTap(bot, {})
    assert.notEqual(bot._client.write, w)
    delete bot._client
  })

  it('deep unfreeze skips the raw block_dig burst (returns false, sends nothing)', async () => {
    let transport
    ({ transport, bot } = await bridgeBot())
    const sent = []
    const call = transport.call.bind(transport)
    transport.call = (method, params) => { sent.push(method); return call(method, params) }
    const lines = await captured(() => assert.equal(deep.unfreeze(bot, [{ x: 0, y: 63, z: 0 }]), false))
    await new Promise((r) => setTimeout(r, 200)) // past UNFREEZE_ABORT_MS: no delayed abort either
    assert.deepEqual(sent.filter((x) => /^dig/.test(x)), [])
    assert.equal(lines.filter((l) => /deep unfreeze/.test(l)).length, 0)
  })

  it('ticker.setMovements runs all seven customisations; lease flags never trip the wire', async () => {
    ({ bot } = await bridgeBot())
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    const m = new Movements(bot)
    const lines = await captured(async () => {
      ticker.setMovements(m)
      const ctx = bot._tickerCtx
      for (const owner of ['idle', 'follow', 'roam', 'idle', 'fight']) {
        body.claimBody(bot, ctx, owner, owner === 'follow' ? { sprint: true } : undefined)
        bot.pathfinder.setGoal(new goals.GoalNear(5, 64, 5, 1)) // adapter reads flags -> #set
        body.claimBody(bot, ctx, owner)
      }
      bot.pathfinder.setGoal(null)
    })
    assert.equal(bot.pathfinder.movements, m)
    assert.ok(m.blocksCantBreak.has(registry.blocksByName.oak_door.id), 'banDoorBreaks')
    for (const k of ['_doorPassInstalled', '_swimExitsInstalled', '_swimPruneInstalled', '_noCornerCutInstalled',
      '_snowGroundInstalled', '_jumpUpCostInstalled', '_dangerCostInstalled', '_nightWaterCostInstalled']) {
      assert.equal(m[k], true, k)
    }
    assert.equal(lines.filter((l) => /body lease violation/.test(l)).length, 0, lines.join('\n'))
    ticker.destroy()
  })
})
