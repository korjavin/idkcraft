'use strict'

// Leaf constants (idkcraft-oqul.3): numbers the behaviours read at load
// time. They used to live on goal.js, which loads the behaviours — a
// behaviour destructuring them off a half-loaded goal froze undefined.
// No require here, ever: this module must be safe to load first.

// House budget (epic rw4, two blueprints since jr2.1): NEED_PLANKS is the
// loose-plank target for a NEW (v2) house — 92 walls+roof+partition plus 5
// bedroom floor (1c4), plus the table (4) and door (6) the gather formula
// adds on top, like the v1 budget did (38 + 4 + 6 = 48). Loads stay 14 logs
// (the v1-proven batch): a v2 house takes ~2 full loads. Adopted v1 houses
// keep their old budget via goal.needPlanks(home), so a small repair never
// triggers a v2-sized gather.
const NEED_LOGS = 14
const NEED_PLANKS = 107
const NEED_PLANKS_V1 = 48

// Bounded holds (g0z.4): a castle fetch that found nothing holds like any
// failure, but expires — an owner restock of the castle chest moves no
// fact, so without the expiry an idle bot by the castle never re-looks.
const CASTLEFETCH_RETRY_MS = 5 * 60 * 1000
// Bounded forage hold (idkcraft-bt8s): a failed forage leg holds like any
// failure, but time-keyed, not text-keyed — known=near/none flips move the
// facts text every few seconds (g0z.12 rig churn, the same mechanism that
// released the castlefetch hold before g0z.15) and would release a text
// hold at once. Explore stays self-advancing (its failures consume the
// point, so holding it would deadlock the spiral); holding forage alone
// pins the pair on explore until the bound passes.
const FORAGE_RETRY_MS = 5 * 60 * 1000
// Failed-build hold (idkcraft-67z3): a failed build re-picks at most once
// per BUILD_RETRY_MS past facts drift — the text-keyed failHolds releases
// every time the wandering rest moves the facts (post-park rig: 19
// build<->rest cycles in ~10 min, the no-site homeless loop). Same-text
// dones stay text-keyed (h9z). no-planks is the routine batch handoff
// (xoj: fail -> craft -> retry) and no-site the chunk-load retry (vmzq.16),
// so only a REPEAT with the same cause holds — structural verdicts pace
// from the first failure.
const BUILD_RETRY_MS = 5 * 60 * 1000

module.exports = { NEED_LOGS, NEED_PLANKS, NEED_PLANKS_V1, CASTLEFETCH_RETRY_MS, FORAGE_RETRY_MS, BUILD_RETRY_MS }
