/* skill {"name": "gen_v2_facade", "description": "v2 facade proof: walk to the oak, break a leaf block, plant a sapling", "kind": "step", "bead": "idkcraft-vf8e.21"} */
// Rig proof skill for idkcraft-vf8e.21 (hand-written, verified with
// SKILL_LOOP_VERIFY — not LLM output, never promoted). Exercises the three
// facade acts park needs on the v2 body: goto 10+ blocks, dig a leaf,
// place a sapling. Order-only: `do gen_v2_facade`.
function feasible(facts) {
  return facts.pinned === 'gen_v2_facade'
}
function run(bot, st) {
  var TX = 68, TY = 64, TZ = -193 // the prep oak's trunk base
  var PX = 69, PY = 64, PZ = -193 // the planting cell (air over grass)
  if (!st.leg) st.leg = 'goto'
  if (st.leg === 'goto') {
    var p = null
    try { p = bot.pos() } catch (e) { p = null }
    if (p && Math.hypot(p.x - (TX + 0.5), p.z - (TZ + 0.5)) < 3) {
      bot.stop()
      st.leg = 'dig'
      return 'running'
    }
    bot.goto(TX, TY, TZ, 2)
    return 'running'
  }
  if (st.leg === 'dig') {
    var s = null
    try { s = bot.status() } catch (e) { s = null }
    if (s && s.busy) return 'running'
    if (s && s.err) return 'failed:dig-error'
    if (!st.leaves) {
      try { st.leaves = bot.findBlocks(['oak_leaves'], 16, 8) || [] } catch (e) { st.leaves = [] }
      st.li = 0
    }
    // vf8e.21 review: GREEN must prove a leaf dig happened — no silent
    // skip to the place leg when every leaf was denied or unreadable.
    if (st.li >= st.leaves.length) {
      if (!st.dugOnce) return 'failed:no-leaf-dig'
      st.leg = 'place'
      return 'running'
    }
    var c = st.leaves[st.li]
    var b = null
    try { b = bot.blockAt(c.x, c.y, c.z) } catch (e) { b = null }
    if (!b || (b.name || '').indexOf('leaves') === -1) { st.li++; return 'running' }
    var d = bot.dig(c.x, c.y, c.z)
    if (d === 'started' || d === 'busy') { st.dugOnce = true; return 'running' }
    st.li++ // denied on this cell: try the next leaf
    return 'running'
  }
  var t = null
  try { t = bot.status() } catch (e) { t = null }
  if (t && t.busy) return 'running'
  if (t && t.err) return 'failed:place-error'
  var cur = null
  try { cur = bot.blockAt(PX, PY, PZ) } catch (e) { cur = null }
  if (cur && cur.name === 'oak_sapling') return 'done'
  var n = 0
  try { n = bot.count('oak_sapling') } catch (e) { n = 0 }
  if (!n) return 'failed:no-sapling'
  var r = bot.place(PX, PY, PZ, 'oak_sapling')
  if (r === 'started' || r === 'busy') return 'running'
  if (typeof r === 'string' && r.indexOf('denied') === 0) return 'failed:place-denied'
  return 'failed:place-error'
}
