'use strict'

// craftany: craft-to-bring (idkcraft-did.2). One generic primitive over
// bot.recipesAll instead of a function per item: pick the covered recipe,
// craft one intermediate layer (planks<-logs, sticks<-planks) through the
// gear ops, execute through gear.runOp (safeCraft + settle + verify-and-
// retry, the ph7 phantom workaround). Bring drives it as phase 'craft';
// jr2.2 beds reuse craftItem directly from their step.
//
// Data, not a tree: candidates (bring passes tool families best-tier-first),
// recipe variants (cobble/deepslate/blackstone stone_axe), and the missing
// report ("need 3 cobblestone (have 0)") all come from recipesAll deltas.
// What it never does: recursive gathering of missing mats (did.4's sub-
// orders own that) — only the pack plus one planks/sticks layer.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const craftMod = require('./craft')
const gearMod = require('./gear')
const equipMod = require('./equip')
const { countItems } = require('../perception')

const TABLE_REACH = craftMod.TABLE_REACH
const WALK_GIVE_UP = 20 // table-walk ticks before the honest no-table line
const TABLE_TRIES = 3 // place attempts before a crafted table gives up

// Tool material rank for the missing-report tie-break. Mirrors
// bring.PICKAXE_RANK; kept local so the bring->craftany edge stays acyclic.
const MAT_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function matRank(name) {
  const m = typeof name === 'string' && name.match(/^(\w+?)_(pickaxe|axe|shovel|hoe|sword)$/)
  if (!m) return 0
  return m[1] in MAT_RANK ? MAT_RANK[m[1]] : -1
}

function have(bot, name) {
  try {
    return countItems(bot, (n) => n === name)
  } catch (_) {
    return 0
  }
}

function packCounts(bot) {
  const counts = {}
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (!i || typeof i.name !== 'string') continue
        counts[i.name] = (counts[i.name] || 0) + (i.count || 0)
      }
    }
  } catch (_) { /* unreadable inventory: empty plan */ }
  return counts
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function isPlanks(name) {
  return typeof name === 'string' && name.endsWith('_planks')
}

function isSubstitutable(name) {
  return name === 'stick' || isPlanks(name) // the one intermediate layer
}

// Ingredient needs from the recipe delta (negatives = consumed). Null when
// the recipe carries no usable data (mock {} probes, registry gaps) — the
// planner skips it instead of crafting blind.
function needsOf(recipe, idToName) {
  try {
    const delta = recipe && recipe.delta
    if (!Array.isArray(delta)) return null
    const needs = []
    for (const d of delta) {
      if (!d || typeof d.count !== 'number' || d.count >= 0) continue
      const name = idToName[d.id]
      if (!name) return null
      needs.push({ name, need: -d.count })
    }
    if (needs.length === 0) return null
    return needs
  } catch (_) {
    return null
  }
}

function resultCount(recipe) {
  try {
    const n = recipe && recipe.result && recipe.result.count
    return typeof n === 'number' && n > 0 ? n : 1
  } catch (_) {
    return 1
  }
}

function totalPlanks(pack) {
  let n = 0
  for (const [name, c] of Object.entries(pack)) {
    if (isPlanks(name)) n += c
  }
  return n
}

function totalLogs(pack) {
  let n = 0
  for (const [name, c] of Object.entries(pack)) {
    if (typeof name === 'string' && name.endsWith('_log')) n += c
  }
  return n
}

// Uncovered needs after the one intermediate layer: sticks close from any
// planks/logs past the direct planks reserve, exact-wood planks from their
// own logs (opPlanks burns the biggest stack — mixed-wood exact counts may
// still fail honestly at execution, see nextOp). Raws close exact.
function gapOf(needs, pack, times) {
  const missing = []
  let sticksNeed = 0
  const planksDirect = new Map()
  for (const { name, need } of needs) {
    const n = need * times
    if (name === 'stick') sticksNeed += n
    else if (isPlanks(name)) planksDirect.set(name, (planksDirect.get(name) || 0) + n)
    else if ((pack[name] || 0) < n) missing.push({ name, need: n, have: pack[name] || 0 })
  }
  let directTotal = 0
  for (const [name, n] of planksDirect) {
    directTotal += n
    const wood = name.slice(0, -'_planks'.length)
    const avail = (pack[name] || 0) + 4 * (pack[`${wood}_log`] || 0)
    if (avail < n) missing.push({ name, need: n, have: pack[name] || 0 })
  }
  if (sticksNeed > 0) {
    const short = sticksNeed - (pack.stick || 0)
    if (short > 0) {
      const ops = Math.ceil(short / 4) // one sticks op yields 4 for 2 planks
      const avail = totalPlanks(pack) + 4 * totalLogs(pack) - directTotal
      if (avail < 2 * ops) missing.push({ name: 'stick', need: sticksNeed, have: pack.stick || 0 })
    }
  }
  return missing
}

