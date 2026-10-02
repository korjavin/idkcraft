'use strict'

// Player chat + far-search handover (idkcraft-6x7.1): mechanically moved from
// index.js — handleChat, the pending-search slicer, block-order/find answers.
const { stubBrain, hybridBrain, jevBrain, JEV_ENDPOINT, brainTimeoutMs, layaUrl, LAYA_URL_DEFAULT } = require('./brain')
const { resolvePlayer } = require('./perception')
const { findNearest, loadedSearchRadius, startFarSearch, stepFarSearch } = require('./behaviours/scout')
const { helpReply, lookupCommand, detailLine } = require('./commands')
const goal = require('./goal')
const bringMod = require('./behaviours/bring')
const flatMod = require('./behaviours/flat')
const homeMod = require('./behaviours/home')
const { denyReason } = require('./behaviours/util')
const blueprint = require('./castle')
const castleMod = require('./behaviours/castle')
const Vec3 = require('vec3')

// Targets declined as too deep, held per player for an explicit 'lead
// anyway'. Overwritten by the next deep decline, cleared on use.
const deepOffers = new Map()
// A target more than this far below the requesting player is announced, not
// led to: walking the player down to buried ore is how prod fell to death.
const DEEP_WARN_DROP = 8

// Wet-commit guard (revmux 02 core-1): the same 'submerged' predicate the
// bring loop applies — the ore cell itself for exposed targets, the dig
// column for buried ones. Unknown cells read dry (proof rule).
function resSubmerged(bot, ctx, res) {
  try {
    const rp = res && res.position
    if (!rp || typeof rp.x !== 'number') return false
    const blk = bot.blockAt && bot.blockAt(rp)
    if (blk && denyReason(bot, blk, ctx) === 'submerged') return true
    if (res.exposed === false) {
      const bp = bot.entity && bot.entity.position
      if (!bp || typeof bp.x !== 'number') return false
      const cand = bringMod.buriedCand(bp, res, bot)
      return !!cand && !!cand.wet
    }
    return false
  } catch (_) { return false }
}

// Shared block-order creation (amb): sync setBring and far-search
// completion build the same order and announce the honest distance.
function startBlockOrder(bot, ctx, { name, want, by }, res) {
  if (!bringMod.isBringable(res.name)) return `can't bring ${res.name} — ores and logs only`
  if (bringMod.needsPickaxe(res.name) && !bringMod.hasPickaxe(bot, res.name)) {
    return bringMod.tierRefusal(bot, res.name)
  }
  // The chat-time commit bypassed the bring-loop submerged skips — a wet
  // nearest vein committed phase 'walk' and the bot dived before any skip
  // ran. A wet res opens in 'find' instead so the loop picks the next
  // candidate (or refuses honestly when nothing dry exists). The wet cell
  // is pre-seeded into o.skip (revmux 03 core-1/body-1): the find
  // pre-check only sees water at the cell or +1, so a buried vein under a
  // water column — or a grafted far-cache hit — would otherwise re-commit
  // to the same wet cell one tick later. sawSubmerged fronts the honest
  // refusal when the seeded skip empties the find.
  if (resSubmerged(bot, ctx, res)) {
    homeMod.releaseMeet(bot, ctx)
    if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
    ctx.unseenTicks = 0
    ctx.resumeWork = false
    ctx.bring = {
      kind: 'block', name, want, by, phase: 'find', have: 0, announced: false,
      skip: new Set([bringMod.skipKey(res.position)]), sawSubmerged: true,
    }
    ctx.paused = false
    return `nearest ${res.name} is underwater, checking for a dry one…`
  }
  homeMod.releaseMeet(bot, ctx) // inside: the exit legs run before the fetch walk (jr2.3)
  if (ctx.lead) { ctx.lead = null; ctx.leadTargetGone = 0 }
  // A fresh explicit order restarts homing math (a tripped counter would
  // starve the order) and supersedes a pending spawn work-resume (which
  // would otherwise cancel the order on the next sighted tick).
  ctx.unseenTicks = 0
  ctx.resumeWork = false
  ctx.bring = {
    kind: 'block', name, want, by, block: res.name, drop: bringMod.dropFor(res.name),
    pos: res.position, phase: 'walk', stalls: 0, lastPos: null,
    have: 0, announced: true, exposed: res.exposed !== false,
  }
  if (res.far === true) ctx.bring.far = true // memory target: unloaded is not gone
  ctx.paused = false
  return bringMod.goingForLine(want, res)
}

