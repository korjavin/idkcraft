'use strict'

// Idle whimsy (idkcraft-o95q): the bot does something funny and illogical
// from time to time — a useless gift, a tiny Stonehenge-like ring, or an
// LLM-improvised joke. Idle-only goal step ('fun', ranked just above
// 'rest'): day, no castle, no orders/pins, nobody fighting for the body,
// pack holds junk or cheap mats. Rare: a 30-60 min randomized cooldown
// stamped when the act starts. Every act chats its own unmistakable line
// so it reads as a joke, never a malfunction; nothing spends the last of
// anything; nothing touches the flat square, the house, or the castle.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { stepDone, stepFailed, stepGen, stale, chatStep } = require('../step')
const { HOSTILE_NAMES } = require('../perception')
const { NEED_LOGS, SCAFFOLD_LOW } = require('../budget')

// Long cooldown, randomized (brief: once per 30-60 min max).
const FUN_MIN_MS = 30 * 60 * 1000
const FUN_JITTER_MS = 30 * 60 * 1000
// Bounds (brief: tiny folly, reversible joke).
const MAX_PLACE = 7
const REACH = 4.5
// Cheap mats only: dirt-family + stone you trip over. Never logs/planks
// (the house eats those), never anything mined with effort.
const CHEAP_BLOCKS = new Set(['dirt', 'coarse_dirt', 'sand', 'gravel', 'cobblestone'])
// Worthless enough to give away with a straight face.
const GIFT_JUNK = new Set([
  'poisonous_potato', 'rotten_flesh', 'spider_eye', 'feather', 'string',
  'wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds',
])
const GIFT_ALLOW = new Set([...GIFT_JUNK, ...CHEAP_BLOCKS])
// One pinned line per act: the joke must be unmistakable.
const CHAT_GIFT = 'a gift for you. you\'re welcome.'
const CHAT_FOLLY = 'do not ask what it means. it is art.'
const CHAT_IMPROV = 'the voices said you would like this. enjoy.'
// New failed: reasons (S5): fun-no-mats, fun-no-ground, fun-no-gift,
// fun-toss, fun-place, fun-threat. All mean "the joke did not land, back
// off" — fun-threat is the combat abort (the body belongs to fight).
const LLM_TIMEOUT_MS = 20000
const TOSS_TIMEOUT_MS = 5000
const PACK_SUMMARY_MAX = 300
// A gift needs a recipient in sight: a visible roster player within this
// many blocks. Unseen-but-online (far, no entity) or distant players get
// no toss at the bot's own feet — delivery defers to a later joke.
const GIFT_RANGE = 8
// Handover happens at toss range (deliver's TOSS_RANGE twin): the bot
// walks into it and faces the recipient before tossing, never throws
// blind across the yard.
const TOSS_RANGE = 3.5
const APPROACH_MS = 10000

function itemsOf(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

function packCounts(bot) {
  const counts = new Map()
  for (const i of itemsOf(bot)) {
    if (!i || typeof i.name !== 'string') continue
    counts.set(i.name, (counts.get(i.name) || 0) + (i.count | 0))
  }
  return counts
}

// Never spends the last of anything: gift one only with 2+ on hand.
function giftPick(bot) {
  const counts = packCounts(bot)
  for (const name of GIFT_ALLOW) {
    if ((counts.get(name) || 0) >= 2) return name
  }
  return null
}

// Folly needs more cheap blocks than it places (keep-last rule).
function follyMats(bot) {
  const counts = packCounts(bot)
  for (const name of CHEAP_BLOCKS) {
    if ((counts.get(name) || 0) > MAX_PLACE) return name
  }
  return null
}

function improvReady(bot) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return false
    return itemsOf(bot).length > 0
  } catch (_) {
    return false
  }
}

// Visible recipient for the gift (o95q R1.2): the nearest roster player
// with a tracked entity inside GIFT_RANGE. Null when nobody is in sight
// — the act is not offered then, never tossed blind.
function giftRecipient(bot) {
  try {
    const ps = require('./deliver').playerStatus(bot)
    if (!ps || ps.level !== 'near' || !ps.entity || !ps.entity.position) return null
    const bp = botPos(bot)
    if (!bp) return null
    const p = ps.entity.position
    const d = Math.hypot(bp.x - p.x, bp.y - (p.y || bp.y), bp.z - p.z)
    if (!(d <= GIFT_RANGE)) return null
    return { name: ps.name || 'you', dist: d, entity: ps.entity }
  } catch (_) {
    return null
  }
}

