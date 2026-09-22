Merge gate — correct only if:
- 'stop' parks the bot: ticks issue no setGoal and no follow decision with a player nearby until 'follow me'.
- 'follow me' resumes following (new setGoal).
- Paused ticks skip the brain call (cost guard), dispatch idle with stop-once, keep scout sensing and the log line format.
- No new command words, single paused boolean, README stop sentence updated.
Finding nothing is a valid answer.