// Missing competition: a gap in a substitutable kind (sticks/planks) means
// the intermediate layer is dry too, so raw-only gaps win (one gather
// away), then fewest units, then the closest to covered, then the cheapest
// tier — the refusal names the smallest honest gap ("need 3 cobblestone",
// not iron, on a bare log). Full ties keep the later variant: the
// registry lists the overworld default last (cobble after deepslate and
// blackstone, oak after every wood — assayed across stone/wooden tools).
function gapCmp(a, b) {
  const sub = (m) => m.missing.filter((e) => isSubstitutable(e.name)).length
  const units = (m) => m.missing.reduce((n, e) => n + Math.max(0, e.need - e.have), 0)
  const has = (m) => m.missing.reduce((n, e) => n + Math.min(e.have, e.need), 0)
  if (sub(a) !== sub(b)) return sub(a) - sub(b)
  if (units(a) !== units(b)) return units(a) - units(b)
  if (has(a) !== has(b)) return has(b) - has(a)
  if (matRank(a.target) !== matRank(b.target)) return matRank(a.target) - matRank(b.target)
  return 0
}

function missingLine(target, missing) {
  const gaps = missing.map((e) => `${e.need} ${e.name} (have ${e.have})`).join(', ')
  return `can't make ${target}: need ${gaps}`
}

// Table path for a table recipe: the verified standing claim, the pack, or
// 4 planks-worth to make one (any wood, logs count quadruple — the recipe
// lookup filters by held). Null reads as the honest no-table refusal,
// never a craft attempt.
// Standing table; under ctx.craftanyLocal (vmzq.37 buried pick rearm) only
// one within reach counts — a far one would be walked to, and a body
// sealed underground cannot walk; it places its own instead.
function standingTable(bot, ctx) {
  const tb = gearMod.tableBlock(bot, ctx)
  if (!tb || !ctx || !ctx.craftanyLocal) return tb
  const bp = bot.entity && bot.entity.position
  for (const p of [ctx.home && ctx.home.table, ctx.claimedTable]) {
    if (!bp || !p || typeof p.x !== 'number' || dist3(bp, p) > TABLE_REACH) continue
    const block = bot.blockAt && bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (block && block.name === 'crafting_table') return { block, pos: p }
  }
  return null
}

function tablePathOf(bot, ctx, pack) {
  try {
    if (standingTable(bot, ctx)) return 'placed'
  } catch (_) { /* unreadable claim: fall through */ }
  if ((pack.crafting_table || 0) > 0) return 'pack'
  // Logs fund the table through a planks op first (did.4 core-1): the
  // executor converts, the planner only checks the worth here.
  if (totalPlanks(pack) + 4 * totalLogs(pack) >= 4) return 'make'
  return null
}

// Registry id -> item name (planCraft builds its own inline; the executor
// needs the same map to read the table wood out of its recipe).
function buildIdToName(bot) {
  const byName = (bot.registry && bot.registry.itemsByName) || {}
  const map = {}
  for (const [n, e] of Object.entries(byName)) {
    if (e && typeof e.id === 'number') map[e.id] = n
  }
  return map
}

// The wood a table recipe burns (its _planks delta), or null.
function tableWoodOf(recipe, idToName) {
  try {
    for (const d of (recipe && recipe.delta) || []) {
      if (d && d.count < 0 && isPlanks(idToName[d.id])) return idToName[d.id]
    }
  } catch (_) { /* malformed recipe: no wood */ }
  return null
}

// Table recipes unfiltered (revmux 02 core-1/body-1): craftMod.recipes is
// bot.recipesFor, which hides the table while the pack holds logs but no
// planks yet — exactly when the make-path needs to SEE it. recipesAll
// lists regardless of inventory; affordability is the caller's own count.
function tableRecipes(bot) {
  try {
    const byName = (bot.registry && bot.registry.itemsByName) || {}
    const e = byName.crafting_table
    if (!e || typeof e.id !== 'number' || typeof bot.recipesAll !== 'function') return []
    return bot.recipesAll(e.id, null, null) || []
  } catch (_) { return [] }
}

