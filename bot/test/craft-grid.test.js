'use strict'

// gxk: the 2x2 crafting grid hangs forever once an ingredient strands in it.
// mineflayer's clickWindow waits for updateSlot:0 after every click on slots
// 0..4, but the server only sends slot 0 when the result CHANGES — placing a
// second log while planks are already shown stays silent, so bot.craft throws
// "Event updateSlot:0 did not fire within timeout of 20000ms", one more log
// strands in the grid (invisible to inventory.items(), which covers slots
// 9..44 only), and the menu loops gather<->craft forever.
//
// The fake below emulates that mineflayer/server contract at slot level: a
// 46-slot inventory window plus a server rule that fires updateSlot:0 only on
// result change. Timeouts throw immediately with mineflayer's exact message
// instead of waiting 20 s; each failed attempt strands exactly one log with
// an empty cursor afterwards, which is the steady state observed in prod
// (logs decrease by 1 per attempt, never collapse to 0).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const craft = require('../src/behaviours/craft')

const TIMEOUT_MSG = 'Event updateSlot:0 did not fire within timeout of 20000ms'

function fakeWindow() {
  const emitter = new EventEmitter()
  const slots = new Array(46).fill(null)
  return {
    slots,
    selectedItem: null,
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => slots.slice(9, 45).filter(Boolean),
    updateSlot(i, item) {
      if (item) item.slot = i
      const old = slots[i]
      slots[i] = item
      emitter.emit('updateSlot', i, old, item)
      emitter.emit(`updateSlot:${i}`, old, item)
    },
  }
}

function logItem(count) {
  return { name: 'oak_log', type: 17, count, stackSize: 64 }
}

function planksItem(count) {
  return { name: 'oak_planks', type: 18, count, stackSize: 64 }
}

// Merge an item into the inventory range (slots 9..44), like a shift-click.
function stash(win, item) {
  for (let i = 9; i < 45; i++) {
    const cur = win.slots[i]
    if (cur && cur.name === item.name && cur.count < (cur.stackSize || 64)) {
      const room = (cur.stackSize || 64) - cur.count
      const take = Math.min(room, item.count)
      cur.count += take
      item.count -= take
      if (item.count <= 0) return
    }
  }
  for (let i = 9; i < 45; i++) {
    if (!win.slots[i]) {
      item.slot = i
      win.slots[i] = item
      return
    }
  }
  throw new Error('fake inventory full')
}

function countIn(win, name) {
  return win.items().reduce((n, it) => (it && it.name === name ? n + it.count : n), 0)
}

function gridOf(win) {
  return [1, 2, 3, 4].map((s) => win.slots[s]).filter(Boolean)
}

// Fake bot: mineflayer's 2x2 log->planks flow at slot level (pick up the
// source stack, place one log in the grid, wait for the server result event)
// plus shift-click clearing through the same server rule.
function fakeBot({ gridLogs = 0, invLogs = 0, craftImpl = null } = {}) {
  const win = fakeWindow()
  if (gridLogs > 0) {
    const g = logItem(gridLogs)
    g.slot = 1
    win.slots[1] = g
  }
  if (invLogs > 0) {
    const s = logItem(invLogs)
    s.slot = 9
    win.slots[9] = s
  }
  // The server already shows planks for the stranded grid: further placements
  // leave the result unchanged, so the server stays silent (the gxk hang).
  let lastResult = gridLogs > 0 ? 'planks' : null
  const resultNow = () => gridOf(win).length > 0 ? 'planks' : null
  const calls = { craft: 0, clicks: [], closes: 0 }
  const bot = {
    calls,
    lines: [],
    errs: [],
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { itemsByName: { oak_log: { id: 17 }, oak_planks: { id: 18 } } },
    inventory: win,
    recipesFor: (id) => (id === 18 ? [{ result: { name: 'oak_planks', count: 4 } }] : []),
    craft: craftImpl || (async (recipe, count) => {
      for (let k = 0; k < count; k++) {
        calls.craft++
        const src = win.slots.findIndex((it, i) => i >= 9 && it && it.name === 'oak_log')
        if (src < 0) throw new Error('missing ingredient')
        const stack = win.slots[src]
        win.slots[src] = null
        stack.count -= 1 // one log placed in the grid (mineflayer: slot 4 first)
        if (win.slots[4] && win.slots[4].name === 'oak_log') win.slots[4].count += 1
        else {
          const dest = logItem(1)
          dest.slot = 4
          win.slots[4] = dest
        }
        const after = resultNow()
        if (after === lastResult) {
          // Silent server: the click applied (log stranded), the event never
          // fires. The cursor stack settles back (prod steady state).
          if (stack.count > 0) stash(win, stack)
          throw new Error(TIMEOUT_MSG)
        }
        lastResult = after
        // Success: cursor back, take the result (grid log consumed, planks land).
        if (stack.count > 0) stash(win, stack)
        win.slots[4].count -= 1
        if (win.slots[4].count <= 0) win.slots[4] = null
        stash(win, planksItem(4))
        lastResult = resultNow()
      }
    }),
    clickWindow: async (slot, button, mode) => {
      calls.clicks.push({ slot, button, mode })
      assert.equal(mode, 1) // the clearer only shift-clicks
      const item = win.slots[slot]
      if (!item) return
      win.slots[slot] = null
      stash(win, item)
      const after = resultNow()
      if (after === lastResult) throw new Error(TIMEOUT_MSG) // applied, but silent
      lastResult = after
    },
    putSelectedItemRange: async () => { /* cursor always empty in this fake */ },
    closeWindow: async () => { calls.closes++ },
    blockAt: () => null,
    pathfinder: { setGoal: () => {}, isMoving: () => false },
    chat: (line) => { bot.lines.push(String(line)) },
  }
  const origError = console.error
  console.error = (m) => { bot.errs.push(String(m)) }
  bot.restoreError = () => { console.error = origError }
  return bot
}

