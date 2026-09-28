'use strict'

// stockpile: the home chest (idkcraft-atl.14). While the owner is away the
// bot banks its surplus in a chest by the house instead of hauling it to a
// player: adopt-or-place the chest at table+1 east, then deposit everything
// the body still needs on hand (tools, light fuel, food, pillar reserve).
//
// Chest contract (shared with rw4.13 torches): ctx.home.chest is a plain
// { x, y, z } like ctx.home.table, claimed only once the chest block is
// really there. Placement scans CHEST_SPOTS in order — table+1 east first,
// then the neighbouring cells — for solid ground below and air at the cell.
// Adopt-on-sight: a chest an earlier run left at a candidate spot is
// adopted, never rebuilt.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { countItems } = require('../perception')

// Candidate chest cells, site-relative (table is BLUEPRINT[0] at (4,0,1),
// so (5,0,1) is table+1 east). All sit beside the east wall, clear of the
// door walk cell (1,0,-1) and the interior.
const CHEST_SPOTS = [
  { dx: 5, dy: 0, dz: 1 },
  { dx: 4, dy: 0, dz: 0 },
  { dx: 4, dy: 0, dz: 2 },
  { dx: 5, dy: 0, dz: 0 },
  { dx: 5, dy: 0, dz: 2 },
  { dx: 6, dy: 0, dz: 1 },
]

// Never banked: worn/carried kit (same shape as bring share keeps), the
// light fuel rw4.13 counts from the inventory (torch, coal, charcoal and
// the sticks they craft from), plus a food and scaffold reserve below.
const TOOL_KEEP = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/
const EXACT_KEEP = new Set([
  'shears', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'arrow', 'shield',
  'torch', 'coal', 'charcoal', 'stick',
])
const FOOD_KEEP = 10
const SCAFFOLD_KEEP = 32
// Surplus batch gate (craft NEED_LOGS precedent): banking preempts forage,
// so a single dug block must not flip it — the leg would shrink to one
// block per round trip home. The menu sees surplus only past a full batch.
const SURPLUS_BATCH = 16
// Park re-probe radius: an expired full park re-arms only near home, so a
// probably-still-full chest never costs a cross-map trip (revmux 02-review).
const REPROBE_RADIUS = 32
// No-spot retry window: all six spots decidably unusable (solid cells,
// floats) stamps a park so far legs don't each cost a walk home to
// rediscover it; a freed spot retries within the hour (revmux 03-review).
const NO_SPOT_RETRY_MS = 60 * 60 * 1000
const CLEAR_FLORA = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush',
  'snow', 'poppy', 'dandelion', 'oxeye_daisy', 'cornflower', 'azure_bluet',
  'allium', 'blue_orchid', 'lily_of_the_valley', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip',
])
// A full chest parks the step, but only for this long: the owner empties
// the chest by hand (no ctx write), so the park must expire and re-probe
// instead of holding until a bring fetch or a restart (revmux 01-review).
const CHEST_FULL_RETRY_MS = 10 * 60 * 1000
// Container/place interaction reach: isMoving()==false is not arrival (no
// path reads the same), so window ops double-check the body is close
// instead of eating mineflayer's 20 s windowOpen timeout (revmux 01-review).
const INTERACT_REACH = 4
// Place reach: GoalPlaceBlock(range 4) ends on head-to-face-centre <= 4,
// so the gate must accept every valid end node (02-review geometry).
const PLACE_REACH = 4.5

function nearPos(bot, p, reach) {
  // Measured to the block CENTRE: GoalPlaceBlock ends on head-to-face
  // distance, and feet-to-corner over-measures by ~1 on +x/+z approaches,
  // failing 'far' on a valid end node (revmux 02-review).
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    return Math.hypot(bp.x - (p.x + 0.5), bp.y - (p.y + 0.5), bp.z - (p.z + 0.5)) <= reach
  } catch (_) {
    return false
  }
}

function edibles() {
  try {
    const set = require('../index').EDIBLE_FOODS
    if (set && typeof set.has === 'function') return set
  } catch (_) { /* index not loaded (unit tests): fall back below */ }
  return new Set(['bread', 'apple', 'carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken'])
}

