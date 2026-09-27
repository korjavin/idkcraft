'use strict'

// Move cost penalties (idkcraft-8yy planner climbs, idkcraft-o6n wedge
// landings): mineflayer-pathfinder costs every +1 climb at a flat 2
// (movements.js getMoveJumpUp) and the executor leaps it with a run-up; on
// Paper 26.1.2 an arc meeting the face is silently cancelled server-side
// (wqt: rise 0.00, ~20 rejects/s), so each planned climb is a stuck lottery
// (path=success, body stands, reset=stuck after 3.5 s). Worse, when the body
// starts wedged (1-wide shaft: all 4 feet-level sides solid) Paper zeroes
// EVERY move including the jump (prod-world replay: maxDy 0.00 vs vanilla
// 1.25, displacement exactly 0.00 for 75 s at ~10 corrections/s), while
// vanilla wriggles out in 3 s — and relaxed spigot thresholds change nothing,
// so no server config fixes it. The lib offers no cost knobs for either
// (only dig/place/liquid/entity costs), so both penalties are applied here
// in the same getNeighbors wrap shape as addNoCornerCut. The planner then
// prefers flat alternatives within ~4 blocks of extra walk and routes around
// 1-wide shafts, and still climbs/enters when forced (reactive recovery owns
// that wedge). JUMP_UP_COST is the smallest value that still reroutes a
// 2-block-distant gap under the full wrapper stack (measured H=10 staircase
// +4 = 1891 nodes vs 56 raw, ~90 ms cached worst case, against +8 = 7832).
// WEDGE_COST can be larger — shaft landings are rare in search, so no A*
// flood — because every entry is certain-stuck on Paper. Pure-vertical
// edges (ladder / 1x1-tower getMoveUp) carry no face arc and skip the climb
// penalty. Parkour-up (gap leap onto a +1 ledge) IS a face arc, so it takes
// the climb penalty; flat/drop parkour never rises and needs no exemption.
const JUMP_UP_COST = 4
const WEDGE_COST = 8
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
      if (m.y - node.y === 1 && (m.x !== node.x || m.z !== node.z)) m.cost += JUMP_UP_COST
      const digs = !!(m.toBreak && m.toBreak.length)
      if (!digs && landsWedged(movements, m)) m.cost += WEDGE_COST
    }
    return ns
  }
}

// A landing whose feet cell has all 4 horizontal neighbours solid: the body
// starts wedged and Paper zeroes every move out (o6n). Unknown cells
// (unloaded chunk: physical=false) fail open — unexplored is not a wedge.
// A side counts only when it fills the cell (height check): carpets, slabs
// and other thin physical blocks are step-overs, not walls; climbables are
// passable. Dig moves (toBreak) skip the charge at the call site: their
// enclosure is self-made (tunnel walls read solid though planned-dug) and
// charging every dug descent would flood A* like the climb penalty did.
function landsWedged(movements, m) {
  if (!movements || typeof movements.getBlock !== 'function') return false
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let c = null
    try { c = movements.getBlock(m, dx, 0, dz) } catch (_) { return false }
    if (!c || !c.physical || c.climbable) return false
    if (typeof c.height !== 'number' || c.height < m.y + 1) return false
  }
  return true
}

module.exports = { addJumpUpCost, JUMP_UP_COST, WEDGE_COST }
