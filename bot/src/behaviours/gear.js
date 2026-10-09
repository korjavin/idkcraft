'use strict'

// gear: the blacksmith step (idkcraft-ipn.3). Climbs the vanilla gear ladder
// and hands finished goods to the owner: one MENU step with an internal rung
// machine, no per-rung steps.
//
// Ladder (iron, then diamond): self pickaxe, self bucket, owner sword,
// owner pickaxe, owner buckets, then armour (ipn.6): self
// helmet/chestplate/leggings/boots, then the owner's spares. Self tools
// first: diamond ore needs an iron pick in the inventory (bring.js tier
// gate), so the bot forges its own hands before the owner's kit; its own
// water-bucket pair (jsf.5, the pit escape) outranks the owner's sword.
// Armour trails the tools (no rung gates on it) but keeps the self-before-
// owner shape. Stone is equip's job and the precondition, not a rung.
//
// The rung machine derives its position from the inventory every tick — no
// monotonic phase counter — so death, displacement, or a gifted tool move it
// correctly (a lost self pick regresses the ladder to iron). Self armour
// counts worn plus packed (worn is invisible to items(), slots 9-44 only)
// and goes on the body at the forge; owner pieces are craft-once: once
// forged and vanished from the pack they read as handed over, whether
// tossed to a player (deliver) or banked (stockpile). A death that eats an
// unhanded owner piece is forgiven, not remade: tracking it would need a
// death marker across steps, and the reconcile below stays silent rather
// than claim a handover it cannot prove (chat honesty).
//
// Subroutines (owned by slices A and B, driven here, no MENU steps of their
// own): furnace(bot, ctx) smelts raw iron behind ctx.furnace.result, deep()
// digs diamonds behind a stepStatus relay. Both run INSIDE the gear step so
// raw mats never sit in the haul across a decision (deliver would toss raw
// diamonds to an online player and starve the ladder). A missing slice impl
// reads as a latched wait, never a failure: iron lands on A, diamonds on B.
//
// Night-shift honesty: online, deliver-first tosses every forage leg before
// gear can accumulate ore, so the ladder effectively progresses with nobody
// online (E's night acceptance). That is the epic's shape, not a bug: the
// day bot fetches raw, the night bot forges. Stranded chest batches (ore
// banked at SURPLUS_BATCH mid-rung) withdraw on demand (ipn.6 pantry):
// stockpile bumps ctx.gearPantryBanked when it banks ladder mats, and a
// mat-short rung draws the shortfall before it yields to the fetchers or
// the deep leg. Coal never banks (EXACT_KEEP), so fuel always recovers on
// hand — no withdraw for it.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const craftMod = require('./craft')
const { countItems, wornItems } = require('../perception')
const { say } = require('./util')
const metrics = require('../metrics')

// Ladder data: tiers in order, pieces in order. kind+owner name the want;
// the item name is `${tier}_${kind}` unless the piece overrides it. Buckets
// (jsf.5) override both ends: crafted as `bucket`, handed over filled as
// `water_bucket` — the `${tier}_${kind}` template would read iron_bucket.
// Armour (ipn.6) trails each tier's tools, self set then owner spares.
const SELF_ARMOR = [
  { kind: 'helmet', owner: false },
  { kind: 'chestplate', owner: false },
  { kind: 'leggings', owner: false },
  { kind: 'boots', owner: false },
]
const OWNER_ARMOR = [
  { kind: 'helmet', owner: true },
  { kind: 'chestplate', owner: true },
  { kind: 'leggings', owner: true },
  { kind: 'boots', owner: true },
]
const RUNGS = [
  {
    tier: 'iron', mat: 'iron_ingot',
    pieces: [
      { kind: 'pickaxe', owner: false },
      { kind: 'bucket', owner: false, item: 'bucket', filled: 'water_bucket' },
      { kind: 'sword', owner: true },
      { kind: 'pickaxe', owner: true },
      { kind: 'bucket', owner: true, item: 'bucket', filled: 'water_bucket' },
      ...SELF_ARMOR,
      ...OWNER_ARMOR,
    ],
  },
  {
    tier: 'diamond', mat: 'diamond',
    pieces: [
      { kind: 'pickaxe', owner: false },
      { kind: 'sword', owner: true },
      { kind: 'pickaxe', owner: true },
      ...SELF_ARMOR,
      ...OWNER_ARMOR,
    ],
  },
]
const MAT_NEED = { pickaxe: 3, sword: 2, bucket: 3, helmet: 5, chestplate: 8, leggings: 7, boots: 4 }
const STICK_NEED = { pickaxe: 2, sword: 1, bucket: 0, helmet: 0, chestplate: 0, leggings: 0, boots: 0 }
// Owner wants per item name (tiers differ by name, so names are unique).
// water_bucket is the multi-unit want (2 spares for the owner, one at a
// time — the given ledger counts units, see reconcile).
const OWNER_WANT = {
  iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1, water_bucket: 2,
  iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1,
  diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
}
// Armour equip destinations (mineflayer bot.equip words, fight.js shape).
// Doubles as the armour-kind test: a kind in this map counts worn+packed
// and goes on the body at the forge.
const ARMOR_DEST = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
// Self reserve (round-2): owner pickaxes share the self pick's item name,
// so handover math counts the pack MINUS the hands. Without it a toss plus
// a bank spends the bot's own pick (live - 0) and knocks the ladder back to
// iron. Swords have no self twin (the stone sword suffices), reserve 0.
// The escape buckets (jsf.5) are shared-name twins like the picks: two stay
// in the pack (owner 2026-09-28: 'simple solution — get another bucket',
// SELF_RESERVE 2 feeds the jsf.2 two-bucket climb), spares hand over.
// Mirrored in stockpile.js GEAR_SELF_RESERVE (no shared import: stockpile
// must not require gear — craft/goal cycle).
// Armour (ipn.6) needs no reserve entry: the worn set is invisible to pack
// counts (items() skips slots 5-8), so handover math can never spend it —
// the slots themselves are the reserve. No mirror changes either.
const SELF_RESERVE = { iron_pickaxe: 1, diamond_pickaxe: 1, water_bucket: 2 }
// Finished-good name: the ledger name (have-checks, made, haul, given).
function pieceName(rung, piece) {
  try {
    if (piece && typeof piece.filled === 'string' && piece.filled) return piece.filled
  } catch (_) { /* template below */ }
  return `${rung.tier}_${piece.kind}`
}
function reserve(name) {
  return SELF_RESERVE[name] || 0
}
// Self pieces complete when the hands are full: the reserve depth (picks 1,
// buckets 2), at least one — a self want without a reserve entry still
// forges a single unit.
function selfWant(name) {
  return Math.max(1, reserve(name))
}
function haulCount(ctx, name) {
  try {
    return (ctx && ctx.haul && ctx.haul[name]) || 0
  } catch (_) {
    return 0
  }
}
// Tossed (pure, no mutation): forged for the owner, pack at/below the
// reserve, and no channel still claims it. Banked pieces short-circuit on
// the given ledger; deaths leave a stale haul and reforge.
function tossed(name, haveCount, ctx) {
  try {
    const made = ctx && ctx.gear && ctx.gear.made
    if (!made || !made[name]) return false
    if (haulCount(ctx, name) > 0) return false
    const fin = (ctx.gearFinished && ctx.gearFinished[name]) || 0
    const live = Math.max(0, (haveCount || 0) - reserve(name))
    if (Math.min(fin, live) > 0) return false
    return (haveCount || 0) <= reserve(name)
  } catch (_) {
    return false
  }
}
const WALK_GIVE_UP = 20