// The table variant to make: the first affordable (4+ planks-worth of its
// wood in the pack, logs counting quadruple) one that burns no wood the
// final needs directly — otherwise the
// make-op eats the recipe's own stack on mixed-wood packs (revmux 02: 5
// oak + 4 birch promised a birch axe, burned the birch into the table,
// then refused). Falls back to the first affordable variant when every
// wood is direct (or none is). Null when no variant is affordable: the
// planner must not promise a table the pack cannot fund (did.4 rig: 4 oak
// promised a spruce table, then failed loud at execution).
function pickTableRecipe(bot, idToName, needs, pack) {
  let found = []
  try {
    found = tableRecipes(bot) || []
  } catch (_) { found = [] }
  if (!Array.isArray(found) || found.length === 0) return null
  const affordable = found.filter((r) => {
    const w = tableWoodOf(r, idToName)
    if (!w) return false
    const base = w.slice(0, -'_planks'.length)
    const have = ((pack && pack[w]) || 0) + 4 * ((pack && pack[`${base}_log`]) || 0)
    return have >= 4
  })
  if (affordable.length === 0) return null
  const direct = new Set()
  for (const { name } of needs) {
    if (isPlanks(name)) direct.add(name)
  }
  if (direct.size === 0) return affordable[0]
  return affordable.find((r) => {
    const w = tableWoodOf(r, idToName)
    return w && !direct.has(w)
  }) || affordable[0]
}

// Pack minus the 4 planks-worth the made table eats from its own variant's
// wood: the 'make' plan checks coverage against this, so the same planks
// never fund both the table and the recipe (revmux 01: 3 cobble + 4 planks
// promised an axe, burned the planks into a stray table, then refused).
// Planks first, then logs, conservatively (did.4 core-1): a log burned for
// 1-3 missing planks leaves no change in the fund, so the plan may fetch
// one log too many, never one too few.
function packMinusTable(pack, wood) {
  if (!isPlanks(wood)) return { ...pack }
  const sub = { ...pack }
  const base = wood.slice(0, -'_planks'.length)
  const lname = `${base}_log`
  let need = 4
  const ptake = Math.min(sub[wood] || 0, need)
  sub[wood] = (sub[wood] || 0) - ptake
  need -= ptake
  if (need > 0) sub[lname] = Math.max(0, (sub[lname] || 0) - Math.ceil(need / 4))
  return sub
}

// Pure sync plan over the pack: candidates in try order (bring sorts tool
// families best-tier-first), recipe variants in registry order (the covered
// stone wins over deepslate/blackstone). Third recipesAll arg is truthy on
// purpose: mineflayer only uses it to filter requiresTable, and planning
// must SEE table recipes before any table is near.
function planCraft(bot, ctx, names, count) {
  const cands = Array.isArray(names) ? names : [names]
  if (!bot || typeof bot.recipesAll !== 'function') return { ok: false, fail: 'no-recipe' }
  const byName = (bot.registry && bot.registry.itemsByName) || {}
  const idToName = {}
  for (const [n, e] of Object.entries(byName)) {
    if (e && typeof e.id === 'number' && !(e.id in idToName)) idToName[e.id] = n
  }
  const pack = packCounts(bot)
  // A made table eats 4 planks before the recipe runs, so on the 'make'
  // path table recipes plan against the pack minus the picked variant's
  // wood — the same stack never funds both the table and the recipe
  // (revmux 01), and plan and execution agree on the wood (revmux 02).
  // Uniform per recipe shape, or variants compete on different packs.
  let reach = tablePathOf(bot, ctx, pack)
  try {
    if (reach === 'make' && tableRecipes(bot).length === 0) reach = null
  } catch (_) { reach = null }
  let refusal = null
  let tableBlocked = null
  for (const target of cands) {
    const e = byName[target]
    if (!e || typeof e.id !== 'number') continue
    let rs = []
    try {
      rs = bot.recipesAll(e.id, null, true) || []
    } catch (_) { rs = [] }
    if (!Array.isArray(rs)) continue
    for (const r of rs) {
      const needs = needsOf(r, idToName)
      if (!needs) continue
      const times = Math.max(1, Math.ceil((count || 1) / resultCount(r)))
      const requiresTable = !!r.requiresTable
      let trec = null
      let fund = pack
      if (requiresTable && reach === 'make') {
        trec = pickTableRecipe(bot, idToName, needs, pack)
        if (!trec) {
          // No affordable table variant (split woods, or no table recipe
          // at all): this recipe cannot run. A mats-covered recipe records
          // the table block — the honest no-table line wins below; a short
          // one competes its mats normally against the unreduced pack.
          if (gapOf(needs, pack, times).length === 0) {
            if (!tableBlocked) tableBlocked = target
            continue
          }
        } else {
          fund = packMinusTable(pack, tableWoodOf(trec, idToName))
        }
      }
      const missing = gapOf(needs, requiresTable ? fund : pack, times)
      if (missing.length === 0) {
        if (requiresTable && !reach) {
          return { ok: false, fail: 'no-table', target, line: 'need a crafting table' }
        }
        return { ok: true, target, recipe: r, needs, times, requiresTable, tableRecipe: trec }
      }
      const cand = { target, missing }
      if (!refusal || gapCmp(cand, refusal) <= 0) refusal = cand
    }
  }
  if (tableBlocked) return { ok: false, fail: 'no-table', target: tableBlocked, line: 'need a crafting table' }
  // The structured gaps ride along for did.4 sub-orders (the winning
  // variant's [{name, need, have}]); existing callers read ok/fail/target/
  // line only and are unaffected.
  if (refusal) return { ok: false, fail: 'missing', target: refusal.target, line: missingLine(refusal.target, refusal.missing), missing: refusal.missing }
  return { ok: false, fail: 'no-recipe' }
}