// Pickaxe upgrade due (o95q R2.2): a wooden/golden pickaxe with the stone
// chain on hand belongs to equip, not to whimsy. Pack-only probe, no
// world reads — the table half of the gate is equip's own business.
function upgradeDue(bot) {
  try {
    return !!require('./equip').stoneUpgradeDue(bot)
  } catch (_) {
    return false
  }
}

// A hostile close by means the body belongs to fight, not whimsy
// (dispatch preemption is the real guard; this keeps the menu honest).
function threatNear(bot) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const entities = (bot && bot.entities && typeof bot.entities === 'object') ? Object.values(bot.entities) : null
    if (!Array.isArray(entities)) return false
    for (const e of entities) {
      if (!e || e.type === 'player' || !e.position) continue
      if (!HOSTILE_NAMES.has(e.name || '')) continue
      if (e.isValid === false) continue
      let d = null
      try { d = bp.distanceTo ? bp.distanceTo(e.position) : Math.hypot(bp.x - e.position.x, bp.y - e.position.y, bp.z - e.position.z) } catch (_) { continue }
      if (typeof d === 'number' && d <= 10) return true
    }
    return false
  } catch (_) {
    return false
  }
}

function castleQuiet(facts) {
  const w = facts && facts.castle
  return w === 'none' || w === 'done' || w === 'parked' || w == null
}

// Only waiting accrues joke credit: rest, explore, the joke itself —
// and staying put through the night (shelter/stay perform no productive
// work, so idle credit survives dawn instead of resetting every night).
// Any productive step, or an unobserved history, restarts the clock. A
// fresh body waits a full stretch before its first joke.
const FUN_IDLE_MS = 20 * 60 * 1000
const IDLE_STEPS = new Set(['rest', 'explore', 'fun', 'stay', 'shelter'])

// Precise idle (o95q R2): the joke runs only when no productive step
// could fire AND the body has idled through a sustained stretch of rest /
// explore picks — a model brain must never see fun alongside real work,
// and a fresh or busy body never sees it at all. Cheap facts/pack checks
// only, no world scans: an unfinished house, a remembered find, a waiting
// haul or bankable surplus, a pinned order, owed beds, an unfinished gear
// ladder, a missing/rearming kit, a due pickaxe upgrade, a waiting craft
// batch (logs or stations), or a torch-ready dark yard all keep the body.
// Rank does the rest: fun sits just above explore, so in FSM mode it fires
// exactly when the only alternatives are rest and an explore with nothing
// new — while a merely-passing idle moment still explores first, and the
// jr2.2 ladder (fresh ctx, full kit) is untouched (R1#5 vs R2#1).
function funFeasible(facts, bot, ctx, now = Date.now()) {
  try {
    if (!facts || facts.time !== 'day') return false
    if (!castleQuiet(facts)) return false
    if (facts.home !== 'built') return false
    if (facts.known === 'near') return false
    if (facts.haul === 'waiting') return false
    if (facts.surplus === 'yes') return false
    if (facts.pinned && facts.pinned !== 'none') return false
    if (facts.beds === 'none' || facts.beds === 'one') return false
    if (facts.gear !== 'done' && facts.gear !== 'hand') return false
    if ((facts.sword || 0) <= 0 || (facts.pickaxe || 0) <= 0 || facts.rearm) return false
    if (upgradeDue(bot)) return false
    if ((facts.scaffold || 0) < SCAFFOLD_LOW) return false
    if ((facts.logs || 0) >= NEED_LOGS) return false
    if ((facts.table || 0) <= 0 && (facts.maxPlanks || 0) >= 4 && ((!facts.tablePlaced && !facts.houseTable) || facts.tableOwed)) return false
    if ((facts.door || 0) <= 0 && facts.tablePlaced && (facts.maxPlanks || 0) >= 6) return false
    if (facts.unlit > 0 && (facts.torches || 0) > 0) return false
    if (!ctx || ctx.paused) return false
    if (ctx.bring || ctx.lead || ctx.comehome || ctx.gocastle) return false
    if (ctx.flat && !ctx.flat.parked) return false
    if (ctx.taskPlanStep || ctx.llmOrder || ctx.llmAsk) return false
    if (threatNear(bot)) return false
    // Time-since-productive-work (o95q R2.1 fallback): ctx.step still
    // holds last tick's pick at decide time. Bookkeeping lives here
    // because goal.js is untouchable — the stamp is monotonic and the
    // read is the gate. Productive work resets the credit even while
    // the joke cools down (the cooldown return sits below this).
    try {
      const last = ctx.step
      if (!last || !IDLE_STEPS.has(last) || typeof ctx.funIdleSince !== 'number') ctx.funIdleSince = now
    } catch (_) { /* stamp best-effort */ }
    if (now - (ctx.funIdleSince || now) < FUN_IDLE_MS) return false
    if (typeof ctx.funNext === 'number' && now < ctx.funNext) return false
    if (giftRecipient(bot) && giftPick(bot)) return true
    if (follyMats(bot)) return true
    if (improvReady(bot) && (giftPick(bot) || follyMats(bot))) return true
    return false
  } catch (_) {
    return false
  }
}