function isKeep(name) {
  if (typeof name !== 'string') return true
  if (EXACT_KEEP.has(name)) return true
  return TOOL_KEEP.test(name)
}

function invItems(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

// Inventory -> deposit list in inventory order, keeps skipped. Food keeps
// the first FOOD_KEEP edibles (the eat reflex feeds from the inventory),
// dirt+cobble keep the first SCAFFOLD_KEEP (the pillar reserve share keeps).
// Self reserve, mirror of gear.js SELF_RESERVE (round-2): owner pickaxes
// share the self pick's item name, so the allowance counts the pack minus
// the hands — a toss plus a bank can never spend the bot's own pick.
const GEAR_SELF_RESERVE = { iron_pickaxe: 1, diamond_pickaxe: 1 }
// Finished-goods exception (ipn.3): forged owner tools bank up to the gear
// ledger count (ctx.gearFinished); the rest of the kit stays. Without ctx
// the behaviour is exactly the old one.
function depositPlan(bot, ctx) {
  const list = invItems(bot)
  const edible = edibles()
  let keepFood = FOOD_KEEP
  let keepScaffold = SCAFFOLD_KEEP
  let finished = null
  try {
    finished = (ctx && ctx.gearFinished) || null
  } catch (_) { /* no allowance */ }
  const totals = {}
  if (finished) {
    for (const j of list) {
      if (!j || typeof j.name !== 'string') continue
      totals[j.name] = (totals[j.name] || 0) + (typeof j.count === 'number' ? j.count : 1)
    }
  }
  const allow = {}
  const plan = []
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (isKeep(i.name)) {
      if (!finished) continue
      if (!(i.name in allow)) {
        const net = Math.max(0, (totals[i.name] || 0) - (GEAR_SELF_RESERVE[i.name] || 0))
        allow[i.name] = Math.max(0, Math.min(finished[i.name] || 0, net))
      }
      const take = Math.min(allow[i.name], typeof i.count === 'number' ? i.count : 1)
      allow[i.name] -= take
      if (take > 0) plan.push({ name: i.name, count: take })
      continue
    }
    let n = typeof i.count === 'number' ? i.count : 1
    if (n <= 0) continue
    if (edible.has(i.name)) {
      const k = Math.min(keepFood, n)
      keepFood -= k
      n -= k
    } else if (i.name === 'dirt' || i.name === 'cobblestone') {
      const k = Math.min(keepScaffold, n)
      keepScaffold -= k
      n -= k
    }
    if (n > 0) plan.push({ name: i.name, count: n })
  }
  return plan
}

function surplusCount(bot, ctx) {
  let n = 0
  for (const p of depositPlan(bot, ctx)) n += p.count
  return n
}

function blockNameAt(bot, x, y, z) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(x, y, z)) : null
    return (b && b.name) || null
  } catch (_) {
    return null
  }
}

// First candidate that can hold the chest: a standing chest to adopt, else
// air (or clearable flora, dug before the place) with solid ground below.
// Adopt scans FIRST across all spots: a chest at a later spot must win
// over an air cell at an earlier one (revmux 03-review). Returns
// { x, y, z, adopt }, 'unknown' when nothing is decidable (chunks dark:
// walk in, don't fail), else null.
function chestSpotFor(bot, ctx) {
  const site = ctx && ctx.home && ctx.home.site
  if (!site || typeof site.x !== 'number') return null
  let sawUnknown = false
  const cell = (s) => {
    const x = site.x + s.dx
    const y = site.y + s.dy
    const z = site.z + s.dz
    const at = blockNameAt(bot, x, y, z)
    if (at === null) { sawUnknown = true; return null }
    return { x, y, z, at }
  }
  for (const s of CHEST_SPOTS) {
    const c = cell(s)
    if (c && c.at === 'chest') return { x: c.x, y: c.y, z: c.z, adopt: true }
  }
  for (const s of CHEST_SPOTS) {
    const c = cell(s)
    if (!c) continue
    if (c.at !== 'air' && !CLEAR_FLORA.has(c.at)) continue
    const below = blockNameAt(bot, c.x, c.y - 1, c.z)
    if (below === null) { sawUnknown = true; continue }
    if (below === 'air') continue
    return { x: c.x, y: c.y, z: c.z, adopt: false }
  }
  return sawUnknown ? 'unknown' : null
}

