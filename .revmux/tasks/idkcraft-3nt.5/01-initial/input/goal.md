Merge gate for PR #28 (idkcraft-3nt.5). Correct only if:
- Stub roams iff player within 3 blocks AND still AND no hostile fact; fight/follow precedence unchanged.
- roam() sets a non-dynamic near-goal within 6 blocks of the player, stays silent while moving, sets no goal beyond 6 (next tick follows).
- request.json strings are byte-identical to the brain.js request; smoke check() accepts roam.
- No new deps; privacy: no hostnames/IPs/keys.
Finding nothing is a valid answer. Report findings as file:line + reason + severity.