function have(bot, name) {
  try {
    return countItems(bot, (n) => n === name)
  } catch (_) {
    return 0
  }
}

// Self completion count: tools read the pack, armour reads worn plus packed
// (a forged self piece is on the body or still in the pack mid-wear — both
// read complete, so a lagged equip never reforges). Owner math stays
// pack-only (have): a worn self piece must never satisfy an owner want.
function selfHave(bot, name, kind) {
  const pack = have(bot, name)
  try {
    if (kind && ARMOR_DEST[kind]) return pack + wornItems(bot, name)
  } catch (_) { /* pack-only */ }
  return pack
}

// Pantry freshness (ipn.6): stockpile bumps ctx.gearPantryBanked when it
// banks ladder mats, the withdraw below records what it saw. Fresh means a
// bank landed that no withdraw has drawn yet — attempt, don't yield. No
// adopted chest reads stale (no pantry to draw); an unlatched session reads
// fresh, so pre-restart strands withdraw on the first mat-short visit.
function pantryFresh(ctx) {
  try {
    if (!ctx || !ctx.home || !ctx.home.chest) return false
    const banked = ctx.gearPantryBanked || 0
    const seen = ctx.gear && typeof ctx.gear.pantrySeen === 'number' ? ctx.gear.pantrySeen : -1
    return banked !== seen
  } catch (_) {
    return false
  }
}

function gearCtx(ctx) {
  try {
    if (!ctx.gear || typeof ctx.gear !== 'object') ctx.gear = {}
    return ctx.gear
  } catch (_) {
    return {}
  }
}

function runCtx(ctx) {
  try {
    if (!ctx.gearRun || typeof ctx.gearRun !== 'object') ctx.gearRun = {}
    return ctx.gearRun
  } catch (_) {
    return {}
  }
}

// Next ladder want, derived from the pack: null when the ladder is complete.
// Self pieces read the inventory (a lost pick regresses the ladder); owner
// pieces read the given ledger. Iron scans before diamond, so the diamond
// rung is structurally gated on a carried iron pick (ipn.2 contract: no
// facts.deep, the need-iron-pick failure cannot fire).
function deriveNext(bot, ctx) {
  let given = null
  try {
    given = (ctx && ctx.gearGiven) || {}
  } catch (_) {
    given = {}
  }
  let noWater = false
  try {
    noWater = !!(ctx && ctx.gear && ctx.gear.noWater)
  } catch (_) { /* water unknown: rungs flow */ }
  for (let ti = 0; ti < RUNGS.length; ti++) {
    const rung = RUNGS[ti]
    for (let pi = 0; pi < rung.pieces.length; pi++) {
      const piece = rung.pieces[pi]
      // Dry home (jsf.5): the bucket rung is skipped, the ladder walks on.
      if (piece.filled && noWater) continue
      const name = pieceName(rung, piece)
      const craft = (piece && piece.item) || name
      if (piece.owner) {
        if ((given[name] || 0) < (OWNER_WANT[name] || 1) && !tossed(name, have(bot, name), ctx)) {
          return { tier: rung.tier, tierIdx: ti, pieceIdx: pi, mat: rung.mat, kind: piece.kind, owner: true, name, craft, fill: !!piece.filled, needMat: MAT_NEED[piece.kind], needSticks: STICK_NEED[piece.kind] }
        }
      } else if (selfHave(bot, name, piece.kind) < selfWant(name)) {
        return { tier: rung.tier, tierIdx: ti, pieceIdx: pi, mat: rung.mat, kind: piece.kind, owner: false, name, craft, fill: !!piece.filled, needMat: MAT_NEED[piece.kind], needSticks: STICK_NEED[piece.kind] }
      }
    }
  }
  return null
}

// Ledger reconcile (tick start): the finished record clamps to the live pack
// (tossed, banked, or died away), and a forged-then-vanished owner piece
// reads as handed over. Silent by design: only the banking channel may claim
// a handover out loud (stockpile), the toss channel speaks for itself
// (deliver's 'brought'), and a death-forgiven loss must not be announced.
function reconcile(ctx, bot) {
  let finished = null
  try {
    if (!ctx.gearFinished || typeof ctx.gearFinished !== 'object') ctx.gearFinished = {}
    finished = ctx.gearFinished
  } catch (_) {
    return
  }
  for (const name of Object.keys(OWNER_WANT)) {
    try {
      const live = have(bot, name)
      const net = Math.max(0, live - reserve(name))
      const prevFin = finished[name] || 0
      if (prevFin > net) finished[name] = net
      if (tossed(name, live, ctx)) {
        if (!ctx.gearGiven || typeof ctx.gearGiven !== 'object') ctx.gearGiven = {}
        // Toss-channel accounting, incremental like the bank channel
        // (stockpile): each vanished finished unit counts once toward the
        // want, capped. Single-unit wants land exactly as before.
        const handed = Math.max(0, prevFin - (finished[name] || 0))
        if (handed > 0 && (ctx.gearGiven[name] || 0) < OWNER_WANT[name]) {
          const before = ctx.gearGiven[name] || 0
          ctx.gearGiven[name] = Math.min(OWNER_WANT[name], before + handed)
          try {
            // The ledger delta, not handed: the want cap above may trim it.
            metrics.gearGiven.inc({ piece: name, channel: 'toss' }, ctx.gearGiven[name] - before)
          } catch (_) { /* metrics best-effort */ }
        }
        // A settled unit leaves the pipeline: with both channels at zero,
        // made clears so the next unit of a multi-unit want (water_bucket
        // x2, jsf.5) re-derives instead of reading handed forever.
        if ((finished[name] || 0) <= 0 && haulCount(ctx, name) <= 0) {
          try {
            if (ctx.gear && ctx.gear.made) delete ctx.gear.made[name]
          } catch (_) { /* ledger best-effort */ }
        }
      }
    } catch (_) { /* ledger best-effort */ }
  }
}

// Live unhanded owner goods: read-only (the stockpile handover gate).
function handoverWaiting(bot, ctx) {
  try {
    const finished = (ctx && ctx.gearFinished) || {}
    for (const name of Object.keys(OWNER_WANT)) {
      if ((finished[name] || 0) > 0 && have(bot, name) > reserve(name)) return true
    }
  } catch (_) { /* none waiting */ }
  return false
}

