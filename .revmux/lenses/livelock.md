---
description: every retry, give-up and failed state has a bounded exit that changes what the bot does next
---
## Lens: livelock

The most common idkcraft prod bug: the bot stands still forever while every tick "decides" the same
thing (atl.4, yvi, 2oe, rw4.3, fja). For each loop, retry, strike counter, `final`/`failed:*` state or
stuck detector the diff adds or touches, walk the ticks after it fires:

- after a step ends `failed:*` / gives up: what clears it, and does the arbiter (`goal.js` `decide`,
  `MENU.*.feasible`) re-pick the same step next tick? `feasible()` must see the failure, or the step
  is chosen, fails at once, and is chosen again
- a strike/stall counter that can never reach its limit: reset by a moving target, by another
  behaviour borrowing the body for one tick, or by a "progress" signal that is not real progress
- "done"/"progress" judged by something that changes without the goal being met (0.9-block sidestep
  on a pit floor, `isMoving()` true on `path=partial`, a jump apex, float vs floored distance)
- a new movement step (walk home, lead, recover action) with no stuck/progress detector and no give-up
- the pathfinder goal left set after give-up, so the body keeps walking or towering (`place_error` loop)
- an escalation (recover menu, `call_player`, chat line, model ask) that can repeat without a cap
  or re-fires every few seconds on the same unreachable target

Report the exact tick sequence: state before, what fires, what the next tick picks, why it never ends.
