'use strict'

// Nature fun projects (idkcraft-l6o2.2/.3): a tree oasis and a flower field,
// planted by the fun runner from pack or remembered-chest stock.
const projects = require('./fun-projects')
const { isSaplingName } = require('./harvest')
const { stockOf } = require('../cheststock')

// Single-block flowers only: two-tall flowers need a second cell.
const FLOWERS = new Set(['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'torchflower'])
// A lone dark oak never grows (2x2 only), as in reforest.
const isSapling = (n) => isSaplingName(n) && n !== 'dark_oak_sapling'
const isFlower = (n) => FLOWERS.has(n)

// [{ name, count }] of matching items in the pack and remembered chests, most first.
function stockList(bot, ctx, test) {
  const names = new Set()
  try { for (const it of bot.inventory.items()) if (it && test(it.name)) names.add(it.name) } catch (_) { /* pack unreadable */ }
  for (const c of [...(ctx.chests || []), ...(ctx.peerChests || [])]) {
    for (const n of Object.keys((c && c.contents) || {})) if (test(n)) names.add(n)
  }
  return [...names].map((name) => ({ name, count: stockOf(bot, ctx, (n) => n === name) }))
    .filter((s) => s.count > 0).sort((a, b) => b.count - a.count)
}

// Up to n items, round-robin over the stocked kinds so a mix shows.
function allot(stock, n) {
  const out = []
  for (let i = 0; out.length < n && stock.some((s) => s.count > i); i++) {
    for (const s of stock) if (s.count > i && out.length < n) out.push(s.name)
  }
  return out
}

// Oasis: 7x7, saplings 4 apart (corners of the inner 5x5) plus the centre,
// or a one-block pool in the centre when a bucket is already on hand.
const OASIS = 7
const TREES = [[1, 1], [5, 1], [1, 5], [5, 5]]
const MID = 3
const MIN_SAPLINGS = 2

function oasisFeasible(bot, ctx) {
  return stockOf(bot, ctx, isSapling) >= MIN_SAPLINGS
}

function oasisSite(bot, ctx) {
  const pool = stockOf(bot, ctx, (n) => n === 'water_bucket' || n === 'bucket') > 0
  const spots = pool ? TREES : [...TREES, [MID, MID]]
  const saplings = allot(stockList(bot, ctx, isSapling), spots.length)
  if (saplings.length < MIN_SAPLINGS) return null
  const isPit = (dx, dz) => pool && dx === MID && dz === MID
  const site = projects.gradedSite(bot, ctx, { w: OASIS, d: OASIS, needsSoil: () => true, omitSoil: isPit })
  return site && { ...site, plants: saplings.map((block, i) => ({ dx: spots[i][0], dz: spots[i][1], block })), pool }
}

function oasisPlan(site) {
  const cells = (site.plants || []).map(({ dx, dz, block }) => ({ dx, dy: 0, dz, kind: 'block', block }))
  if (site.pool) cells.unshift({ dx: MID, dy: -1, dz: MID, kind: 'clear' }, { dx: MID, dy: -1, dz: MID, kind: 'water' })
  return cells
}

// Flower field: 9x5, flowers on the checkerboard so the bot can walk it.
const FIELD_W = 9
const FIELD_D = 5
const MIN_FLOWERS = 6
const FIELD_SPOTS = []
for (let dz = 0; dz < FIELD_D; dz++) for (let dx = 0; dx < FIELD_W; dx++) if ((dx + dz) % 2 === 0) FIELD_SPOTS.push([dx, dz])

// shortcut: only stocked flowers count (pack + chests); picking wild flowers
// or bonemealing grass is not probed, add it if fields never get picked.
function fieldFeasible(bot, ctx) {
  return stockOf(bot, ctx, isFlower) >= MIN_FLOWERS
}

function fieldSite(bot, ctx) {
  const flowers = allot(stockList(bot, ctx, isFlower), FIELD_SPOTS.length)
  if (flowers.length < MIN_FLOWERS) return null
  const site = projects.gradedSite(bot, ctx, { w: FIELD_W, d: FIELD_D, needsSoil: () => true })
  return site && { ...site, plants: flowers.map((block, i) => ({ dx: FIELD_SPOTS[i][0], dz: FIELD_SPOTS[i][1], block })) }
}

function fieldPlan(site) {
  return (site.plants || []).map(({ dx, dz, block }) => ({ dx, dy: 0, dz, kind: 'block', block }))
}

projects.register({ id: 'oasis', weight: 1, feasible: oasisFeasible, pickSite: oasisSite, plan: oasisPlan })
projects.register({ id: 'flowers', weight: 1, feasible: fieldFeasible, pickSite: fieldSite, plan: fieldPlan })

module.exports = { isFlower, isSapling, oasisPlan, fieldPlan }
