# Goal: idkcraft-3nt.3 merge gate (final)

Bead intent (acceptance criteria): `cd bot && npm test` green with fight.test.js; stub end-to-end (zombie at 4 blocks logs action=fight, returns to follow/idle when it dies); in-game sword+summon kill deferred to prod acceptance; attacking never targets players, passive mobs, or creepers.

This review is the final merge gate for PR #23. Hunt defects in the fight bead's scope: a behaviour stealing the tick from another one (fight never yields), wrong targeting (players/passives/creepers), pathfinder churn or stuck pursuit, stateKey dedup staleness, brain-contract drift, interplay with paused mode and the scout/find-me seam. Finding nothing is a valid outcome — report clean if the code meets the bar.

Explicit question for the goal-and-tests lens: fight.js grew from ~40 to its current size with sticky target, hysteresis, shadow goal and re-probe — is each mechanism proportionate to the bead (ponytail), or would a smaller shape do? Name the smaller shape if so.
