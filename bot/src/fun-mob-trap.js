'use strict'

const { countItems } = require('./perception')

const W = 5
const D = 6 // row zero is the approach apron outside the chamber
const DOOR_X = 2
const BLOCK = 'cobblestone'

function plan() {
  const cells = []
  const closures = []
  const block = (dx, dy, dz) => ({ dx, dy, dz, kind: 'block', block: BLOCK })
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 1; dz < D; dz++) {
        if (dx !== 0 && dx !== W - 1 && dz !== 1 && dz !== D - 1) continue
        const cell = block(dx, dy, dz)
        if (dx === DOOR_X && dz === 1) {
          closures.push({ ...cell, stand: { dx, dy: 0, dz: 0 } })
        } else {
          cells.push(cell)
        }
      }
    }
  }
  for (let dx = 0; dx < W; dx++) {
    for (let dz = 1; dz < D; dz++) cells.push(block(dx, 2, dz))
  }
  // Leave the two-block entrance open through the roof pass.
  return [...cells, ...closures]
}

const MATERIALS = plan().length
module.exports = function mobTrap(gradedSite) {
  return {
    id: 'mob-trap',
    weight: 1,
    feasible(bot, ctx) {
      if (countItems(bot, (name) => name === BLOCK) >= MATERIALS) return true
      if (typeof bot.mine === 'function' && countItems(bot, (name) => name.endsWith('_pickaxe')) > 0) return true
      return typeof bot.openChest === 'function' && (!!ctx.home?.chest || ctx.chests?.length > 0 || ctx.peerChests?.length > 0)
    },
    pickSite(bot, ctx) {
      return gradedSite(bot, ctx, { w: W, d: D, accept: (f) => !f.wet && f.cs.every((c) => !c.tree) })
    },
    plan,
  }
}
