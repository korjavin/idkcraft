Merge gate — correct only if:
- empty-path stop with no goal never latches `stopPathing` (next `setGoal` effective);
- stationary live goal (dynamic follow in range) is cancelled on idle/park without latching;
- moving idle still stops once via `lastGoalKey`;
- tests fail when any new branch is inverted or deleted; nothing else changes, no new deps.
Finding nothing is a valid answer — report only real blockers.
