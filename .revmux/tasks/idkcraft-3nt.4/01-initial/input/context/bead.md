◐ idkcraft-3nt.4 · Scout: behaviours/scout.js scans loaded chunks for valuable ore every 5 s and reports new veins in chat (local, no brain, runs alongside any decision)   [P1 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: feature
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  "Scout and report valuable minerals" is the behaviour that costs the body   
  nothing: the bot already walks with the player, so it can look at the loaded
  chunks around itself and say what it sees. That is why scouting does NOT go 
  through the brain and is not in the BEHAVIOURS dispatch table — there is no 
  trade-off to arbitrate. It hooks into the every-tick seam left by idkcraft- 
  3nt.1 and runs whatever the decision was (following, fighting, idle).       
                                                                              
  What to learn here: mineflayer keeps every loaded chunk in memory, so       
  bot.findBlocks is effectively x-ray vision — the bot "sees" diamond ore 12  
  blocks underground. That is a genuine superpower over a human scout, and it 
  is why the report needs dedup (the same vein stays visible for minutes) and 
  rate limiting (a scan can return dozens of blocks). Cost: findBlocks checks 
  each chunk section's palette first, so a 16-block radius scan is cheap when 
  no ore is around, and a few ms when there is; still, once every 5 s is      
  plenty — ore does not move.                                                 
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/behaviours/scout.js (new): makeScout(bot, { everyMs = 5000,      
  radius = 16, say = bot.chat }) returning { tick() } — a closure, not a class.
  tick() no-ops until everyMs elapsed since the last scan. Scan: bot.         
  findBlocks({ matching: ORE_IDS, maxDistance: radius, count: 64 }) where     
  ORE_IDS is resolved once from bot.registry.blocksByName for: diamond_ore,   
  deepslate_diamond_ore, emerald_ore, deepslate_emerald_ore, ancient_debris,  
  gold_ore, deepslate_gold_ore, iron_ore, deepslate_iron_ore, lapis_ore,      
  deepslate_lapis_ore, redstone_ore, deepslate_redstone_ore (coal and copper  
  deliberately excluded — "valuable"; names missing in the registry are       
  skipped, not fatal). Dedup: a Set of x,y,z strings; cap it at 5000 entries  
  then clear (// ponytail: bounded memory, LRU if it ever matters). Report:   
  group NEW positions by ore name (strip the deepslate_ prefix), and for each 
  name say one chat line: <name> x<count> at <x> <y> <z> with the position of 
  the block nearest the bot. At most 3 lines per scan (highest-value names    
  first, order = the ORE list above); the rest are still marked seen. Also    
  console.log the same text with a scout prefix so it shows in container logs.
  2. bot/src/index.js: two lines — create the scout after spawn (needs bot.   
  registry) and call scout.tick() at the every-tick seam. It must run when a  
  player is present only (no chat into an empty server; the idle branch       
  returns before the seam anyway).                                            
  3. bot/test/scout.test.js (new): mock bot with registry.blocksByName,       
  findBlocks returning canned Vec3-like positions ({x,y,z, distanceTo} as in  
  tick.test.js), blockAt returning { name }, chat collecting lines, and an    
  injectable clock or everyMs: 0. Cases: first scan says one line per ore name
  with the right count and nearest position; second identical scan says       
  nothing; a new position of a known ore says one line with count 1; cap of 3 
  lines per scan; unknown ore names in the list do not throw.                 
  4. bot/README.md: one paragraph "Scouting" (what it reports, radius, cadence,
  that it sees through walls) and how to try it: op runs /setblock ~2 ~ ~     
  diamond_ore.                                                                
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • cd bot && npm test green with scout.test.js.                              
  • In-game: op runs /setblock ~2 ~-1 ~ diamond_ore next to the player →      
  within ~5 s the bot says diamond_ore x1 at <x> <y> <z> once; standing there 
  for a minute produces no repeat. Walking through a cave with iron produces  
  at most 3 lines per 5 s. Developer pastes the chat/log lines in the PR body.
  • Scouting keeps working while the bot is fighting or idle (it is called    
  from the seam, not from a behaviour).                                       
  • No new dependency.                                                        
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/behaviours/scout.js (new)                                         
  • bot/src/index.js (2 lines)                                                
  • bot/test/scout.test.js (new)                                              
  • bot/README.md (1 paragraph)                                               
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: small-medium. One PR. Depends on idkcraft-3nt.1 (every-tick seam).  
  Independent of the brain and fight beads; runs in parallel with fight (each 
  adds a line to index.js — trivial rebase).                                  
  • Deliberately NOT a brain decision and NOT a movement: the bot does not    
  walk to the ore or mine it. If the owner later wants "go look around", that 
  is the roam bead (idkcraft-3nt roam child), which widens what the scan sees 
  without touching this file.                                                 
  • Chat is the player-facing channel because the owner plays from a          
  Switch/Bedrock client via Geyser; keep lines short and ASCII.               



DESIGN

  Not a brain decision and not a movement: pure perception + chat, hooked at  
  the every-tick seam. bot.findBlocks over a 16-block radius every 5 s        
  (palette check makes it cheap), dedup Set of positions capped at 5000, group
  new hits by ore name, say nearest position + count, top 3 names per scan.   
  Ore list excludes coal/copper. Roam (separate P2 bead) widens coverage      
  without touching this file.                                                 



ACCEPTANCE CRITERIA

  npm test green with scout.test.js; in-game /setblock diamond_ore -> one chat
  line within ~5 s, no repeat for a minute; max 3 lines per scan; works while 
  fighting/idle; no new dependency                                            



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.1: Bot: split index.js into perception.js + behaviours/ + dispatch table (no behaviour change) so follow/fight/scout can be built in parallel P1

BLOCKS
  ← ○ idkcraft-3nt.6: Prod acceptance + docs: observe fight/scout/roam on the real server, measure laya disagreement rate and latency, update bot/README.md + CLAUDE.md (no hostnames) P2
  ← ○ idkcraft-3nt.7: Chat command 'find me <block>': scan for a named ore/block and report the nearest one in chat P2