// What the no-chest branch can do: 'adopt' a standing chest on sight,
// 'place' one when the pack holds a chest item or 8 same-wood planks,
// 'none' otherwise. The no-spot stamp gates placing only: a chest the
// owner puts down by hand adopts immediately, never after the hour
// (revmux 04-review). The menu gates on this so an unready bot never
// preempts a forage leg to fail at once.
function chestTodo(bot, ctx, maxPlanks) {
  try {
    const site = ctx && ctx.home && ctx.home.site
    if (site && typeof site.x === 'number') {
      for (const s of CHEST_SPOTS) {
        if (blockNameAt(bot, site.x + s.dx, site.y + s.dy, site.z + s.dz) === 'chest') return 'adopt'
      }
    }
  } catch (_) { /* no adopt */ }
  try {
    const stamped = ctx && ctx.chestNoSpotAt
    if (stamped != null && Date.now() - stamped < NO_SPOT_RETRY_MS) return 'none'
  } catch (_) { /* unstamped */ }
  try {
    if (countItems(bot, (n) => n === 'chest') > 0) return 'place'
    if ((maxPlanks || 0) >= 8) return 'place'
  } catch (_) { /* undecidable: none */ }
  return 'none'
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort */ }
}

function fail(ctx, reason) {
  ctx.stepStatus = `failed:${reason}`
}

// Far patience: consecutive far+standing ticks on one goal key before the
// 'far' verdict. A single far reading is often a recovering pathfinder,
// never a verdict (live assay); movement or a fresh goal resets. Wedge
// recovery bounds the truly stuck case (it tears the goal, ticks accrue).
const FAR_STALL_TICKS = 5
function farStalled(ctx, key) {
  const f = (ctx.stockpileFar && ctx.stockpileFar.key === key) ? ctx.stockpileFar : { key, n: 0 }
  f.n++
  ctx.stockpileFar = f
  return f.n >= FAR_STALL_TICKS
}

// Claim the chest coords only once the chest block is really there (same
// placed-station contract as the table: a ghost claim would walk bring to
// an empty cell).
function adopted(ctx, spot) {
  ctx.home.chest = new Vec3(spot.x, spot.y, spot.z) // Vec3, not plain (h9z): withChest blockAt()s it
  ctx.chestFull = false
  ctx.chestFullAt = null
  ctx.chestErrorAt = null
  ctx.chestNoSpotAt = null
}

// Open the adopted chest, run fn(window), always close.
// { status: 'ok', value } | 'gone' | 'unknown' | 'error'.
// Unknown (blockAt null: unloaded chunk) is NOT gone — the caller walks
// closer and retries instead of dropping the adoption. An open throw on a
// LOADED chest (blocked lid, cat, lag) is an error, never unknown: the
// caller fails loud so failHolds parks the step (revmux 02-review).
async function withChest(bot, ctx, fn) {
  const c = ctx && ctx.home && ctx.home.chest
  if (!c || typeof bot.openChest !== 'function') return { status: 'gone' }
  let block = null
  let unknown = false
  try {
    block = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!block) unknown = true
  } catch (_) { unknown = true }
  if (!block) return { status: unknown ? 'unknown' : 'gone' }
  if (block.name !== 'chest') return { status: 'gone' }
  try {
    const window = await bot.openChest(block)
    try {
      return { status: 'ok', value: await fn(window) }
    } finally {
      try { window.close() } catch (_) { /* close best-effort */ }
    }
  } catch (_) {
    return { status: 'error' }
  }
}

// Withdraw up to count of name from the adopted chest. { got } — 0 when the
// chest is gone, empty of name, or the inventory is full.
async function withdrawFromChest(bot, ctx, name, count) {
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      let want = count
      let got = 0
      if (Array.isArray(stacks)) {
        for (const s of stacks) {
          if (want <= 0) break
          if (!s || s.name !== name) continue
          const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
          if (take <= 0) continue
          await window.withdraw(s.type, s.metadata, take)
          want -= take
          got += take
        }
      }
      return got
    })
    return { got: res && res.status === 'ok' ? res.value : 0 }
  } catch (_) {
    return { got: 0 }
  }
}

