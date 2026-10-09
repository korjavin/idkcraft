'use strict'

// The BEHAVIOURS table (idkcraft-oqul.3): action name -> handler. Moved out
// of src/index.js so goal.registered() reads it without an edge into the
// main file; index.js re-exports this same object (identity preserved —
// tests and registration mutate/compare it).
const fightMod = require('./fight')
const retreatMod = require('./retreat')
const bringMod = require('./bring')
const flatMod = require('./flat')
const homeMod = require('./home')
const castleMod = require('./castle')
const recover = require('./recover')
const BEHAVIOURS = {
  fight: fightMod,
  follow: require('./follow'),
  roam: require('./roam'),
  lead: require('./lead'),
  gather: require('./gather'),
  bring: bringMod,
  flat: flatMod,
  craft: require('./craft'),
  equip: require('./equip'),
  rest: require('./rest'),
  gohome: homeMod.gohome,
  stay: homeMod.stay,
  shelter: homeMod.shelter,
  comehome: homeMod.comehome,
  gocastle: require('./gocastle'),
  build: require('./build'),
  castle: castleMod,
  castlefetch: require('./castlefetch'),
  sitebed: require('./sitebed'),
  beds: require('./beds'),
  light: require('./light'),
  explore: require('./explore'),
  forage: require('./forage'),
  deliver: require('./deliver'),
  stockpile: require('./stockpile'),
  gear: require('./gear'),
  retreat: retreatMod.retreat,
  pillar: retreatMod.pillar,
  // Recovery primitives (ef3): one BEHAVIOURS line each, like goal steps.
  pillar_up: (bot, ctx) => recover.run(bot, ctx),
  dig_up: (bot, ctx) => recover.run(bot, ctx),
  water_up: (bot, ctx) => recover.run(bot, ctx),
  dig_pillar: (bot, ctx) => recover.run(bot, ctx),
  dig_step: (bot, ctx) => recover.run(bot, ctx),
  hop_step: (bot, ctx) => recover.run(bot, ctx),
  sidestep: (bot, ctx) => recover.run(bot, ctx),
  dig_through: (bot, ctx) => recover.run(bot, ctx),
  wait: (bot, ctx) => recover.run(bot, ctx),
  call_player: (bot, ctx) => recover.run(bot, ctx),
}

module.exports = { BEHAVIOURS }