// Cooldown stamped when the act STARTS, so a failure still spaces out.
function stampFun(ctx, now = Date.now(), rand = Math.random) {
  try {
    const r = typeof rand === 'function' ? rand() : rand
    ctx.funNext = now + FUN_MIN_MS + Math.floor((typeof r === 'number' ? r : Math.random()) * FUN_JITTER_MS)
  } catch (_) {
    try { ctx.funNext = now + FUN_MIN_MS } catch (_) { /* stamp best-effort */ }
  }
}

// Which acts can run now; the trigger rolls one (brief: the model picks
// for improv, the dice picks between the acts). The gift needs a visible
// recipient in range — never offered blind.
function availActs(bot, ctx) {
  const acts = []
  try {
    if (giftRecipient(bot) && giftPick(bot)) acts.push('gift')
    if (follyMats(bot)) acts.push('folly')
    if (improvReady(bot) && (giftPick(bot) || follyMats(bot))) acts.push('improv')
  } catch (_) { /* available best-effort */ }
  return acts
}

function pickAct(bot, ctx, rand = Math.random) {
  const acts = availActs(bot, ctx)
  if (!acts.length) return null
  const r = typeof rand === 'function' ? rand() : rand
  return acts[Math.floor((typeof r === 'number' ? r : 0) * acts.length) % acts.length]
}

// "name xN, ..." sublist for the model, capped (brief: capped length).
function packSummary(bot, max = PACK_SUMMARY_MAX) {
  try {
    const parts = []
    for (const [name, n] of packCounts(bot)) parts.push(`${name} x${n}`)
    let s = parts.join(', ')
    if (s.length > max) s = s.slice(0, max)
    return s
  } catch (_) {
    return ''
  }
}

const FUN_SYSTEM = 'You invent a tiny joke for a Minecraft companion bot with an idle moment. ' +
  'Answer JSON only, no prose: {"kind":"gift","item":"<id>"} to hand over one worthless item, or ' +
  '{"kind":"build","block":"<id>","count":<n>} to place a tiny ring of n identical cheap blocks. ' +
  'Rules: item/block must come from the pack list; block must be dirt, coarse_dirt, sand, gravel or cobblestone; ' +
  'count is 1-7; never tools, weapons, armour, food, fire, lava, water, tnt or redstone; keep it small and reversible. ' +
  'When nothing in the pack suits a joke, answer {"kind":"none"}.'

