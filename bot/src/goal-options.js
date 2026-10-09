'use strict'

// Option table (idkcraft-vmzq.22): label -> { step, policy, available, cost }.
// No new behaviours, no aliases without an executor. Unavailable options
// are not offered (and the reason logged), so the model never picks a
// promise the executor cannot keep.
//
// Plain steps keep their step id (castlefetch, gather, ...) for the .21
// contract; unlocks use suffixed ids (explore-far, house-build, ...).
// The watchdog choice is the optionId; applyCommit maps it to step+unlock.

const { OUTER_DISK } = require('./goal-unlock')
const { failReason } = require('./step')
const { PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION } = require('./plan-consts') // oqul.5: was a lazy task.js require

function taskActive(ctx) {
  try {
    return !!require('./behaviours/explore').taskActive(ctx)
  } catch (_) {
    return false
  }
}

function anchorOf(bot, ctx) {
  try {
    return require('./behaviours/explore').anchorOf(bot, ctx)
  } catch (_) {
    return null
  }
}

function ownerOnline(bot) {
  try {
    return !!(bot && bot.players && Object.keys(bot.players).some((n) => n !== bot.username))
  } catch (_) {
    return false
  }
}

function castleFirst(ctx) {
  try {
    return !!require('./behaviours/explore').castleActive(ctx)
  } catch (_) {
    return false
  }
}

// Remembered items past `radius` of the anchor, within the outer disk.
// `test` filters by name (logs, stone, ...). Returns the nearest candidate
// { x, y, z, name, dist } or null.
function rememberedPast(bot, ctx, radius, test) {
  try {
    const a = anchorOf(bot, ctx)
    if (!a || typeof a.x !== 'number') return null
    const mem = ctx && ctx.resources
    if (!mem || !(mem.items instanceof Map)) return null
    let best = null
    let bestD = Infinity
    for (const it of mem.items.values()) {
      if (!it || typeof it.x !== 'number' || typeof it.z !== 'number') continue
      if (test && !test(it.name)) continue
      const d = Math.hypot(it.x - a.x, it.z - a.z)
      if (d <= radius) continue
      if (d > OUTER_DISK) continue
      if (d < bestD) {
        bestD = d
        best = { x: it.x, y: it.y, z: it.z, name: it.name, dist: d }
      }
    }
    return best
  } catch (_) {
    return null
  }
}

function isLogName(n) {
  return typeof n === 'string' && n.endsWith('_log')
}

function isStoneName(n) {
  return n === 'stone' || n === 'cobblestone' || n === 'granite' || n === 'diorite' || n === 'andesite'
}

function isForageName(n) {
  // Same value ranks as forage.js bestMemoryCell (ore rank <=2, logs rank 3).
  if (typeof n !== 'string') return false
  if (n.endsWith('_log')) return true
  if (/_ore$/.test(n)) return true
  if (n === 'coal' || n === 'iron_ore' || n === 'diamond') return true
  return false
}

// Fetch kinds whose world source is logs (castlefetch gathers a load for
// all of these; stone digs, torch has no far path).
const WOOD_FETCH_KINDS = ['planks', 'door', 'fence', 'chest', 'frame']

