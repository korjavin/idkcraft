---
description: runtime correctness of the mineflayer bot — tick loop, behaviour arbitration, events, brain calls
---
## Lens: bot-loop

The bot is a single Node process: mineflayer events feed a fixed-interval tick that asks a "brain"
(remote System-1 or the local stub) for a reflex decision and acts on it. Read the changed code and
its callers in `bot/src/`, then trace one full tick through the new behaviour.

Look for:

- a behaviour that never yields the tick: following stops while scouting, fighting runs forever, a
  priority check inverted or missing so two behaviours issue conflicting movement in one tick
- a promise the tick loop does not await or catch — one rejection and the process crash-loops or the
  tick silently stops re-arming
- a mineflayer listener registered per tick or per event (`bot.on` inside a loop) — a leak that grows
  until the bot lags out, and a listener not removed on disconnect/respawn
- state that must survive between ticks kept in a local, or state that must reset on death, respawn or
  a new target kept forever (last-seen ore, current attack target, follow lock)
- remote-brain calls made when the cost guard says not to (no player online, timeout), a timeout
  that does not fall back to the stub, or the stub no longer usable when the key/URL is absent
- pathfinder goals set without clearing the previous one, or set every tick for an unchanged target
- chat output on every tick where the code meant to report once per discovery

Name the sequence of ticks or events that triggers the defect before reporting it. A smell without a
trigger is not a finding.
