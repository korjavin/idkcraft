'use strict'

// World sources from minecraft-data (owner: solve the class, not per
// material). Pure leaf: an item's world source is its mob (small MOB
// table), else its recipe/furnace inputs' sources, else the blocks that
// drop it. explore's castle expedition and resources.scan read it;
// behaviours/acquire.js runs it.

const DEFAULT_REG = require('minecraft-data')('26.1.2')
const blueprint = require('./castle')
// Furnace edges the bring smelt rung runs (bringitem SMELT): output -> its
// raw input; raw null = any log (charcoal).
const SMELT = {
  iron_ingot: { raw: 'raw_iron', ore: 'iron_ore' },
  gold_ingot: { raw: 'raw_gold', ore: 'gold_ore' },
  copper_ingot: { raw: 'raw_copper', ore: 'copper_ore' },
  glass: { raw: 'sand', ore: 'sand' },
  charcoal: { raw: null, ore: 'logs' },
}
function smelt(item) { return SMELT[item] }

const MOB = [[/_wool$/, 'sheep']] // item -> mob that drops it (the hunts bring can run)
const DEPTH = 6

function regOf(bot) { const r = bot && bot.registry; return r && r.itemsByName && r.items && r.blocks && r.recipes ? r : DEFAULT_REG }

function mobsOf(item) { return MOB.filter(([re]) => re.test(item)).map(([, m]) => m) }

// Blocks whose drop is the item (minecraft-data block.drops).
function blocksOf(reg, item) {
  const it = reg.itemsByName[item]
  if (!it) return []
  return Object.values(reg.blocks).filter((b) => Array.isArray(b.drops) && b.drops.includes(it.id)).map((b) => b.name)
}

// Recipe (every variant) and furnace inputs of an item, by name.
function inputsOf(reg, item) {
  const it = reg.itemsByName[item]
  const out = new Set()
  for (const r of (it && reg.recipes && reg.recipes[it.id]) || []) {
    const ids = r.inShape ? r.inShape.flat() : (r.ingredients || [])
    for (const x of ids) {
      const id = x && typeof x === 'object' ? x.id : x
      const e = typeof id === 'number' && reg.items[id]
      if (e) out.add(e.name)
    }
  }
  const s = smelt(item)
  if (s) for (const n of s.raw ? [s.raw] : Object.keys(reg.itemsByName).filter((k) => k.endsWith('_log'))) out.add(n)
  return [...out]
}

// World sources of an item: its mob; else its inputs' sources (recipe or
// furnace); else the blocks that drop it. A craftable item's own block is a
// build, never a source (laid door, coal_block), so storage loops fall
// through to the ore.
function sources(bot, item, depth = 0, seen = new Set()) {
  const reg = regOf(bot)
  const out = { blocks: new Set(), mobs: new Set() }
  if (seen.has(item) || depth > DEPTH) return out
  seen.add(item)
  for (const m of mobsOf(item)) out.mobs.add(m)
  if (out.mobs.size) return out
  const inputs = inputsOf(reg, item)
  for (const i of inputs) {
    const s = sources(bot, i, depth + 1, seen)
    for (const b of s.blocks) out.blocks.add(b)
    for (const m of s.mobs) out.mobs.add(m)
  }
  if (out.blocks.size || out.mobs.size) return out
  for (const b of blocksOf(reg, item)) if (!(inputs.length && b === item) && !b.startsWith('potted_')) out.blocks.add(b)
  return out
}

// World source blocks of a castle kind (every item the blueprint lays for
// it, undyed). Stone is its own quarry path.
const KIND_CACHE = new Map()
function kindSources(kind) {
  if (!kind || kind === 'stone') return new Set()
  if (KIND_CACHE.has(kind)) return KIND_CACHE.get(kind)
  const out = new Set()
  for (const i of Object.keys(DEFAULT_REG.itemsByName)) {
    // a dyed variant is the plain item plus dye: its flowers are no source
    if (blueprint.matches(kind, i) && !inputsOf(DEFAULT_REG, i).some((n) => n.endsWith('_dye'))) for (const b of sources(null, i).blocks) out.add(b)
  }
  KIND_CACHE.set(kind, out)
  return out
}

// The plain item a kind is acquired as when the pack/chests name none:
// among the items the blueprint lays for the kind (undyed, with a world
// source), the one with the most interchangeable variants (family: any
// wood serves), then the shortest name (the base variant carries no
// prefix). Null when none has a source.
const ITEM_CACHE = new Map()
function kindItem(kind) {
  if (!kind) return null
  if (ITEM_CACHE.has(kind)) return ITEM_CACHE.get(kind)
  let best = null
  let key = null
  for (const i of Object.keys(DEFAULT_REG.itemsByName)) {
    if (!blueprint.matches(kind, i) || inputsOf(DEFAULT_REG, i).some((n) => n.endsWith('_dye'))) continue
    const s = sources(null, i)
    if (!s.blocks.size && !s.mobs.size) continue
    const k = [-family(i).length, i.length, i]
    const j = key ? k.findIndex((v, x) => v !== key[x]) : 0
    if (!key || (j >= 0 && k[j] < key[j])) { best = i; key = k }
  }
  ITEM_CACHE.set(kind, best)
  return best
}

// Interchangeable variants of an item: same name suffix after the first
// '_' and the same recipe shape once each item's own prefix is dropped
// (oak_log -> every *_log, stripped too; oak_planks -> every log-made *_planks; never
// iron_door for oak_door, never gold for iron). The item first.
const FAMILY_CACHE = new Map()
function family(item) {
  if (FAMILY_CACHE.has(item)) return FAMILY_CACHE.get(item)
  const cut = item.indexOf('_')
  let out = [item]
  if (cut > 0) {
    const suffix = item.slice(cut + 1)
    const shape = (i) => { const p = i.slice(0, i.length - suffix.length); return inputsOf(DEFAULT_REG, i).map((x) => x.split(p).join('')).sort().join() }
    const want = shape(item)
    if (!want.includes('_dye')) {
      for (const i of Object.keys(DEFAULT_REG.itemsByName)) {
        if (i !== item && i.endsWith(`_${suffix}`) && shape(i) === want) out.push(i)
      }
    }
  }
  FAMILY_CACHE.set(item, out)
  return out
}

// The castle's open need: the concrete item castlefetch crafts for the
// kind (ctx.castleNeed, e.g. birch_door -> birch_log), else the kind alias.
function needSources(ctx) {
  const cw = ctx && ctx.castleWord
  if (!cw) return new Set()
  const n = ctx.castleNeed
  if (n && n.kind === cw.kind && n.item && cw.kind !== 'stone') {
    // Any variant of the same recipe shape serves (birch_door or oak_door:
    // *_planks), never another shape (iron_door: iron_ingot).
    const shape = (i) => inputsOf(DEFAULT_REG, i).map((x) => x.slice(x.indexOf('_') + 1)).sort().join()
    const want = shape(n.item)
    const out = new Set()
    for (const i of Object.keys(DEFAULT_REG.itemsByName)) {
      if ((i === n.item || (blueprint.matches(cw.kind, i) && shape(i) === want))) for (const b of sources(null, i).blocks) out.add(b)
    }
    return out
  }
  return kindSources(cw.kind)
}

module.exports = { sources, kindSources, kindItem, family, needSources, blocksOf, inputsOf, mobsOf, smelt, regOf, SMELT, DEPTH, DEFAULT_REG }
