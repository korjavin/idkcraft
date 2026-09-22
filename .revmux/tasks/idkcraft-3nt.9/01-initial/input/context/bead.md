◐ idkcraft-3nt.9 [BUG] · Ticker: guard the pathfinder stop() sites in index.js with isMoving() so an empty-path stop cannot latch stopPathing and swallow the next goal   [P3 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: bug
Created: 2026-09-22 · Started: 2026-09-22 · Updated: 2026-09-22
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  Found by revmux during the fight bead (idkcraft-3nt.3), rejected there as   
  out of its file budget. mineflayer-pathfinder's stop() only sets a          
  stopPathing flag; called on an empty path it latches and the NEXT setGoal is
  swallowed until the path resets — with fight's spaced retries (every 6      
  ticks) that is a ~6 s freeze. fight.js already never stops an empty path;   
  the four stop() sites in bot/src/index.js (idle branch, paused branch,      
  unknown action, disconnect) still can.                                      
                                                                              
  ## What                                                                     
                                                                              
  Guard each stop() in bot/src/index.js with bot.pathfinder.isMoving() (or    
  route them through one small helper), keep the 'stop once' semantics via    
  ctx.lastGoalKey. One ticker test: idle after a goal that never produced a   
  path must not swallow the next follow goal.                                 
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/index.js                                                          
  • bot/test/tick.test.js                                                     



ACCEPTANCE CRITERIA

  npm test green with a test that fails when a stop() on an empty path is     
  followed by a swallowed setGoal; no behaviour change otherwise              



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

