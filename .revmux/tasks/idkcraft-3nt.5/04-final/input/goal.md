Merge gate for PR #28 (idkcraft-3nt.5), final round. Correct only if:
- The walk-back cannot wedge, loop, or churn goals; the wedge test pins the stale-cache case.
- Every stub branch matches exactly one criterion; request.json is byte-identical to brain.js.
- No new deps; privacy: no hostnames/IPs/keys.
Finding nothing is a valid answer. Report findings as file:line + reason + severity.
