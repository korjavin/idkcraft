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
//
// e8t: the planner must never route a water->water descent or a rise
// ending above a floor. The executor holds jump while isInWater
// unconditionally, so it can never sink to a deeper node (chasing a
// diagonal dive treadmills — arrival needs |dy|<1 and the bot only
// rises), and a rise ending directly above a floor runs in contact
// with the submerged face: Paper 26.1.2 rejects every tick with a
// same-pos teleport at 20/s (rig E7: 14 s of storm on a 0.1 shelf
// step; the idkcraft-gyw lake-bottom pin is an underwater ledge-mount
// of the same shape — vy≈0, zero displacement, moving=true forever,
// the executor re-plans the identical move every 3.5 s). addSwimPrune
// drops those two neighbour shapes. Everything else stays: level
// cruises (head-on approaches into 2+ faces arrive fine — rig:
// goal_reached, fm=0 — never prune them), open-water rises, flat
// wading (rig E8: goal_reached), +1 bank approaches. Dry sources are
// exempt (bank entries dive in) and dry targets are mounts (h04 owns
// mounts — still offered; Paper 26.1.2 rejects them all, option D).
// Nothing dives on purpose: gather targets logs, explore rides
// GoalXZ, deep shafts are dry by construction.
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

function addSwimPrune(movements) {
  // Same wrap shape as addSwimExits/addNoCornerCut: real Movements only,
  // installed once (setMovements is the single production call site).
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._swimPruneInstalled) return
  movements._swimPruneInstalled = true
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => {
    const out = orig(node)
    const feet = movements.getBlock(node, 0, 0, 0)
    if (!feet || !feet.liquid || !feet.safe) return out
    return out.filter((m) => !unswimmable(movements, node, m))
  }
}

// A water->water move is unexecutable when it descends (dy<0, the
// lib's diagonal dives — the executor holds jump while isInWater and
// never sinks to them) or when it rises ending directly above a floor
// (dy>0, target-below solid — the rise runs in contact with the
// submerged face and Paper rejects every tick; rig E7 measured 14 s
// of storm on a 0.1 shelf step, and the idkcraft-gyw bottom pin is an
// underwater ledge-mount of the same shape). Prune both (see the
// header). Dry targets are bank mounts (h04 owns mounts — offered,
// unexecutable on Paper 26.1.2), level head-on approaches arrive fine
// (rig: goal_reached, fm=0 — never prune them), and lava is never
// offered (feet.safe excludes it).
function unswimmable(movements, node, m) {
  const dx = m.x - node.x
  const dy = m.y - node.y
  const dz = m.z - node.z
  const target = movements.getBlock(node, dx, dy, dz)
  if (!target || !target.liquid || !target.safe) return false
  if (dy < 0) return true
  // Level moves never step up (a wet target's floor-top sits at or
  // below the source feet), so only rises need the floor check.
  if (dy > 0) {
    const underTarget = movements.getBlock(node, dx, dy - 1, dz)
    if (underTarget && underTarget.physical) return true
  }
  return false
}

module.exports = { addSwimExits, addSwimPrune, SWIM_EXIT_COST, SWIM_RISE_COST }
