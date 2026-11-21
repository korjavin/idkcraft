'use strict'

// Plans are data so a restart can resume the original plot and exact cells.
const KINDS = new Set(['block', 'clear', 'fill', 'ground', 'soil', 'planks', 'door', 'table', 'fence', 'gate', 'chest', 'farmland', 'water'])
const NAME = /^[a-z][a-z0-9_-]*$/

function savedProject(project) {
  const site = project?.site
  const cells = project?.blueprint
  if (!site || ![site.x, site.y, site.z, site.w, site.d].every(Number.isInteger) ||
      site.w < 1 || site.d < 1 || !Number.isFinite(site.cost) ||
      typeof project.id !== 'string' || !NAME.test(project.id) ||
      !Array.isArray(cells) || cells.length === 0) return null
  const blueprint = []
  for (const cell of cells) {
    if (!cell || ![cell.dx, cell.dy, cell.dz].every(Number.isInteger) || !KINDS.has(cell.kind) ||
        (cell.kind === 'block' && (typeof cell.block !== 'string' || !NAME.test(cell.block)))) return null
    const { dx, dy, dz, kind, phase, block, stand, alternateStands } = cell
    const validStand = (p) => p && [p.dx, p.dy, p.dz].every(Number.isInteger)
    const copyStand = ({ dx, dy, dz }) => ({ dx, dy, dz })
    if (stand && !validStand(stand)) return null
    if (alternateStands && (!stand || !Array.isArray(alternateStands) || !alternateStands.every(validStand))) return null
    blueprint.push({
      dx, dy, dz, kind, ...(phase === 'prep' ? { phase } : {}), ...(kind === 'block' ? { block } : {}),
      ...(stand ? { stand: copyStand(stand) } : {}),
      ...(alternateStands ? { alternateStands: alternateStands.map(copyStand) } : {}),
    })
  }
  const { x, y, z, w, d, cost } = site
  return {
    kind: 'project', id: project.id, site: { x, y, z, w, d, cost }, blueprint,
    why: project.why === 'stall' ? 'stall' : 'idle', built: project.built === true, failed: project.failed === true,
  }
}

module.exports = { savedProject }