// Next live op from the pack: exact-wood planks first (a sticks op would
// burn the final's stack — biggest-first, no steering), then sticks, then
// the final. Null when the pack no longer covers (mats wandered off) —
// the caller recomputes the honest gap instead of failing blind.
function nextOp(bot, plan, table) {
  const pack = packCounts(bot)
  let sticksNeed = 0
  const planksDirect = []
  for (const { name, need } of plan.needs) {
    const n = need * plan.times
    if (name === 'stick') sticksNeed += n
    else if (isPlanks(name)) planksDirect.push([name, n])
    else if ((pack[name] || 0) < n) return null
  }
  for (const [name, n] of planksDirect) {
    if ((pack[name] || 0) >= n) continue
    const wood = name.slice(0, -'_planks'.length)
    if ((pack[`${wood}_log`] || 0) < 1) return null
    return gearMod.opPlanks(bot)
  }
  if ((pack.stick || 0) < sticksNeed) {
    if (totalPlanks(pack) >= 2) return gearMod.opSticks(bot)
    if (totalLogs(pack) >= 1) return gearMod.opPlanks(bot)
    return null
  }
  return { item: plan.target, recipe: plan.recipe, count: 1, table: table || null }
}

function clearRun(ctx) {
  try {
    ctx.craftany = null
  } catch (_) { /* cleanup best-effort */ }
}

