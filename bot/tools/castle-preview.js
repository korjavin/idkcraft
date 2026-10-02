#!/usr/bin/env node
'use strict'

// castle-preview: stamp-and-approve preview for a castle blueprint version
// (beads idkcraft-g0z.1, g0z.11). Prints (a) the bill of materials and ASCII
// per layer and (b) /setblock commands with concrete blocks relative to a
// given origin, so the owner (OP) can stamp the castle in a test world and
// approve the look before the bot builds it.
//
// Usage: node bot/tools/castle-preview.js [ox oy oz] [--rot N] [--v N] [--ascii|--commands]
//   ox oy oz default to 0 64 0 (the site's SW corner at ground level).
//   --rot 0..3 rotates the plan (default 0, gate north). --v picks the
//   blueprint version (default: the full castle).

const castle = require('../src/castle')

const BLOCKS = {
  stone: 'cobblestone',
  planks: 'birch_planks',
  frame: 'spruce_log',
  fence: 'oak_fence',
  door: 'oak_door',
  chest: 'chest',
  torch: 'torch',
  air: 'air',
  dig: 'air',
}

const GLYPHS = {
  stone: '#',
  planks: 'p',
  frame: 'F',
  fence: 'f',
  door: 'D',
  chest: 'C',
  torch: 't',
  air: '.',
  dig: '~',
}

function parseArgs(argv) {
  const out = { origin: [0, 64, 0], rot: 0, version: castle.FULL_VERSION, mode: 'both' }
  const nums = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ascii') out.mode = 'ascii'
    else if (a === '--commands') out.mode = 'commands'
    else if (a.startsWith('--rot=')) out.rot = Number(a.slice(6))
    else if (a === '--rot') { out.rot = Number(argv[i + 1]); i++ } // skip the value: not an origin coord
    else if (a.startsWith('--v=')) out.version = Number(a.slice(4))
    else if (a === '--v') { out.version = Number(argv[i + 1]); i++ }
    else if (Number.isFinite(Number(a))) nums.push(Number(a))
  }
  if (nums.length >= 3) out.origin = [nums[0], nums[1], nums[2]]
  if (![0, 1, 2, 3].includes(out.rot)) {
    console.error('bad --rot (want 0..3)')
    process.exit(1)
  }
  if (!castle.BLUEPRINTS[out.version]) {
    console.error(`bad --v (want ${Object.keys(castle.BLUEPRINTS).join(' or ')})`)
    process.exit(1)
  }
  return out
}

function main() {
  const { origin, rot, version, mode } = parseArgs(process.argv.slice(2))
  const [ox, oy, oz] = origin
  const bp = castle.BLUEPRINTS[version]
  const plan = castle.rotatePlan(bp.PLAN, rot, version)
  const { w, d } = castle.siteDimensions(rot, version)
  const byLayer = new Map()
  for (const c of plan) {
    if (!byLayer.has(c.dy)) byLayer.set(c.dy, [])
    byLayer.get(c.dy).push(c)
  }
  const dys = [...byLayer.keys()].sort((a, b) => b - a)

  if (mode === 'both' || mode === 'ascii') {
    const bom = castle.billOfMaterials(plan)
    console.log(`castle v${version} rot=${rot} origin=${ox} ${oy} ${oz} (${w}x${d}, ${plan.length} cells)`)
    console.log(`bill of materials: ${Object.entries(bom).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    console.log(`legend: ${Object.entries(GLYPHS).map(([k, g]) => `${g}=${k}`).join(' ')} (x left->right, z top->bottom; row 0 = north at rot 0)`)
    for (const dy of dys) {
      console.log(`--- dy=${dy >= 0 ? '+' + dy : dy} ---`)
      const grid = Array.from({ length: d }, () => Array(w).fill(' '))
      for (const c of byLayer.get(dy)) grid[c.dz][c.dx] = GLYPHS[c.kind] || '?'
      for (let z = 0; z < d; z++) console.log(grid[z].join('').replace(/\s+$/, ''))
    }
  }

  if (mode === 'both' || mode === 'commands') {
    // Door upper halves are emitted with their door; the keep-clear marker
    // at the same cell must not wipe them afterwards (revmux 01 core-2).
    const doorUppers = new Set(
      plan.filter((c) => c.kind === 'door').map((c) => `${c.dx},${c.dy + 1},${c.dz}`),
    )
    for (const c of plan) {
      const x = ox + c.dx
      const y = oy + c.dy
      const z = oz + c.dz
      if (c.kind === 'door') {
        // Doors are two blocks; /setblock places exactly one.
        console.log(`setblock ${x} ${y} ${z} ${BLOCKS.door}[half=lower]`)
        console.log(`setblock ${x} ${y + 1} ${z} ${BLOCKS.door}[half=upper]`)
      } else if (c.kind === 'air' && doorUppers.has(`${c.dx},${c.dy},${c.dz}`)) {
        continue
      } else {
        console.log(`setblock ${x} ${y} ${z} ${BLOCKS[c.kind] || 'air'}`)
      }
    }
  }
}

main()
