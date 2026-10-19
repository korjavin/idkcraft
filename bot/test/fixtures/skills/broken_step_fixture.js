/* skill {"name": "broken_step_fixture", "description": "fixture step whose feasible loops", "kind": "step", "body": "any", "verifiedBy": null, "bead": "idkcraft-vf8e.2"} */
// Test fixture (skills.test.js): the feasible busy-loops past the call timeout.

function feasible(facts) {
  for (;;) { /* loop */ }
}

function run(bot, st) {
  return 'done'
}
