'use strict'

const { goals } = require('mineflayer-pathfinder')
const { clearGoal, issueGoal, denyReason, isOwnPlaced, isTreeLog, say } = require('./util')
const { withChest, INTERACT_REACH } = require('./packroom')
const { carried, requirement } = require('./toolprep')

const BATCH_LOGS = 8
const WALK_MS = 20000
const PICKUP_MS = 12000
const CHEST_RADIUS = 32
const WOOD = /^(?:(?!stripped_).+_log|crimson_stem|warped_stem)$/

function count(bot, name) {
  return bot.inventory.items().reduce((n, item) => n + (item.name === name ? item.count : 0), 0)
}

function targets(bot, center, radius) {
  const wood = Object.values(bot.registry.blocksByName).filter(b => WOOD.test(b.name)).map(b => b.id)
  if (!wood.length) return []
  return bot.findBlocks({ point: center, matching: wood, maxDistance: 48, count: 65536 })
    .filter(p => Math.abs(p.x - center.x) <= radius && Math.abs(p.z - center.z) <= radius &&
      p.y >= center.y - 12 && p.y <= center.y + 32)
    .flatMap(p => {
      const block = bot.blockAt(p)
      return block && isTreeLog(bot, block) ? [{ pos: p, name: block.name }] : []
    })
}

function chests(bot, center) {
  const types = ['chest', 'trapped_chest'].map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  return types.length ? bot.findBlocks({ point: center, matching: types, maxDistance: CHEST_RADIUS, count: 32 }) : []
}

function prepare(bot, center, radius) {
  const logs = targets(bot, center, radius)
  if (!logs.length) return 'no trees found in that area'
  const storage = chests(bot, center)
  if (!storage.length) return 'place a chest within 32 blocks of the clearing first'
  const base = new Map()
  for (const item of bot.inventory.items()) base.set(item.name, (base.get(item.name) || 0) + item.count)
  return { logs, storage, base, wood: new Set(), cut: 0, stored: 0, missed: 0, skipped: 0, batch: 0, chestIndex: 0 }
}

function cancel(bot, ctx) {
  if (!ctx?.deforest) return
  ctx.deforest = null
  if (ctx.lastGoalKey?.startsWith('deforest:')) clearGoal(bot, ctx)
  if (ctx.deforestFlight === 'dig' && bot.targetDigBlock) bot.stopDigging?.()
}

function finish(bot, ctx, job, why = '') {
  cancel(bot, ctx)
  const remaining = job.logs.length + job.skipped
  say(bot, `deforest ${why ? 'stopped: ' + why : remaining || job.missed ? 'partly complete' : 'done'} — cut ${job.cut}, stored ${job.stored} planks${remaining ? `, ${remaining} targets left` : ''}${job.missed ? `, ${job.missed} drops missed` : ''}`)
}

function walk(bot, ctx, job, p, range, key, now) {
  const pos = bot.entity.position
  const dist = pos.distanceTo(p.offset(0.5, 0, 0.5))
  if (job.walk?.key !== key) job.walk = { key, dist, at: now }
  if (dist < job.walk.dist - 0.5) job.walk = { key, dist, at: now }
  if (now - job.walk.at >= WALK_MS) return false
  if (ctx.lastGoalKey !== key || !bot.pathfinder.goal) {
    issueGoal(bot, ctx, new goals.GoalNear(p.x, p.y, p.z, range), key, false)
  }
  return true
}

function run(bot, ctx, job, kind, action) {
  ctx.deforestFlight = kind
  const active = () => ctx.deforest === job
  void action(active).catch(() => {
    if (active()) finish(bot, ctx, job, `${kind} failed`)
  }).finally(() => { ctx.deforestFlight = null })
}

function selectLog(bot, job) {
  const pos = bot.entity.position
  // Nearest horizontal column first, bottom up so the crown stays intact.
  job.logs.sort((a, b) => Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z) -
    Math.hypot(b.pos.x - pos.x, b.pos.z - pos.z) || a.pos.y - b.pos.y)
  job.target = job.logs[0]
}

function dropTick(bot, ctx, job, now) {
  const { name, pos, before, until } = job.pickup
  const got = count(bot, name) > before
  if (!got && now < until) {
    const drop = Object.values(bot.entities || {}).find(e => e.position && Math.hypot(e.position.x - pos.x, e.position.z - pos.z) <= 3 &&
      e.position.y <= pos.y + 2 && e.position.y >= pos.y - 40 &&
      e.getDroppedItem?.()?.name?.replace(/^minecraft:/, '') === name)
    if (drop) {
      const p = drop.position.floored()
      walk(bot, ctx, job, p, 0, `deforest:pickup:${p}`, now)
    }
    return
  }
  if (got) {
    job.wood.add(name)
    job.batch++
  } else job.missed++
  job.pickup = null
  clearGoal(bot, ctx)
}

