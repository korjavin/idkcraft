#!/usr/bin/env node
'use strict'

// castle-preview: stamp-and-approve preview for the castle slice blueprint
// (bead idkcraft-g0z.1). Prints (a) ASCII per layer and (b) /setblock
// commands with concrete blocks relative to a given origin, so the owner
// (OP) can stamp the slice in a test world and approve the look before the
// bot builds it.
//
// Usage: node bot/tools/castle-preview.js [ox oy oz] [--rot N] [--ascii|--commands]
//   ox oy oz default to 0 64 0. --rot 0..3 rotates the plan (default 0).

const castle = require('../src/castle')

const BLOCKS = {
  stone: 'cobblestone',
  planks: 'oak_planks',
  door: 'oak_door',
  torch: 'torch',
  air: 'air',
}

const GLYPHS = {
  stone: '#',
  planks: 'p',
  door: 'D',
  torch: 't',
  air: '.',
}

function parseArgs(argv) {
  const out = { origin: [0, 64, 0], rot: 0, mode: 'both' }
  const nums = []
  for (const a of argv) {
    if (a === '--ascii') out.mode = 'ascii'
    else if (a === '--commands') out.mode = 'commands'
    else if (a.startsWith('--rot=')) out.rot = Number(a.slice(6))
    else if (a === '--rot') out.rot = NaN // consumed below
    else if (Number.isFinite(Number(a))) nums.push(Number(a))
  }
  const rotIdx = argv.indexOf('--rot')
  if (rotIdx !== -1 && argv[rotIdx + 1] !== undefined) out.rot = Number(argv[rotIdx + 1])
  if (nums.length >= 3) out.origin = [nums[0], nums[1], nums[2]]
  if (![0, 1, 2, 3].includes(out.rot)) {
    console.error('bad --rot (want 0..3)')
    process.exit(1)
  }
  return out
}

function main() {
  const { origin, rot, mode } = parseArgs(process.argv.slice(2))
  const [ox, oy, oz] = origin
  const plan = castle.rotatePlan(castle.PLAN, rot)
  const { w, d } = castle.siteDimensions(rot)
  const byLayer = new Map()
  for (const c of plan) {
    if (!byLayer.has(c.dy)) byLayer.set(c.dy, [])
    byLayer.get(c.dy).push(c)
  }
  const dys = [...byLayer.keys()].sort((a, b) => b - a)

  if (mode === 'both' || mode === 'ascii') {
    console.log(`castle slice v${castle.BLUEPRINT_VERSION} rot=${rot} origin=${ox} ${oy} ${oz} (${w}x${d}, ${plan.length} cells)`)
    console.log(`legend: ${Object.entries(GLYPHS).map(([k, g]) => `${g}=${k}`).join(' ')}`)
    for (const dy of dys) {
      console.log(`--- dy=${dy >= 0 ? '+' + dy : dy} ---`)
      const grid = Array.from({ length: d }, () => Array(w).fill(' '))
      for (const c of byLayer.get(dy)) grid[c.dz][c.dx] = GLYPHS[c.kind] || '?'
      for (let z = 0; z < d; z++) console.log(grid[z].join(''))
    }
  }

  if (mode === 'both' || mode === 'commands') {
    for (const c of plan) {
      const x = ox + c.dx
      const y = oy + c.dy
      const z = oz + c.dz
      if (c.kind === 'door') {
        // Doors are two blocks; /setblock places exactly one.
        console.log(`setblock ${x} ${y} ${z} ${BLOCKS.door}[half=lower]`)
        console.log(`setblock ${x} ${y + 1} ${z} ${BLOCKS.door}[half=upper]`)
      } else {
        console.log(`setblock ${x} ${y} ${z} ${BLOCKS[c.kind] || 'air'}`)
      }
    }
  }
}

main()