// Plan counts from goal facts (the MENU.feasible/stepWhy/goalText world).
// Per-tier piece counts ride dedicated facts; the furnace claim reads ctx.
function countsFromFacts(facts, ctx) {
  const f = facts || {}
  let furnaceClaim = false
  try {
    furnaceClaim = !!(ctx && ctx.home && ctx.home.furnace)
  } catch (_) { /* no claim */ }
  return {
    ironOre: f.ironOre || 0, ingots: f.ingots || 0, diamonds: f.diamonds || 0,
    sticks: f.sticks || 0, planks: f.maxPlanks || 0, logs: f.logs || 0,
    iron_pickaxe: f.ironPick || 0, iron_sword: f.ironSword || 0,
    diamond_pickaxe: f.diamondPick || 0, diamond_sword: f.diamondSword || 0,
    bucket: f.bucket || 0, water_bucket: f.waterBucket || 0,
    iron_helmet: f.ironHelmet || 0, iron_chestplate: f.ironChestplate || 0,
    iron_leggings: f.ironLeggings || 0, iron_boots: f.ironBoots || 0,
    diamond_helmet: f.diamondHelmet || 0, diamond_chestplate: f.diamondChestplate || 0,
    diamond_leggings: f.diamondLeggings || 0, diamond_boots: f.diamondBoots || 0,
    // Worn counts ride beside the pack counts (revmux 01 core-1/body-1):
    // owner math (tossed, hand) must read the pack only, or a worn self
    // piece holds a tossed spare in 'hand' forever — gear infeasible, the
    // tick never reconciles, the ladder freezes (survives restarts via
    // the persisted ledger). Only the self branch adds worn.
    worn_iron_helmet: f.wornIronHelmet || 0, worn_iron_chestplate: f.wornIronChestplate || 0,
    worn_iron_leggings: f.wornIronLeggings || 0, worn_iron_boots: f.wornIronBoots || 0,
    worn_diamond_helmet: f.wornDiamondHelmet || 0, worn_diamond_chestplate: f.wornDiamondChestplate || 0,
    worn_diamond_leggings: f.wornDiamondLeggings || 0, worn_diamond_boots: f.wornDiamondBoots || 0,
    tablePlaced: !!f.tablePlaced, furnaceClaim,
    furnaceItem: f.furnaceItem || 0, cobble: f.cobble || 0, fuel: f.coal || 0,
  }
}

// Menu-world entry: counts + impl presence + furnace-busy in one call, so
// MENU.feasible, stepWhy, and the goalText bucket share one source.
function menuPlan(facts, ctx) {
  const counts = countsFromFacts(facts, ctx)
  let busy = false
  try {
    busy = !!(ctx.furnace && !ctx.furnace.settled)
  } catch (_) { /* no run in flight */ }
  let furnace = false
  let deep = false
  try {
    furnace = !!legImpl(ctx, 'furnace')
    deep = !!legImpl(ctx, 'deep')
  } catch (_) { /* slices unreadable */ }
  return planFor(counts, ctx, { furnace, deep }, busy)
}

// The single planning source for MENU.feasible, stepWhy, goalText, and the
// tick: pure over counts + ctx (ledger read-only here).
//
// counts: liveCounts (tick) or countsFromFacts (menu) shape.
// impls: { furnace: bool, deep: bool } — slice-A/B presence.
// furnaceBusy: a furnace run is mid-flight (its phases own the tick).
//
// Returns { state, key } plus, by state: ready -> { action },
// want/wait -> { key, line } (the latched announce line).
function planFor(counts, ctx, impls, furnaceBusy) {
  const c = counts || {}
  const im = impls || {}
  let given = {}
  try {
    given = (ctx && ctx.gearGiven) || {}
  } catch (_) {
    given = {}
  }
  let noWater = false
  try {
    noWater = !!(ctx && ctx.gear && ctx.gear.noWater)
  } catch (_) { /* water unknown: rungs flow */ }
  for (let ti = 0; ti < RUNGS.length; ti++) {
    const rung = RUNGS[ti]
    for (let pi = 0; pi < rung.pieces.length; pi++) {
      const piece = rung.pieces[pi]
      // Dry home (jsf.5): the bucket rung is skipped, the ladder walks on.
      if (piece.filled && noWater) continue
      const name = pieceName(rung, piece)
      if (piece.owner) {
        if ((given[name] || 0) >= (OWNER_WANT[name] || 1) || tossed(name, c[name] || 0, ctx)) continue
      } else {
        // Self armour reads worn plus packed (deriveNext selfHave shape);
        // tools read the pack. Worn adds ONLY here — the owner branch
        // above and the hand check below stay pack-only (core-1/body-1).
        const wornN = (piece.kind && ARMOR_DEST[piece.kind]) ? (c['worn_' + name] || 0) : 0
        if ((c[name] || 0) + wornN >= selfWant(name)) continue
      }
      return planPiece(rung, piece, name, c, im, furnaceBusy, ctx)
    }
  }
  return { state: 'done', key: 'done' }
}

function planPiece(rung, piece, name, c, im, furnaceBusy, ctx) {
  const kind = piece.kind
  // Awaiting handover: forged for the owner, still held past the reserve.
  // Infeasible by design — deliver/stockpile own the next move — so the
  // ladder yields silently instead of begging mats for a finished piece.
  if (piece.owner) {
    let made = false
    try {
      made = !!(ctx && ctx.gear && ctx.gear.made && ctx.gear.made[name])
    } catch (_) { /* unmade */ }
    if (made && (c[name] || 0) > reserve(name)) return { state: 'hand', key: `hand-${name}`, name }
  }
  // Bucket fill (jsf.5): an empty on hand fills before anything new is
  // crafted — a fresh forge and a leftover (lost scoop refill, gifted
  // empty) rejoin the same sub-step.
  if (piece.filled && (c[piece.item] || 0) > 0) return { state: 'ready', key: 'ready', action: 'fill' }
  const needMat = MAT_NEED[kind]
  const needSticks = STICK_NEED[kind]
  const matHave = rung.tier === 'iron' ? (c.ingots || 0) : (c.diamonds || 0)
  // Sticks first: the cheapest op, and a stick shortfall with mats on hand
  // must not read as a mat want.
  if ((c.sticks || 0) < needSticks) {
    if ((c.planks || 0) >= 2) return { state: 'ready', key: 'ready', action: 'sticks' }
    if ((c.logs || 0) >= 1) return { state: 'ready', key: 'ready', action: 'planks' }
    return { state: 'want', key: 'want-logs', line: 'need logs for sticks, going to chop' }
  }
  if (matHave >= needMat) {
    if (!c.tablePlaced) return { state: 'wait', key: 'wait-table', line: 'need a crafting table at home' }
    return { state: 'ready', key: 'ready', action: 'craft' }
  }
  const short = needMat - matHave
  if (rung.tier === 'diamond') {
    // Pantry first (ipn.6): stranded chest diamonds beat an expedition.
    if (pantryFresh(ctx)) return { state: 'ready', key: 'ready', action: 'withdraw' }
    // Buried cells are undiggable by forage (ipn.2): without the deep leg
    // the want is unactionable, so it waits instead of announcing a dig.
    if (!im.deep) return { state: 'wait', key: 'wait-deep', line: 'waiting on the deep shaft for diamonds' }
    return { state: 'ready', key: 'ready', action: 'deep' }
  }
  // Iron: smeltable ore on hand, or ore to fetch, or a slice to wait for.
  const oreHave = c.ironOre || 0
  if (furnaceBusy) return { state: 'ready', key: 'ready', action: 'smelt' }
  if (oreHave > 0) {
    // ipn.13: the furnace burns coal to zero, then planks (2 smelt 3 ore).
    if ((c.fuel || 0) === 0 && (c.planks || 0) < 2) return { state: 'want', key: 'want-coal', line: `need coal or planks to smelt ${oreHave} ore, going to dig` }
    if (!im.furnace) return { state: 'wait', key: 'wait-furnace', line: `waiting on the furnace to smelt ${oreHave} ore` }
    if (!c.furnaceClaim && !c.furnaceItem && (c.cobble || 0) < 8) {
      return { state: 'want', key: 'want-cobble', line: 'need 8 cobble for the furnace, going to dig' }
    }
    return { state: 'ready', key: 'ready', action: 'smelt' }
  }
  // Pantry first (ipn.6): a banked batch draws before the fetchers walk.
  if (pantryFresh(ctx)) return { state: 'ready', key: 'ready', action: 'withdraw' }
  return { state: 'want', key: 'want-ore', line: `need ${short} more raw iron, going to dig` }
}

