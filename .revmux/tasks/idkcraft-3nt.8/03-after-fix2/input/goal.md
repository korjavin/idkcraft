Merge gate — correct only if:
- 'stop' parks the bot: no setGoal and no follow decision with a player nearby until 'follow me', including when stop lands during the brain await; resume works.
- Paused ticks skip brain (except an already-in-flight call whose decision is discarded), stop-once, scout senses while visible and scans nothing with nobody online, log format kept.
- No new command words, single paused boolean.
Finding nothing is a valid answer.
