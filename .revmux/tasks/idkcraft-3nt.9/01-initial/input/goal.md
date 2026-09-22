Merge gate — the change is correct only if:
- every `stop()` in `bot/src/index.js` is guarded by `isMoving()` (or one helper), so an empty-path stop cannot latch `stopPathing`;
- stop-once semantics survive via `lastGoalKey` (idle ticks stay quiet, moving idle still stops once);
- a test fails when an empty-path stop is followed by a swallowed `setGoal`, and is green otherwise;
- no behaviour change otherwise, smallest diff, no new deps.
Finding nothing is a valid answer — report only real blockers.