// ---- live world ----

// Verified table claim (h9z, furnace tableBlock shape): the claim plus a
// live block read. Verified-different is a ghost (mined table); null or a
// throwing read keeps the claim — an unloaded chunk is unknown, never gone.
function stationStanding(bot, tablePos) {
  try {
    if (!tablePos || typeof tablePos.x !== 'number') return false
    let block = null
    try {
      block = bot && bot.blockAt ? bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z)) : null
    } catch (_) {
      return true
    }
    if (!block) return true
    return block.name === 'crafting_table'
  } catch (_) {
    return true
  }
}

function liveCounts(bot, ctx) {
  let planks = 0
  let logs = 0
  try {
    const items = (bot && bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()) || []
    const perWood = {}
    for (const i of items) {
      if (!i || typeof i.name !== 'string') continue
      const n = typeof i.count === 'number' ? i.count : 1
      if (i.name.endsWith('_planks')) perWood[i.name] = (perWood[i.name] || 0) + n
      else if (i.name.endsWith('_log')) logs += n
    }
    for (const v of Object.values(perWood)) {
      if (v > planks) planks = v
    }
  } catch (_) { /* unscannable reads empty */ }
  let tablePlaced = false
  let furnaceClaim = false
  try {
    // Verified like the menu world (h9z: countsFromFacts reads the verified
    // facts.tablePlaced): a ghost claim waits for a rebuild instead of
    // failing no-table every pick. Null reads unloaded, never gone. Both
    // claims verify (goalFacts mirror, revmux 01 major): a ghost home.table
    // must not shadow the standing roadside table or the tick yields
    // wait-table forever while the menu offers gear.
    tablePlaced = !!stationStanding(bot, (ctx && ctx.home && ctx.home.table)) ||
      !!stationStanding(bot, (ctx && ctx.claimedTable))
    furnaceClaim = !!(ctx && ctx.home && ctx.home.furnace)
  } catch (_) { /* no stations */ }
  // Armour: pack counts under the item name (owner math reads these —
  // revmux 01 core-1/body-1), worn counts beside them for the self branch.
  const armor = (name) => have(bot, name)
  const wornArmor = (name) => wornItems(bot, name)
  return {
    ironOre: have(bot, 'raw_iron'), ingots: have(bot, 'iron_ingot'), diamonds: have(bot, 'diamond'),
    sticks: have(bot, 'stick'), planks, logs,
    iron_pickaxe: have(bot, 'iron_pickaxe'), iron_sword: have(bot, 'iron_sword'),
    diamond_pickaxe: have(bot, 'diamond_pickaxe'), diamond_sword: have(bot, 'diamond_sword'),
    bucket: have(bot, 'bucket'), water_bucket: have(bot, 'water_bucket'),
    iron_helmet: armor('iron_helmet'), iron_chestplate: armor('iron_chestplate'),
    iron_leggings: armor('iron_leggings'), iron_boots: armor('iron_boots'),
    diamond_helmet: armor('diamond_helmet'), diamond_chestplate: armor('diamond_chestplate'),
    diamond_leggings: armor('diamond_leggings'), diamond_boots: armor('diamond_boots'),
    worn_iron_helmet: wornArmor('iron_helmet'), worn_iron_chestplate: wornArmor('iron_chestplate'),
    worn_iron_leggings: wornArmor('iron_leggings'), worn_iron_boots: wornArmor('iron_boots'),
    worn_diamond_helmet: wornArmor('diamond_helmet'), worn_diamond_chestplate: wornArmor('diamond_chestplate'),
    worn_diamond_leggings: wornArmor('diamond_leggings'), worn_diamond_boots: wornArmor('diamond_boots'),
    tablePlaced, furnaceClaim,
    furnaceItem: have(bot, 'furnace'), cobble: have(bot, 'cobblestone'),
    fuel: have(bot, 'coal') + have(bot, 'charcoal'),
  }
}

// Sub-behaviour resolution: ctx.gearLegs fakes (tests) win, then the real
// slice module. A missing module reads as absent, never throws: the plan
// waits on the slice instead of failing the step.
function legImpl(ctx, name) {
  try {
    if (ctx && ctx.gearLegs && typeof ctx.gearLegs[name] === 'function') return ctx.gearLegs[name]
  } catch (_) { /* fall through to the real module */ }
  try {
    const mod = name === 'furnace' ? require('./furnace') : require('./deep')
    return typeof mod === 'function' ? mod : null
  } catch (_) {
    return null
  }
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:gear-${item}`
  try {
    runCtx(ctx).walkTicks = 0
  } catch (_) { /* reset best-effort */ }
  try {
    console.error(`gear failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// Walk one leg with a give-up (furnace shape): an unreachable station fails
// the step instead of idling here forever.
function walkTo(bot, ctx, key, p, reason) {
  if (key !== ctx.lastGoalKey) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 3), false)
    } catch (_) { /* retry next tick */ }
    ctx.lastGoalKey = key
  }
  const r = runCtx(ctx)
  r.walkTicks = (r.walkTicks || 0) + 1
  if (r.walkTicks > WALK_GIVE_UP) fail(ctx, reason)
}

// Stop a stale walk before a look-dependent op (z80): a walk goal left
// live (the fill walk scoops from reach 4 while its GoalNear range is 2,
// so it never reaches and never clears) keeps steering the head every
// physics tick. The steer wins the race against the op's lookAt, the
// server's recorded look misses the station, and the use is silently
// ignored — 20 s windowOpen timeouts on table crafts. Clearing only when
// a goal is actually live keeps arrived walks (already auto-cleared) and
// goal-less mocks untouched; the key clears unconditionally so the next
// walk re-issues even for the same station.
function stopSteering(bot, ctx) {
  try {
    const live = bot && bot.pathfinder && bot.pathfinder.goal
    if (live && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null)
  } catch (_) { /* best-effort */ }
  try {
    if (ctx) ctx.lastGoalKey = ''
  } catch (_) { /* best-effort */ }
}

// Verified crafting table: one reader with the furnace step (g0z.36), so
// a castle home's storeroom table counts for every gear/craftany craft.
function tableBlock(bot, ctx) {
  return require('./furnace').tableBlock(bot, ctx)
}

