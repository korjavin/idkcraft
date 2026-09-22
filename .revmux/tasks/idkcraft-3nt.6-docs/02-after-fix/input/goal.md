This review is the merge gate for the documentation half of idkcraft-3nt.6. Finding nothing is a valid and acceptable answer if the criteria are satisfied.

Correct only if:
- `bot/README.md` introduces the bot with the "one body, many senses" model, includes a Behaviours table (follow, fight, idle, scout) with triggers, decider (brain vs local reflex), and observation instructions.
- `bot/README.md` accurately documents fight mechanics (8/6 blocks, health >= 6, creepers excluded, sticky target margin, give-up & shadow fallback, swing rate), scout mechanics (16 blocks, 5 s, ore list with coal/copper excluded, max 3 lines), chat commands (`follow me`, `stop`, `find me <block>`), brain arbitration (1 exclusive body choice per tick), and the `brain disagree` log line.
- `CLAUDE.md` has 1-2 lines in Architecture Overview pointing to behaviours layout without touching the shared contract list.
- No hostnames, domains, or IPs are introduced.
