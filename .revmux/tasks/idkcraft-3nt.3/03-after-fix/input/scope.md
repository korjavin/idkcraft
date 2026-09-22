# Scope: idkcraft-3nt.3 round 3 (after round-2 fixes)

Fixed all 3 round-2 findings, fight bead only. Diff vs round-2 code (workdir commits d980a71..HEAD): bot/src/behaviours/fight.js (give-up now shadows the player under a fight-shadow key with a separate fightGivenUpId latch, re-engages on range; sticky target while previous is still a fight candidate; stop() only on a non-empty path), bot/src/perception.js (new exported isFightTarget single definition; buildState loop uses it, same semantics), bot/test/fight.test.js (shadow assertions incl. goal-entity capture, flip-flop stickiness, stop-only-when-moving).

Verify: (1) no freeze after give-up — shadow goal on the player, latch survives shadowing, swing on re-entry; (2) nearest flip-flop no longer resets retry/give-up/equip budgets, switch happens once the old target is lost; (3) no stop() on an empty path anywhere in fight.js (stopPathing latch cannot swallow the next goal); perception refactor preserved ranges/exclusions (suite + boundary tests).

Read: bot/src/behaviours/fight.js, bot/src/perception.js, bot/test/fight.test.js.
