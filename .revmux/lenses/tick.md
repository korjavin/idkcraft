---
description: tick loop health — nothing blocks or kills the self-re-arming tick, and brain calls respect the cost guard
---
## Lens: tick

`index.js` runs a self-re-arming `setTimeout` tick. Check the changed code on the tick path:

- synchronous work that can take long on a tick: `findBlocks` / `findBlock` with a large radius or
  high `count`, full inventory or entity scans, loops over chunks — must be bounded or spread over ticks
- an `await` on the tick path with no timeout (dig, place, equip, consume, brain call), or a rejection
  that is not caught so the tick stops re-arming
- a mineflayer listener added per tick/event (`MaxListenersExceededWarning` in prod — yvi)
- remote brain called when nobody is online, or the paid brain (`BRAIN_URL` → JEV) reached from a
  path meant for laya/stub only; a brain timeout that does not fall back to the FSM
- chat or log lines emitted every tick where once per event was meant
