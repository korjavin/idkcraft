'use strict'

// One cost-ordered sourcing ladder for every needed item (owner 2026-11-13:
// generalize, not per-bug patches). Cheapest rung first:
//   1. inventory  — already held, or crafted/cooked/eaten from the pack now
//                   (incl. the table from a carried table/planks/log)
//   2. drops      — dropped item entities nearby (castlefetch site sweep)
//   3. nearChest  — home/site/remembered chests within the near radius
//   4. obtain     — mine stone, chop trees, hunt passive animals
//   5. far        — far chests (castlefetch up to 1000, via the hold's hop
//                   leg) / long trips (chestSearch's spiral for food)
// A rung is a function returning true while it serves this tick and false
// when it cannot (nothing there, noPath, dry): the walk goes on to the next
// rung in the SAME tick, so one dead rung never fails the leg. The leg fails
// only when every rung said no; the caller keeps its own per-item hold.
//
// Consumers: castlefetch (rungs 1-3 here, 4 its dig/gather tail, 5 the hop
// leg), food-recovery (bread/chest/hunt phases in this order, then the
// chestSearch step once the leg holds).

const RUNGS = ['inventory', 'drops', 'nearChest', 'obtain', 'far']

// rungs: [[name, fn], ...] in RUNGS order. Returns the serving rung's name,
// or null when none served. state.rung remembers it so a switch logs once.
function climb(state, rungs, label) {
  for (const [name, fn] of rungs) {
    let ok = false
    try { ok = !!fn() } catch (_) { ok = false } // a throwing rung is a dead rung
    if (!ok) continue
    if (state && state.rung !== name) {
      state.rung = name
      try { console.log(`source ${label} rung=${name}`) } catch (_) { /* log best-effort */ }
    }
    return name
  }
  return null
}

module.exports = { RUNGS, climb }
