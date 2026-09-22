This review is the merge gate. Finding nothing is a valid answer.

Correct only if:
- Round 1 minor findings addressed:
  - Comment on `resolveBlockIds` matches shipped state.
  - Distance rounding is tested with a non-integral distance.
- Three reply shapes are supported and accurate:
  - Found: `<name> at x y z (N blocks)` with actual block name and Euclidean distance rounded
  - None within range: `no <name> within 48 blocks`
  - Unknown: `unknown block: <name>`
- Bot does not move as a result of the command (report-only).
- No hostnames, domain names, or IPs anywhere in files or docs.
- Ponytail check: index.js grew by 43 lines for a chat command — is that proportionate (ponytail)?
