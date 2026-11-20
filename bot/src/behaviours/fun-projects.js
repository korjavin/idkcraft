'use strict'

const build = require('./build')
const { acquireCellMaterial } = require('./acquire')
const survey = require('../structure-site')
const { savedProject } = require('../fun-project-plan')
const { failReason } = require('../step')
const { W, D } = require('../farm-plan')
const { siteDimensions } = require('../castle')

// Register data-only projects at startup. feasible is a cheap eligibility
// check. pickSite may use gradedSite below and returns a site or null.
// plan(site) returns relative builder cells. The runner adds site.prep.
const registry = new Map()

function register(project) {
  const { id, weight, feasible, pickSite, plan } = project
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(id) ||
      !Number.isFinite(weight) || weight <= 0 || [feasible, pickSite, plan].some((f) => typeof f !== 'function')) {
    throw new TypeError('invalid fun project')
  }
  registry.set(id, project)
}

function active(p) { return !!p && !p.built && !p.failed }

function available(bot, ctx) {
  if (active(ctx.funProject)) return true
  return [...registry.values()].some((p) => p.feasible(bot, ctx))
}

function gradedSite(bot, ctx, footprint) {
  const avoid = [...(footprint.avoid || [])]
  const add = (site, w, d) => {
    if (site) avoid.push({ x0: site.x, z0: site.z, x1: site.x + w - 1, z1: site.z + d - 1 })
  }
  if (ctx.home?.kind !== 'castle') add(ctx.home?.site, 7, 6)
  if (ctx.castle?.site) {
    const { w, d } = siteDimensions(ctx.castle.rot | 0, ctx.castle.blueprintVersion)
    add(ctx.castle.site, w, d)
  }
  add(ctx.farmBuild?.site, W, D)
  const last = ctx.funProject?.site
  if (last) add(last, last.w, last.d)
  const around = footprint.around || bot.entity?.position
  const { site } = survey.pickSite(bot, around, { ...footprint, avoid })
  return site && { ...site, w: footprint.w, d: footprint.d }
}

function pick(bot, ctx, why, rand) {
  const choices = []
  let total = 0
  for (const project of registry.values()) {
    if (!project.feasible(bot, ctx)) continue
    const site = project.pickSite(bot, ctx)
    if (!site) continue
    const blueprint = [...(site.prep || []), ...project.plan(site)]
    const state = savedProject({ id: project.id, site, blueprint, why })
    if (!state) continue
    const weight = project.weight / (1 + Math.max(0, site.cost) + blueprint.length)
    choices.push({ state, upto: total += weight })
  }
  const roll = rand() * total
  return choices.find((c) => roll < c.upto)?.state || null
}

function viewOf(ctx, project) {
  const state = project.state || (project.state = {})
  const local = (k) => typeof k === 'string' && k.startsWith('build')
  return new Proxy(ctx, {
    get(t, k) { return k === 'home' ? project : local(k) ? state[k] : t[k] },
    set(t, k, value) {
      if (k !== 'home') (local(k) ? state : t)[k] = value
      return true
    },
  })
}

function run(bot, ctx, why, rand = Math.random) {
  let project = ctx.funProject
  if (!active(project)) {
    project = pick(bot, ctx, why, rand)
    if (!project) return false
    ctx.funProject = project
    const { x, y, z, cost } = project.site
    console.log(`fun project pick id=${project.id} site=${x},${y},${z} cost=${cost} why=${why}`)
  }
  const view = viewOf(ctx, project)
  // The builder sees the project site. Chest and station lookups use the
  // real context, including the adopted home and shared stores.
  build(bot, view, null, null, (body, _view, home, cell) => acquireCellMaterial(body, ctx, home, cell))
  const { done, total } = build.houseProgress(bot, project)
  if (done !== project.placed) {
    project.placed = done
    console.log(`fun project progress id=${project.id} placed=${done}/${total}`)
  }
  if (failReason(ctx.stepStatus) !== null) project.failed = true
  return true
}

register(require('../fun-mob-trap')(gradedSite))

module.exports = { register, active, available, gradedSite, run }
