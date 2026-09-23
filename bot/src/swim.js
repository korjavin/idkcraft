'use strict'

// Swim primitive (idkcraft-be7): the missing edge in mineflayer-pathfinder
// 2.4.5 Movements. The planner routes INTO water (drop-down, forward with
// liquidCost) and the executor already holds jump while isInWater, but no
// neighbor ever climbs OUT onto a bank: getMoveJumpUp refuses when the wall
// is more than 1.2 above the riverbed, so with no scaffold blocks for a
// bridge the search ends partial at the far wall. This appends swim-exit
// edges — water feet, standable bank 1-2 up, headroom — to the same A*,
// costed like a jump. No decision logic: when to swim vs walk around vs
// bridge is the ef3/rw4.6 model menu, the FSM fallback just swims.
const Move = require('mineflayer-pathfinder/lib/move')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SWIM_EXIT_COST = 2

function addSwimExits(movements) {
  // setMovements also accepts plain movement-like objects (unit mocks carry
  // only flags): wrap only a real Movements with getNeighbors.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._swimExitsInstalled) return
  movements._swimExitsInstalled = true
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => {
    const out = orig(node)
    // getBlock annotates liquid/safe/physical; raw blockAt does not.
    // feet.safe excludes lava (blocksToAvoid), so only water exits.
    const feet = movements.getBlock(node, 0, 0, 0)
    if (!feet.liquid || !feet.safe) return out
    // A +2 exit needs room to surface above the feet (b50): standing on
    // the bottom of 1-deep water the body jumps ~1.25 and never climbs out,
    // so the planner must not offer the edge there. Head liquid + safe also
    // excludes lava and a ceiling over the start cell.
    const headStart = movements.getBlock(node, 0, 1, 0)
    const canSurface = headStart && headStart.liquid && headStart.safe
    for (const [dx, dz] of DIRS) {
      for (const dy of [1, 2]) {
        if (dy === 2 && !canSurface) continue
        const stand = movements.getBlock(node, dx, dy - 1, dz)
        const step = movements.getBlock(node, dx, dy, dz)
        const head = movements.getBlock(node, dx, dy + 1, dz)
        if (stand && stand.physical && step && step.safe && head && head.safe) {
          out.push(new Move(node.x + dx, node.y + dy, node.z + dz, node.remainingBlocks, SWIM_EXIT_COST, [], []))
        }
      }
    }
    return out
  }
}

module.exports = { addSwimExits, SWIM_EXIT_COST }
