'use strict'
// Rig-built v2 house (idkcraft-6x7.8): raise an adoptable house at an exact
// site in the disposable rig world, so come-home order spots have a home to
// walk to. The snapshot holds no adoptable house near the pit (measured:
// doors stand but the table cell + quorum reject every one), and seeding
// memory is ctx-state (dies at the between-spot cut, poisons the bring
// chest check) — world-state is robust: the house stands until the reset.
//
// Plan-driven, never copied: cells come from the REAL buildMod blueprint,
// so a plan change moves the rig with it. Cells group into fill runs per
// (kind, y, z) with contiguous x; the door lands as two setblocks
// (facing=north, the plan's north-wall door). Fill cells are skipped: the
// pad slab reads solid, which is their done state. The pad is levelled
// (dirt slab at oy-1, air above) so rough ground needs no pre-picked flat
// site; the doorstep gets a groomed 3x3 (the walk to it stays real).
// Pure command generation (houseCommands, unit-tested) + a runner.

const buildMod = require('../src/behaviours/build')

function houseCommands(site) {
  if (!site || !Number.isInteger(site.x) || !Number.isInteger(site.y) || !Number.isInteger(site.z)) {
    throw new Error('houseCommands: site needs integer {x, y, z}')
  }
  const { x: ox, y: oy, z: oz } = site
  const cmds = []
  // Level: solid slab under the house, air for the rooms + roof + margin.
  cmds.push(`fill ${ox} ${oy - 1} ${oz} ${ox + 6} ${oy - 1} ${oz + 5} dirt`)
  cmds.push(`fill ${ox} ${oy} ${oz} ${ox + 6} ${oy + 8} ${oz + 5} air`)
  // Doorstep: solid + air so the meet walk can always arrive it.
  const dx = ox + 3
  cmds.push(`fill ${dx - 1} ${oy - 1} ${oz - 2} ${dx + 1} ${oy - 1} ${oz - 1} dirt`)
  cmds.push(`fill ${dx - 1} ${oy} ${oz - 2} ${dx + 1} ${oy + 2} ${oz - 1} air`)
  // Plan cells, grouped into x-runs per (kind, y, z).
  const plan = buildMod.blueprintFor({ v: 2 })
  const runs = new Map() // `${kind}|${y}|${z}` -> sorted xs
  let door = null
  let table = null
  for (const c of plan) {
    if (c.kind === 'fill') continue // the slab reads solid: done
    if (c.kind === 'door') { door = c; continue }
    if (c.kind === 'table') { table = c; continue }
    if (c.kind !== 'planks') throw new Error(`houseCommands: unknown kind ${JSON.stringify(c.kind)}`)
    const k = `${oy + c.dy}|${oz + c.dz}`
    if (!runs.has(k)) runs.set(k, [])
    runs.get(k).push(ox + c.dx)
  }
  for (const [k, xs] of runs) {
    const [y, z] = k.split('|').map(Number)
    xs.sort((a, b) => a - b)
    let s = xs[0]
    let p = xs[0]
    const flush = () => {
      if (s === p) cmds.push(`setblock ${s} ${y} ${z} oak_planks`)
      else cmds.push(`fill ${s} ${y} ${z} ${p} ${y} ${z} oak_planks`)
    }
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] === p + 1) p = xs[i]
      else { flush(); s = xs[i]; p = xs[i] }
    }
    flush()
  }
  if (!table) throw new Error('houseCommands: plan has no table cell')
  cmds.push(`setblock ${ox + table.dx} ${oy + table.dy} ${oz + table.dz} crafting_table`)
  if (!door) throw new Error('houseCommands: plan has no door cell')
  const dox = ox + door.dx
  const doy = oy + door.dy
  const doz = oz + door.dz
  cmds.push(`setblock ${dox} ${doy} ${doz} oak_door[facing=north,half=lower,hinge=left]`)
  cmds.push(`setblock ${dox} ${doy + 1} ${doz} oak_door[facing=north,half=upper,hinge=left]`)
  return cmds
}

async function raiseHouse(rcon, site) {
  const cmds = houseCommands(site)
  for (const c of cmds) await rcon(c)
  return cmds.length
}

module.exports = { houseCommands, raiseHouse }