// Bounded live scan for EXPOSED stone past DIG_RADIUS of the castle site
// (finding 1): resource memory never holds stone in prod (the arrival scan
// notes ores + logs only), so a remembered "stone" would send the fetcher
// to a tree. Rings sample 8 compass points each, nearest ring first, and
// the first probe with an accepted hit wins (ring early-exit: this runs
// only on watchdog fire, never per tick). Every hit is filtered through
// pickStone's own acceptance (R2 core-2: the site ground window, EXPOSE,
// !danger.near, canBreak — one shared predicate, so the table never
// offers a block the leg would refuse), across ALL hits before taking the
// nearest (R2 body-3: findBlocks is nearest-first, so a small count sees
// only the buried layer). Returns { x, y, z, name, dist } or null.
function liveStonePast(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return null
    const reg = bot && bot.registry && bot.registry.blocksByName
    const e = reg && reg.stone
    if (!e || typeof e.id !== 'number' || typeof bot.findBlocks !== 'function') return null
    const Vec3 = require('vec3')
    const fetch = require('./behaviours/castlefetch')
    const accept = fetch && fetch.acceptStone
    const COUNT = (fetch && fetch.FIND_COUNT) || 4096
    if (typeof accept !== 'function') return null
    const a = anchorOf(bot, ctx)
    const DIG = 32
    for (const r of [64, 128, 192]) {
      for (let k = 0; k < 8; k++) {
        const x = Math.round(st.site.x + r * Math.sin((k * Math.PI) / 4))
        const z = Math.round(st.site.z - r * Math.cos((k * Math.PI) / 4))
        let hits = []
        try {
          hits = bot.findBlocks({ point: new Vec3(x, st.site.y, z), matching: e.id, maxDistance: 24, count: COUNT }) || []
        } catch (_) {
          hits = []
        }
        let best = null
        for (const p of hits) {
          if (!p || typeof p.x !== 'number') continue
          const dSite = Math.hypot(p.x - st.site.x, p.z - st.site.z)
          if (dSite <= DIG) continue
          if (a && typeof a.x === 'number' && Math.hypot(p.x - a.x, p.z - a.z) > OUTER_DISK) continue
          if (!accept(bot, ctx, p, st.site.y)) continue
          const dProbe = Math.hypot(p.x - x, p.y - st.site.y, p.z - z)
          if (!best || dProbe < best.dProbe) best = { x: p.x, y: p.y, z: p.z, name: 'stone', dist: dSite, dProbe }
        }
        if (best) return { x: best.x, y: best.y, z: best.z, name: best.name, dist: best.dist }
      }
    }
    return null
  } catch (_) {
    return null
  }
}

// Far-fetch candidate past DIG_RADIUS of the SITE (castlefetch-far), within
// the outer disk of the anchor — matched to the CURRENT demand (finding
// 1): stone demand gets live exposed stone only (memory never holds stone
// in prod); wood demand gets remembered logs (the scan writes logs); any
// other demand gets nothing. Returns { candidate, why } — why names the
// miss for the skip log.
function castleFarCandidate(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return { candidate: null, why: 'no castle site' }
    const cw = ctx && ctx.castleWord
    const demand = cw && cw.kind
    if (demand === 'stone') {
      const hit = liveStonePast(bot, ctx)
      return hit ? { candidate: hit, why: null } : { candidate: null, why: 'no exposed stone past 32' }
    }
    if (!demand || WOOD_FETCH_KINDS.indexOf(demand) === -1) {
      return { candidate: null, why: demand ? `no far path for ${demand}` : 'no castle demand' }
    }
    const DIG = 32
    const a = anchorOf(bot, ctx)
    const mem = ctx && ctx.resources
    if (!mem || !(mem.items instanceof Map)) return { candidate: null, why: 'no remembered logs past 32' }
    let best = null
    let bestD = Infinity
    for (const it of mem.items.values()) {
      if (!it || typeof it.x !== 'number') continue
      if (!isLogName(it.name)) continue
      const dSite = Math.hypot(it.x - st.site.x, it.z - st.site.z)
      if (dSite <= DIG) continue
      if (a && typeof a.x === 'number') {
        const dA = Math.hypot(it.x - a.x, it.z - a.z)
        if (dA > OUTER_DISK) continue
      }
      if (dSite < bestD) {
        bestD = dSite
        best = { x: it.x, y: it.y, z: it.z, name: it.name, dist: dSite }
      }
    }
    return best ? { candidate: best, why: null } : { candidate: null, why: 'no remembered logs past 32' }
  } catch (_) {
    return { candidate: null, why: 'candidate unreadable' }
  }
}

function packFull(bot, ctx) {
  try {
    return !!require('./goal').packFull(bot, ctx)
  } catch (_) {
    return false
  }
}

function registered(name) {
  try {
    const table = require('./behaviours/index').BEHAVIOURS
    return !!table && typeof table[name] === 'function'
  } catch (_) {
    return false
  }
}

