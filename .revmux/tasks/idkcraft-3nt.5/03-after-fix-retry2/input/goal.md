Merge gate for PR #28 (idkcraft-3nt.5), after-fix round. Correct only if:
- The envelope fix is coherent: still + no hostile + d<=6 roams; follow reclaims past 6;
  moving/hostile-caution rules preserve legacy behavior; question text matches the stub.
- The crossover test pins the round-01 yo-yo; no new preemption path exists.
- request.json stays byte-identical to the brain.js request; smoke accepts roam, 7 rows.
- No new deps; privacy: no hostnames/IPs/keys.
Finding nothing is a valid answer. Report findings as file:line + reason + severity.
