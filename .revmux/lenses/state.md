---
description: ctx state across mode switches, preemption, death, respawn and quit — what leaks, what resets wrongly
---
## Lens: state

The bot has one `ctx` and many owners: chat orders (`follow me`, `go work`, `stop`, `bring`, `find`),
the arbiter (`fight` | `follow` | `roam` | `idle` | goal steps), reflexes (eat, recover, scout) and the
connection lifecycle (death, respawn, leave/rejoin). For every `ctx`/module field the diff adds or
reads:

- is it reset on every order that should reset it, and NOT reset when another behaviour only borrows
  the body for a tick (the `lastGoalKey` trap: fight/bring changes the key and wipes gather/follow
  counters — 68p)
- a pending async (search, meal, equip, far scan, timer) that outlives `stop`, a newer order, death or
  quit, and whose completion then overrides the newer state
- the target being null/invisible (`players[name].entity === null`, dist=none): does the new branch
  treat "can't see the player" as "nobody online" (3a7)?
- timers, listeners or a whole bot object not torn down on leave/rejoin, or re-registered per tick
- a latch/flag set on one path and cleared on another path that is not always reached

Name the order of events (e.g. `go work` → fight tick → gather tick) and the wrong value it leaves.
