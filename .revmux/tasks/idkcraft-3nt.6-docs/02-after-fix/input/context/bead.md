◐ idkcraft-3nt.6 · Prod acceptance + docs: observe fight/scout/roam on the real server, measure laya disagreement rate and latency, update bot/README.md + CLAUDE.md (no hostnames)   [P2 · IN_PROGRESS]
Created by: Korzhavin Ivan · Assignee: orch-2026-09-22-0056 · Type: task
Created: 2026-09-21 · Started: 2026-09-22 · Updated: 2026-09-22
Lease: expires in 4 mins (heartbeat just now)

DESCRIPTION

  ## Why                                                                      
                                                                              
  Iteration 1 and 2 each ended with a bring-up bead (idkcraft-cyg.4, idkcraft-
  cne.3): someone joins the real server, watches the behaviour, reads the     
  logs, and writes down what the model actually did. This iteration is        
  explicitly an experiment ("проверить применимость модели"), so the          
  observation IS the deliverable: how often LAYA disagrees with the reference 
  rules, whether it picks fight when a zombie shows up, how long a kill takes 
  on the 1 s tick, whether scouting spams. The docs part makes the behaviours 
  discoverable for the owner (learning project) without leaking hostnames.    
                                                                              
  ## What                                                                     
                                                                              
  1. Prod session (after the epic's code beads are merged and deployed via the
  deploy branch / Portainer): owner or developer joins; run the three checks  
  from the child beads (/summon zombie, /setblock diamond_ore, walk away and  
  stand still) and capture ~5 minutes of bot container logs. Count brain      
  disagree lines vs total decision source=laya lines; note laya p50 from its  
  logs (elapsed_ms) — with the longer state line and three/four choices it    
  must stay under BRAIN_TICK_MS (1000 ms) p50, else file a follow-up (a       
  shorter state line is the first lever).                                     
  2. bot/README.md: rewrite the intro paragraph (follow + scout + fight, what 
  the brain decides vs what is local — copy the epic's "one body, many senses"
  paragraph in short), a "Behaviours" table (behaviour / trigger / who decides
  / how to observe), and the chat commands. Keep the env table; no new env    
  vars were added unless a child bead says so.                                
  3. CLAUDE.md Architecture Overview: one line under the bot box ("follow +   
  scout + fight, brain arbitrates the body") and the new source files in the  
  shared contract only if a rename would break anything (probably nothing to  
  add — say so in the PR if empty).                                           
  4. Record the findings on the epic (bd update idkcraft-3nt --notes):        
  disagreement rate, kill time, scout noise, laya latency. Close the epic with
  that summary.                                                               
                                                                              
  ## Acceptance Criteria                                                      
                                                                              
  • README and CLAUDE.md updated; grep shows no hostnames/IPs/keys (git grep -
  nE "[0-9]{1,3}(\.[0-9]{1,3}){3}|wandergeek|kfamcloud" returns nothing).     
  • Epic notes contain the four numbers above plus the pasted log excerpt     
  (sanitized).                                                                
  • Owner has seen the bot fight and report ore in their own session (or the  
  developer has, with a note that the owner check is pending).                
                                                                              
  ## Files                                                                    
                                                                              
  • bot/README.md                                                             
  • CLAUDE.md                                                                 
  • (bd notes on idkcraft-3nt)                                                
                                                                              
  ## Notes                                                                    
                                                                              
  • Size: small. Depends on 3nt.3 and 3nt.4 (and 3nt.5 if it lands first; do  
  not wait for it). Last in the epic.                                         



DESIGN

  Mirror of cyg.4 / cne.3: the observation is the deliverable. Four numbers,  
  one README table, close the epic with the summary.                          



ACCEPTANCE CRITERIA

  README Behaviours table + CLAUDE.md line, hostname grep clean; epic notes   
  hold disagreement rate, kill time, scout noise, laya p50 with a sanitized   
  log excerpt; owner (or developer, flagged) saw fight + ore report in-game   



LABELS: bot, docs, iteration-3, poc

PARENT
  ↑ ○ idkcraft-3nt: (EPIC) idkcraft iteration 3: concurrent behaviours (follow + scout ore + fight hostiles) arbitrated by the System-1 brain P1

DEPENDS ON
  → ✓ idkcraft-3nt.4: Scout: behaviours/scout.js scans loaded chunks for valuable ore every 5 s and reports new veins in chat (local, no brain, runs alongside any decision) P1
  → ✓ idkcraft-3nt.3: Fight: perception adds nearest-hostile facts (no creepers), behaviours/fight.js walks in range and swings, wired as BEHAVIOURS.fight P1

