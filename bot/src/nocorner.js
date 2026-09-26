'use strict'

// No-corner-cut guard (idkcraft-4ac): mineflayer-pathfinder 2.4.5
// getMoveDiagonal offers a diagonal when only ONE of the two side cells is
// free; the 0.6-wide body clips the occupied corner and the executor wedges
// there until reset=stuck (prod 2026-09-24: 18-24% of moving ticks, almost
// all by the plank home where guardOwnWalls also forbids digging the corner
// through). Drops single-step diagonals whose side column holds a solid
// block at body levels — the same getNeighbors wrap shape as addSwimExits.
// Kept: diagonals the executor digs first (every solid side cell in
// move.toBreak — the corner is open after digging) and openable blocks.
// Note the lib's openable set is gate-named blocks only (fence gates are
// already non-physical): doors and trapdoors count as solid here and their
// diagonals are dropped, which is conservative while canOpenDoors=false.
function addNoCornerCut(movements) {
  // setMovements also accepts plain movement-like objects (unit mocks carry
  // only flags): wrap only a real Movements with getNeighbors.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._noCornerCutInstalled) return
  movements._noCornerCutInstalled = true
  const orig = movements.getNeighbors.bind(movements)
  movements.getNeighbors = (node) => orig(node).filter((m) => !cutsCorner(movements, node, m))
}

function cutsCorner(movements, node, m) {
  const dx = m.x - node.x
  const dz = m.z - node.z
  if (Math.abs(dx) !== 1 || Math.abs(dz) !== 1) return false
  // h04: a diagonal descent into safe water forgives the below-feet
  // brush only — the body lands liquid, nothing wedges. Without this the
  // only lip entries into water are dives (the level diagonals graze the
  // bank-top block), the plan arrives deep at the far bank, and the pin is
  // deeper and less visible. Body-level side cells (dy >= 0) stay checked:
  // a post or bank corner at feet/head height still wedges the 0.6-wide
  // body even with a wet landing (4ac). Lava stays vetoed (never safe).
  // The clamp only affects descents: level/climb diagonals already start
  // the loop at 0.
  const landing = movements.getBlock(node, dx, m.y - node.y, dz)
  const waterLanding = landing && landing.liquid && landing.safe
  const broken = new Set((m.toBreak || []).map((p) => `${p.x},${p.y},${p.z}`))
  const lo = waterLanding ? 0 : Math.min(0, m.y - node.y)
  const hi = Math.max(0, m.y - node.y) + 1
  for (let dy = lo; dy <= hi; dy++) {
    for (const [ox, oz] of [[dx, 0], [0, dz]]) {
      const cell = movements.getBlock(node, ox, dy, oz)
      if (!cell || !cell.physical || cell.safe || cell.openable) continue
      const pos = cell.position
      if (pos && broken.has(`${pos.x},${pos.y},${pos.z}`)) continue
      return true
    }
  }
  return false
}

module.exports = { addNoCornerCut }