// ---- bucket fill (jsf.5) ----

// Fill search radius (bead ~32, from home or self); candidates per scan;
// scoop reach (TABLE_REACH shape — the server raycast is 4.5, waterup
// USE_REACH); the dry latch only fires with home in range, so a far leg
// walks home instead of skipping the rung on an unloaded chunk; per-cell
// patience (WALK_GIVE_UP shape); verify window (phantom-settle shape).
const FILL_SEARCH = 32
const FILL_FIND_COUNT = 8
const FILL_SCAN_COUNT = 512
const DRY_LATCH_TICKS = 20
const FILL_REACH = 4
const FILL_NEAR_HOME = 16
const FILL_WALK_TICKS = 20
const FILL_SETTLE_MS = 500

function waterId(bot) {
  try {
    const byName = (bot.registry && bot.registry.blocksByName) || {}
    const e = byName.water
    if (e && typeof e.id === 'number') return e.id
  } catch (_) { /* unresolvable */ }
  return null
}

// Nearest-first SOURCE water cells from the body, tried ones excluded.
// Fill wherever water is; the home anchor below only gates the dry
// latch. The scan is deep (z80): findBlocks slices to count BEFORE we
// filter, so a shallow count hides farther sources behind nearer flow —
// re-flow plumes outrank 40+ deep on prod terrain — and latches a wet
// home dry. 512 needs 512 nearer flow cells to mask a source, which a
// still-water source never has; the depth costs nothing extra
// (findBlocks scans the sphere either way and only sorts/slices more).
// The tried widening (revmux jsf.5-01 core-2/body-2) rides along.
// Returns { out, flow }: the flow count tells the latch whether water
// is present-but-flowing (settle patience) or absent (instant latch).
function findWater(bot, tried) {
  try {
    if (!bot || typeof bot.findBlocks !== 'function') return { out: [], flow: 0 }
    const id = waterId(bot)
    if (id === null) return { out: [], flow: 0 }
    const skip = tried ? Object.keys(tried).length : 0
    const found = bot.findBlocks({ matching: [id], maxDistance: FILL_SEARCH, count: FILL_SCAN_COUNT + skip }) || []
    const out = []
    let flow = 0
    for (const p of found) {
      if (!p || typeof p.x !== 'number') continue
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      if (tried && tried[key]) continue
      if (isFlowWater(bot, p)) {
        flow++
        continue
      }
      out.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), key })
    }
    return { out, flow }
  } catch (_) {
    return { out: [], flow: 0 }
  }
}

// Confirmed-flow check (z80): nearest-first over flow cells chases
// re-flow and 2x2 spread away from the source — each miss re-targets, so
// the bot spirals outward and never fills in cap. Only level-0 water
// scoops. Lenient by design: unreadable cells (mocks, chunk edges) stay
// candidates — excluding only PROVEN flow never strands a rung the old
// scan would have filled.
function isFlowWater(bot, p) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(p) : null
    if (!b) return false
    let level = null
    if (typeof b.getProperties === 'function') {
      const props = b.getProperties()
      if (props && props.level != null) level = props.level
    }
    if (level == null && typeof b.metadata === 'number') level = b.metadata
    if (level == null) return false
    const n = typeof level === 'number' ? level : parseInt(level, 10)
    return Number.isFinite(n) && n !== 0
  } catch (_) {
    return false
  }
}

function nearHomeSite(bot, ctx, r) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    const s = ctx && ctx.home && ctx.home.site
    if (!bp || !s || typeof s.x !== 'number') return false
    return Math.hypot(bp.x - s.x, bp.y - s.y, bp.z - s.z) <= r
  } catch (_) {
    return false
  }
}

function findBucket(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && i.name === 'bucket') return i
      }
    }
  } catch (_) { /* unscannable */ }
  return null
}

// Fill one empty at a water cell: equip, aim, use (buckets work ONLY via
// lookAt + activateItem, the server raycast — placeBlock is silently
// ignored for buckets on Paper, jsf.1 verdict), then verify water_bucket
// +1. The ledger lands here, not at the craft: forged() on an empty would
// hand deliver a claim for a bucket that holds no water yet.
function runFillOp(bot, ctx, next, t, aim) {
  if (typeof bot.activateItem !== 'function') {
    fail(ctx, 'fill-no-use')
    return
  }
  let before = 0
  try {
    before = have(bot, 'water_bucket')
  } catch (_) { /* unverifiable: trust the op */ }
  const snap = { name: next.name, owner: next.owner }
  ctx.gearInFlight = true
  void (async () => {
    try {
      const item = findBucket(bot)
      if (!item) {
        ctx.gearInFlight = false
        return // raced the empty: re-plan retries or re-forges
      }
      if (typeof bot.equip !== 'function') {
        ctx.gearInFlight = false
        fail(ctx, 'fill-no-equip')
        return
      }
      await bot.equip(item, 'hand')
      try {
        bot.lookAt(aim, true)
      } catch (_) { /* aim best-effort */ }
      bot.activateItem()
    } catch (_) {
      ctx.gearInFlight = false
      return // transient window race: re-plan retries the same cell
    }
    await new Promise((resolve) => setTimeout(resolve, FILL_SETTLE_MS))
    ctx.gearInFlight = false
    let landed = false
    try {
      landed = have(bot, 'water_bucket') > before
    } catch (_) { /* unverifiable: trust the op */ }
    if (!landed) {
      // Flowing cell or a missed raycast (only sources fill): next one.
      try {
        const r = runCtx(ctx)
        if (!r.fillTried || typeof r.fillTried !== 'object') r.fillTried = {}
        r.fillTried[t.key] = true
      } catch (_) { /* retry best-effort */ }
      return
    }
    try {
      forged(bot, ctx, snap)
    } catch (_) { /* completion best-effort */ }
  })()
}