// Withdraw up to count of the first edible in the adopted chest.
// { got, name } — name null when nothing edible came out.
async function withdrawEdible(bot, ctx, count) {
  const edible = edibles()
  try {
    const res = await withChest(bot, ctx, async (window) => {
      const stacks = typeof window.containerItems === 'function' ? window.containerItems() : []
      if (!Array.isArray(stacks)) return { got: 0, name: null, status: 'ok' }
      const first = stacks.find((s) => s && typeof s.name === 'string' && edible.has(s.name))
      if (!first) return { got: 0, name: null }
      let want = count
      let got = 0
      for (const s of stacks) {
        if (want <= 0) break
        if (!s || s.name !== first.name) continue
        const take = Math.min(typeof s.count === 'number' ? s.count : 1, want)
        if (take <= 0) continue
        await window.withdraw(s.type, s.metadata, take)
        want -= take
        got += take
      }
      return { got, name: first.name }
    })
    return res && res.status === 'ok' ? res.value : { got: 0, name: null }
  } catch (_) {
    return { got: 0, name: null }
  }
}

function stockpile(bot, ctx, target, state) {
  if (!ctx) return
  if (ctx.stockpileInFlight) return // exactly one window op at a time (craft.js rule)
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return
  const home = ctx.home
  if (!home || !home.site) {
    fail(ctx, 'no-home')
    return
  }

  // Adopt-on-sight: a chest an earlier run left at a candidate spot is
  // claimed, never rebuilt. A ghost claim (mined chest) unadopts.
  if (!home.chest) {
    let spot = null
    try {
      spot = chestSpotFor(bot, ctx)
    } catch (_) { spot = null }
    if (spot === 'unknown') {
      // Home chunk dark (returning from a far leg): walk in so the scan
      // can decide. Failing here would preempt every leg to fail at once.
      const site = home.site
      const key = `stockpile-site:${site.x},${site.y},${site.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(site.x + 2, site.y, site.z + 2, 3), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      if (!nearPos(bot, { x: site.x + 2, y: site.y, z: site.z + 2 }, REPROBE_RADIUS)) {
        if (!farStalled(ctx, key)) return
        fail(ctx, 'far') // issued, standing, still far: no path home
        return
      }
      return // arrived but the scan is still dark: retry next tick
    }
    if (spot && spot.adopt) {
      adopted(ctx, spot)
    } else if (spot) {
      placeChest(bot, ctx, spot, bp)
      return
    } else {
      ctx.chestNoSpotAt = Date.now()
      fail(ctx, 'no-spot')
      return
    }
  }

  const c = home.chest
  let at = null
  try {
    at = blockNameAt(bot, c.x, c.y, c.z)
  } catch (_) { at = null }
  if (at === null) {
    // Chunk unknown (bot far from home): walk in so it loads. Never
    // unadopt on unknown — that deletes a good claim from 200 blocks out.
    const key = `stockpile:${c.x},${c.y},${c.z}`
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
      } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
      return
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
    if (moving) return
    if (!nearPos(bot, c, INTERACT_REACH)) {
      if (!farStalled(ctx, key)) return
      fail(ctx, 'far') // issued, standing, still far: no path
      return
    }
    return // arrived but the chunk is still dark: retry next tick
  }
  if (at !== 'chest') {
    home.chest = null // mined or never there: re-place, same step
    ctx.stepStatus = 'running'
    stockpile(bot, ctx, target, state)
    return
  }

  const plan = depositPlan(bot, ctx)
  if (plan.length === 0) {
    ctx.stepStatus = 'done'
    return
  }

  const key = `stockpile:${c.x},${c.y},${c.z}`
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (!nearPos(bot, c, INTERACT_REACH)) {
    // No path reads as !moving too: fail instead of eating the 20 s
    // windowOpen timeout on an out-of-range open (revmux 01-review).
    // Five consecutive far ticks: one is often a recovering pathfinder.
    if (!farStalled(ctx, key)) return
    fail(ctx, 'far')
    return
  }

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const before = surplusCount(bot, ctx)
      const names = []
      const bankedByName = {}
      let banked = 0
      const res = await withChest(bot, ctx, async (window) => {
        for (const p of depositPlan(bot, ctx)) {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[p.name]
          const type = entry && typeof entry.id === 'number' ? entry.id : null
          if (type == null) continue
          try {
            await window.deposit(type, null, p.count)
            banked += p.count
            bankedByName[p.name] = (bankedByName[p.name] || 0) + p.count
            names.push(`${p.count} ${p.name}`)
          } catch (_) { /* chest full or stack unmovable: stop at the rest */ }
        }
        return true
      })
      ctx.stockpileInFlight = false
      if (!res || res.status === 'gone') {
        home.chest = null // vanished mid-step: re-place, same step
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'unknown') {
        // Chunk unloaded mid-open: walk back in, keep the claim.
        ctx.stepStatus = 'running'
        ctx.lastGoalKey = null
        return
      }
      if (res.status === 'error') {
        // Lid blocked or open timed out: seal like a full chest (time +
        // near-home re-probe) so far legs don't each cost a walk + 20 s.
        ctx.chestErrorAt = Date.now()
        fail(ctx, 'deposit')
        return
      }
      if (banked > 0) {
        let handed = []
        try {
          const fin = ctx.gearFinished && typeof ctx.gearFinished === 'object' ? ctx.gearFinished : null
          if (fin) {
            if (!ctx.gearGiven || typeof ctx.gearGiven !== 'object') ctx.gearGiven = {}
            for (const name of Object.keys(bankedByName)) {
              if ((fin[name] || 0) <= 0) continue
              const c = Math.min(fin[name], bankedByName[name])
              fin[name] -= c
              ctx.gearGiven[name] = (ctx.gearGiven[name] || 0) + c
              try {
                if (ctx.haul && typeof ctx.haul === 'object') ctx.haul[name] = Math.max(0, (ctx.haul[name] || 0) - c)
              } catch (_) { /* haul best-effort */ }
              handed.push(`${c} ${name}`)
            }
          }
        } catch (_) { /* ledger best-effort */ }
        ctx.chestFull = false
        ctx.chestFullAt = null
        ctx.chestErrorAt = null
        say(bot, `stockpiled ${names.join(', ')}`)
        if (handed.length > 0) {
          say(bot, `handed ${handed.join(', ')} to the home chest`)
          try {
            console.log(`gear handed ${handed.join(', ')} to chest`)
          } catch (_) { /* logging best-effort */ }
        }
      }
      if (before > 0 && banked === 0) {
        // Nothing moved with surplus on hand: the chest is full. Done, not
        // failed — failing would hold and spam; the stamped flag parks the
        // step until the retry window expires or a bring fetch re-arms it.
        ctx.chestFull = true
        ctx.chestFullAt = Date.now()
        say(bot, 'the home chest is full')
      }
      ctx.stepStatus = 'done'
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'deposit')
    }
  })()
}

// Ensure a chest item (craft one at the placed table when needed) and place
// it at the spot. One in-flight op; ticks re-enter until adopted.
function placeChest(bot, ctx, spot, bp) {
  const have = countItems(bot, (n) => n === 'chest')
  if (have <= 0) {
    // Deferred require: stockpile loads during goal's load (goal requires
    // this module), while craft destructures NEED_LOGS off goal at load —
    // a top-level require here would hand craft a half-loaded goal.
    let craftMod = null
    try { craftMod = require('./craft') } catch (_) { craftMod = null }
    let tableBlock = null
    let tablePos = null
    if (craftMod) {
      // First verified-standing (h9z): a ghost home claim must not shadow
      // the standing roadside table (craft.js pattern).
      for (const cand of [(ctx.home && ctx.home.table), (ctx && ctx.claimedTable)]) {
        if (!cand || typeof cand.x !== 'number') continue
        try {
          const b = bot.blockAt && bot.blockAt(new Vec3(cand.x, cand.y, cand.z))
          if (b && b.name === 'crafting_table') { tableBlock = b; tablePos = cand; break }
        } catch (_) { /* unreadable: try the next claim */ }
      }
    }
    if (!tableBlock) {
      fail(ctx, 'no-chest')
      return
    }
    const found = craftMod ? craftMod.recipes(bot, 'chest', tableBlock) : []
    if (found.length === 0) { // no ingredients for the recipe
      fail(ctx, 'no-chest')
      return
    }
    // The table craft opens a window: walk into reach first (craft.js door
    // rule). Crafting from across the map eats the 20 s windowOpen timeout
    // and — with the error swallowed — livelocks the step (revmux 01-review).
    const reach = (craftMod && craftMod.TABLE_REACH) || INTERACT_REACH
    if (!nearPos(bot, tablePos, reach)) {
      const key = `stockpile-table:${tablePos.x},${tablePos.y},${tablePos.z}`
      if (key !== ctx.lastGoalKey) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(tablePos.x, tablePos.y, tablePos.z, 2), false)
        } catch (_) { /* retry next tick */ }
        ctx.lastGoalKey = key
        return
      }
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
      if (moving) return
      if (!farStalled(ctx, key)) return
      fail(ctx, 'far') // issued, standing, still far: no path to the table
      return
    }
    ctx.stockpileInFlight = true
    void (async () => {
      try {
        await craftMod.safeCraft(bot, found[0], 1, tableBlock)
      } catch (_) {
        ctx.stockpileInFlight = false
        fail(ctx, 'craft') // loud: failHolds parks until the situation moves
        return
      }
      ctx.stockpileInFlight = false
    })()
    return
  }

  const p = new Vec3(spot.x, spot.y, spot.z)
  const gkey = `stockpile-place:${spot.x},${spot.y},${spot.z}`
  if (ctx.lastGoalKey !== gkey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalPlaceBlock(p, bot.world, { range: 4 }), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = gkey
    return
  }
  let moving = false
  try { moving = bot.pathfinder.isMoving() } catch (_) { /* treat as arrived */ }
  if (moving) return
  if (!nearPos(bot, p, PLACE_REACH)) {
    if (!farStalled(ctx, gkey)) return
    fail(ctx, 'far') // issued, standing, still far: no path to the spot
    return
  }

  ctx.stockpileInFlight = true
  void (async () => {
    try {
      const below = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))
      if (!below || !below.name || below.name === 'air') {
        ctx.stockpileInFlight = false
        fail(ctx, 'no-ground')
        return
      }
      // The scan admits clearable flora: break it first, the server
      // refuses to place into a non-replaceable cell (revmux 04-review).
      // Anything else non-air here fails below at the landed check.
      try {
        const cell = bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
        if (cell && cell.name && cell.name !== 'air' && cell.name !== 'chest' &&
          CLEAR_FLORA.has(cell.name) && typeof bot.dig === 'function') {
          await bot.dig(cell)
        }
      } catch (_) {
        ctx.stockpileInFlight = false
        fail(ctx, 'dig')
        return
      }
      const items = bot.inventory.items()
      const item = Array.isArray(items) ? items.find((i) => i && i.name === 'chest') : null
      if (!item) {
        ctx.stockpileInFlight = false
        fail(ctx, 'no-chest')
        return
      }
      if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
      await bot.placeBlock(below, new Vec3(0, 1, 0))
      const landed = blockNameAt(bot, spot.x, spot.y, spot.z)
      ctx.stockpileInFlight = false
      if (landed === 'chest') {
        adopted(ctx, spot)
        ctx.lastGoalKey = null
        say(bot, 'placed the home chest')
      } else {
        fail(ctx, 'place')
      }
    } catch (_) {
      ctx.stockpileInFlight = false
      fail(ctx, 'place')
    }
  })()
}

module.exports = stockpile
module.exports.depositPlan = depositPlan
module.exports.surplusCount = surplusCount
module.exports.chestSpotFor = chestSpotFor
module.exports.withdrawFromChest = withdrawFromChest
module.exports.withdrawEdible = withdrawEdible
module.exports.CHEST_SPOTS = CHEST_SPOTS
module.exports.FOOD_KEEP = FOOD_KEEP
module.exports.SCAFFOLD_KEEP = SCAFFOLD_KEEP
module.exports.CHEST_FULL_RETRY_MS = CHEST_FULL_RETRY_MS
module.exports.INTERACT_REACH = INTERACT_REACH
module.exports.PLACE_REACH = PLACE_REACH
module.exports.SURPLUS_BATCH = SURPLUS_BATCH
module.exports.REPROBE_RADIUS = REPROBE_RADIUS
module.exports.NO_SPOT_RETRY_MS = NO_SPOT_RETRY_MS
module.exports.chestTodo = chestTodo
