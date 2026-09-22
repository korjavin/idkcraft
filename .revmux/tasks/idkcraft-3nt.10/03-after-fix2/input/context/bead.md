◐ idkcraft-3nt.10 · Brain: let the arbitration yield fight → follow for an unreachable mob (state gains hostile_reachable or fight_ticks; stub policy + criteria updated)   [P3 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: task
Created: 2026-09-22 · Started: 2026-09-22 · Updated: 2026-09-22
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  Today fight.js handles an unreachable mob locally (give-up after 18 ticks → 
  shadow the player → re-probe every 30 ticks). The brain keeps answering     
  fight because the state line never says the pursuit failed, so the          
  arbitration cannot switch back to follow — the behaviour works around the   
  decision layer instead of informing it. Feeding the fact back is the epic's 
  design ('perception is local, the brain owns the choice').                  
                                                                              
  ## What                                                                     
                                                                              
  Add one fact to the state line (e.g. hostile_reachable=true|false from      
  fight's give-up latch, or fight_ticks=N), extend the fight criterion text   
  and the stub reference policy (do not fight an unreachable mob unless it is 
  near the player), sync laya/test/request.json + smoke.py, then simplify     
  fight.js by removing what the brain now decides (the shadow fallback can    
  stay as the local safety net). Serial after idkcraft-3nt.5 (roam) — both    
  touch brain.js.                                                             
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/brain.js, bot/test/brain.test.js, laya/test/request.json,         
  laya/smoke.py                                                               
  • bot/src/behaviours/fight.js, bot/test/fight.test.js, bot/src/perception.js



ACCEPTANCE CRITERIA

  npm test green; the stub answers follow for a hostile flagged unreachable   
  and not near the player; request.json criteria identical to brain.js;       
  fight.js smaller than before                                                



LABELS: bot, brain, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.5: Roam: fourth brain choice — stroll within 6 blocks of a standing player (widens the ore scan); local-rule fallback if LAYA cannot hold four choices P2

