/* skill {"name": "stroll_fixture", "description": "fixture step: time is day — stand still one tick", "kind": "step", "body": "any", "verifiedBy": null, "bead": "idkcraft-vf8e.2"} */
// Test fixture (skills.test.js): a goal-step skill loaded from SKILLS_DIR.

function feasible(facts) {
  return facts.time === 'day'
}

function run(bot, st) {
  st.n = (st.n || 0) + 1
  return st.n >= 2 ? 'done' : 'running'
}
