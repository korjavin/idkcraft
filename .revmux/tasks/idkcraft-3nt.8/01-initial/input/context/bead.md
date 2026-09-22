◐ idkcraft-3nt.8 [BUG] · 'stop' chat command must actually hold the bot: add a paused flag to the ticker instead of falling back to nearest player   [P3 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: bug
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  Today 'stop' clears the follow lock (setFollow('')), but findTarget then    
  falls back to the nearest player, so on the next tick the bot resumes       
  following whoever is closest — 'stop' is a no-op in practice. The owner     
  expects 'stop' to park the bot. Pre-existing bug noticed by the architect   
  while planning iteration 3.                                                 
                                                                              
  What to learn here: 'no target' and 'do not act' are different states. The  
  follow lock answers 'whom', the paused flag answers 'whether'. Keeping them 
  separate is what lets scout keep sensing while the body stands still.       
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/index.js: add ctx.paused (false). Chat 'stop' → paused = true    
  (and clear the follow lock as today); chat 'follow me' → paused = false +   
  lock as today. In the tick: when paused, run perception, run the every-tick 
  seam (scout), then dispatch idle (pathfinder.stop() once) and skip the brain
  call — same cost guard path as 'no player online'. Keep the log line format.
  2. bot/test/tick.test.js: one test for stop → no setGoal across several     
  ticks with a player nearby; follow me → setGoal again.                      
  3. bot/README.md: adjust the one sentence about 'stop'.                     
                                                                              
  ## Acceptance                                                               
                                                                              
  • npm test green with the new test.                                         
  • In-game: 'stop' parks the bot; 'follow me' resumes.                       
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/index.js                                                          
  • bot/test/tick.test.js                                                     
  • bot/README.md (1 line)                                                    
                                                                              
  ## Notes                                                                    
                                                                              
  • Depends on idkcraft-3nt.1 (the ticker/dispatch table it hooks into).      
  Serial after 3nt.1 merges; touches index.js so never in parallel with 3nt.  
  3/3nt.4.                                                                    
  • Size: small. One PR.                                                      



DESIGN

  A single boolean 'paused' in the ticker context, set by 'stop', cleared by  
  'follow me'. When paused, the tick still runs perception (scout keeps       
  reporting) but skips the brain call and dispatches idle — no brain cost     
  while parked. No new command words.                                         



ACCEPTANCE CRITERIA

  npm test green with a new tick test: after 'stop', ticks issue no setGoal   
  and log no follow decision until 'follow me' is said again; 'follow me'     
  resumes. In-game: 'stop' leaves the bot standing even with a player nearby. 



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.1: Bot: split index.js into perception.js + behaviours/ + dispatch table (no behaviour change) so follow/fight/scout can be built in parallel P1

