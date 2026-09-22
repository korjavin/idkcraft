# Goal: idkcraft-3nt.3 merge gate

Bead intent (acceptance criteria): `cd bot && npm test` green with fight.test.js; stub end-to-end (zombie at 4 blocks logs action=fight, returns to follow/idle when it dies); in-game sword+summon kill deferred to prod acceptance; attacking never targets players, passive mobs, or creepers.

This review is the merge gate for PR #23. Hunt defects in the fight bead's scope: a behaviour stealing the tick from another one (fight never yields), wrong targeting (players/passives/creepers), pathfinder churn or stuck pursuit, stateKey dedup staleness, brain-contract drift. Finding nothing is a valid outcome — report clean if the code meets the bar.