// Shared found-answer (amb): sync find-me and far-search completion lead to
// the hit or warn about depth the same way.
function answerFound(bot, ticker, playerName, refY, res) {
  const down = refY != null ? Math.round(refY - res.position.y) : 0
  if (down > DEEP_WARN_DROP) {
    bot.chat(`${res.name} is ${down} blocks down, dig carefully`)
    deepOffers.set(playerName, { name: res.name, pos: res.position, distance: res.distance })
  } else {
    bot.chat(`leading you to ${res.name}, ${res.distance} blocks, follow me`)
    if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: res.name, pos: res.position, by: playerName, lastProgressAt: Date.now() })
  }
}

// One pending far search (amb), advanced once per tick: the 96/160 shells
// sliced to the per-tick CPU budget. Completion chats the answer (find) or
// opens the order (bring); a newer request replaces a stale one. Slices
// pause while hostiles are near (last tick's snapshot): search must not
// stall the fight reflexes. A negative names the cursor's own edge — the
// radius actually scanned, not a re-probe that may have drifted.
async function advancePendingSearch(bot, ticker, ctx) {
  const p = ctx && ctx.pendingSearch
  if (!p || p.deciding) return
  if (ctx.lastHostileSnap && ctx.lastHostileSnap.count > 0) return
  if (p.kind === 'castle') { advanceCastleSearch(bot, ctx, p); return }
  // Bring shells carry the walk gate (atl.22), the searchfar twin's predicate.
  const r = stepFarSearch(bot, p.cursor, p.kind === 'bring'
    ? { gate: (q) => bringMod.descentGated(bot.entity && bot.entity.position, q) }
    : undefined)
  if (!r.done) return
  ctx.pendingSearch = null
  if (r.result === 'unknown') {
    bot.chat(`unknown block: ${p.name}`)
    return
  }
  const edge = (r && typeof r.edge === 'number') ? r.edge : loadedSearchRadius(bot)
  if (p.kind === 'bring') {
    const bp0 = bot.entity && bot.entity.position
    if (bp0) {
      // Shells done (atl.15): the verdict weighs live exposed (a) against
      // memory (b) and the dig (c) — the stashed 48 hit when creation saw
      // buried ore, else the far hit itself. Contested asks the model once
      // (the tick awaits this); the cache rides onto the new order. The
      // cursor ran in exposed mode (atl.19), so (c) rides r.buried (the
      // second pass over the same hits).
      const stash = p.buried && p.buried.position ? p.buried : null
      const far = r.result && r.result.exposed !== false ? bringMod.liveExposed(bp0, r.result, bot) : null
      const farBuried = r.result && r.result.exposed === false ? r.result : (r.buried || null)
      // A gated stash falls back to the far shaft (chv): buriedCand returns
      // null past the gate, and the stash merely existing must not hide a
      // diggable far hit (the searchfar twin already falls back this way).
      const buried = (stash && bringMod.buriedCand(bp0, stash, bot)) || (farBuried ? bringMod.buriedCand(bp0, farBuried, bot) : null)
      let mem = null
      try { mem = bringMod.memoryExposed(bot, ctx, bp0, p.name, null) } catch (_) { mem = null }
      const exposed = bringMod.bestExposed(far, bringMod.memoryInBudget(mem, buried))
      if (!exposed && !buried) {
        // atl.8: open the order instead of refusing — the first tick walks
        // search legs (the far shells just came up empty, skip the re-scan).
        if (!bringMod.canBringName(bot, p.name)) {
          bot.chat(`can't bring ${p.name} — ores and logs only`)
          return
        }
        homeMod.releaseMeet(bot, ctx)
        // A shaft the gate dropped (chv) rides along for the honest refusal:
        // the stashed 48 hit when creation saw buried ore, else the far hit,
        // else a gated deep hike (atl.22).
        const gated = stash || farBuried || r.gated
        ctx.bring = {
          kind: 'block', name: p.name, want: p.want, by: p.by, phase: bringMod.openPhase(ctx),
          have: 0, announced: false, searchSkipFar: true,
          deepVein: gated ? bringMod.deepVeinOf(bp0, gated) : undefined,
        }
        try {
          ctx.bring.farCache = { x: bp0.x, y: bp0.y, z: bp0.z, edge, hit: null, buriedHit: null }
        } catch (_) { /* cache best-effort */ }
        // The handover takes the body (jr2.2): a stale stay must not
        // survive, and a body asleep from the pending wait must wake.
        ctx.step = null
        ctx.stepStatus = null
        ctx.gohome = null
        ctx.stay = null
        ctx.shelter = null
        ctx.inShelter = false
        wakeBody(bot)
        ctx.paused = false
        return
      }
      // The ask suspends: re-arm the pending token across the await so a
      // mid-ask retire (stop/death/newer order) aborts the commit below.
      // Non-contested verdicts never suspend (no brain call to await).
      const d0 = bringMod.decideBringSource(exposed, buried)
      let c
      const cache = {}
      if (!d0.contested) {
        c = { action: d0.pick === 'buried' ? 'dig_buried' : 'walk_exposed' }
      } else {
        ctx.pendingSearch = p
        p.deciding = true
        try {
          c = await bringMod.chooseBringSource(ctx && ctx.brain, bringMod.sourceText(p, exposed, buried), exposed, buried, cache)
        } finally {
          p.deciding = false
        }
        if (!ctx || ctx.pendingSearch !== p) return // retired mid-ask: touch nothing
        ctx.pendingSearch = null
      }
      if (ticker && typeof ticker.clearStuck === 'function') ticker.clearStuck()
      // Bring owns the body now: end any night step at once (module scope has
      // no resetNightStep, so inline it). canDig is the body's (body.js):
      // clearing the walk above ends the borrow; the lease re-applies it.
      ctx.step = null
      ctx.stepStatus = null
      ctx.gohome = null
      ctx.stay = null
      ctx.shelter = null
      ctx.inShelter = false
      wakeBody(bot) // jr2.2: an order takes the body even at night
      const pick = c.action === 'dig_buried' ? 'buried' : 'exposed'
      const win = pick === 'buried' ? buried : exposed
      const rival = pick === 'buried' ? exposed : buried
      console.log(bringMod.verdictLine(p.name, exposed, buried, pick))
      // A refusal (tier/unbringable) leaves a surviving older order in
      // place: attach the verdict only to an order this commit created
      // (revmux 02 core-1), never graft it onto the old one.
      const prev = ctx.bring
      bot.chat(startBlockOrder(bot, ctx, p, bringMod.choiceRes(win, rival, bp0)))
      if (ctx.bring && ctx.bring !== prev) {
        ctx.bring.verdict = bringMod.verdictFacts(exposed, buried, pick)
        if (cache.sourceAsked) { ctx.bring.sourceAsked = true; ctx.bring.sourcePick = cache.sourcePick }
        try {
          ctx.bring.farCache = {
            x: bp0.x, y: bp0.y, z: bp0.z, edge, hit: far,
            buriedHit: farBuried ? bringMod.buriedCand(bp0, farBuried, bot) : null,
          }
        } catch (_) { /* cache best-effort */ }
      }
      return
    }
    if (!r.result) {
      // atl.8: open the order instead of refusing — the first tick walks
      // search legs (the far shells just came up empty, skip the re-scan).
      if (!bringMod.canBringName(bot, p.name)) {
        bot.chat(`can't bring ${p.name} — ores and logs only`)
        return
      }
      homeMod.releaseMeet(bot, ctx)
      ctx.bring = {
        kind: 'block', name: p.name, want: p.want, by: p.by, phase: bringMod.openPhase(ctx),
        have: 0, announced: false, searchSkipFar: true,
      }
      // The handover takes the body (revmux 02-review): same inline reset as
      // the found branch — a stale stay must not survive, and a body asleep
      // from the pending wait must wake.
      ctx.step = null
      ctx.stepStatus = null
      ctx.gohome = null
      ctx.stay = null
      ctx.shelter = null
      ctx.inShelter = false
      wakeBody(bot)
      ctx.paused = false
      return
    }
    if (ticker && typeof ticker.clearStuck === 'function') ticker.clearStuck()
    // Bring owns the body now: end any night step at once (module scope has
    // no resetNightStep, so inline it). canDig is the body's (body.js):
    // clearing the walk above ends the borrow; the lease re-applies it.
    ctx.step = null
    ctx.stepStatus = null
    ctx.gohome = null
    ctx.stay = null
    ctx.shelter = null
    ctx.inShelter = false
    wakeBody(bot) // jr2.2: an order takes the body even at night
    bot.chat(startBlockOrder(bot, ctx, p, r.result))
    return
  }
  if (!r.result) {
    bot.chat(`no ${p.name} within ${edge} blocks (loaded area)`)
    return
  }
  answerFound(bot, ticker, p.by, p.refY, r.result)
}

