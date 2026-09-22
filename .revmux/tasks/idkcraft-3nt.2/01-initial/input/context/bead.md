◐ idkcraft-3nt.2 · Brain contract: state gains hostile_distance/hostile_near_player, action choice gains fight, stub = reference policy, disagreement log; sync laya request.json + smoke   [P1 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: task
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  The brain today answers one choice (follow|idle) plus one noul (sprint) from
  a 6-field state line. To let it arbitrate between fighting and following,   
  the contract needs two things: (a) the state must carry what a hostile is   
  doing (how far, is it near the player), and (b) the choice must include     
  fight. This is the core of the owner's experiment — does a System-1 typed   
  model reproduce a small rule set when the rules are written into the        
  criteria? — so the stub brain must implement exactly the same reference     
  policy that the criteria describe, and the remote brain logs when it        
  disagrees with the stub. Reading brain disagree lines on prod is how the    
  owner evaluates the model.                                                  
                                                                              
  Why the brain and not local code decides fight-vs-follow: both need the body
  (pathfinder), so it is a real trade-off — the one place in this iteration   
  where a decision is not a pure fact. Everything else (who is hostile, where 
  is ore) stays local.                                                        
                                                                              
  Why NOT ask the brain more questions (target selection, retreat, "is this   
  ore worth reporting"): LAYA is a ~300M CPU classifier with a 1 s tick budget
  (BRAIN_TIMEOUT_MS 3000); every extra question multiplies latency and the    
  cne.4 probe showed it only answers reliably when the criteria read like     
  rules. One exclusive choice + one noul is the sweet spot; keep it.          
                                                                              
  ## What                                                                     
                                                                              
  1. State fields (bot/src/brain.js stateToText): append                      
  hostile_distance=<nearest hostile distance to the BOT, 1 decimal, or none>  
  hostile_near_player=<true|false: nearest hostile within 6 blocks of the     
  player>. Fields absent in state (perception not yet upgraded, or tests) →   
  none / false. Existing fields keep their order so laya/test/request.json    
  stays a prefix-compatible line.                                             
  2. action question: choices fight, follow, idle, in that order, with rule-  
  like criteria in the style cne.4 proved works, e.g. instructions: "Decide   
  what the companion bot does this second. Fight when a hostile mob is within 
  8 blocks of the bot or near the player and the bot has at least 6 health.   
  Otherwise follow when the player is more than 3 blocks away. Otherwise wait.
  " criteria.fight: "A hostile mob is within 8 blocks (or near the player) and
  bot_health is 6 or more: attack the mob." criteria.follow / idle as today.  
  parseAction accepts the three choices. sprint noul unchanged.               
  3. stubBrain.decide = the same policy in code: fight if hostile_distance <= 
  8 || hostile_near_player and bot_health >= 6; else follow if d > 3 (sprint d
  > 8); else idle. This is the reference policy; the criteria text and the    
  stub must say the same thing (reviewer checks side by side).                
  4. Disagreement log in jevBrain.decide, after a successful remote answer:   
  const ref = stubBrain.decide(state).action; if (ref !== action) console.    
  error(brain disagree source=${source} model=${action} stub=${ref}           
  state=${stateToText(state)}). One line, only on disagreement, nothing else  
  changes. (Not a fallback — the model's answer is still used; that is the    
  point.)                                                                     
  5. laya/test/request.json: regenerate from the new brain.js request (the    
  NOTE in laya/smoke.py says it must be byte-identical in                     
  model/state/questions). laya/smoke.py: check() accepts fight; add one row to
  STATES with a hostile at 4 blocks and expect the human-readable table to    
  show fight (print only — latency and quality are not asserted, same as      
  today).                                                                     
  6. bot/test/brain.test.js: stub cases for fight (hostile 4 blocks, health   
  20), no-fight when health 5, fight with hostile_near_player only; jevBrain  
  maps a canned fight answer; request-shape test updated for the new state    
  line / choices; disagreement line captured via a stubbed console.error in   
  one test.                                                                   
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • cd bot && npm test green with the new stub/jev cases above.               
  • The action criteria strings in bot/src/brain.js and laya/test/request.json
  are identical (diff <(node -e ...) laya/test/request.json or eyeball — say  
  which in the PR).                                                           
  • python laya/smoke.py against a local sidecar (or the CI smoke job) prints 
  the quality table with the hostile row; developer pastes the table in the PR
  body. If LAYA answers idle for the hostile row, do NOT tune silently: note  
  it in the PR and on the bead (this is a finding, not a bug).                
  • In-game: nothing visible yet (perception does not send hostile fields     
  until the fight bead lands); logs must show no stub-fallback regressions    
  with BRAIN_URL pointing at laya.                                            
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/brain.js                                                          
  • bot/test/brain.test.js                                                    
  • laya/test/request.json                                                    
  • laya/smoke.py                                                             
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: small-medium. One PR. File-disjoint from the restructure bead; run  
  in parallel.                                                                
  • Do not touch bot/src/index.js or perception (the fight bead fills the new 
  state fields).                                                              
  • Design defaults chosen here (change on the bead if the owner objects):    
  fight radius 8 blocks around the bot, "near player" = 6 blocks, minimum     
  health to fight = 6 (3 hearts). Creepers are excluded from fight targets by 
  perception (see the fight bead) — the brain never sees them as              
  hostile_distance.                                                           



DESIGN

  One exclusive choice (fight|follow|idle) + one noul (sprint) per tick — the 
  brain arbitrates only where behaviours compete for the body. Stub encodes   
  the identical rules as the criteria text; jevBrain logs brain disagree ...  
  only when model != stub, model answer still wins. Defaults: fight radius 8, 
  near-player 6, min health 6.                                                



ACCEPTANCE CRITERIA

  npm test green incl. fight stub/jev cases; criteria strings identical in    
  brain.js and laya/test/request.json; smoke.py accepts fight and its quality 
  table (with the hostile row) is pasted in the PR; no stub-fallback          
  regressions on prod logs                                                    



LABELS: bot, brain, iteration-3, laya, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

BLOCKS
  ← ○ idkcraft-3nt.3: Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight P1
  ← ○ idkcraft-3nt.5: Roam: fourth brain choice — stroll within 6 blocks of a standing player (widens the ore scan); local-rule fallback if LAYA cannot hold four choices P2