// Feasibility under a would-be unlock (finding 3): temporarily arm the
// window, probe MENU feasibility, restore. No state mutated. A pin
// decide() would refuse is never offered, so a chosen round can't burn
// on an infeasible step.
function probeFeasible(bot, ctx, step, unlock) {
  try {
    const goal = require('./goal')
    const facts = goal.goalFacts(bot, ctx)
    const g = ctx && ctx.goal
    if (!g) return !!(goal.MENU[step] && goal.MENU[step].feasible(facts, bot, ctx))
    const saved = g.commit
    const fakeUntil = Date.now() + 60000
    g.commit = { goalId: g.id, generation: g.generation, step, until: fakeUntil, unlock: unlock || null }
    try {
      return !!(goal.MENU[step] && goal.MENU[step].feasible(facts, bot, ctx))
    } finally {
      if (saved === undefined) delete g.commit
      else g.commit = saved
    }
  } catch (_) {
    return false
  }
}

// Expected goal effect per plain step (idkcraft-vmzq.28): the watchdog
// criterion names what the step does FOR THE GOAL METRIC, not just its
// trigger — R3 showed JEV picking gather (trigger match) over craft (the
// chain bottleneck) because craft never said it unblocks the castle.
// Kept out of STEP_CRITERIA so the tick path keeps its exact words.
const STEP_EFFECT = {
  castle: {
    castle: ' (+castle laid, the goal metric)',
    castlefetch: ' (+castle material)',
    gocastle: ' (+castle return: walk back to the site so laying can resume)',
    craft: ' (+castle chain: table unblocks pickaxe for stone)',
    equip: ' (+castle chain: pickaxe unblocks stone digging)',
    gather: ' (+castle chain when logs short)',
    build: ' (no +castle now)',
    beds: ' (no +castle now)',
    light: ' (no +castle now)',
    deliver: ' (no +castle now)',
    stockpile: ' (no +castle now)',
    gear: ' (no +castle now)',
    forage: ' (unlikely +castle now)',
    explore: ' (unlikely +castle now)',
    gohome: ' (night safety, no +castle now)',
    shelter: ' (night safety, no +castle now)',
    stay: ' (night safety, no +castle now)',
  },
  house: {
    build: ' (+home built, the goal metric)',
    beds: ' (+home bedroom)',
    gather: ' (+home chain when logs short)',
    craft: ' (+home chain: table/door/planks)',
    equip: ' (+home chain: tools/blocks)',
    light: ' (+home lighting)',
    castle: ' (castle work, no +home now)',
    castlefetch: ' (castle work, no +home now)',
    deliver: ' (no +home now)',
    stockpile: ' (no +home now)',
    gear: ' (no +home now)',
    forage: ' (unlikely +home now)',
    explore: ' (unlikely +home now)',
    gohome: ' (night safety, no +home now)',
    shelter: ' (night safety, no +home now)',
    stay: ' (night safety, no +home now)',
  },
}

// Plain-step menu for work goals (the .21 watchdogMenu): feasible +
// registered, failHolds ignored, rest excluded, current step included as
// a bounded hold. Returns [{ id, step, criterion }].
function plainSteps(bot, ctx, kind = null) {
  const goal = require('./goal')
  const facts = goal.goalFacts(bot, ctx)
  const steps = goal.STEP_ORDER.filter((n) => {
    if (n === 'rest') return false
    try {
      return !!(goal.MENU[n] && goal.MENU[n].feasible(facts, bot, ctx) && registered(n))
    } catch (_) {
      return false
    }
  })
  const eff = (kind && STEP_EFFECT[kind]) || {}
  return steps.map((n) => {
    let criterion = goal.STEP_CRITERIA[n] || n
    if (eff[n]) criterion += eff[n]
    // Held steps ride as retry with their failure named (bead FIX 2).
    try {
      const sf = ctx && ctx.stepFail && ctx.stepFail[n]
      if (sf && failReason(sf.status) !== null) {
        const reason = failReason(sf.status) || 'unknown'
        criterion = `${criterion} — retry now although it failed (${reason})`
      }
    } catch (_) { /* plain criterion */ }
    return { id: n, step: n, unlock: null, criterion }
  })
}