// Validator: the allowlist is the safety — anything outside is an honest
// skip, never executed. keep-last: counts must leave one behind.
function validateFunOffer(offer, counts) {
  const bad = (why) => ({ ok: false, why })
  if (!offer || typeof offer !== 'object') return bad('no-offer')
  const kind = typeof offer.kind === 'string' ? offer.kind.toLowerCase().trim() : ''
  const have = (name) => (counts instanceof Map ? (counts.get(name) || 0) : 0)
  if (kind === 'none') return bad('model-passed')
  if (kind === 'gift') {
    const item = typeof offer.item === 'string' ? offer.item.toLowerCase().trim().replace(/\s+/g, '_') : ''
    if (!GIFT_ALLOW.has(item)) return bad(`gift-no-item:${item.slice(0, 24)}`)
    if (!(have(item) >= 2)) return bad(`gift-short:${item.slice(0, 24)}`)
    return { ok: true, act: 'gift', item }
  }
  if (kind === 'build') {
    const block = typeof offer.block === 'string' ? offer.block.toLowerCase().trim().replace(/\s+/g, '_') : ''
    if (!CHEAP_BLOCKS.has(block)) return bad(`build-no-block:${block.slice(0, 24)}`)
    const count = Math.floor(Number(offer.count))
    if (!(count >= 1 && count <= MAX_PLACE)) return bad(`build-count:${String(offer.count).slice(0, 8)}`)
    if (!(have(block) > count)) return bad(`build-short:${block.slice(0, 24)}`)
    return { ok: true, act: 'build', block, count }
  }
  return bad(`no-kind:${String(kind).slice(0, 24)}`)
}

// Entity collision boxes (o95q R2.3/R4.7): a cell holding the bot or
// a tracked entity is unbuildable — checked at scan time AND rechecked
// per placement, since bodies move between the two. Skipped, not failed.
function cellOccupied(bot, x, y, z) {
  try {
const all = []
const bp = botPos(bot)
if (bp) all.push(bp)
const entities = (bot && bot.entities && typeof bot.entities === 'object') ? Object.values(bot.entities) : []
for (const e of entities) {
  if (!e || e.isValid === false || !e.position) continue
  all.push(e.position)
}
for (const p of all) {
  if (!p || typeof p.x !== 'number') continue
  const py = Math.floor(typeof p.y === 'number' ? p.y : y)
  if (Math.abs(x + 0.5 - p.x) < 0.8 && Math.abs(z + 0.5 - p.z) < 0.8 && (y === py || y === py + 1)) return true
}
  } catch (_) { /* positions best-effort */ }
  return false
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    return p && typeof p.x === 'number' ? p : null
  } catch (_) {
    return null
  }
}

