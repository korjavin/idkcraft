'use strict'

// Jump-up cost penalty (idkcraft-8yy): mineflayer-pathfinder costs every +1
// climb at a flat 2 (movements.js getMoveJumpUp) and the executor leaps it
// with a run-up; on Paper 26.1.2 an arc meeting the face is silently
// cancelled server-side (wqt: rise 0.00, ~20 rejects/s), so each planned
// climb is a stuck lottery (path=success, body stands, reset=stuck after
// 3.5 s). The lib offers no jump-up cost knob (only dig/place/liquid/entity
// costs), so the penalty is applied here in the same getNeighbors wrap shape
// as addNoCornerCut. The planner then prefers flat alternatives within ~4
// blocks of extra walk, and still climbs when the jump is the only way (the
// reactive hop_step recovers that wedge). The value is the smallest that
// reroutes a 2-block-distant gap under the full wrapper stack (the corner-cut
// guard forbids the diagonal shortcut, so +2 still climbs): measured H=10
// staircase +4 = 1891 nodes vs 56 raw (~90 ms cached worst case, sliced
// across 40 ms ticks), against +8 = 7832 nodes. Pure-vertical edges (ladder
// / 1x1-tower getMoveUp) carry no face arc
// and are left alone. Parkour-up (gap leap onto a +1 ledge) IS a face arc —
// across a gap, with less room — so it takes the penalty too; flat/drop
// parkour never rises and needs no exemption.
const JUMP_UP_COST = 4
function addJumpUpCost(movements) {
  // setMovements also accepts plain movement-like objects (unit mocks carry
  // only flags): wrap only a real Movements with getNeighbors.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._jumpUpCostInstalled) return
  movements._jumpUpCostInstalled = true
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => {
    const ns = orig(node)
    for (const m of ns) {
      if (!m || typeof m.y !== 'number' || typeof m.cost !== 'number') continue
      if (m.y - node.y !== 1) continue
      if (m.x === node.x && m.z === node.z) continue // ladder/tower: no face arc
      m.cost += JUMP_UP_COST
    }
    return ns
  }
}

module.exports = { addJumpUpCost, JUMP_UP_COST }
