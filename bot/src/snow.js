'use strict'

// Snow ground (idkcraft-2pt): snow layers read as non-physical air
// (boundingBox 'empty' in minecraft-data), so the planner walks through
// them and Paper rolls the penetration back — the body freezes with
// moving=true. Per the block shapes, layers=1 has no collision box at all
// (leave it as air); layers>=2 are thin but real ground. Installed in
// setMovements next to addSwimExits/addNoCornerCut. No decision logic.

function addSnowGround(movements) {
  // setMovements also accepts plain movement-like objects (unit mocks carry
  // only flags): wrap only a real Movements with getNeighbors.
  if (!movements || typeof movements.getNeighbors !== 'function' || movements._snowGroundInstalled) return
  movements._snowGroundInstalled = true
  const orig = movements.getBlock.bind(movements)
  movements.getBlock = (node, dx, dy, dz) => {
    const b = orig(node, dx, dy, dz)
    try {
      // b.shapes comes from the block's own state: [] for layers=1,
      // a thin box for layers>=2. Height is already shape-based.
      if (b && b.name === 'snow' && Array.isArray(b.shapes) && b.shapes.length > 0) b.physical = true
    } catch (_) { /* annotation best-effort */ }
    return b
  }
}

module.exports = { addSnowGround }