// Stateful tick primitive for bring phase 'craft' and jr2.2 beds: plan on
// a new key, then walk/table/make/ops legs to completion. 'running' while
// busy; terminal { done } clears the run. gear.runOp reports its loud
// failure via ctx.stepStatus — the run snapshots (and clears) stale work
// failures at open, so only its own ops can trip it.
function craftItem(bot, ctx, name, count) {
  const names = Array.isArray(name) ? name : [name]
  const key = `${names.join(',')}x${count || 1}`
  let st = null
  try {
    st = ctx.craftany
  } catch (_) { st = null }
  if (!st || st.key !== key) {
    const plan = planCraft(bot, ctx, names, count || 1)
    if (!plan.ok) return { done: false, line: plan.line || `can't make ${names[0] || 'item'}: no recipe` }
    st = { key, plan, have0: have(bot, plan.target), finalNeed: plan.times * resultCount(plan.recipe), table: null, tableTries: 0, tableP: false, walkTicks: 0, lastDist: null }
    try {
      if (typeof ctx.stepStatus === 'string' && ctx.stepStatus.startsWith('failed:gear-')) ctx.stepStatus = null
      ctx.craftany = st
    } catch (_) { /* state best-effort */ }
  }
  const plan = st.plan
  try {
    if (typeof ctx.stepStatus === 'string' && ctx.stepStatus.startsWith('failed:gear-')) {
      ctx.stepStatus = null
      clearRun(ctx)
      return { done: false, line: `can't make ${plan.target}: crafting failed` }
    }
  } catch (_) { /* status best-effort */ }
  try {
    if (ctx.gearInFlight) return 'running'
  } catch (_) { /* flag best-effort */ }
  const bp = bot.entity && bot.entity.position
  if (!bp) return 'running'
  if (have(bot, plan.target) - st.have0 >= st.finalNeed) {
    clearRun(ctx)
    return { done: true, target: plan.target }
  }
  // g0z.40 rig: the run outlives the leg, so a table latched earlier is
  // re-checked; the body walked away (19 blocks) -> unlatch and walk back.
  if (st.table && st.table.position && !craftMod.tableUsable(bot, st.table, st.table.position)) st.table = null
  if (plan.requiresTable && !st.table) {
    let tb = null
    try {
      tb = standingTable(bot, ctx)
    } catch (_) { tb = null }
    if (tb) {
      if (!craftMod.tableUsable(bot, tb.block, tb.pos)) { // g0z.40: reach + sight
        const tkey = `craftany-table:${tb.pos.x},${tb.pos.y},${tb.pos.z}`
        if (tkey !== ctx.lastGoalKey) {
          try {
            bot.pathfinder.setGoal(craftMod.tableGoal(bot, tb.pos), false)
          } catch (_) { /* retry next tick */ }
          ctx.lastGoalKey = tkey
        }
        // Progress-based stall (bring walk-leg shape): a far table stays
        // walkable while the bot closes in; only standing still gives up.
        const d = dist3(bp, tb.pos)
        if (st.lastDist != null && d < st.lastDist - 1) st.walkTicks = 0
        else st.walkTicks += 1
        st.lastDist = d
        if (st.walkTicks > WALK_GIVE_UP) {
          clearRun(ctx)
          return { done: false, line: "can't reach the crafting table" }
        }
        return 'running'
      }
      st.walkTicks = 0
      st.lastDist = null
      st.table = tb.block
    } else {
      if (!st.tableP) {
        const pack = packCounts(bot)
        if ((pack.crafting_table || 0) > 0 || totalPlanks(pack) >= 4 || totalLogs(pack) >= 1) {
          if (st.tableTries >= TABLE_TRIES) {
            clearRun(ctx)
            return { done: false, line: 'need a crafting table' }
          }
          // A pack table places via the h9z tableFor contract; with planks
          // but no table the make-op lands one first, then we retry. The
          // make-op re-issues while the pack lacks the table (a phantom
          // first craft retries like any op — no latch); runOp fails loud
          // past its own retry budget and the tick top ends the run.
          if ((pack.crafting_table || 0) > 0) {
            st.tableP = true
            st.tableTries += 1
            void equipMod.tableFor(bot, ctx).then(
              (t) => { st.tableP = false; if (t) st.table = t.block },
              () => { st.tableP = false },
            )
            return 'running'
          }
          // Affordable first (revmux 03 core-2/body-1): the registry-first
          // variant (cherry) is usually unfunded — the table vanished
          // mid-run, so re-pick like the planner instead of crafting blind.
          const trec = plan.tableRecipe || pickTableRecipe(bot, buildIdToName(bot), plan.needs || [], pack)
          // Logs fund the table through a planks op for the table's own
          // wood first (did.4 core-1): the generic biggest-first op could
          // burn a whole other stack while this wood stays short. One op
          // lands 4 planks, so the next tick makes the table.
          const tweed = trec && tableWoodOf(trec, buildIdToName(bot))
          const tlog = tweed && `${tweed.slice(0, -'_planks'.length)}_log`
          if (trec && tweed && (pack[tweed] || 0) < 4 && (tlog && (pack[tlog] || 0) > 0)) {
            const pf = craftMod.recipes(bot, tweed, null)[0]
            if (!pf) {
              clearRun(ctx)
              return { done: false, line: 'need a crafting table' }
            }
            gearMod.runOp(bot, ctx, { item: tweed, recipe: pf, count: 1, table: null })
            return 'running'
          }
          if (trec) {
            gearMod.runOp(bot, ctx, { item: 'crafting_table', recipe: trec, count: 1, table: null })
            return 'running'
          }
        }
        clearRun(ctx)
        return { done: false, line: 'need a crafting table' }
      }
      return 'running'
    }
  }
  const op = nextOp(bot, plan, st.table)
  if (!op || op.fail) {
    const missing = gapOf(plan.needs, packCounts(bot), plan.times)
    clearRun(ctx)
    if (missing.length > 0) return { done: false, line: missingLine(plan.target, missing) }
    return { done: false, line: `can't make ${plan.target}: crafting failed` }
  }
  gearMod.runOp(bot, ctx, op)
  return 'running'
}

module.exports = craftItem
module.exports.planCraft = planCraft
module.exports.standingTable = standingTable
