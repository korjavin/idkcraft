'use strict'

// Leaf constants shared by goal.js, task.js and goal-options.js
// (idkcraft-oqul.5): moved here so goal-options needs no task.js and the
// task loop needs no goal.js for them. Re-exported from the old modules.

const STEP_ORDER = ['stay', 'gohome', 'shelter', 'gocastle', 'castlefetch', 'castle', 'sitebed', 'craft', 'equip', 'build', 'beds', 'light', 'gather', 'deliver', 'stockpile', 'gear', 'forage', 'explore', 'rest']
// Watchdog question language (NOT the tick path: ASK_INSTRUCTIONS and
// goalText() stay untouched — the facts-text diff IS the decision
// cadence). Short clauses in the STEP_CRITERIA style.
const PLAN_INSTRUCTIONS = 'The goal is stalled: pick the step most likely to move its progress metric now; park only if no step can help'
const PLAN_PARK_CRITERION = 'no step can move the goal now: stop the task and rest at home'

module.exports = { STEP_ORDER, PLAN_INSTRUCTIONS, PLAN_PARK_CRITERION }
