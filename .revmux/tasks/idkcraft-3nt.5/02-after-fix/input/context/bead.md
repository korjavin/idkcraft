◐ idkcraft-3nt.5 · Roam: fourth brain choice — stroll within 6 blocks of a standing player (widens the ore scan); local-rule fallback if LAYA cannot hold four choices   [P2 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: feature
Created: 2026-09-21 · Started: 2026-09-22 · Updated: 2026-09-22
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  The owner's words were "ходил вокруг игрока" — walked AROUND the player, not
  just stood next to them. Today the bot freezes at 3 blocks (idle). A bot    
  that wanders a few blocks around a standing player looks alive and — more   
  usefully — moves its 16-block ore scan across new chunks, so scouting finds 
  more while the player builds or mines. This is also the second real         
  arbitration case for the model: roam is only right when nothing else needs  
  the body (no hostile, player already close), so it is a fourth choice for   
  the brain, ranked last.                                                     
                                                                              
  Why P2 and last: adding a fourth choice is a risk for LAYA (cne.4 showed it 
  collapses to one answer when criteria are vague). The bead includes a       
  fallback rule if the model cannot hold four choices.                        
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/brain.js: add roam to the action choices after idle, criteria in 
  the rule style: "The player is within 3 blocks and is not moving, and no    
  hostile mob is near: walk a few blocks around the player to look at the     
  surroundings." Stub: roam when d <= 3 && !player_moving and no hostile; else
  idle. Keep the disagreement log as is (it now covers roam too).             
  2. bot/src/behaviours/roam.js (new): roam(bot, ctx, state, target) — if the 
  pathfinder is not moving, pick a random point within 6 blocks of the player 
  (target.position + random dx/dz, same y) and set GoalNear(x, y, z, 1) (not  
  dynamic). Never further than 8 blocks from the player: if the bot is already
  > 6 away, hand the body back (set no goal; the next tick's brain answer will
  be follow). // ponytail: random point, no reachability check — pathfinder   
  just fails and the next tick picks another.                                 
  3. bot/src/index.js: one line in BEHAVIOURS.                                
  4. laya/test/request.json regenerate; laya/smoke.py check() accepts roam;   
  add a STATES row "dist 1 still" and look at what the model answers.         
  5. Tests: brain.test.js stub cases (roam vs idle vs fight precedence), one  
  roam.test.js case (sets GoalNear within 6 blocks of the player, does nothing
  while moving).                                                              
                                                                              
  Fallback (decide inside the PR, record on the bead): if the smoke table     
  shows LAYA now answers roam or idle where it should fight/follow, drop roam 
  from the brain question and make it a local rule instead: idle for 5        
  consecutive ticks → roam. Say which path was taken and why — that result is 
  part of the owner's experiment.                                             
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • cd bot && npm test green.                                                 
  • In-game: player stands still → within ~10 s the bot starts strolling in a 
  radius of ~6 blocks and never leaves 8; player walks away → bot follows     
  immediately; /summon zombie while strolling → bot fights. Log lines show    
  action=roam from the brain (or the local rule, per the fallback note).      
  • smoke.py quality table pasted in the PR with the four-choice outcome.     
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/brain.js                                                          
  • bot/src/behaviours/roam.js (new)                                          
  • bot/src/index.js (1 line)                                                 
  • bot/test/brain.test.js, bot/test/roam.test.js (new)                       
  • laya/test/request.json, laya/smoke.py                                     
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: small. One PR. Depends on idkcraft-3nt.2 (brain contract) and       
  idkcraft-3nt.3 (fight must win over roam in the precedence; fight.js must   
  exist so the precedence test is real). Serialize after those; touches brain.
  js, so do not run in parallel with 3nt.2.                                   



DESIGN

  roam ranks last in the action choice (fight > follow > roam > idle-when-    
  moving). behaviours/roam.js sets a non-dynamic GoalNear at a random point <=
  6 blocks from the player; no reachability check. If LAYA degrades with four 
  choices, drop roam from the question and use a local rule (idle for 5 ticks 
  -> roam) — record the outcome, it is data for the experiment.               



ACCEPTANCE CRITERIA

  npm test green; in-game: standing player -> bot strolls within 6 blocks,    
  never > 8; walking player -> follow; zombie -> fight wins; smoke table with 
  four choices pasted in PR; fallback path recorded on the bead if taken      



LABELS: bot, brain, iteration-3, laya, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.3: Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight P1
  → ✓ idkcraft-3nt.2: Brain contract: state gains hostile_distance/hostile_near_player, action choice gains fight, stub = reference policy, disagreement log; sync laya request.json + smoke P1

BLOCKS
  ← ○ idkcraft-3nt.10: Brain: let the arbitration yield fight → follow for an unreachable mob (state gains hostile_reachable or fight_ticks; stub policy + criteria updated) P3

