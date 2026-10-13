// idkcraft-neuc.12: bot.craft / bot.recipesFor / bot.recipesAll for the
// Baritone body.
//
// A port of mineflayer lib/plugins/craft.js (4.39.0). recipesFor/recipesAll
// are the same pure functions over prismarine-recipe + bot.inventory (zero
// bridge traffic). craft() runs mineflayer's click sequence (pick up the
// ingredient, right-click one into each grid cell, put the rest back,
// take the result) through bot.clickWindow, looked up per click so
// craft.js's pacedCraft wrapper still paces table crafts. Shipped path:
// window clicks; the recipe-book fast path (clickRecipe) was not needed.
//
// Differences, all because the client is the model here:
// - the table opens through windows.js openBlock (window.open), not
//   activateBlock + once('windowOpen');
// - the result slot is filled by the server (the client never predicts
//   it), so before the grab we wait for the mod's slot push (window.slot,
//   or inventory.update for the 2x2 grid — the mod diffs slots 0..45)
//   instead of mineflayer's local updateSlot(0) fake;
// - no _syncWindow before the close: every click reply is the client's
//   menu, and a vanilla close hands grid leftovers back to the inventory.
//
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const { withBaritonePaused } = require('./look')

// A transitive dep (via the pinned mineflayer), so a dynamic require like
// inventory.js's tryLoad keeps bridge-body's declared-dep scan honest.
const RECIPE_PKG = 'prismarine-recipe'

// Server round trip + one client tick diff; a grid the server rejected
// never fills the result slot.
const RESULT_WAIT_MS = 3000
const RESULT_POLL_MS = 25

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)) }

// mineflayer craft.js unusedRecipeSlots: the grid cells the shape leaves
// free (shapeless ingredients pop from the end).
function unusedRecipeSlots(recipe, w, h) {
  const slot = (x, y) => 1 + x + w * y
  const out = []
  if (!recipe.inShape) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(slot(x, y))
    return out
  }
  let y = 0
  for (; y < recipe.inShape.length; y++) {
    const row = recipe.inShape[y]
    let x = 0
    for (; x < row.length; x++) if (row[x].id === -1) out.push(slot(x, y))
    for (; x < w; x++) out.push(slot(x, y))
  }
  for (; y < h; y++) for (let x = 0; x < w; x++) out.push(slot(x, y))
  return out
}

function installCraft(bot, openBlock) {
  let recipeReg = null
  let Recipe = null
  // The handshake swaps bot.registry; reload on identity change.
  const recipeClass = () => {
    if (!Recipe || recipeReg !== bot.registry) {
      Recipe = require(RECIPE_PKG)(bot.registry).Recipe
      recipeReg = bot.registry
    }
    return Recipe
  }

  function requirementsMet(recipe, minResultCount, craftingTable) {
    if (recipe.requiresTable && !craftingTable) return false
    const craftCount = Math.ceil(minResultCount / recipe.result.count)
    for (const d of recipe.delta) {
      if (bot.inventory.count(d.id, d.metadata) + d.count * craftCount < 0) return false
    }
    return true
  }

  bot.recipesFor = (itemType, metadata, minResultCount, craftingTable) => {
    const min = minResultCount ?? 1
    return recipeClass().find(itemType, metadata).filter((r) => requirementsMet(r, min, craftingTable))
  }

  bot.recipesAll = (itemType, metadata, craftingTable) =>
    recipeClass().find(itemType, metadata).filter((r) => !r.requiresTable || craftingTable)

  async function waitResult(win, recipe) {
    const deadline = Date.now() + RESULT_WAIT_MS
    for (;;) {
      const r = win.slots[0]
      if (r && r.type === recipe.result.id) return
      if (Date.now() >= deadline) throw new Error(`craft: no ${recipe.result.id} in the result slot`)
      await sleepMs(RESULT_POLL_MS)
    }
  }

  async function craftOnce(recipe, win, w) {
    let originalSourceSlot = null
    const place = async (ing, dest) => {
      if (!ing || ing.id === -1) return
      const sel = win.selectedItem
      if (!sel || sel.type !== ing.id || (ing.metadata != null && sel.metadata !== ing.metadata)) {
        const src = win.findInventoryItem(ing.id, ing.metadata)
        if (!src) throw new Error('missing ingredient')
        if (originalSourceSlot == null) originalSourceSlot = src.slot
        await bot.clickWindow(src.slot, 0, 0)
      }
      await bot.clickWindow(dest, 1, 0)
    }
    const extra = unusedRecipeSlots(recipe, w, w)
    if (recipe.inShape) {
      for (let y = 0; y < recipe.inShape.length; y++) {
        const row = recipe.inShape[y]
        for (let x = 0; x < row.length; x++) await place(row[x], 1 + x + w * y)
      }
    }
    if (recipe.ingredients) for (const ing of recipe.ingredients) await place(ing, extra.pop())
    await bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, originalSourceSlot)
    await waitResult(win, recipe)
    await bot.putAway(0)
  }

  bot.craft = (recipe, count, craftingTable) => withBaritonePaused(bot, async () => {
    if (!recipe) throw new Error('craft: no recipe')
    const n = parseInt(count ?? 1, 10)
    if (recipe.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(recipe))
    }
    let table = null
    try {
      if (craftingTable) {
        table = await openBlock(craftingTable)
        if (!String(table.type).startsWith('minecraft:crafting')) {
          throw new Error('crafting: non craftingTable used as craftingTable: ' + table.type)
        }
      } else if (bot.currentWindow) {
        await bot.closeWindow(bot.currentWindow) // 2x2 clicks must land in the inventory menu
      }
      for (let i = 0; i < n; i++) await craftOnce(recipe, table || bot.inventory, table ? 3 : 2)
    } finally {
      if (table) await bot.closeWindow(table)
    }
  })
}

module.exports = { installCraft, unusedRecipeSlots }