// Full option list for a goal kind. `logSkip` collects unavailable reasons
// (the caller logs them). Returns [{ id, step, unlock, criterion }].
function goalOptions(bot, ctx, kind, logSkip = null) {
  const out = []
  const skip = (id, why) => {
    try {
      if (Array.isArray(logSkip)) logSkip.push({ id, why })
    } catch (_) { /* skip best-effort */ }
  }
  const isOrder = kind === 'bring' || kind === 'comehome' || kind === 'gocastle' || kind === 'lead' || kind === 'flat'
  const isWork = kind === 'castle' || kind === 'house'

  if (isWork) {
    for (const p of plainSteps(bot, ctx, kind)) out.push(p)
  } else if (isOrder) {
    // Hold the current order leg (the run-4 answer for orders).
    const holdText = {
      bring: 'keep working the bring order',
      comehome: 'keep walking home',
      gocastle: 'keep walking to the castle',
      lead: 'keep leading to the find',
      flat: 'keep flattening',
    }[kind] || `keep working ${kind}`
    out.push({ id: `hold-${kind}`, step: null, orderKind: kind, unlock: null, criterion: holdText })
  }

  // explore-far: the spiral cap to the outer disk. Work goals probe step
  // feasibility under the unlock (finding 3); bring offers it only to
  // capped self hunts (finding 8 — owner legs are already uncapped, so
  // the unlock would be a no-op alias).
  if (isWork || kind === 'bring') {
    const bringOrder = kind === 'bring' ? ctx && ctx.bring : null
    if (!registered('explore')) {
      skip('explore-far', 'explore off')
    } else if (!anchorOf(bot, ctx)) {
      skip('explore-far', 'no anchor')
    } else if (kind === 'bring' && !(bringOrder && bringOrder.self)) {
      skip('explore-far', 'owner bring already uncapped')
    } else if (isWork && !probeFeasible(bot, ctx, 'explore', { radius: OUTER_DISK })) {
      skip('explore-far', 'explore not feasible')
    } else {
      const eff = kind === 'castle' ? ' (may find the blocked material)' : kind === 'house' ? ' (may find wood)' : ''
      out.push({
        id: 'explore-far', step: isWork ? 'explore' : null, orderKind: isWork ? null : kind,
        unlock: { radius: OUTER_DISK },
        criterion: `search beyond the task radius up to 256 blocks${eff}; costs a long walk and a night out`,
      })
    }
  }

  // gather-far: a remembered tree past the task radius — for bring, the
  // tree must match the ordered item (findings 7, 8), else the criterion
  // promises a walk the executor never takes.
  if (isWork || kind === 'bring') {
    const TASK_R = 64
    try {
      const ex = require('./behaviours/explore')
      void ex
    } catch (_) { /* radius stays 64 */ }
    const bringOrder = kind === 'bring' ? ctx && ctx.bring : null
    let matchNames = null
    if (kind === 'bring' && bringOrder && bringOrder.self) {
      try {
        matchNames = require('./behaviours/bring').memoryNames(bot, bringOrder.name || bringOrder.drop) || []
      } catch (_) {
        matchNames = []
      }
    }
    const cand = kind === 'bring'
      ? (matchNames && matchNames.length > 0 ? rememberedPast(bot, ctx, TASK_R, (n) => matchNames.indexOf(n) !== -1) : null)
      : rememberedPast(bot, ctx, TASK_R, isLogName)
    if (isWork && !registered('gather')) {
      skip('gather-far', 'gather off')
    } else if (kind === 'bring' && !(bringOrder && bringOrder.self)) {
      skip('gather-far', 'owner bring already uncapped')
    } else if (kind === 'bring' && (!matchNames || matchNames.length === 0)) {
      skip('gather-far', 'bring item has no memory names')
    } else if (!cand) {
      skip('gather-far', kind === 'bring' ? 'no remembered matching find past 64' : 'no remembered tree past 64')
    } else if (isWork && !probeFeasible(bot, ctx, 'gather', { radius: OUTER_DISK })) {
      skip('gather-far', 'gather not feasible')
    } else {
      const eff = kind === 'castle' ? ' (+castle wood when wood short)' : kind === 'house' ? ' (+home wood)' : kind === 'bring' ? ' (+have when brought back)' : ''
      out.push({
        id: 'gather-far', step: isWork ? 'gather' : null, orderKind: isWork ? null : kind,
        unlock: { radius: OUTER_DISK },
        criterion: `walk to the remembered ${cand.name} ${Math.round(cand.dist)} blocks out${eff}; costs a long walk and a night out`,
      })
    }
  }

  // forage-far: a remembered find past the park/task radius.
  if (isWork) {
    const cand = rememberedPast(bot, ctx, 64, isForageName)
    if (!registered('forage')) {
      skip('forage-far', 'forage off')
    } else if (!cand) {
      skip('forage-far', 'no remembered find past 64')
    } else if (!probeFeasible(bot, ctx, 'forage', { radius: OUTER_DISK })) {
      skip('forage-far', 'forage not feasible')
    } else {
      const eff = kind === 'castle'
        ? (isLogName(cand.name) ? ' (+castle wood when wood short)' : ' (unlikely +castle now)')
        : kind === 'house' ? (isLogName(cand.name) ? ' (+home wood)' : ' (unlikely +home now)') : ''
      out.push({
        id: 'forage-far', step: 'forage', unlock: { radius: OUTER_DISK },
        criterion: `dig the remembered ${cand.name} ${Math.round(cand.dist)} blocks out${eff}; costs a long walk and a night out`,
      })
    }
  }

  // castlefetch-far: ONLY with a demand-matched candidate past DIG_RADIUS
  // (finding 1) — live exposed stone for stone demand, remembered logs
  // for wood demand. Stone needs the pickaxe like the local leg
  // (vmzq.28: R3 offered far stone to a pickless bot — the leg ends done
  // at once, so the offer is a promise the executor cannot keep).
  if (kind === 'castle') {
    const found = castleFarCandidate(bot, ctx)
    const cand = found && found.candidate
    let demand = null
    try {
      demand = ctx && ctx.castleWord && ctx.castleWord.kind
    } catch (_) { /* demand best-effort */ }
    let hasPick = true
    try {
      const facts = require('./goal').goalFacts(bot, ctx)
      hasPick = ((facts && facts.pickaxe) || 0) > 0
    } catch (_) { /* readable pickaxe */ }
    if (!registered('castlefetch')) {
      skip('castlefetch-far', 'castlefetch off')
    } else if (!cand) {
      skip('castlefetch-far', (found && found.why) || 'no far candidate')
    } else if (demand === 'stone' && !hasPick) {
      skip('castlefetch-far', 'no pickaxe for stone')
    } else {
      out.push({
        id: 'castlefetch-far', step: 'castlefetch', unlock: { radius: OUTER_DISK, candidate: { x: cand.x, y: cand.y, z: cand.z } },
        criterion: `fetch the blocked ${cand.name} from ${Math.round(cand.dist)} blocks out (+castle material, unblocks laying); costs a long walk and a night out`,
      })
    }
  }

  // house-build / house-beds: ONE house step with castleFirst lifted.
  if (kind === 'castle') {
    for (const hs of ['build', 'beds']) {
      if (!registered(hs)) {
        skip(`house-${hs}`, `${hs} off`)
        continue
      }
      if (!castleFirst(ctx)) {
        skip(`house-${hs}`, 'no castle-first veto')
        continue
      }
      // Otherwise-feasible: the veto is the only block.
      if (!probeFeasible(bot, ctx, hs, { houseStep: hs })) {
        skip(`house-${hs}`, `${hs} not feasible even unlocked`)
        continue
      }
      out.push({
        id: `house-${hs}`, step: hs, unlock: { houseStep: hs },
        criterion: `work on the house ${hs} instead (castle-first veto lifted for this step only); costs the castle a day (no +castle now)`,
      })
    }
  }

  // bank: stockpile when the pack is full.
  if (isWork) {
    if (!registered('stockpile')) {
      skip('bank', 'stockpile off')
    } else if (!packFull(bot, ctx)) {
      skip('bank', 'pack not full')
    } else {
      const eff = kind === 'castle' ? ' (+castle chain: frees room for the batch)' : kind === 'house' ? ' (+home chain: frees room)' : ''
      out.push({
        id: 'bank', step: 'stockpile', unlock: null,
        criterion: `bank the full pack at home before fetching more${eff}`,
      })
    }
  }

  // park: always offered (the deterministic out).
  out.push({ id: 'park', step: null, unlock: null, criterion: PLAN_PARK_CRITERION })

  // ask-owner: only when online (owner notes).
  if (!ownerOnline(bot)) {
    skip('ask-owner', 'nobody online')
  } else {
    out.push({
      id: 'ask-owner', step: null, unlock: null,
      criterion: 'tell the owner what blocks and wait for them',
    })
  }

  return out
}

