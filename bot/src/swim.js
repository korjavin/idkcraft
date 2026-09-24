'use strict'

// Swim primitive (idkcraft-be7): the missing edge in mineflayer-pathfinder
// 2.4.5 Movements. The planner routes INTO water (drop-down, forward with
// liquidCost) and the executor already holds jump while isInWater, but no
// neighbor ever climbs OUT onto a bank: getMoveJumpUp refuses when the wall
// is more than 1.2 above the riverbed, so with no scaffold blocks for a
// bridge the search ends partial at the far wall. This appends swim-exit
// edges — water feet, standable bank 1 up, headroom — plus diagonal rise
// and a gated +2 bottom exit, to the same A*. Mounting floats: live
// (idk-eqd, h04) a mount started floating below the surface never executes
// (jump-hold swim caps under the top; pressing the face while rising gets
// every packet rejected), but a jump impulse from solid bottom launches ~2
// blocks with swim continuation — so +2 fires only standing on the bottom
// with the head still submerged. No decision logic: when to swim vs walk
// around vs
// bridge is the ef3/rw4.6 model menu, the FSM fallback just swims.
const Move = require('mineflayer-pathfinder/lib/move')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SWIM_EXIT_COST = 2
const SWIM_RISE_COST = 6 // rise swims ~0.4 blocks/s live vs ~2 cruise: price it last-resort so shallow
// plans stay bottom-cruised (hop-chain keeps jump-impulse access) and only deep water rises

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
    // Rise diagonally while still submerged (head liquid + safe also
    // excludes lava and a ceiling): live (idk-eqd, h04) rise-while-cruising
    // executes but a vertical pin never lifts — the executor needs lateral
    // motion with its jump. Open directions only (no face to press); the
    // target stays liquid so this never becomes a mount.
    const headStart = movements.getBlock(node, 0, 1, 0)
    if (headStart && headStart.liquid && headStart.safe) {
      const room = movements.getBlock(node, 0, 2, 0)
      if (room && (room.safe || room.liquid)) {
        for (const [dx, dz] of DIRS) {
          const rt = movements.getBlock(node, dx, 1, dz)
          const rh = movements.getBlock(node, dx, 2, dz)
          if (rt && rt.liquid && rt.safe && rh && (rh.safe || rh.liquid)) {
            out.push(new Move(node.x + dx, node.y + 1, node.z + dz, node.remainingBlocks, SWIM_RISE_COST, [], []))
          }
        }
      }
    }
    // +2 bottom exit: feet on solid ground (jump impulse) plus a submerged
    // head (swim continuation) — live measured ~2.8 climb from the bottom.
    // Floating starts get no +2: hold-swim alone caps under the surface.
    const floor = movements.getBlock(node, 0, -1, 0)
    const grounded = floor && floor.physical
    const submerged = headStart && headStart.liquid && headStart.safe
    for (const [dx, dz] of DIRS) {
      const stand = movements.getBlock(node, dx, 0, dz)
      const step = movements.getBlock(node, dx, 1, dz)
      const head = movements.getBlock(node, dx, 2, dz)
      if (stand && stand.physical && step && step.safe && head && head.safe) {
        out.push(new Move(node.x + dx, node.y + 1, node.z + dz, node.remainingBlocks, SWIM_EXIT_COST, [], []))
      }
      if (grounded && submerged) {
        const stand2 = movements.getBlock(node, dx, 1, dz)
        const step2 = movements.getBlock(node, dx, 2, dz)
        const head2 = movements.getBlock(node, dx, 3, dz)
        if (stand2 && stand2.physical && step2 && step2.safe && head2 && head2.safe) {
          out.push(new Move(node.x + dx, node.y + 2, node.z + dz, node.remainingBlocks, SWIM_EXIT_COST, [], []))
        }
      }
    }
    return out
  }
}

module.exports = { addSwimExits, SWIM_EXIT_COST, SWIM_RISE_COST }