// A pending far search belongs to the order or question that started it:
// any mode change or death retires it, so a late completion can never
// override stop, follow, work, or a newer order.
function clearPendingSearch(ctx) {
  if (ctx) ctx.pendingSearch = null
}

function handleChat(bot, ticker, username, message, senderUuid) {
  if (username === bot.username) return
  const playerName = resolvePlayer(bot, username, senderUuid)
  const msg = message.toLowerCase().trim()
  if (msg === 'follow me') {
    if (ticker) ticker.setFollow(playerName)
    const seen = bot.players && bot.players[playerName] && bot.players[playerName].entity
    if (seen) {
      bot.chat(`Following ${playerName}`)
    } else {
      // Honest: the server sends no coordinates for an out-of-range player
      // and the bot is not OP, so it cannot walk there — say where it is.
      const bp = bot.entity && bot.entity.position
      const at = bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
      const sp = bot.spawnPoint
      const dist = bp && sp ? ` (~${Math.round(Math.hypot(bp.x - sp.x, bp.y - sp.y, bp.z - sp.z))} blocks from spawn)` : ''
      bot.chat(`I can't see you — I'm at ${at}${dist}; come closer or /tp ${bot.username} ${playerName}`)
    }
  } else if (msg === 'stop') {
    if (ticker) {
      ticker.setFollow('')
      ticker.stop()
    }
  } else if (msg === 'lead anyway') {
    const offer = deepOffers.get(playerName)
    deepOffers.delete(playerName)
    if (offer) {
      bot.chat(`leading you to ${offer.name}, ${offer.distance} blocks, follow me`)
      if (ticker && typeof ticker.setLead === 'function') ticker.setLead({ name: offer.name, pos: offer.pos, by: playerName, lastProgressAt: Date.now() })
    } else {
      bot.chat('no deep find on hold — ask me to find something first')
    }
  } else if (msg === 'go work' || msg === 'free') {
    if (ticker) ticker.work()
    bot.chat(`on my own; say 'follow me' to call me`)
  } else if (msg === 'come home') {
    if (ticker && typeof ticker.setComehome === 'function') bot.chat(ticker.setComehome({ by: playerName }))
  } else if (msg === 'build here') {
    const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
    const pos = speaker && speaker.position
    // b2o: out of tracking range is an answer, not silence — the server
    // sends no coordinates and the bot cannot walk there.
    if (!pos || typeof pos.x !== 'number') {
      bot.chat("I can't see you, come closer")
      return
    }
    // rpw: always a new site, even over a built home — the owner asked.
    // The new home becomes current (gohome/night go there); old walls stay
    // protected by build.js guardOwnWalls (block-type based, not site).
    // b2o: then the same transition as 'go work' — follow drops the body
    // and the goal loop starts building instead of trailing the owner.
    const site = goal.siteFor(bot, pos)
    if (ticker && typeof ticker.setHome === 'function') ticker.setHome(site, { fresh: true })
    if (ticker) ticker.work()
    const st = (site && site.site) || {}
    bot.chat(`building a home at ${st.x} ${st.y} ${st.z}`)
  } else if (msg === 'build castle' || msg === 'castle' || msg.startsWith('castle ')) {
    const reply = castleChat(bot, ticker, playerName, msg)
    if (reply) bot.chat(reply)
  } else if (msg === 'status') {
    if (ticker && typeof ticker.status === 'function') ticker.status()
  } else if (msg === 'brain' || msg.startsWith('brain ')) {
    // Brain switch (d75): with a follow target only they may switch; with
    // nobody followed (work mode) any roster player may. Others get silence
    // and the engine never changes for them.
    const followed = ticker && typeof ticker.getFollowName === 'function' ? ticker.getFollowName() : null
    const allowed = ticker && playerName && (followed
      ? playerName === followed
      : !!(bot.players && bot.players[playerName]))
    if (!allowed) return
    const arg = msg.slice(5).trim()
    if (!arg) {
      bot.chat(`brain: ${ticker.getBrainEngine()}`)
      return
    }
    if (arg === 'off' || arg === 'laya' || arg === 'jev') {
      if (arg === 'jev' && !process.env.TYPESAFE_API_KEY) {
        bot.chat('jev: no api key')
        return
      }
      const from = ticker.getBrainEngine()
      const url = arg === 'laya' ? (layaUrl() || LAYA_URL_DEFAULT) : JEV_ENDPOINT
      const next = arg === 'off' ? stubBrain : hybridBrain(jevBrain(process.env.TYPESAFE_API_KEY, undefined, brainTimeoutMs(process.env), url))
      ticker.setBrain(next, arg)
      if (bot._tickerCtx) bot._tickerCtx.manualBrain = arg
      bot.chat(`brain: ${arg}`)
      console.log(`brain switch from=${from} to=${arg} by=${playerName}`)
    } else {
      bot.chat(`unknown brain: "${arg.slice(0, 30)}" — say help brain`)
    }
  } else if (msg === 'help' || msg.startsWith('help ')) {
    const topic = msg.slice(4).trim()
    if (!topic) {
      bot.chat(helpReply(1))
    } else if (/^\d+$/.test(topic)) {
      bot.chat(helpReply(Number(topic)) || `no help page ${topic.slice(0, 10)} — say help for the list`)
    } else {
      const cmd = lookupCommand(topic)
      if (cmd) bot.chat(detailLine(cmd))
      // Echo capped: the raw topic is unbounded player text, and an overlong
      // reply would be split past the 256-char chat cap.
      else bot.chat(`unknown command: "${topic.slice(0, 30)}" — say help for the list`)
    }
  } else {
    const m = msg.match(/^find me\s+(\S+)$/)
    if (m) {
      if (bot._tickerCtx) clearPendingSearch(bot._tickerCtx)
      const name = m[1]
      const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
      const speakerY = speaker && typeof speaker.position?.y === 'number' ? speaker.position.y : null
      // No speaker entity (out of tracking range): judge depth from the
      // bot's own Y, the same fallback the ranking uses — never silently 0.
      const botY = bot.entity && typeof bot.entity.position?.y === 'number' ? bot.entity.position.y : null
      const refY = speakerY != null ? speakerY : botY
      const res = findNearest(bot, name, refY)
      if (res === 'unknown') {
        bot.chat(`unknown block: ${name}`)
      } else if (!res) {
        const search = startFarSearch(bot, name, refY)
        if (search === 'unknown') {
          bot.chat(`unknown block: ${name}`)
        } else if (!search) {
          bot.chat(`no ${name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
        } else {
          const t = ticker && bot._tickerCtx ? bot._tickerCtx : null
          if (t) t.pendingSearch = { cursor: search, kind: 'find', name, refY, by: playerName }
          bot.chat(`nothing within 48, widening the search for ${name}…`)
        }
      } else {
        answerFound(bot, ticker, playerName, refY, res)
      }
    } else if (msg === 'find me' || msg.startsWith('find me ')) {
      bot.chat('try: find me iron')
    } else if (msg === 'flat' || msg.startsWith('flat ') || msg === 'make flat' || msg.startsWith('make flat ') || msg === 'flatten' || msg.startsWith('flatten ')) {
      const m = msg.match(/^(?:flat|make flat|flatten)(?:\s+(\S+))?$/)
      const r = m ? flatMod.parseRadius(m[1]) : null
      if (r == null) bot.chat('try: flat 16')
      else if (ticker && typeof ticker.setFlat === 'function') bot.chat(ticker.setFlat({ radius: r, by: playerName, explicit: m[1] != null }))
    } else if (msg === 'share') {
      if (ticker && typeof ticker.setShare === 'function') {
        const r = ticker.setShare({ by: playerName })
        if (r) bot.chat(r)
      }
    } else if (msg === 'autonomous' || msg.startsWith('autonomous ')) {
      const m = msg.match(/^autonomous(?:\s+(on|off))?$/)
      if (!m) {
        bot.chat('try: autonomous on')
      } else if (ticker && typeof ticker.setAutonomous === 'function') {
        if (!m[1]) bot.chat(`autonomous is ${bot._tickerCtx && bot._tickerCtx.autonomous ? 'on' : 'off'}`)
        else bot.chat(ticker.setAutonomous(m[1] === 'on'))
      }
    } else if (msg === 'bring me' || msg.startsWith('bring me ')) {
      const m = msg.match(/^bring me\s+(.+?)(?:\s+(\d+))?$/)
      if (!m) {
        bot.chat('try: bring me coal')
      } else if (ticker && typeof ticker.setBring === 'function') {
        const name = bringMod.normalizeBringName(m[1])
        const food = bringMod.isFoodRequest(name)
        const want = m[2]
          ? Math.min(bringMod.WANT_MAX, Math.max(1, parseInt(m[2], 10)))
          : (food ? bringMod.WANT_FOOD : (/logs?$|_log$/.test(name) ? bringMod.WANT_LOGS : bringMod.WANT_ORE))
        bot.chat(ticker.setBring({ name, want, by: playerName }))
      }
    }
  }
}

// Castle order (idkcraft-g0z.3). The castle rises in front of the speaker
// (the way they look) with its gate facing back at them: the entrance apron
// lands two blocks ahead of their feet. Mineflayer yaw looks along
// (-sin, -cos); rot r = gate facing north/east/south/west.
function castleSite(pos, yaw) {
  const y = typeof yaw === 'number' && Number.isFinite(yaw) ? yaw : 0
  const lx = -Math.sin(y)
  const lz = -Math.cos(y)
  const rot = castleMod.facing(lx, lz)
  const [dx, dz] = [[0, 1], [-1, 0], [0, -1], [1, 0]][rot] // the look axis (gate north: castle south)
  const bp = blueprint.blueprintOf(blueprint.BLUEPRINT_VERSION) // new orders only
  const e = blueprint.rotatePlan([{ ...bp.ENTRANCE, kind: 'air' }], rot, bp.version)[0]
  const site = {
    x: Math.floor(pos.x) + 2 * dx - e.dx,
    y: Math.floor(pos.y),
    z: Math.floor(pos.z) + 2 * dz - e.dz,
  }
  return { site, rot }
}

// The house box plus a one-block yard (interior + walls + 1); a home
// without an interior reads as the v2 7x6 footprint.
function overlapsHome(home, site, rot) {
  if (!home || !home.site) return false
  const lo = home.interior && home.interior.min ? { x: home.interior.min.x - 2, z: home.interior.min.z - 2 } : { x: home.site.x - 1, z: home.site.z - 1 }
  const hi = home.interior && home.interior.max ? { x: home.interior.max.x + 2, z: home.interior.max.z + 2 } : { x: home.site.x + 7, z: home.site.z + 6 }
  const { w, d } = blueprint.siteDimensions(rot, blueprint.BLUEPRINT_VERSION)
  return site.x <= hi.x && site.x + w - 1 >= lo.x && site.z <= hi.z && site.z + d - 1 >= lo.z
}

const at = (p) => `${p.x} ${p.y} ${p.z}`

function startCastle(ticker, site, rot, announce) {
  const v = blueprint.BLUEPRINT_VERSION
  ticker.setCastle({ site, rot, blueprintVersion: v, phase: 'prep', blocked: {}, parked: false, announce })
  ticker.work()
  const n = blueprint.blueprintOf(v).PLAN.filter((c) => blueprint.isPlaceTarget(c.kind)).length
  return `castle at ${at(site)}, ~${n} blocks, this will take many hours; I work while someone is online (or autonomous on)`
}

const SEARCH_WHY = {
  water: 'water', uneven: 'ground too uneven', built: "somebody's buildings",
  house: 'my house in the way', unloaded: "ground I can't see (not loaded)",
}

// One tick of a castle site search (g0z.19): the found site becomes the
// order (the castle executor walks there), else an honest refusal naming
// the most common reason. A newer order, stop, follow or castle forget
// clears ctx.pendingSearch, so a late result never lands.
function advanceCastleSearch(bot, ctx, p) {
  const r = castleMod.stepSiteSearch(bot, p.cursor)
  if (!r.done) return
  ctx.pendingSearch = null
  if (!r.site) {
    const why = SEARCH_WHY[r.why] || 'nothing fits'
    bot.chat(`I found no castle spot within ${castleMod.SEARCH_RADIUS} blocks — mostly ${why} (${r.n} of ${r.of} spots); try another area`)
    return
  }
  if (ctx.castle) return // ordered meanwhile (another speaker)
  const { w, d } = blueprint.siteDimensions(r.rot, blueprint.BLUEPRINT_VERSION)
  const f = p.cursor.from
  const dist = Math.round(Math.hypot(r.site.x + w / 2 - f.x, r.site.z + d / 2 - f.z))
  bot.chat(`found a castle spot ${dist} blocks away, going there; ${startCastle(p.ticker, r.site, r.rot, true)}`)
}

// One castle per bot: 'build castle' starts it, 'castle' reports, 'castle
// stop' / 'castle go' park and resume, 'castle forget' drops the project
// (the laid blocks stay). Returns the reply line, or null for silence.
function castleChat(bot, ticker, playerName, cmd) {
  const ctx = bot && bot._tickerCtx
  if (!ticker || !ctx || typeof ticker.setCastle !== 'function') return null
  const st = ctx.castle
  if (cmd === 'build castle') {
    if (st) return `I already have a castle at ${at(st.site)} — say castle forget first`
    const speaker = bot.players && bot.players[playerName] && bot.players[playerName].entity
    const pos = speaker && speaker.position
    if (!pos || typeof pos.x !== 'number') return "I can't see you, come closer"
    // The spot in front of the speaker first; else the bot searches the
    // nearest one itself (g0z.19), sliced over ticks by advancePendingSearch.
    const { site, rot } = castleSite(pos, speaker.yaw)
    const v = blueprint.BLUEPRINT_VERSION
    const home = overlapsHome(ctx.home, site, rot)
    const r = home ? null : castleMod.siteEval(bot, site, rot, v)
    if (r && !r.bad) return startCastle(ticker, { ...site, y: r.y }, rot, false)
    const why = home ? `it would sit on my house at ${at(ctx.home.site)}` : r.bad
    ctx.pendingSearch = {
      kind: 'castle', by: playerName, ticker,
      cursor: castleMod.startSiteSearch(pos, v, (s, q) => overlapsHome(ctx.home, s, q)),
    }
    return `not right here (${why}) — looking for a castle spot within ${castleMod.SEARCH_RADIUS} blocks…`
  }
  if (!st) {
    if (ctx.pendingSearch && ctx.pendingSearch.kind === 'castle' && (cmd === 'castle forget' || cmd === 'castle stop')) {
      clearPendingSearch(ctx)
      return 'castle search cancelled'
    }
    return 'no castle yet — say build castle'
  }
  if (cmd === 'castle') {
    const now = Date.now()
    let loaded = false
    // All four footprint corners (the v2 site spans up to 3x3 chunks).
    try {
      const { w, d } = blueprint.siteDimensions(st.rot | 0, st.blueprintVersion)
      loaded = [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].every(([dx, dz]) => !!bot.blockAt(new Vec3(st.site.x + dx, st.site.y, st.site.z + dz)))
    } catch (_) { loaded = false }
    const blocked = Object.values(st.blocked || {}).filter((e) => e && e.until > now).length
    const tail = `now: ${st.parked ? 'parked — say castle go' : (st.status || 'waiting for its turn')}; blocked ${blocked}`
    if (!loaded) return `castle at ${at(st.site)}: too far to count; ${tail}`
    const by = castleMod.progressByKind(bot, st)
    let done = 0
    let total = 0
    for (const e of Object.values(by)) { done += e.done; total += e.total }
    const parts = Object.entries(by).map(([k, e]) => `${k} ${e.done}/${e.total}`).join(', ')
    return `castle at ${at(st.site)}: ${total ? Math.floor((100 * done) / total) : 100}% (${parts}); ${tail}`
  }
  if (cmd === 'castle stop') {
    st.parked = true
    ticker.saveMemory()
    return 'castle parked — say castle go to resume'
  }
  if (cmd === 'castle go') {
    st.parked = false
    ticker.saveMemory()
    ticker.work()
    return 'castle resumed'
  }
  if (cmd === 'castle forget') {
    ticker.setCastle(null)
    return `castle at ${at(st.site)} forgotten — the blocks stay`
  }
  return 'try: castle, castle stop, castle go, castle forget'
}

// jr2.2: an order takes the body even at night — the server ignores
// movement from a sleeping player until the client sends leave-bed, which
// only bot.wake() sends (revmux 01-review). Awake bots pass through.
function wakeBody(bot) {
  try {
    if (!bot || !bot.isSleeping || typeof bot.wake !== 'function') return
  } catch (_) { return }
  void (async () => { try { await bot.wake() } catch (_) { /* already awake: the event won */ } })()
}

module.exports = { handleChat, advancePendingSearch, clearPendingSearch, startBlockOrder, answerFound, resSubmerged, wakeBody, castleSite }
