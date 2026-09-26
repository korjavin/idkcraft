'use strict'

// Swim primitive (idkcraft-be7): the missing edge in mineflayer-pathfinder
// Movements. The planner routes INTO water (drop-down, forward with
// liquidCost) and the executor already holds jump while isInWater, but no
// neighbor ever climbs OUT onto a bank: getMoveJumpUp refuses when the wall
// is more than 1.2 above the riverbed, so with no scaffold blocks for a
// bridge the search ends partial at the far wall. This appends swim-exit
// edges — water feet, standable bank 1 up, headroom — plus diagonal rise
// for submerged starts, to the same A*.
//
// There is deliberately NO +2 exit (idkcraft-h04): a +2 mount from water is
// unexecutable on this fleet's server. Paper 26.1.2 rejects every
// rise-while-touching-the-wall move with a same-pos teleport, 20/s —
// measured live on pool and pit assays, 1 and 2 deep, across every swim
// input shape (hold, rise-then-push, sprint, tap patterns, packet mirrors);
// vanilla 26.1.2 and Paper 1.21.4 accept the identical moves, so it is a
// Paper 26.x regression, not a plan shape. Offering the edge only plans a
// dive to the bottom and pins there — deeper and less visible than a
// surface pin — and reintroduces the b50 spawn trap (11-min unexecutable
// loop). Revival path: when the server accepts wall mounts again, re-add a
// geometry-only +2 (stand2 physical, step2/head2 safe), costed above +1.
// No decision logic: when to swim vs walk around vs bridge is the
// ef3/rw4.6 model menu, the FSM fallback just swims.
const Move = require('mineflayer-pathfinder/lib/move')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SWIM_EXIT_COST = 2
const SWIM_RISE_COST = 6 // rise swims ~0.4 blocks/s live vs ~2 cruise: price it last-resort so the
// planner prefers surface entries and only rises out of genuinely deep starts

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
    // No +2 exit by design (h04, b50): see the header — the mount is
    // unexecutable on Paper 26.1.2 (wall-rise rejected 20/s) and the edge
    // would only plan dives that pin deep. +1 exits only.
    for (const [dx, dz] of DIRS) {
      const stand = movements.getBlock(node, dx, 0, dz)
      const step = movements.getBlock(node, dx, 1, dz)
      const head = movements.getBlock(node, dx, 2, dz)
      if (stand && stand.physical && step && step.safe && head && head.safe) {
        out.push(new Move(node.x + dx, node.y + 1, node.z + dz, node.remainingBlocks, SWIM_EXIT_COST, [], []))
      }
    }
    return out
  }
}

module.exports = { addSwimExits, SWIM_EXIT_COST, SWIM_RISE_COST }
