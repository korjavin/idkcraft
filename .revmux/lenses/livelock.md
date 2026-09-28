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
- "done"/"progress" judged by a jump apex, a sub-block sidestep (0.9 on a pit floor) or a float that
  moves while the body stays on the same block (fja, ak4, 1wj) — progress is a new block position that
  holds for a tick after the action ended
- an escalation (recover episode, call_player, gave-up, model ask) with no cap **per spot**: the same
  block coordinates re-enter the loop after the latch clears and the sequence starts over (q0h: 82 min
  at one site; 9sq F2)
- a fix that only works if the server accepts the action: Paper 26.1.2 zeroes movement when the bbox
  starts wedged, refuses a place at the jump apex (needs +250–350 ms on the ascent), refuses every
  dig/place inside spawn protection for a non-op bot. Say what Paper does to the packet the fix sends;
  a fix verified only on the fake harness for one of these classes is a **major**
- a finding of this lens raised in a previous round (`findings-*.json` in context) or by the other
  agent on the panel may not be dropped or downgraded without a written reason in the finding body
