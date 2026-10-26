'use strict'

// Leaf constants shared by goal.js, task.js and goal-options.js
// (idkcraft-oqul.5): moved here so goal-options needs no task.js and the
// task loop needs no goal.js for them. Re-exported from the old modules.

const STEP_ORDER = ['stay', 'gohome', 'shelter', 'gocastle', 'castlefetch', 'castle', 'bank', 'sitebed', 'craft', 'equip', 'build', 'beds', 'light', 'gather', 'deliver', 'stockpile', 'gear', 'forage', 'reforest', 'explore', 'rest']
// Watchdog question language (NOT the tick path: ASK_INSTRUCTIONS and
// goalText() stay untouched — the facts-text diff IS the decision
// cadence). Short clauses in the STEP_CRITERIA style.
const PLAN_INSTRUCTIONS = 'The goal is stalled: pick the step most likely to move its progress metric now; park only if no step can help. Read world (voxel slice), attempts, inventory and target: do not repeat a step that just failed the same way from the same spot'
// vhlb.3: plan menus state the EFFECT of each step (what it changes in the
// world), not the FSM trigger rule STEP_CRITERIA restates. One text for
// JEV and the LLM planner; the tick path keeps STEP_CRITERIA.
const STEP_EFFECT_TEXT = {
  gather: 'chops nearby trees — adds logs to the pack, moves the bot to the trees',
  craft: 'turns logs into planks, table and door in place — unblocks tools and building',
  build: 'places the house blocks at the home site',
  beds: 'gets wool, crafts and places the bedroom beds in the house',
  light: 'places torches around the house',
  castlefetch: 'fetches castle material — takes it from the castle chest, or digs stone and chops logs, then crafts it; walks away from here',
  castle: 'lays the next castle blocks at the site',
  bank: 'walks to the castle chest and deposits the castle kinds it carries above its kit keep',
  sitebed: 'places a bed outside the castle site and sets the spawn',
  equip: 'crafts tools and digs blocks — gives pickaxe, sword and block stock',
  gohome: 'walks to the home and goes inside',
  shelter: 'stops marching and waits here until dawn',
  gocastle: 'walks back to the castle site on the surface so laying can resume',
  deliver: 'carries the hauled items to the player',
  stockpile: 'places a chest and banks the surplus items',
  gear: 'forges better tools',
  forage: 'walks to a remembered find and digs it',
  reforest: 'beats nearby leaves and banks the dropped saplings for later planting',
  explore: 'walks the visited boundary to new ground to find resources',
  stay: 'waits inside',
  rest: 'rests near home',
}
const PLAN_PARK_CRITERION = 'no step can move the goal now: stop the task and rest at home'

module.exports = { STEP_ORDER, STEP_EFFECT_TEXT, PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION }
