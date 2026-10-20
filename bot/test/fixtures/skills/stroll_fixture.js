/* skill {"name": "stroll_fixture", "description": "fixture step: ordered only — stand still one tick", "kind": "step", "body": "any", "verifiedBy": null, "bead": "idkcraft-vf8e.17"} */
// Test fixture (skills.test.js, llm-orders.test.js): an order-only goal-step
// skill. It runs only when the plan executive pins it (do <name> or an LLM
// plan) — never on its own before rest.

function feasible(facts) {
  return facts.pinned === 'stroll_fixture'
}

function run(bot, st) {
  st.n = (st.n || 0) + 1
  return st.n >= 2 ? 'done' : 'running'
}