function bankTick(bot, ctx, job, now) {
  for (const name of job.wood) {
    const logs = count(bot, name) - (job.base.get(name) || 0)
    if (logs <= 0) continue
    const plank = name.replace(/_(?:log|stem)$/, '_planks')
    const type = bot.registry.itemsByName[plank]?.id
    const recipe = type == null ? null : bot.recipesFor(type, null, 1, null)
      .find(r => r.delta.some(i => i.id === bot.registry.itemsByName[name]?.id && i.count === -1))
    if (!recipe) { finish(bot, ctx, job, `no recipe for ${name}`); return }
    if (bot.inventory.emptySlotCount() < 1) { finish(bot, ctx, job, 'inventory full'); return }
    clearGoal(bot, ctx)
    run(bot, ctx, job, 'craft', async (active) => {
      const before = count(bot, name)
      await bot.craft(recipe, 1, null)
      if (active() && count(bot, name) >= before) throw new Error('log was not consumed')
    })
    return
  }
  const planks = [...new Set([...job.wood].map(name => name.replace(/_(?:log|stem)$/, '_planks')))]
    .filter(name => count(bot, name) > (job.base.get(name) || 0))
  if (!planks.length) {
    job.batch = 0
    job.wood.clear()
    job.chestIndex = 0
    if (!job.logs.length) finish(bot, ctx, job)
    return
  }

  const at = job.storage[job.chestIndex]
  if (!at) { finish(bot, ctx, job, 'chests full or unreachable; carrying remaining planks'); return }
  if (bot.entity.position.distanceTo(at.offset(0.5, 0.5, 0.5)) > INTERACT_REACH) {
    if (!walk(bot, ctx, job, at, 2, `deforest:chest:${at}`, now)) job.chestIndex++
    return
  }
  clearGoal(bot, ctx)
  run(bot, ctx, job, 'deposit', async (active) => {
    const attempts = []
    await withChest(bot, ctx, async window => {
      for (const name of planks) {
        if (!active()) return
        const item = bot.registry.itemsByName[name]
        const before = count(bot, name)
        const capacity = window.slots.slice(0, window.inventoryStart).reduce((n, stack) => {
          if (!stack) return n + item.stackSize
          return n + (stack.type === item.id ? item.stackSize - stack.count : 0)
        }, 0)
        const amount = Math.min(before - (job.base.get(name) || 0), capacity)
        if (amount <= 0) continue
        attempts.push({ name, before, amount })
        await window.deposit(item.id, null, amount)
      }
    }, at, active)
    // Mineflayer copies the container's player slots back on close.
    for (const { name, before, amount } of attempts) {
      job.stored += Math.max(0, Math.min(amount, before - count(bot, name)))
    }
    if (active()) job.chestIndex++
  })
}

function tick(bot, ctx, now) {
  const job = ctx.deforest
  if (!job || ctx.deforestFlight || ctx.digInFlight || ctx.craftInFlight || bot.currentWindow) return
  if (job.pickup) { dropTick(bot, ctx, job, now); return }
  if (job.batch >= BATCH_LOGS || !job.logs.length || (job.batch && bot.inventory.emptySlotCount() < 2)) {
    bankTick(bot, ctx, job, now)
    return
  }
  if (bot.inventory.emptySlotCount() < 2) { finish(bot, ctx, job, 'inventory full'); return }
  if (!job.target) selectLog(bot, job)
  const { pos, name } = job.target
  const advance = () => {
    job.logs.shift()
    job.target = null
    clearGoal(bot, ctx)
  }
  const block = bot.blockAt(pos)
  if (block && block.name !== name) { advance(); return }
  if (block && !isOwnPlaced(ctx, block) && isTreeLog(bot, block) &&
      !denyReason(bot, block, ctx) && bot.canDigBlock(block)) {
    clearGoal(bot, ctx)
    run(bot, ctx, job, 'dig', async (active) => {
      const req = requirement(block)
      const axe = req && carried(bot, req)
      if (axe && bot.heldItem?.name !== axe.name && !job.axeFailed) {
        try { await bot.equip(axe, 'hand') } catch (_) { job.axeFailed = true }
      }
      if (!active()) return
      const current = bot.blockAt(pos)
      if (current?.name !== name || isOwnPlaced(ctx, current) || !isTreeLog(bot, current) ||
          denyReason(bot, current, ctx) || !bot.canDigBlock(current)) return
      const before = count(bot, name)
      try { await bot.dig(current) } catch (_) { /* verify below */ }
      if (!active()) return
      const after = bot.blockAt(pos)
      if (after && after.name !== name) {
        job.cut++
        job.pickup = { name, pos, before, until: Date.now() + PICKUP_MS }
      } else job.skipped++
      advance()
    })
  } else if ((block && (isOwnPlaced(ctx, block) || !isTreeLog(bot, block))) ||
      !walk(bot, ctx, job, pos, 2, `deforest:log:${pos}`, now)) {
    job.skipped++
    advance()
  }
}

module.exports = { prepare, cancel, tick }
