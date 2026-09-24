---
description: mineflayer-pathfinder use — shared Movements mutation, goal churn, stop/setGoal races, distance semantics
---
## Lens: pathing

There is ONE `Movements` object (`ticker.setMovements`, `ctx.movements`) shared by every behaviour for
the whole session. Check every diff line that touches `Movements`, `setGoal`, `stop`, goals or
`isMoving`:

- a mutation of the shared `Movements` (`blocksCantBreak`, `blocksToAvoid`, `canDig`,
  `allowSprinting`, `allow1by1towers`, `scafoldingBlocks`, swim exits) that is not scoped to the step
  that needs it and restored after — it silently changes pathing for follow/gather/recover (4ac:
  build's guard of all planks/doors made the bot wedge at its own house corners). For each such
  mutation name when it is undone; "never" or "on disconnect" is a **major**, even if the diff's own
  behaviour works
- `pathfinder.stop()` and `setGoal()` in the same tick, or `stop()` on an empty path latching
  `stopPathing` and swallowing the next goal (3nt.9, 3nt.23)
- a goal re-issued every tick for an unchanged target (tears down A* — 3nt.19), or a dynamic goal
  whose centre goes stale
- arrival/range checks mixing float entity positions with the floored block the goal ends on
  (06v, 3nt.11, 3nt.19)
- trusting `isMoving()`/`path=success` as progress — the body can stand still with a live path
- sprint or jump settings re-enabled (sprint-jump wedges on 1-block steps — 3nt.24)
