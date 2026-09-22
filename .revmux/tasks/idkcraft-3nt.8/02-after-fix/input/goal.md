Merge gate — correct only if:
- 'stop' parks the bot: no setGoal and no follow decision with a player nearby until 'follow me'; resume works.
- Paused ticks skip brain, stop-once, scout senses while a player is visible and scans nothing with nobody online, log format kept.
- No new command words, single paused boolean.
Finding nothing is a valid answer.