// Trailing flat/failed summary from the watchdog history ring
// (idkcraft-vmzq.28): R3 showed JEV re-picking gather at conf 0.29 after
// two flat gathers — the history rode the request but the model ignored
// it. Naming it in the instructions flips R3 to craft at 0.9. Returns
// e.g. 'gather flat 2 rounds' or 'castlefetch failed no-stone', else null.
function flatSummary(ctx, kind) {
  try {
    const st = ctx && ctx.task && ctx.task[kind]
    const hist = st && st.wd && Array.isArray(st.wd.history) ? st.wd.history : []
    if (hist.length === 0) return null
    const last = hist[hist.length - 1]
    if (!last || typeof last.choice !== 'string') return null
    const isFlat = (o) => o === 'flat' || failReason(o) !== null
    if (!isFlat(last.outcome)) return null
    let n = 1
    for (let i = hist.length - 2; i >= 0; i--) {
      const h = hist[i]
      if (!h || h.choice !== last.choice || !isFlat(h.outcome)) break
      n++
    }
    if (last.outcome === 'flat') return `${last.choice} flat ${n} round${n > 1 ? 's' : ''}`
    let reason = String(failReason(last.outcome) || 'unknown')
    const prefix = `${last.choice}-`
    if (reason.startsWith(prefix)) reason = reason.slice(prefix.length)
    return n > 1 ? `${last.choice} failed ${reason} ${n} rounds` : `${last.choice} failed ${reason}`
  } catch (_) {
    return null
  }
}

