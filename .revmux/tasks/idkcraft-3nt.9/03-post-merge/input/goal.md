Merge gate — correct only if:
- empty-path stop with no goal never latches `stopPathing`;
- stationary live goal cancelled via `setGoal(null)` without latching;
- moving idle stops once via `lastGoalKey`;
- tests catch inversion/deletion of each new branch; nothing else changes.
Finding nothing is a valid answer — report only real blockers.
