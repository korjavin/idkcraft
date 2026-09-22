◐ idkcraft-3nt.7 · Chat command 'find me <block>': scan for a named ore/block and report the nearest one in chat   [P2 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: feature
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  The owner (playing beside the bot) wants to ask for a specific resource on  
  demand: 'find me coal'. The scout behaviour (idkcraft-3nt.4) already reports
  valuable ore it stumbles on, but it deliberately excludes common ore (coal, 
  copper) to keep chat quiet, and it only reports what enters its 16-block    
  scan. A chat command turns the same block scan into a question the player   
  asks, which is the natural way for the owner to probe what the bot can      
  'see'.                                                                      
                                                                              
  What to learn here: chat commands live in the chat handler in               
  bot/src/index.js next to 'follow me' / 'stop'; the scan itself is the same  
  bot.findBlocks call scout uses. Keep the scan in scout.js (one exported     
  helper), keep the command parsing in index.js — that is the sense/act split 
  from the epic.                                                              
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/behaviours/scout.js: export findNearest(bot, name, radius=48) → {
  name, position, distance } | null | 'unknown'. Resolve name against bot.    
  registry.blocksByName: exact match first, else any block name containing    
  '<name>_ore' (so 'coal' hits coal_ore and deepslate_coal_ore), else         
  'unknown'. Use bot.findBlocks({ matching: ids, maxDistance: radius, count:  
  64 }) and pick the closest.                                                 
  2. bot/src/index.js chat handler: on 'find me <name>' (case-insensitive, one
  word) call findNearest and bot.chat one line: '<name> at x y z (N blocks)' /
  'no <name> within 48 blocks' / 'unknown block: <name>'. Do not move the bot.
  3. bot/test/scout.test.js: one test per reply shape using the existing mock 
  bot (add a findBlocks stub and a tiny blocksByName registry if the mock has 
  none).                                                                      
  4. bot/README.md: add the command to the in-game chat line.                 
                                                                              
  ## Acceptance                                                               
                                                                              
  • npm test green, three reply shapes covered.                               
  • The bot does not move as a result of the command.                         
  • In-game: 'find me coal' answers with coordinates within one tick.         
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/behaviours/scout.js                                               
  • bot/src/index.js (chat handler, ~5 lines)                                 
  • bot/test/scout.test.js                                                    
  • bot/README.md (1 line)                                                    
                                                                              
  ## Notes                                                                    
                                                                              
  • Depends on idkcraft-3nt.4 (scout.js and its test file exist after it).    
  Serial after 3nt.4 merges.                                                  
  • Size: small. One PR.                                                      



DESIGN

  Report-only: the bot answers with coordinates, it does not walk there       
  (walking takes the body and would enter the fight/follow arbitration — a    
  later 'go to' bead if the owner wants it). Name matching: 'coal' → any block
  whose name contains 'coal_ore' (covers deepslate_coal_ore); 'diamond'       
  likewise; a name that matches no block in the registry → 'unknown block'.   
  Radius 48 (wider than scout's 16 because it is a one-off on demand), max 1  
  reply per command, nearest by Euclidean distance from the bot.              



ACCEPTANCE CRITERIA

  npm test green with a new test: 'find me coal' on a mocked bot with a       
  coal_ore block at known coords replies with the block name, coords and      
  distance; unknown name replies with a clear 'unknown block' line; 'find me  
  diamond' with none in range replies 'no diamond within N blocks'. In-game:  
  typing 'find me coal' near a cave gets one chat line with coordinates.      



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.4: Scout: behaviours/scout.js scans loaded chunks for valuable ore every 5 s and reports new veins in chat (local, no brain, runs alongside any decision) P1

