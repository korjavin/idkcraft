---
description: prompts and menus for the small System-1 model (laya) — options, criteria wording, fallbacks
---
## Lens: brain

laya is a small CPU model: reliable on two-option questions with short, mutually exclusive criteria;
it drifts to one favourite answer on longer menus (4jr: always `pillar_up`; iwb: 43% disagreement on
hard states). Check changes to `brain.js`, `goal.js` menus, `recover.js` menus and `laya/`:

- a question offering more than two options, or criteria longer than one short clause each
- two criteria that match the same state, or a criterion that contradicts the stub/FSM rule it mirrors
- a menu option offered when it is infeasible or just failed (feasible() ignores `last=<opt>:failed`)
- a model answer that is not validated against the offered options, or an unknown answer with no
  FSM fallback
- a wire field renamed or dropped that `laya/shim.py` or `laya/smoke.py` still reads