function fillTick(bot, ctx, next) {
  const g = gearCtx(ctx)
  const r = runCtx(ctx)
  // The tried-set lives one empty: a fresh empty re-arms every cell.
  let empties = 0
  try {
    empties = have(bot, 'bucket')
  } catch (_) { /* unscannable */ }
  if (r.fillEmpties !== empties) {
    r.fillEmpties = empties
    r.fillTried = {}
    r.fillTarget = null
    r.fillWalkKey = null
    r.fillWalkTicks = 0
  }
  if (!r.fillTried || typeof r.fillTried !== 'object') r.fillTried = {}
  // Locked target (revmux jsf.5-01 body-3): re-picking the nearest cell
  // every tick resets the walk give-up whenever the body moves past a
  // nearer cell, so an unreachable cell is never marked tried. The lock
  // holds until the cell fills, fails, or times out.
  if (!r.fillTarget || r.fillTried[r.fillTarget.key]) r.fillTarget = null
  const scan = findWater(bot, r.fillTried)
  const cands = scan.out
  if (cands.length === 0) {
    if (nearHomeSite(bot, ctx, FILL_NEAR_HOME)) {
      if (scan.flow > 0) {
        // Present-but-flowing (z80): a settling 2x2 or passing re-flow
        // reads sourceless for a few ticks — hold, don't latch; sources
        // usually appear within a couple of seconds, and a truly
        // flow-only home still latches after the patience runs out.
        r.dryTicks = (r.dryTicks || 0) + 1
        if (r.dryTicks < DRY_LATCH_TICKS) return
      }
      // Dry home: say once, skip the rung, the ladder walks on. The latch
      // is session-scoped — water near home is static, and a re-scan every
      // gear visit would cost a scan per rung forever.
      try {
        g.noWater = true
      } catch (_) { /* latch best-effort */ }
      try {
        r.fillTried = {}
      } catch (_) { /* reset best-effort */ }
      announceYield(ctx, g, bot, 'want-water', 'need water for the bucket')
      return
    }
    // Water may wait at home: walk there like the table walk (craft
    // precedent — the give-up fails loud instead of idling far away).
    const s = ctx.home.site
    walkTo(bot, ctx, `gear-home:${s.x},${s.y},${s.z}`, s, 'home-far')
    return
  }
  r.dryTicks = 0
  if (!r.fillTarget) r.fillTarget = cands[0]
  const t = r.fillTarget
  const bp = bot.entity.position
  const aim = new Vec3(t.x + 0.5, t.y + 0.5, t.z + 0.5)
  if (dist3(bp, aim) > FILL_REACH) {
    const key = `gear-water:${t.key}`
    if (r.fillWalkKey !== key) {
      r.fillWalkKey = key
      r.fillWalkTicks = 0
    }
    if (key !== ctx.lastGoalKey) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 2), false)
      } catch (_) { /* retry next tick */ }
      ctx.lastGoalKey = key
    }
    r.fillWalkTicks = (r.fillWalkTicks || 0) + 1
    if (r.fillWalkTicks > FILL_WALK_TICKS) {
      // Unreachable cell: try the next one, never fail the ladder — water
      // behind a wall reads as no water (skip, don't stall). The walk
      // goal stops too (revmux z80-01 core-1): leaving it live steers
      // the head through the patience hold and the next retarget.
      r.fillTried[t.key] = true
      r.fillTarget = null
      r.fillWalkKey = null
      r.fillWalkTicks = 0
      stopSteering(bot, ctx)
    }
    return
  }
  r.fillWalkKey = null
  r.fillWalkTicks = 0
  runFillOp(bot, ctx, next, t, aim)
}

// One 2x2 op (sticks, planks) or 3x3 tool op. { fail } when stuck.
function opSticks(bot) {
  const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
  if (planks.length === 0 || planks[0][1] < 2) return { fail: 'no-planks' }
  const found = craftMod.recipes(bot, 'stick', null)
  if (found.length === 0) return { fail: 'no-stick-recipe' }
  return { item: 'stick', recipe: found[0], count: 1, table: null }
}

function opPlanks(bot) {
  const logs = craftMod.sortedWoods(craftMod.tally(bot, '_log'))
  if (logs.length === 0) return { fail: 'no-logs' }
  const found = craftMod.recipes(bot, `${logs[0][0]}_planks`, null)
  if (found.length === 0) return { fail: 'no-planks-recipe' }
  return { item: `${logs[0][0]}_planks`, recipe: found[0], count: 1, table: null }
}

function opTool(bot, name, table) {
  const found = craftMod.recipes(bot, name, table)
  if (found.length === 0) return { fail: `no-${name}-recipe` }
  return { item: name, recipe: found[0], count: 1, table }
}

const PHANTOM_RETRIES = 3
const PHANTOM_SETTLE_MS = 500 // model packets land well inside this
function runOp(bot, ctx, op, onDone) {
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  let before = 0
  try {
    before = have(bot, op.item)
  } catch (_) { /* unverifiable: trust the op */ }
  ctx.gearInFlight = true
  void (async () => {
    try {
      await craftMod.safeCraft(bot, op.recipe, op.count, op.table, { ctx, item: op.item })
    } catch (err) {
      ctx.gearInFlight = false
      fail(ctx, op.item, err)
      return
    }
    // Always settle before the single check: a ghost model entry (craft
    // resolved, product visible, server reverts it within a round-trip)
    // passes an immediate check. 500 ms of craft time is nothing next to
    // a false forge (2 ingots + a rung of chat). inFlight stays up through
    // the settle: the op is not done until verified, and a tick inside the
    // window must not re-issue on a stale model.
    await new Promise((resolve) => setTimeout(resolve, PHANTOM_SETTLE_MS))
    // g0z.25: the settled model still misses landed products (assayed on
    // Paper 26.1.2 — the product packets trail the op), so the phantom
    // judge reads post-resync truth, never the raw model.
    try { await craftMod.syncInventory(bot) } catch (_) { /* unverified: the recount below still decides */ }
    ctx.gearInFlight = false
    let landed = true
    try {
      landed = have(bot, op.item) > before
    } catch (_) { /* unverifiable: trust the op */ }
    if (!landed) {
      const r = runCtx(ctx)
      const n = (r.phantomTicks || 0) + 1
      r.phantomTicks = n
      try {
        console.error(`gear phantom craft item=${op.item} try=${n}`)
      } catch (_) { /* logging best-effort */ }
      if (n > PHANTOM_RETRIES) {
        r.phantomTicks = 0
        try { console.error(`gear craft-no-product item=${op.item} slots: ${craftMod.slotSummary(bot)}`) } catch (_) { /* logging best-effort */ }
        fail(ctx, op.item, new Error('craft-no-product'))
      }
      return // transient: re-plan re-issues next tick
    }
    try {
      runCtx(ctx).phantomTicks = 0
    } catch (_) { /* reset best-effort */ }
    try {
      if (typeof onDone === 'function') onDone()
    } catch (_) { /* completion best-effort */ }
  })()
}

// Drive a sub-behaviour for one tick, translating its step report into a
// gear-owned outcome: null while it runs, 'done', or 'failed:<reason>'.
// The gear step's own status is saved and restored — a subroutine must never
// end the step (ipn.1 contract: outcome reads result first, then the relay).
// A synchronously read stamp is consumed (nulled) so decide's async
// reconciliation below never sees it twice.
function driveLeg(bot, ctx, impl, resultOf, consume) {
  const keep = ctx.stepStatus
  try {
    ctx.stepStatus = 'running'
  } catch (_) { /* status best-effort */ }
  try {
    impl(bot, ctx)
  } catch (err) {
    try {
      ctx.stepStatus = keep
    } catch (_) { /* restore best-effort */ }
    return `failed:leg-threw:${err && err.message ? err.message : err}`
  }
  let out = null
  try {
    out = resultOf(ctx)
    if (out && typeof consume === 'function') {
      try {
        consume(ctx)
      } catch (_) { /* consume best-effort */ }
    }
    if (!out) {
      const s = ctx.stepStatus
      if (s && s !== 'running') out = s
    }
  } catch (_) {
    out = null
  }
  try {
    ctx.stepStatus = keep
  } catch (_) { /* restore best-effort */ }
  return out
}

function driveFurnace(bot, ctx, impl) {
  return driveLeg(bot, ctx, impl, (c) => {
    try {
      return (c.furnace && c.furnace.result) || null
    } catch (_) {
      return null
    }
  }, (c) => {
    try {
      if (c.furnace) c.furnace.result = null
    } catch (_) { /* consume best-effort */ }
  })
}