function freshCtx() {
  return { lastGoalKey: '', stepStatus: 'running', home: null }
}

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('gxk 2x2 grid hang', () => {
  it('acceptance: stranded log is cleared, the whole batch converts in one step', async () => {
    // Grid slot 1 already holds a log; the server shows planks and stays
    // silent on further placements. Before the fix this craft times out and
    // strands one more log (13 -> 12); after the fix the grid is cleared up
    // front, the log returns to items(), and the whole NEED_LOGS batch
    // converts inside one step — converting one log per op would re-arm
    // gather at 13 logs and restart the switching (revmux round-1).
    const bot = fakeBot({ gridLogs: 1, invLogs: 13 })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.deepEqual(gridOf(bot.inventory), [])
    assert.equal(countIn(bot.inventory, 'oak_log'), 0) // 14 returned, 14 crafted
    assert.equal(countIn(bot.inventory, 'oak_planks'), 56)
    assert.equal(bot.calls.craft, 14) // one count=1 call per log ...
    assert.deepEqual(bot.lines, ['crafted 56 oak_planks (planks 56, logs 0)']) // ... one chat
    bot.restoreError()
    // The next craft on a fresh bot passes too, no re-hang.
    const bot2 = fakeBot({ invLogs: 2 })
    const ctx2 = freshCtx()
    craft(bot2, ctx2, null, {})
    await flush()
    assert.equal(ctx2.stepStatus, 'running')
    assert.deepEqual(gridOf(bot2.inventory), [])
    assert.equal(countIn(bot2.inventory, 'oak_log'), 0)
    assert.equal(countIn(bot2.inventory, 'oak_planks'), 8)
    bot2.restoreError()
  })

  it('a failed craft still returns the stranded ingredient to items()', async () => {
    // Non-timeout failure after stranding: the catch path must unload the
    // grid instead of leaving the log invisible (logs would churn 14->13 and
    // re-arm the gather<->craft loop).
    const bot = fakeBot({
      invLogs: 14,
      craftImpl: async () => {
        const stack = bot.inventory.slots[9]
        stack.count -= 1
        const g = logItem(1)
        g.slot = 2
        bot.inventory.slots[2] = g
        throw new Error('window jammed')
      },
    })
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'failed:craft-oak_planks')
    assert.deepEqual(gridOf(bot.inventory), [])
    assert.equal(countIn(bot.inventory, 'oak_log'), 14)
    bot.restoreError()
  })

  it('a repeated slot timeout asks the server for a resync, once', async () => {
    // Two consecutive updateSlot timeouts: the second one closes the bare
    // inventory window so the server resyncs the model. A success in between
    // resets the streak.
    const bot = fakeBot({ invLogs: 14 })
    bot.craft = async () => { throw new Error(TIMEOUT_MSG) }
    await assert.rejects(craft.safeCraft(bot, {}, 1, null), /did not fire within timeout/)
    assert.equal(bot.calls.closes, 0)
    await assert.rejects(craft.safeCraft(bot, {}, 1, null), /did not fire within timeout/)
    assert.equal(bot.calls.closes, 1)
    bot.craft = async () => {}
    await craft.safeCraft(bot, {}, 1, null) // success resets the streak
    bot.craft = async () => { throw new Error(TIMEOUT_MSG) }
    await assert.rejects(craft.safeCraft(bot, {}, 1, null), /did not fire within timeout/)
    assert.equal(bot.calls.closes, 1)
    bot.restoreError()
  })

  it('table crafts skip the 2x2 grid handling entirely', async () => {
    // 3x3 crafts run in the table window (mineflayer closes it on error
    // itself): no grid clicks, no resync close.
    const bot = fakeBot({ invLogs: 14 })
    let n = 0
    bot.craft = async () => { n++ }
    await craft.safeCraft(bot, {}, 1, { name: 'crafting_table' })
    assert.equal(n, 1)
    assert.deepEqual(bot.calls.clicks, [])
    assert.equal(bot.calls.closes, 0)
    bot.restoreError()
  })

  it('a cursor-held stack is returned to the inventory (pre- and catch-clear)', async () => {
    // A timed-out craft leaves the picked-up stack on the cursor with its
    // origin slot empty: both clearings must put it back, never toss it.
    const bot = fakeBot({ invLogs: 13 })
    const grab = (which) => {
      const win = bot.inventory
      const src = win.slots.findIndex((it, i) => i >= 9 && it && it.name === 'oak_log')
      assert.ok(src >= 0, `${which}: no log stack to grab`)
      win.selectedItem = win.slots[src]
      win.slots[src] = null
    }
    bot.putSelectedItemRange = async (start, end, win) => {
      assert.ok(win.selectedItem)
      stash(win, win.selectedItem) // the freed origin slot takes it back
      win.selectedItem = null
    }
    grab('pre') // cursor set before the op: the pre-clear returns it
    bot.craft = async () => {
      grab('catch') // and again mid-op: the catch-clear returns it too
      throw new Error(TIMEOUT_MSG)
    }
    await assert.rejects(craft.safeCraft(bot, {}, 1, null), /did not fire within timeout/)
    assert.equal(bot.inventory.selectedItem, null)
    assert.equal(countIn(bot.inventory, 'oak_log'), 13)
    bot.restoreError()
  })

  it('a hanging clearing click does not stall recovery past its budget', async () => {
    // A click the server never answers (worst case: the full 20 s mineflayer
    // wait per slot) must not push safeCraft past equip's 30 s deadline:
    // each clearing click gets ~2 s, then recovery moves on.
    const bot = fakeBot({ gridLogs: 1, invLogs: 13 })
    bot.clickWindow = () => new Promise(() => {}) // silent forever
    let crafted = 0
    bot.craft = async () => { crafted++ }
    const t0 = Date.now()
    await craft.safeCraft(bot, {}, 1, null)
    assert.ok(Date.now() - t0 < 10000, 'recovery must not wait out the silent click')
    assert.equal(crafted, 1)
    bot.restoreError()
  })

  it('an over-counted batch ends cleanly when the wood runs out', async () => {
    // Ghost cursor log: counted in the batch size at selection (visible 13 +
    // cursor 1 = 14), then wiped by a server correction — it never lands in
    // items(). The loop must stop at exhaustion with the converted load
    // reported, not fail the whole batch as missing ingredient (round-2).
    const bot = fakeBot({ invLogs: 13 })
    const ghost = logItem(1)
    bot.inventory.selectedItem = ghost
    bot.putSelectedItemRange = async (start, end, win) => {
      win.selectedItem = null // correction: the server never held it
    }
    const ctx = freshCtx()
    craft(bot, ctx, null, {})
    await flush()
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.inventory.selectedItem, null)
    assert.equal(countIn(bot.inventory, 'oak_log'), 0)
    assert.equal(countIn(bot.inventory, 'oak_planks'), 52)
    assert.equal(bot.calls.craft, 13)
    assert.deepEqual(bot.lines, ['crafted 52 oak_planks (planks 52, logs 0)'])
    bot.restoreError()
  })
})