// Hex-ish ground ring + centre, 7 cells max. Rejects cells near the home
// site, the flat square, or the castle site — whimsy never builds on work.
function findFollySpot(bot, ctx) {
  try {
    const bp = botPos(bot)
    if (!bp) return null
    const home = ctx && ctx.home && ctx.home.site
    // Both flat records, always (o95q R3.3/R4.4): the finished flatEnd
    // AND a parked in-progress episode share the { cx, cz, r } shape —
    // checking only whichever is set first builds on the other square.
    const flats = [ctx && ctx.flatEnd, ctx && ctx.flat].filter((s) => s && typeof s.cx === 'number')
    const castle = ctx && ctx.castle && ctx.castle.site
    // A 10-block radius cannot guard a 31x27 castle: check every ring
    // cell against the footprint and yard predicates of every known
    // castle (o95q R1.1). The old centre-distance veto below stays as a
    // cheap pre-filter only.
    const castleKept = (x, y, z) => {
      try {
        const castleMod = require('../castle')
        return !!castleMod.anyCastle(ctx, (st) =>
          castleMod.inFootprint(st, { x, y, z }) || castleMod.yardRing(st, { x, y, z }))
      } catch (_) {
        return false
      }
    }
    // House footprints are per-cell too (o95q R3.5): a centre 6 out can
    // still hang a ring cell over the roof or the porch apron.
    const houseKept = (x, y, z) => {
      try {
        return !!require('./util').inHouseFootprint(ctx && ctx.home, { x, y, z })
      } catch (_) {
        return false
      }
    }
    const farFrom = (x, z, s, r) => {
      if (!s || typeof s !== 'object') return true
      // Flat squares (ctx.flat episode / ctx.flatEnd) are { cx, cz, r },
      // not points: keep the ring (radius 2) plus a margin off the whole
      // square, or the folly lands on the fresh flattening (o95q review).
      if (typeof s.cx === 'number' && typeof s.cz === 'number') {
        const half = (typeof s.r === 'number' ? s.r : 0) + 2 + 1
        return Math.abs(x - s.cx) > half || Math.abs(z - s.cz) > half
      }
      if (typeof s.x !== 'number') return true
      return Math.hypot(x - s.x, z - s.z) > r
    }
    const ring = [[2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1], [1, -1], [0, 0]]
    // The centre hugs the body: the far ring cell (centre + 2) must stay
    // within placing reach, so the centre sits 2 out in each of 8
    // directions. Vetoes keep the ring off the home site, the flat
    // square and the castle site.
    const d = 2
    for (let a = 0; a < 8; a++) {
      const cx = Math.round(bp.x + d * Math.cos((a * Math.PI) / 4))
      const cz = Math.round(bp.z + d * Math.sin((a * Math.PI) / 4))
      if (!farFrom(cx, cz, home, 6) || flats.some((s) => !farFrom(cx, cz, s, 0)) || !farFrom(cx, cz, castle, 10)) continue
      let gy = null
      const cells = []
      let ok = true
      for (const [ox, oz] of ring) {
        const x = cx + ox
        const z = cz + oz
        if (Math.hypot(x - bp.x, z - bp.z) > REACH) { ok = false; break }
        let y = null
        for (let dy = 2; dy >= -3; dy--) {
          const n = blockNameAt(bot, new Vec3(x, Math.floor(bp.y) + dy, z))
          if (n == null) { ok = false; break }
          if (n === 'air' || n === 'cave_air' || n === 'void_air') continue
          y = Math.floor(bp.y) + dy + 1
          break
        }
        if (y == null) { ok = false; break }
        if (gy == null) gy = y
        if (y !== gy) { ok = false; break } // one flat ring, no cliffs
        const top = blockNameAt(bot, new Vec3(x, y, z))
        if (top !== 'air' && top !== 'cave_air' && top !== 'void_air') { ok = false; break }
        if (castleKept(x, y, z)) { ok = false; break } // never build on a castle
        if (ctx && ctx.home && houseKept(x, y, z)) { ok = false; break } // never build on the house
        if (!cellOccupied(bot, x, y, z)) cells.push(new Vec3(x, y, z)) // occupied cells are skipped, not failed
      }
      if (ok && cells.length) return { cells }
    }
    return null
  } catch (_) {
    return null
  }
}

function tossOne(bot, item) {
  // Count-limited promise toss (mineflayer bot.toss): tossStack drops the
  // whole stack and takes no callback, which would break the keep-last
  // bound and time every gift out (o95q review). No count-limited toss
  // on this body (e.g. a bridge adapter) fails honestly instead.
  const type = item && typeof item.type === 'number' ? item.type : null
  if (type == null || typeof bot.toss !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const fin = (ok) => { if (!done) { done = true; resolve(ok) } }
    try {
      const timer = setTimeout(() => fin(false), TOSS_TIMEOUT_MS)
      Promise.resolve(bot.toss(type, null, 1)).then(
        () => { clearTimeout(timer); fin(true) },
        () => { clearTimeout(timer); fin(false) },
      )
    } catch (_) {
      fin(false)
    }
  })
}

async function equipHand(bot, name) {
  try {
    const item = itemsOf(bot).find((i) => i && i.name === name)
    if (!item) return false
    if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
    return true
  } catch (_) {
    return false
  }
}

// Combat cancels the joke: a hostile walking up mid-ring owns the body,
// so every placement revalidates safety, not just the generation.
function safeToJoke(bot) {
  try {
    return !threatNear(bot)
  } catch (_) {
    return false
  }
}

