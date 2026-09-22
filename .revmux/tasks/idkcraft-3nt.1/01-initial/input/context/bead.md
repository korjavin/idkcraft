◐ idkcraft-3nt.1 · Bot: split index.js into perception.js + behaviours/ + dispatch table (no behaviour change) so follow/fight/scout can be built in parallel   [P1 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: task
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 5 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  bot/src/index.js (214 lines) is one closure: createTicker owns perception   
  (findTarget, buildState, the hostile scan), the brain-call dedup, and       
  execution (applyDecision sets pathfinder goals). Every new behaviour (fight,
  scout, roam) would edit the same function body, so three developers working 
  in parallel would collide on every PR. This bead cuts the file along the    
  seam the epic describes — perception / decision / execution — WITHOUT       
  changing behaviour, so the follow-up beads each add one file plus a one-line
  registration.                                                               
                                                                              
  What to learn here: the tick is a sense → decide → act loop. Sense is local 
  and cheap; decide is the one brain call (cached by stateKey when the world  
  did not change); act is whoever the decision names. Keeping those three     
  phases in separate modules is what lets several behaviours coexist: they    
  never share mutable state, they only read the same state object and one of  
  them gets the pathfinder.                                                   
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/perception.js (new): move HOSTILE_NAMES, findTarget, buildState, 
  stateKey out of index.js. Export { findTarget(bot, followName),             
  buildState(bot, target, prev), stateKey, HOSTILE_NAMES }. buildState needs  
  the previous target position for player_moving; pass it in and return it (e.
  g. state._lastTargetPos is fine too — pick the smaller diff) rather than    
  keeping a closure variable in index.js.                                     
  2. bot/src/behaviours/follow.js (new): the follow branch of applyDecision   
  (GoalFollow re-issue logic incl. the lastGoalKey / isMoving() retry comment).
  Export one function follow(bot, ctx, target) where ctx is a tiny mutable    
  object owned by the ticker ({ lastGoalKey, movements }) — no classes, no    
  base class, no lifecycle hooks (activate/deactivate). Write // ponytail:    
  where you skip one.                                                         
  3. bot/src/index.js: keep createTicker and the cadence/dedup logic. Replace 
  the if (decision.action === 'follow') chain by a dispatch table at module   
  top: const BEHAVIOURS = { follow: require('./behaviours/follow') }; idle    
  (and unknown actions) → the existing pathfinder.stop() once. Leave an       
  obvious, commented seam for every-tick sensors that run regardless of the   
  decision (scout will hook there) — a single // every-tick hooks (no body    
  cost) go here line right after buildState is enough; do NOT build a plugin  
  registry.                                                                   
  4. bot/test/tick.test.js: adjust imports (stateKey now from perception);    
  tests must stay green with no assertion changes. Add one test that the      
  dispatch table routes follow to the follow module and idle to stop (mock bot
  already counts setGoal / stop).                                             
                                                                              
  Do NOT change: the log line format (decision source=... action=...          
  sprint=... dist=...), the idle cost guards (no brain call without a player, 
  10 s idle poll, 1 log/min), the dedup rule, brain.js, chat commands.        
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • cd bot && npm test green; existing tick tests unchanged except import     
  paths; one new dispatch test.                                               
  • bot/src/index.js contains no pathfinder goal construction any more (grep  
  GoalFollow → only behaviours/follow.js) and no HOSTILE_NAMES.               
  • node test/e2e-follow.js against test/mc-up.sh still prints PASS (developer
  runs it once locally, notes the result in the PR body).                     
  • In-game: identical to today — bot follows, follow me / stop still work.   
  • Diff is a move, not a rewrite: reviewer can map every moved block to its  
  origin.                                                                     
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/index.js (shrinks)                                                
  • bot/src/perception.js (new)                                               
  • bot/src/behaviours/follow.js (new)                                        
  • bot/test/tick.test.js (imports + 1 test)                                  
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: medium. One PR. Runs in parallel with the brain-contract bead       
  (idkcraft brain bead touches only brain.js / brain.test.js / laya/*).       
  • Fight and scout beads depend on this one; they will each add one entry to 
  BEHAVIOURS or one call at the every-tick seam. Keep those two spots on their
  own lines so their rebases are trivial.                                     



DESIGN

  Three modules along sense/decide/act: perception.js (facts), index.js ticker
  (brain call + dedup + dispatch table BEHAVIOURS), behaviours/<name>.js (owns
  the pathfinder while chosen). No classes, no lifecycle hooks, no plugin     
  registry — a plain object table and one commented every-tick seam are enough
  for three behaviours.                                                       



ACCEPTANCE CRITERIA

  npm test green; e2e-follow PASS noted in PR; index.js has no                
  GoalFollow/HOSTILE_NAMES; log format and idle cost guards unchanged; in-game
  follow identical                                                            



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

BLOCKS
  ← ○ idkcraft-3nt.4: Scout: behaviours/scout.js scans loaded chunks for valuable ore every 5 s and reports new veins in chat (local, no brain, runs alongside any decision) P1
  ← ○ idkcraft-3nt.3: Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight P1