function driveDeep(bot, ctx, impl) {
  return driveLeg(bot, ctx, impl, () => null) // stepStatus relay only (ipn.2)
}

// A forged owner piece rides both handover channels at once: the haul for
// an online player (deliver), the finished record for the home chest
// (stockpile). Both clamp to the live pack, so a toss and a bank can never
// double-spend the same tool.
function forged(bot, ctx, next) {
  const g = gearCtx(ctx)
  try {
    if (next.owner) {
      if (!g.made) g.made = {}
      g.made[next.name] = true
      // Exact-set, not addHaul (+=): one piece per name per ladder, so the
      // forge asserts exactly one unhanded unit. A retried craft (phantom
      // first op, death reforge) must not stack claims per attempt.
      if (!ctx.haul || typeof ctx.haul !== 'object') ctx.haul = {}
      ctx.haul[next.name] = 1
      if (!ctx.gearFinished || typeof ctx.gearFinished !== 'object') ctx.gearFinished = {}
      ctx.gearFinished[next.name] = 1
    }
  } catch (_) { /* ledger best-effort */ }
  say(bot, `forged ${next.name} for ${next.owner ? 'you' : 'me'}`)
  try {
    console.log(`gear forged ${next.name} for ${next.owner ? 'owner' : 'self'}`)
  } catch (_) { /* logging best-effort */ }
  try {
    metrics.gearForged.inc({ piece: next.name, owner: next.owner ? 'owner' : 'self' })
  } catch (_) { /* metrics best-effort */ }
}

// Self armour goes on the body at the forge (ipn.6): find the fresh piece
// in the pack and equip it to its slot (an upgrade swaps the old tier down
// to the pack — TOOL_KEEP holds it there, clutter, not a stall). The rung
// reads complete from worn+packed either way, so a failed equip strands the
// piece in the pack instead of stalling or reforging; death heals it (the
// pack loss re-derives the rung). inFlight through the settle, fill shape.
// Owner pieces never come here — only the tick's self branch calls this.
const WEAR_SETTLE_MS = 500
const WEAR_RETRIES = 3
function wearSelf(bot, ctx, name, kind) {
  const dest = (kind && ARMOR_DEST[kind]) || null
  if (!dest || !bot || typeof bot.equip !== 'function') return
  let item = null
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) item = items.find((i) => i && i.name === name) || null
  } catch (_) { item = null }
  if (!item) return
  ctx.gearInFlight = true
  void (async () => {
    // Bounded retries (revmux 01 core-2): a lag-rejected equip heals on
    // the spot instead of stranding the self piece in the pack, where the
    // owner twin would later spend it. A persistently failing equip still
    // strands (logged) rather than stall — death heals it.
    let on = false
    for (let n = 0; n < WEAR_RETRIES && !on; n++) {
      try {
        await bot.equip(item, dest)
      } catch (_) { /* unverifiable below: the settle decides */ }
      await new Promise((resolve) => setTimeout(resolve, WEAR_SETTLE_MS))
      try {
        on = wornItems(bot, name) > 0
      } catch (_) { on = true }
    }
    ctx.gearInFlight = false
    if (!on) {
      try {
        console.error(`gear wear failed item=${name}`)
      } catch (_) { /* logging best-effort */ }
    }
  })()
}

// Pantry withdraw (ipn.6): draw the rung's shortfall from the adopted home
// chest — ingots first (direct), then smeltable ore; diamonds exact. One
// window per name (bringitem.withdrawCraftMats shape), stockpile deferred
// (legImpl precedent — no new import edge). The seen latch lands on a
// short or errored draw only: a wedged lid yields to the fetchers instead
// of looping, while a satisfied draw keeps the batch open for the next
// rung; any future bank re-arms. Next tick re-plans (smelt/craft on stock,
// the latched want/deep otherwise) — no fallback lines here.
function runWithdraw(bot, ctx, next) {
  let stockpileMod = null
  try {
    stockpileMod = require('./stockpile')
  } catch (_) { stockpileMod = null }
  const g = gearCtx(ctx)
  if (!stockpileMod || typeof stockpileMod.withdrawFromChest !== 'function') {
    try {
      g.pantrySeen = ctx.gearPantryBanked || 0
    } catch (_) { /* latch best-effort */ }
    return
  }
  ctx.gearInFlight = true
  void (async () => {
    let errored = false
    try {
      const draw = async (name, want) => {
        if (!(want > 0)) return
        await stockpileMod.withdrawFromChest(bot, ctx, name, want)
      }
      if (next.tier === 'iron') {
        await draw('iron_ingot', Math.max(0, (next.needMat || 0) - have(bot, 'iron_ingot')))
        await draw('raw_iron', Math.max(0, (next.needMat || 0) - have(bot, 'iron_ingot') - have(bot, 'raw_iron')))
      } else {
        await draw('diamond', Math.max(0, (next.needMat || 0) - have(bot, 'diamond')))
      }
    } catch (_) { errored = true }
    ctx.gearInFlight = false
    try {
      // Latch on the end state, not the request sum (revmux 02): a rung
      // covered by the draw leaves the pantry fresh, so the next
      // mat-short rung draws from the same batch instead of digging past
      // it. Summing per-draw wants double-counts the iron path (ingot
      // shortfall plus ore remainder) and latches a satisfied rung. A
      // covered pack re-plans to smelt/craft, a short one latches to
      // want/deep — no withdraw loop either way.
      const need = next.needMat || 0
      const stock = next.tier === 'iron'
        ? have(bot, 'iron_ingot') + have(bot, 'raw_iron')
        : have(bot, 'diamond')
      if (errored || stock < need) g.pantrySeen = ctx.gearPantryBanked || 0
    } catch (_) { /* latch best-effort */ }
  })()
}

// Latched announce + yield: fetchers run (want) or slices land (wait). The
// yield is done, never failed — failing would hold the step while another
// step can fix the shortfall. The latch doubles as the MENU.feasible gate:
// a latched need reads infeasible until a new need arrives.
function announceYield(ctx, g, bot, key, line) {
  if (g.saidNeed !== key) {
    g.saidNeed = key
    say(bot, line)
    try {
      console.log(`gear yield key=${key} line=${line}`) // ipn.15: the chat alone never reaches the logs
    } catch (_) { /* logging best-effort */ }
  }
  ctx.stepStatus = 'done'
}

// Honest want lines (idkcraft-ipn.9): 'going to dig' is a promise forage
// keeps through its latch preference — but only while the want names a
// remembered, pickaxe-diggable, unstruck cell. Without one the need is
// announced without the promise; the latch still stands, so a later find
// sends forage out with no re-announce. Single source for the sync
// announces here and the async furnace translation in goal.js. Cobble is
// absent on purpose: stone is not a memory resource (scan notes ores+logs
// only), so a memory check would always misreport it — its fetch gap is a
// separate bead. Fail-open: a broken check keeps the old line, never gags.
const HONEST_WANT = {
  'want-ore': 'need raw iron, none known',
  'want-coal': 'need coal or planks, none known',
}

