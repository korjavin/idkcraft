◐ idkcraft-3nt.3 · Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight   [P1 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: feature
Created: 2026-09-21 · Started: 2026-09-21 · Updated: 2026-09-21
Lease: expires in 5 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  "Help fight off hostile mobs" is the behaviour that genuinely competes with 
  following: the bot cannot walk to the player and to a zombie at once. The   
  brain contract bead (idkcraft-3nt.2) teaches the brain to answer fight; this
  bead gives perception the hostile facts the brain needs and adds the body   
  that executes fight. Feasibility in mineflayer: yes — core has              
  bot.attack(entity) (melee swing, server-side reach ~3 blocks), bot.lookAt,  
  bot.equip, and the pathfinder's dynamic GoalFollow(entity, range) walks to a
  moving mob. No plugin needed for melee; mineflayer-pvp only adds swing      
  timing and its own movements — explicitly NOT added (ponytail; upgrade path 
  noted below).                                                               
                                                                              
  What to learn here: perception decides WHAT is a threat (facts: nearest     
  hostile, its distance to the bot and to the player), the brain decides      
  WHETHER to fight instead of follow (trade-off), the behaviour decides HOW   
  (walk in range, swing). Three different questions, three different places.  
                                                                              
  ## What                                                                     
                                                                              
  1. bot/src/perception.js: extend the existing hostile scan in buildState.   
  Keep nearby_hostiles (count < 16) for compatibility and add:                
  hostile_distance (distance from the bot to the nearest hostile, or null),   
  hostile_near_player (that hostile within 6 blocks of the player), and state.
  hostile (the entity object itself, for the behaviour — strip it or ignore it
  in stateToText; it is not sent to the brain). Exclude creeper from fight    
  candidates: hitting one near the player makes it explode next to the player,
  which is the opposite of defending them (fleeing is out of scope; note as //
  ponytail:). stateKey must add Math.round(hostile_distance) and              
  hostile_near_player, otherwise the dedup cache would keep replaying follow  
  while a zombie walks up.                                                    
  2. bot/src/behaviours/fight.js (new): fight(bot, ctx, state) — target =     
  state.hostile. If missing/dead → stop pathfinder, return. Set               
  GoalFollow(target, 2) dynamic once per target (same ctx.lastGoalKey trick as
  follow.js: key fight:<id>). If bot.entity.position.distanceTo(target.       
  position) <= 3: bot.lookAt(target.position.offset(0, target.height * 0.8, 0),
  true) then bot.attack(target). One swing per tick — // ponytail: one swing  
  per tick (1/s); add a 600 ms swing timer if kills take too long (a swing    
  timer would need a deactivate hook, which we deliberately do not have).     
  Before the first swing on a new target, equip the best sword in inventory if
  any (bot.inventory.items().filter(i => i.name.endsWith('_sword')), pick     
  highest attackDamage… or just the first — say which); fists are fine for the
  demo, an op can /give IdkBot iron_sword.                                    
  3. bot/src/index.js: one line — fight: require('./behaviours/fight') in     
  BEHAVIOURS. The decision log line stays as is; add the hostile distance to  
  it only if it fits in the same line (hostile=<d|none>), otherwise leave it. 
  4. Tests: bot/test/fight.test.js (new) with the same mockBot shape as tick. 
  test.js (copy the helper or export it from tick.test.js — smaller diff      
  wins): a zombie entity at 2 blocks → bot.attack called once per fight() call
  and setGoal once; at 6 blocks → setGoal but no attack; creeper at 2 blocks →
  perception yields hostile_distance: null; stateKey changes when a hostile   
  approaches.                                                                 
                                                                              
  Out of scope (file follow-ups only if the owner asks): retreat/heal, ranged 
  mobs (skeletons will plink the bot — that is fine for a demo), bow use,     
  shield, targeting priority beyond "nearest".                                
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • cd bot && npm test green with fight.test.js.                              
  • Stub brain end-to-end (no laya, BRAIN_URL unset): with a zombie at 4      
  blocks the tick logs decision source=stub action=fight ...; when the zombie 
  dies the next tick returns to follow/idle.                                  
  • In-game (prod or test/mc-up.sh, DIFFICULTY is easy so mobs exist): op runs
  /give IdkBot iron_sword then /summon zombie ~ ~ ~ a few blocks from the     
  player; the bot turns, walks to it, swings and kills it, then comes back to 
  the player. Bot logs show source=laya action=fight (or stub if laya is off) 
  and, if the model disagreed with the rules, a brain disagree line. Developer
  pastes ~10 log lines in the PR body.                                        
  • Attacking never targets players, passive mobs or creepers.                
                                                                              
  ## Files                                                                    
                                                                              
  • bot/src/perception.js                                                     
  • bot/src/behaviours/fight.js (new)                                         
  • bot/src/index.js (1 line)                                                 
  • bot/test/fight.test.js (new)                                              
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: medium. One PR. Depends on idkcraft-3nt.1 (perception.js +          
  BEHAVIOURS table must exist) and idkcraft-3nt.2 (brain answers fight). Runs 
  in parallel with the scout bead — both add one line to index.js in different
  spots; expect a trivial rebase.                                             
  • Ranges (perception): fight candidates within 8 blocks of the bot or 6     
  blocks of the player — same numbers the brain criteria state (3nt.2); keep  
  them as named consts at the top of perception.js so a later tuning PR is a  
  one-liner.                                                                  
  • mineflayer entity fields used: entity.name ('zombie'), entity.position,   
  entity.height, entity.id, entity.type === 'player' to skip players.         



DESIGN

  Perception = what is a threat (facts), brain = whether to fight instead of  
  follow (trade-off), behaviour = how (GoalFollow range 2 + bot.attack once   
  per tick when <= 3 blocks). No mineflayer-pvp: core attack + pathfinder     
  suffice; upgrade path is a 600 ms swing timer or the plugin if kills are too
  slow. Creepers excluded from targets; retreat/ranged out of scope.          



ACCEPTANCE CRITERIA

  npm test green with fight.test.js; stub e2e logs action=fight with a zombie 
  at 4 blocks and returns to follow after; in-game /give sword + /summon      
  zombie: bot kills it and comes back, ~10 log lines in PR; never attacks     
  players/passive/creepers                                                    



LABELS: bot, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.1: Bot: split index.js into perception.js + behaviours/ + dispatch table (no behaviour change) so follow/fight/scout can be built in parallel P1
  → ✓ idkcraft-3nt.2: Brain contract: state gains hostile_distance/hostile_near_player, action choice gains fight, stub = reference policy, disagreement log; sync laya request.json + smoke P1

BLOCKS
  ← ○ idkcraft-3nt.6: Prod acceptance + docs: observe fight/scout/roam on the real server, measure laya disagreement rate and latency, update bot/README.md + CLAUDE.md (no hostnames) P2
  ← ○ idkcraft-3nt.5: Roam: fourth brain choice — stroll within 6 blocks of a standing player (widens the ore scan); local-rule fallback if LAYA cannot hold four choices P2

