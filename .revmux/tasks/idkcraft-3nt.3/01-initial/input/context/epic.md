○ idkcraft-3nt [EPIC] · idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain   [P1 · OPEN]
Created by: Korzhavin Ivan · Type: epic
Created: 2026-09-21 · Updated: 2026-09-21

DESCRIPTION

  ## Why                                                                      
                                                                              
  Iteration 1+2 delivered a single behaviour: follow the player, with one     
  System-1 question per tick (action: follow|idle, sprint: noul) answered by  
  LAYA (or JEV, or the local stub). The owner now wants to test whether that  
  model can drive richer behaviour: the bot should stay near the player, scout
  for valuable ore and report it in chat, and fight hostile mobs that threaten
  the player or itself — all at the same time. This is a learning project:    
  each child bead explains the design reasoning, and every PR must be         
  observable in-game.                                                         
                                                                              
  ## Design (read before picking up any child)                                
                                                                              
  Concurrency model — "one body, many senses":                                
                                                                              
  • Perception is local and always-on (bot/src/perception.js): distances,     
  hostile scan, ore scan. No brain involved; these are facts, not decisions.  
  • The System-1 brain answers ONE exclusive question per tick: who owns the  
  body right now — fight, follow or idle (later maybe roam). This is the only 
  place where behaviours compete (pathfinder + attack are a single resource), 
  so it is the only place we need arbitration, and we hand exactly that       
  arbitration to the model. LAYA is a typed classifier over a state string,   
  not a planner: ask it one clear choice with rule-like criteria (idkcraft-   
  cne.4 proved terse criteria make it answer idle forever).                   
  • Execution is local (bot/src/behaviours/*.js): the chosen behaviour drives 
  the pathfinder / attack; scout has no body cost and runs every tick         
  regardless of the decision, so it never enters the arbitration.             
  • The stub brain encodes the same reference policy as the question texts.   
  Comparing source=laya decisions against the stub in the logs IS the         
  experiment ("does the model reproduce the rules we described?"); the brain  
  bead adds a one-line disagreement log for exactly that.                     
                                                                              
  Dispatch shape: idkcraft children 1 (restructure) and 2 (brain contract) are
  file-disjoint and run in parallel; fight and scout depend on the restructure
  and touch bot/src/index.js by one line each (a dispatch-table entry / one   
  call), so they run in parallel with trivial rebases; roam and the prod      
  acceptance/docs bead go last.                                               
                                                                              
  ## Success Criteria                                                         
                                                                              
  • cd bot && npm test green on every PR; no new npm dependencies (mineflayer 
  core + mineflayer-pathfinder only).                                         
  • In-game on prod: the bot follows the player; when an op runs /summon      
  zombie within ~8 blocks the bot logs decision source=laya action=fight and  
  kills it, then returns to following; when the player walks past ore the bot 
  posts one chat line per new vein (e.g. diamond_ore x3 at 120 12 -40), never 
  repeating a position.                                                       
  • Bot logs stay readable: one decision line per tick, at most one scout line
  per scan, no chat spam.                                                     
  • No hostnames/IPs/keys in the repo or PR bodies (CLAUDE.md privacy rule).  



LABELS: bot, iteration-3, poc

CHILDREN
  ↳ ◐ idkcraft-3nt.2: Brain contract: state gains hostile_distance/hostile_near_player, action choice gains fight, stub = reference policy, disagreement log; sync laya request.json + smoke P1
  ↳ ○ idkcraft-3nt.4: Scout: behaviours/scout.js scans loaded chunks for valuable ore every 5 s and reports new veins in chat (local, no brain, runs alongside any decision) P1
  ↳ ○ idkcraft-3nt.3: Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight P1
  ↳ ◐ idkcraft-3nt.1: Bot: split index.js into perception.js + behaviours/ + dispatch table (no behaviour change) so follow/fight/scout can be built in parallel P1
  ↳ ○ idkcraft-3nt.5: Roam: fourth brain choice — stroll within 6 blocks of a standing player (widens the ore scan); local-rule fallback if LAYA cannot hold four choices P2
  ↳ ○ idkcraft-3nt.6: Prod acceptance + docs: observe fight/scout/roam on the real server, measure laya disagreement rate and latency, update bot/README.md + CLAUDE.md (no hostnames) P2
  ◐ 0/6 complete (0%)

