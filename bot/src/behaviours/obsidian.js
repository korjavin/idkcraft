'use strict'

// Obsidian (idkcraft-6ci5.1): 'bring me obsidian' mines exposed obsidian
// with a diamond pick and delivers it. The dig itself rides the block
// find/walk/dig/pickup phases in bring.js; this module holds only the
// obsidian-shaped data: the order check and the diamond-pick gate name.
// No requires of bring.js (one-directional: bringitem requires obsidian,
// wool's shape precedent). Lava-finding and water-cast autonomy are an
// explicit follow-up, NOT this bead — only exposed (already placed)
// obsidian is mined here.

// Vanilla: obsidian drops only under a diamond (or netherite) pick.
const OBSIDIAN_TOOL = 'diamond_pickaxe'

function isObsidianName(name) {
  return name === 'obsidian'
}

// A resolved item family (or order carrying names) is pure obsidian when
// it names exactly the one block — the mine rung of the bring ladder
// serves it.
function isObsidianFamily(resolved) {
  return !!resolved && Array.isArray(resolved.names) && resolved.names.length === 1 &&
    resolved.names[0] === 'obsidian'
}

module.exports.OBSIDIAN_TOOL = OBSIDIAN_TOOL
module.exports.isObsidianName = isObsidianName
module.exports.isObsidianFamily = isObsidianFamily
