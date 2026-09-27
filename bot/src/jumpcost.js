'use strict'

// Jump-up cost penalty (idkcraft-8yy): mineflayer-pathfinder costs every +1
// climb at a flat 2 (movements.js getMoveJumpUp) and the executor leaps it
// with a run-up; on Paper 26.1.2 an arc meeting the face is silently
// cancelled server-side (wqt: rise 0.00, ~20 rejects/s), so each planned
// climb is a stuck lottery (path=success, body stands, reset=stuck after
// 3.5 s). The lib offers no jump-up cost knob (only dig/place/liquid/entity
// costs), so the penalty is applied here in the same getNeighbors wrap shape
// as addNoCornerCut. The planner then routes around +1 faces when a flat
// alternative exists, and still climbs when the jump is the only way (the
// reactive hop_step recovers that wedge). Penalty scale: a flat step costs
// 1, so +8 means the planner walks up to ~8 extra blocks to avoid one climb
// — cheaper than 3.5 s stuck plus recovery. Pure-vertical edges (ladder /
// 1x1-tower getMoveUp) and parkour gap jumps carry no face arc and are left
// alone.
const JUMP_UP_COST = 8
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
      if (m.parkour) continue // gap jump: arc meets air, not a face
      m.cost += JUMP_UP_COST
    }
    return ns
  }
}

module.exports = { addJumpUpCost, JUMP_UP_COST }
