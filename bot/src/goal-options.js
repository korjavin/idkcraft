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

// Stone/log candidate past DIG_RADIUS of the SITE (castlefetch-far), within
// the outer disk of the anchor. Reads memory/finds only — no world scan.
function castleFarCandidate(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return null
    const DIG = 32
    try {
      const cf = require('./behaviours/castlefetch')
      void cf
    } catch (_) { /* DIG stays 32 */ }
    const a = anchorOf(bot, ctx)
    const mem = ctx && ctx.resources
    if (!mem || !(mem.items instanceof Map)) return null
    let best = null
    let bestD = Infinity
    for (const it of mem.items.values()) {
      if (!it || typeof it.x !== 'number') continue
      if (!isStoneName(it.name) && !isLogName(it.name)) continue
      const dSite = Math.hypot(it.x - st.site.x, it.z - st.site.z)
      if (dSite <= DIG) continue
      if (a && typeof a.x === 'number') {
        const dA = Math.hypot(it.x - a.x, it.z - a.z)
        if (dA > OUTER_DISK) continue
      }
      const d = dSite
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

function packFull(bot, ctx) {
  try {
    return !!require('./goal').packFull(bot, ctx)
  } catch (_) {
    return false
  }
}

function registered(name) {
  try {
    const table = require('./index').BEHAVIOURS
    return !!table && typeof table[name] === 'function'
  } catch (_) {
    return false
  }
}

// Plain-step menu for work goals (the .21 watchdogMenu): feasible +
// registered, failHolds ignored, rest excluded, current step included as
// a bounded hold. Returns [{ id, step, criterion }].
function plainSteps(bot, ctx) {
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
  return steps.map((n) => {
    let criterion = goal.STEP_CRITERIA[n] || n
    // Held steps ride as retry with their failure named (bead FIX 2).
    try {
      const sf = ctx && ctx.stepFail && ctx.stepFail[n]
      if (sf && typeof sf.status === 'string' && sf.status.startsWith('failed:')) {
        const reason = sf.status.slice('failed:'.length) || 'unknown'
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
    for (const p of plainSteps(bot, ctx)) out.push(p)
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

  // explore-far: the spiral cap to the outer disk. Available when explore
  // is registered and an anchor exists (the cap binds only under taskActive,
  // but the option is harmless otherwise — the unlock is a no-op off-task).
  if (isWork || kind === 'bring') {
    if (!registered('explore')) {
      skip('explore-far', 'explore off')
    } else if (!anchorOf(bot, ctx)) {
      skip('explore-far', 'no anchor')
    } else {
      out.push({
        id: 'explore-far', step: isWork ? 'explore' : null, orderKind: isWork ? null : kind,
        unlock: { radius: OUTER_DISK },
        criterion: 'search beyond the task radius up to 256 blocks; costs a long walk and a night out',
      })
    }
  }

  // gather-far: a remembered tree past the task radius.
  if (isWork || kind === 'bring') {
    const TASK_R = 64
    try {
      const ex = require('./behaviours/explore')
      void ex
    } catch (_) { /* radius stays 64 */ }
    const cand = rememberedPast(bot, ctx, TASK_R, isLogName)
    if (!registered('gather') && isWork) {
      skip('gather-far', 'gather off')
    } else if (!cand) {
      skip('gather-far', 'no remembered tree past 64')
    } else {
      out.push({
        id: 'gather-far', step: isWork ? 'gather' : null, orderKind: isWork ? null : kind,
        unlock: { radius: OUTER_DISK },
        criterion: `walk to the remembered ${cand.name} ${Math.round(cand.dist)} blocks out; costs a long walk and a night out`,
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
    } else {
      out.push({
        id: 'forage-far', step: 'forage', unlock: { radius: OUTER_DISK },
        criterion: `dig the remembered ${cand.name} ${Math.round(cand.dist)} blocks out; costs a long walk and a night out`,
      })
    }
  }

  // castlefetch-far: ONLY with a known stone/log candidate past DIG_RADIUS.
  if (kind === 'castle') {
    const cand = castleFarCandidate(bot, ctx)
    if (!registered('castlefetch')) {
      skip('castlefetch-far', 'castlefetch off')
    } else if (!cand) {
      skip('castlefetch-far', 'no remembered stone past 32')
    } else {
      out.push({
        id: 'castlefetch-far', step: 'castlefetch', unlock: { radius: OUTER_DISK, candidate: { x: cand.x, y: cand.y, z: cand.z } },
        criterion: `fetch ${cand.name} ${Math.round(cand.dist)} blocks out; costs a long walk and a night out`,
      })
    }
  }

  // house-build / house-beds: ONE house step with castleFirst lifted.
  if (kind === 'castle') {
    const goal = require('./goal')
    for (const hs of ['build', 'beds']) {
      if (!registered(hs)) {
        skip(`house-${hs}`, `${hs} off`)
        continue
      }
      if (!castleFirst(ctx)) {
        skip(`house-${hs}`, 'no castle-first veto')
        continue
      }
      // Otherwise-feasible: the veto is the only block. Probe by calling
      // feasible with a temporary unlock (no state mutated).
      let feasible = false
      try {
        const facts = goal.goalFacts(bot, ctx)
        // Temporarily arm the unlock, probe, disarm. The helper reads the
        // live window, so stamp a fake one and restore.
        const g = ctx && ctx.goal
        const saved = g ? g.commit : undefined
        const fakeUntil = Date.now() + 60000
        if (g) g.commit = { goalId: g.id, generation: g.generation, step: hs, until: fakeUntil, unlock: { houseStep: hs } }
        try {
          feasible = !!(goal.MENU[hs] && goal.MENU[hs].feasible(facts, bot, ctx))
        } finally {
          if (g) {
            if (saved === undefined) delete g.commit
            else g.commit = saved
          }
        }
      } catch (_) {
        feasible = false
      }
      if (!feasible) {
        skip(`house-${hs}`, `${hs} not feasible even unlocked`)
        continue
      }
      out.push({
        id: `house-${hs}`, step: hs, unlock: { houseStep: hs },
        criterion: `work on the house ${hs} instead (castle-first veto lifted for this step only); costs the castle a day`,
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
      out.push({
        id: 'bank', step: 'stockpile', unlock: null,
        criterion: 'bank the full pack at home before fetching more',
      })
    }
  }

  // park: always offered (the deterministic out).
  try {
    const { PLAN_PARK_CRITERION } = require('./task')
    out.push({ id: 'park', step: null, unlock: null, criterion: PLAN_PARK_CRITERION })
  } catch (_) {
    out.push({ id: 'park', step: null, unlock: null, criterion: 'no step can move the goal now: stop the task and rest at home' })
  }

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

// Instructions per goal kind (castle/house keep the .21 words verbatim).
function planInstructions(kind, ctx, done, total) {
  const { PLAN_INSTRUCTIONS } = require('./task')
  if (kind === 'castle' || kind === 'house') return PLAN_INSTRUCTIONS
  try {
    if (kind === 'bring') {
      const o = ctx && ctx.bring
      const want = o && typeof o.want === 'number' ? o.want : '?'
      const name = (o && (o.name || o.drop)) || 'items'
      const by = (o && o.by) || 'owner'
      const have = typeof done === 'number' ? done : '?'
      return `Goal: bring ${want} ${name} to ${by}; have ${have}/${want}. Pick the option most likely to move have now; park only if no option can help`
    }
    if (kind === 'comehome') return `Goal: come home; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    if (kind === 'gocastle') return `Goal: go to the castle; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    if (kind === 'lead') {
      const o = ctx && ctx.lead
      const name = (o && o.name) || 'the find'
      return `Goal: lead to ${name}; ${done}/${total} blocks left. Pick the option most likely to arrive now; park only if no option can help`
    }
    if (kind === 'flat') return `Goal: flatten ${done}/${total} cells levelled. Pick the option most likely to level more now; park only if no option can help`
  } catch (_) { /* fall through to the generic */ }
  return PLAN_INSTRUCTIONS
}

module.exports = { goalOptions, planInstructions, rememberedPast, castleFarCandidate, ownerOnline }