// Instructions per goal kind (castle/house keep the .21 words verbatim on
// the first stall — the summary rides only once history names a flat).
function planInstructions(kind, ctx, done, total) {
  const summary = flatSummary(ctx, kind)
  if (kind === 'castle' || kind === 'house') {
    if (!summary) return PLAN_INSTRUCTIONS
    return `The goal is stalled: ${summary}. Pick the step most likely to move its progress metric now; avoid repeating flat steps; park only if no step can help`
  }
  try {
    let base = null
    if (kind === 'bring') {
      const o = ctx && ctx.bring
      const want = o && typeof o.want === 'number' ? o.want : '?'
      const name = (o && (o.name || o.drop)) || 'items'
      const by = (o && o.by) || 'owner'
      const have = typeof done === 'number' ? done : '?'
      base = `Goal: bring ${want} ${name} to ${by}; have ${have}/${want}. Pick the option most likely to move have now; park only if no option can help`
    } else if (kind === 'comehome') {
      base = `Goal: come home; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    } else if (kind === 'gocastle') {
      base = `Goal: go to the castle; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    } else if (kind === 'lead') {
      const o = ctx && ctx.lead
      const name = (o && o.name) || 'the find'
      base = `Goal: lead to ${name}; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    } else if (kind === 'flat') {
      base = `Goal: flatten ${done}/${total} cells levelled. Pick the option most likely to level more now; park only if no option can help`
    }
    if (base) {
      if (!summary) return base
      return base
        .replace('. Pick the option', `. ${summary}. Pick the option`)
        .replace('; park only', '; avoid repeating flat options; park only')
    }
  } catch (_) { /* fall through to the generic */ }
  return PLAN_INSTRUCTIONS
}

module.exports = { goalOptions, planInstructions, flatSummary, rememberedPast, castleFarCandidate, ownerOnline }