async function placeCells(bot, ctx, gen, block, cells) {
  let placed = 0
  for (const cell of cells) {
    if (stale(ctx, gen)) return { placed, fail: 'preempted' }
    if (!safeToJoke(bot)) return { placed, fail: 'threat' }
    // Bodies move between scan and placement (o95q R4.7): recheck the
    // collision box per cell and skip the occupied ones instead of
    // aborting the joke.
    if (cellOccupied(bot, cell.x, cell.y, cell.z)) continue
    try {
      if (!equipHandSyncCheck(bot, block)) return { placed, fail: 'no-mats' }
      const okEq = await equipHand(bot, block)
      if (stale(ctx, gen)) return { placed, fail: 'preempted' } // stop ordered mid-equip: place nothing
      if (!safeToJoke(bot)) return { placed, fail: 'threat' } // combat started mid-equip: hold fire
      if (!okEq) return { placed, fail: 'no-mats' }
      let ref = null
      try { ref = bot.blockAt && bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z)) } catch (_) { ref = null }
      if (!ref || !ref.position) return { placed, fail: 'no-ground' }
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      placed++
    } catch (_) {
      return { placed, fail: 'place-fail' }
    }
  }
  return { placed, fail: null }
}

function equipHandSyncCheck(bot, block) {
  try {
    return itemsOf(bot).some((i) => i && i.name === block)
  } catch (_) {
    return false
  }
}

function stopWalk(bot, ownGoal) {
  // Ownership-checked cleanup (o95q R4.6): a preempted act must not null
  // the replacement step's movement goal — clear only the goal this act
  // set (or a goal already gone).
  try {
    if (!bot || !bot.pathfinder || typeof bot.pathfinder.setGoal !== 'function') return
    const cur = bot.pathfinder.goal
    if (cur == null || (ownGoal != null && cur === ownGoal)) bot.pathfinder.setGoal(null)
  } catch (_) { /* walk best-effort */ }
}

// Walk into toss range and face the recipient (o95q R2.5): a gift is
// handed over, never thrown blind from afar. Returns 'ok' (in range,
// facing), 'left' (recipient gone), 'threat' (combat owns the body),
// 'gone' (preempted) or 'far' (unreachable in time — hold, don't toss).
async function approachRecipient(bot, ctx, gen, ms = APPROACH_MS) {
  const t0 = Date.now()
  const budget = (ctx && typeof ctx.funApproachMs === 'number') ? ctx.funApproachMs : ms
  let walkGoal = null
  for (;;) {
    if (stale(ctx, gen)) { stopWalk(bot, walkGoal); return 'gone' }
    if (!safeToJoke(bot)) { stopWalk(bot, walkGoal); return 'threat' }
    const r = giftRecipient(bot)
    if (!r) { stopWalk(bot, walkGoal); return 'left' }
    if (r.dist <= TOSS_RANGE) {
      try {
        const p = r.entity.position
        await bot.lookAt(new Vec3(p.x, (typeof p.y === 'number' ? p.y : 64) + 1.6, p.z))
      } catch (_) { /* facing best-effort */ }
      stopWalk(bot, walkGoal)
      return 'ok'
    }
    if (Date.now() - t0 > budget) { stopWalk(bot, walkGoal); return 'far' }
    try {
      const p = r.entity.position
      walkGoal = new goals.GoalNear(p.x, p.y, p.z, 2)
      bot.pathfinder.setGoal(walkGoal)
    } catch (_) { /* walk best-effort */ }
    await new Promise((w) => setTimeout(w, 250))
  }
}

async function doGift(bot, ctx, gen, item, line) {
  if (stale(ctx, gen)) return
  if (!giftRecipient(bot)) { stepDone(ctx, gen); return } // recipient left: defer, never toss blind
  const how = await approachRecipient(bot, ctx, gen)
  if (how === 'gone') return
  if (how === 'threat') { stepFailed(ctx, 'fun-threat', gen); return }
  if (how !== 'ok') { stepFailed(ctx, 'fun-no-recipient', gen); return } // 'left' or 'far': hold, don't toss
  // Final recheck after the facing await (o95q R4.5): the toss itself is
  // irreversible, so generation, threat and the recipient are revalidated
  // here — not just inside the approach loop.
  if (stale(ctx, gen)) return
  if (!safeToJoke(bot)) { stepFailed(ctx, 'fun-threat', gen); return }
  if (!giftRecipient(bot)) { stepFailed(ctx, 'fun-no-recipient', gen); return }
  const inv = itemsOf(bot)
  const stack = inv.find((i) => i && i.name === item) || { name: item, type: null }
  const tossed = await tossOne(bot, stack)
  if (stale(ctx, gen)) return // preempted mid-toss: the body belongs elsewhere now
  if (!tossed) { stepFailed(ctx, 'fun-toss', gen); return }
  try { chatStep(bot, ctx, line) } catch (_) { /* chat best-effort */ }
  stepDone(ctx, gen)
}