function honestLine(bot, ctx, bp, key, line) {
  const honest = HONEST_WANT[key]
  if (!honest) return line
  try {
    const forageMod = require('./forage')
    if (forageMod.gearWantCell(bot, ctx, bp, key)) return line
  } catch (_) {
    return line
  }
  return honest
}

function gear(bot, ctx, target, state) {
  if (!ctx) return
  if (ctx.gearInFlight || ctx.furnaceInFlight) return // exactly one window op at a time
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return
  const home = ctx.home
  if (!home || !home.site || !home.built) return // menu gates built; a race yields silently
  reconcile(ctx, bot)
  const g = gearCtx(ctx)
  const next = deriveNext(bot, ctx)
  const counts = liveCounts(bot, ctx)
  let busy = false
  try {
    busy = !!(ctx.furnace && !ctx.furnace.settled)
  } catch (_) { /* no run in flight */ }
  const im = { furnace: !!legImpl(ctx, 'furnace'), deep: !!legImpl(ctx, 'deep') }
  const plan = planFor(counts, ctx, im, busy)
  if (!next || plan.state === 'done') {
    try {
      console.log('gear ladder complete')
    } catch (_) { /* logging best-effort */ }
    ctx.stepStatus = 'done'
    return
  }
  const key = `${next.tier}:${next.kind}:${next.owner ? 'give' : 'self'}`
  if (g.lastKey !== key) {
    g.lastKey = key
    g.saidNeed = null // new rung, new needs: the latch must not gag them
    say(bot, `next gear: ${next.name} for ${next.owner ? 'you' : 'me'}`)
    try {
      console.log(`gear rung ${key}`)
    } catch (_) { /* logging best-effort */ }
  }
  if (plan.state === 'hand') {
    if (g.saidHand !== plan.key) {
      g.saidHand = plan.key // log once per piece, like the yield latch
      try {
        console.log(`gear hand ${plan.name}`)
      } catch (_) { /* logging best-effort */ }
    }
    ctx.stepStatus = 'done' // handover steps own it; silent in chat
    return
  }
  if (plan.state === 'want' || plan.state === 'wait') {
    announceYield(ctx, g, bot, plan.key, honestLine(bot, ctx, bp, plan.key, plan.line))
    return
  }
  if (plan.state !== 'ready') {
    ctx.stepStatus = 'done' // unknown state: safe yield, never a hold
    return
  }
  if (plan.action === 'sticks') {
    const op = opSticks(bot)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    runOp(bot, ctx, op)
    return
  }
  if (plan.action === 'planks') {
    const op = opPlanks(bot)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    runOp(bot, ctx, op)
    return
  }
  if (plan.action === 'smelt') {
    const impl = legImpl(ctx, 'furnace')
    if (!impl) {
      ctx.stepStatus = 'done' // raced the slice: re-plan next tick
      return
    }
    const out = driveFurnace(bot, ctx, impl)
    if (!out) return // leg in progress
    if (out === 'done') return // ingots landed; re-plan next tick
    const reason = out.startsWith('failed:') ? out.slice('failed:'.length) : out
    if (reason === 'no-cobble') {
      announceYield(ctx, g, bot, 'want-cobble', honestLine(bot, ctx, bp, 'want-cobble', 'need 8 cobble for the furnace, going to dig'))
      return
    }
    if (reason === 'no-fuel') {
      announceYield(ctx, g, bot, 'want-coal', honestLine(bot, ctx, bp, 'want-coal', 'need coal or planks, going to dig'))
      return
    }
    fail(ctx, `furnace-${reason}`)
    return
  }
  if (plan.action === 'deep') {
    const impl = legImpl(ctx, 'deep')
    if (!impl) {
      ctx.stepStatus = 'done' // raced the slice: re-plan next tick
      return
    }
    const out = driveDeep(bot, ctx, impl)
    if (!out) return // leg in progress
    if (out === 'done') return // diamonds landed; re-plan next tick
    const reason = out.startsWith('failed:') ? out.slice('failed:'.length) : out
    fail(ctx, `deep-${reason}`)
    return
  }
  if (plan.action === 'withdraw') {
    const cpos = ctx.home && ctx.home.chest
    if (!cpos || typeof cpos.x !== 'number') {
      ctx.stepStatus = 'done' // raced the adoption: re-plan next tick
      return
    }
    if (dist3(bp, cpos) > craftMod.TABLE_REACH) {
      // Latch on the give-up tick (revmux 01 body-3): walkTo fails below
      // without recording, and an unlatched plan re-offers the same
      // unreachable walk every pick instead of degrading to want/deep.
      if ((runCtx(ctx).walkTicks || 0) >= WALK_GIVE_UP) {
        try {
          gearCtx(ctx).pantrySeen = ctx.gearPantryBanked || 0
        } catch (_) { /* latch best-effort */ }
      }
      walkTo(bot, ctx, `gear-chest:${cpos.x},${cpos.y},${cpos.z}`, cpos, 'chest-far')
      return
    }
    runCtx(ctx).walkTicks = 0
    stopSteering(bot, ctx) // z80: the chest open is look-dependent too
    runWithdraw(bot, ctx, next)
    return
  }
  if (plan.action === 'fill') {
    fillTick(bot, ctx, next)
    return
  }
  if (plan.action === 'craft') {
    const st = tableBlock(bot, ctx)
    if (!st) {
      fail(ctx, 'no-table')
      return
    }
    if (dist3(bp, st.pos) > craftMod.TABLE_REACH) {
      walkTo(bot, ctx, `gear-table:${st.pos.x},${st.pos.y},${st.pos.z}`, st.pos, 'table-far')
      return
    }
    runCtx(ctx).walkTicks = 0
    const op = opTool(bot, next.craft || next.name, st.block)
    if (op.fail) {
      fail(ctx, op.fail)
      return
    }
    // Buckets forge silently (jsf.5): the ledger (made/haul/finished) lands
    // at fill completion, so deliver never tosses the bot's own water for
    // an owner claim that holds no water yet. Self armour goes on the body
    // at the forge (ipn.6); owner armour rides the haul untouched.
    stopSteering(bot, ctx) // z80: no stale steer during the table use
    runOp(bot, ctx, op, () => {
      if (!next.fill) forged(bot, ctx, next)
      if (!next.owner && next.kind && ARMOR_DEST[next.kind]) wearSelf(bot, ctx, next.name, next.kind)
    })
    return
  }
  ctx.stepStatus = 'done' // unknown action: safe yield, never a hold
}

module.exports = gear
module.exports.RUNGS = RUNGS
module.exports.driveLeg = driveLeg // g0z.36: castlefetch runs a furnace tick in its own leg
module.exports.driveFurnace = driveFurnace
module.exports.OWNER_WANT = OWNER_WANT
module.exports.deriveNext = deriveNext
module.exports.reconcile = reconcile
module.exports.menuPlan = menuPlan
module.exports.honestLine = honestLine
module.exports.planFor = planFor
module.exports.countsFromFacts = countsFromFacts
module.exports.handoverWaiting = handoverWaiting
module.exports.tableBlock = tableBlock
module.exports.liveCounts = liveCounts
// Craft-any reuse (idkcraft-did.2): the verified single-op path, unmodified.
module.exports.opSticks = opSticks
module.exports.opPlanks = opPlanks
module.exports.runOp = runOp
