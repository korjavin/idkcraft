/* skill {"name": "ledge_fixture", "description": "climb: fixture skill — dig the block above the head, done when the dig lands", "kind": "recover", "body": "any", "verb": "digging the fixture ledge", "verifiedBy": null, "bead": "idkcraft-vf8e.2"} */
// Test fixture (skills.test.js): loaded from SKILLS_DIR.

function feasible(facts) {
  return facts.walls >= 0
}

function run(bot, st) {
  if (!st.started) {
    st.started = true
    const p = bot.pos()
    const r = bot.dig(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z))
    return r === 'started' ? 'running' : 'failed:' + r.replace('denied:', '')
  }
  return bot.status().busy ? 'running' : 'done'
}