async function doFolly(bot, ctx, gen, block, count, line) {
  if (stale(ctx, gen)) return
  const spot = findFollySpot(bot, ctx)
  if (!spot) { stepFailed(ctx, 'fun-no-ground', gen); return }
  const cells = spot.cells.slice(0, count)
  const { placed, fail } = await placeCells(bot, ctx, gen, block, cells)
  if (stale(ctx, gen)) return // preempted mid-ring: stop placing, write nothing
  if (fail || placed === 0) {
    try { console.log(`fun folly placed=${placed}/${cells.length} fail=${fail || 'all-occupied'}`) } catch (_) { /* log best-effort */ }
    stepFailed(ctx, fail === 'no-mats' ? 'fun-no-mats' : fail === 'no-ground' ? 'fun-no-ground' : fail === 'threat' ? 'fun-threat' : 'fun-place', gen)
    return
  }
  try { chatStep(bot, ctx, line) } catch (_) { /* chat best-effort */ }
  stepDone(ctx, gen)
}

async function doImprov(bot, ctx, gen, fetchFn) {
  if (stale(ctx, gen)) return
  const summary = packSummary(bot)
  if (!summary) { stepDone(ctx, gen); return }
  let data = null
  try {
    const brain = require('../brain')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new DOMException('fun timeout', 'TimeoutError')), LLM_TIMEOUT_MS)
    try {
      data = await brain.llmCall({
        use: 'fun',
        apiKey: process.env.ANTHROPIC_API_KEY,
        signal: ac.signal,
        fetchFn,
        body: {
          model: process.env.LLM_MODEL || brain.LLM_MODEL,
          max_tokens: 300,
          thinking: { type: 'disabled' },
          system: FUN_SYSTEM,
          messages: [{ role: 'user', content: `Pack (name xcount): ${summary}\nOffer ONE tiny joke fitting the pack.` }],
        },
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    try { console.log(`fun improv llm error: ${String((err && err.message) || err).slice(0, 80)}`) } catch (_) { /* log best-effort */ }
    if (!stale(ctx, gen)) stepDone(ctx, gen) // honest skip: the joke does not land, the cooldown spaces the next try
    return
  }
  let offer = null
  try {
    const out = ((data && Array.isArray(data.content) ? data.content : []).find((b) => b && b.type === 'text') || {}).text || ''
    offer = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch (_) { offer = null }
  const v = validateFunOffer(offer, packCounts(bot))
  try { console.log(`fun improv offer=${JSON.stringify(offer).slice(0, 160)} verdict=${v.ok ? v.act : v.why}`) } catch (_) { /* log best-effort */ }
  if (stale(ctx, gen)) return // preempted mid-ask: offer dies with the step
  // Combat cancels the joke (o95q R1.4): the generation check above does
  // not move on a fight dispatch, so revalidate safety before executing.
  if (!safeToJoke(bot)) { stepFailed(ctx, 'fun-threat', gen); return }
  if (!v.ok) { stepDone(ctx, gen); return } // honest skip on anything outside the allowlist
  if (v.act === 'gift') {
    if (!giftRecipient(bot)) { stepDone(ctx, gen); return } // recipient left: no blind toss
    await doGift(bot, ctx, gen, v.item, CHAT_IMPROV)
  } else await doFolly(bot, ctx, gen, v.block, v.count, CHAT_IMPROV)
}

// Fire-and-forget like every other behaviour (applyDecision does not
// await): the busy flag owns the async window, the cooldown was stamped
// at pick time, and stepStatus ends the step.
async function run(bot, ctx) {
  if (!ctx || ctx.funBusy) return
  const gen = stepGen(ctx)
  ctx.funBusy = true
  ctx.funRun = gen
  stampFun(ctx)
  try {
    const act = pickAct(bot, ctx, Math.random)
    if (act === 'gift') {
      const g = giftPick(bot)
      if (!g) stepFailed(ctx, 'fun-no-gift', gen)
      else await doGift(bot, ctx, gen, g, CHAT_GIFT)
    } else if (act === 'improv') {
      await doImprov(bot, ctx, gen)
    } else if (act === 'folly') {
      const m = follyMats(bot)
      if (!m) stepFailed(ctx, 'fun-no-mats', gen)
      else await doFolly(bot, ctx, gen, m, MAX_PLACE, CHAT_FOLLY)
    } else stepFailed(ctx, 'fun-no-mats', gen)
  } finally {
    // A preempted-then-repicked run owns the flag now: only the owning
    // generation releases it.
    try { if (ctx.funRun === gen) { ctx.funBusy = false; ctx.funRun = null } } catch (_) { /* flag best-effort */ }
  }
}

module.exports = run
module.exports.run = run
module.exports.funFeasible = funFeasible
module.exports.pickAct = pickAct
module.exports.availActs = availActs
module.exports.validateFunOffer = validateFunOffer
module.exports.packSummary = packSummary
module.exports.giftPick = giftPick
module.exports.follyMats = follyMats
module.exports.improvReady = improvReady
module.exports.stampFun = stampFun
module.exports.findFollySpot = findFollySpot
module.exports.FUN_MIN_MS = FUN_MIN_MS
module.exports.FUN_JITTER_MS = FUN_JITTER_MS
module.exports.MAX_PLACE = MAX_PLACE
module.exports.CHEAP_BLOCKS = CHEAP_BLOCKS
module.exports.GIFT_ALLOW = GIFT_ALLOW
module.exports.CHAT_GIFT = CHAT_GIFT
module.exports.CHAT_FOLLY = CHAT_FOLLY
module.exports.CHAT_IMPROV = CHAT_IMPROV
module.exports.FUN_SYSTEM = FUN_SYSTEM
module.exports.giftRecipient = giftRecipient
module.exports.safeToJoke = safeToJoke
module.exports.registerInto = registerInto
module.exports.upgradeDue = upgradeDue
module.exports.GIFT_RANGE = GIFT_RANGE
module.exports.TOSS_RANGE = TOSS_RANGE
module.exports.FUN_IDLE_MS = FUN_IDLE_MS

// Registration (o95q R1.5): bot/src/goal.js stays byte-identical —
// the step joins the goal menu through here, on the skills.js registerStep
// precedent: a MENU entry whose feasible IS funFeasible, a STEP_ORDER slot
// just above rest (any work step outranks it; the feasible gate itself
// refuses while useful work is available), plus the criteria and effect
// text the model menus read. Modules are injected (never required: a
// behaviour requiring the arbiter is a forbidden edge, lazy or not).
// Idempotent: call from the ticker entry and from tests.
const FUN_VERB = 'having a little fun'
const FUN_CRITERION = 'time is day, the house stands finished, nothing known nearby, and the pack holds junk or cheap mats: play a tiny rare joke'
const FUN_EFFECT = 'plays a tiny rare joke with junk or cheap mats'
function registerInto(goalMod, constsMod) {
  try {
    if (!goalMod || !goalMod.MENU || goalMod.MENU.fun) return
    goalMod.MENU.fun = {
      feasible: (facts, bot, ctx) => {
        try {
          return funFeasible(facts, bot, ctx)
        } catch (_) {
          return false
        }
      },
      chat: () => 'on my own: a little something for morale',
      verb: FUN_VERB,
    }
    // Just above explore (o95q R2.1): every productive step outranks the
    // joke, so in FSM mode it fires exactly when the only alternatives
    // are rest and an explore with nothing new.
    if (constsMod && Array.isArray(constsMod.STEP_ORDER) && !constsMod.STEP_ORDER.includes('fun')) {
      const at = constsMod.STEP_ORDER.indexOf('explore')
      constsMod.STEP_ORDER.splice(at < 0 ? constsMod.STEP_ORDER.length : at, 0, 'fun')
    }
    if (goalMod.STEP_CRITERIA) goalMod.STEP_CRITERIA.fun = FUN_CRITERION
    if (constsMod && constsMod.STEP_EFFECT_TEXT) constsMod.STEP_EFFECT_TEXT.fun = FUN_EFFECT
  } catch (_) { /* registration best-effort */ }
}
