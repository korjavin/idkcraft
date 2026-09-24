'use strict'

// Prometheus metrics, scraped by the host vmagent (compose label
// prometheus.scrape=true). One module-level registry: tests create many
// tickers and simply keep counting into it.
const http = require('node:http')
const client = require('prom-client')

client.collectDefaultMetrics({ prefix: 'idkcraft_bot_' })

const brainRequests = new client.Counter({
  name: 'idkcraft_bot_brain_requests_total',
  help: 'Remote brain calls by source and outcome (ok|timeout|http|invalid|error)',
  labelNames: ['source', 'outcome']
})
const brainDuration = new client.Histogram({
  name: 'idkcraft_bot_brain_request_duration_seconds',
  help: 'Remote brain call latency, failures included',
  labelNames: ['source'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5]
})
const disagreements = new client.Counter({
  name: 'idkcraft_bot_brain_disagreements_total',
  help: 'Remote brain answer differs from the stub reference',
  labelNames: ['model', 'stub']
})
const routes = new client.Counter({
  name: 'idkcraft_bot_brain_routes_total',
  help: 'Hybrid brain routing: easy = rule FSM only, hard = remote model consulted (reason = hard state)',
  labelNames: ['route', 'reason']
})
const decisions = new client.Counter({
  name: 'idkcraft_bot_decisions_total',
  help: 'Decisions dispatched to the body, by source and action',
  labelNames: ['source', 'action']
})
const tickDuration = new client.Histogram({
  name: 'idkcraft_bot_tick_duration_seconds',
  help: 'Full tick latency (perception + brain + dispatch)',
  labelNames: ['brain_called'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5]
})
const events = new client.Counter({
  name: 'idkcraft_bot_events_total',
  help: 'Body events: death, respawn, reflex_swing, spawn',
  labelNames: ['event']
})
const vitals = new client.Gauge({
  name: 'idkcraft_bot_state',
  help: 'Latest perception facts (health, food, distance_to_player, hostile_distance, nearby_hostiles, player_visible)',
  labelNames: ['fact']
})

const online = new client.Gauge({
  name: 'idkcraft_bot_online',
  help: '1 while the bot is joined; it leaves an empty server (BOT_LEAVE_AFTER_MS)'
})
const autonomous = new client.Gauge({
  name: 'idkcraft_bot_autonomous',
  help: '1 while autonomous mode keeps the bot working with nobody online'
})
const searchDuration = new client.Histogram({
  name: 'idkcraft_bot_search_duration_seconds',
  help: 'findBlocks scan latency per radius stage (amb staged search)',
  labelNames: ['radius'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
})

function setVitals(state) {
  for (const f of ['bot_health', 'bot_food', 'distance_to_player', 'hostile_distance', 'nearby_hostiles']) {
    const v = state && state[f]
    if (typeof v === 'number' && Number.isFinite(v)) vitals.set({ fact: f }, v)
    else vitals.remove({ fact: f })
  }
  vitals.set({ fact: 'player_visible' }, state && typeof state.distance_to_player === 'number' ? 1 : 0)
}

function serve(port) {
  http.createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': client.register.contentType })
    res.end(await client.register.metrics())
  }).listen(port, () => console.log(`metrics on :${port}/metrics`))
}

const bring = new client.Counter({
  name: 'idkcraft_bot_bring_total',
  help: 'Bring-me orders by outcome (done|refused|cancelled) and kind (block|food)',
  labelNames: ['outcome', 'kind']
})
const goalSteps = new client.Counter({
  name: 'idkcraft_bot_goal_steps_total',
  help: 'Goal step choices by step and choice source (laya|jev|only-option|goal-fsm|fsm-fallback)',
  labelNames: ['step', 'source']
})
const goalStep = new client.Gauge({
  name: 'idkcraft_bot_goal_step',
  help: 'Current goal step timeline (1 on the running step, 0 elsewhere)',
  labelNames: ['step']
})
const goalDisagreements = new client.Counter({
  name: 'idkcraft_bot_goal_disagreements_total',
  help: 'Model step choice differs from the FSM reference',
  labelNames: ['model', 'fsm']
})
const goalChoiceDuration = new client.Histogram({
  name: 'idkcraft_bot_goal_choice_duration_seconds',
  help: 'Step-choice latency (model calls only; brain_request_duration_seconds stays the overall per-source latency)',
  labelNames: ['source'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5]
})
// Escalation ladder (owner direction): every fallback from a consulted model
// to the FSM reserve is an escalation event. ef3 adds higher levels.
const escalation = new client.Counter({
  name: 'idkcraft_bot_escalation_total',
  help: 'Escalation events by level transition and reason',
  labelNames: ['from', 'to', 'reason']
})
const recover = new client.Counter({
  name: 'idkcraft_bot_recover_total',
  help: 'Recovery menu (ef3 stuck episodes) by primitive, choice source and outcome (chosen|done|failed|gave-up)',
  labelNames: ['action', 'source', 'outcome']
})
module.exports = { client, online, autonomous, searchDuration, routes, brainRequests, brainDuration, disagreements, decisions, tickDuration, events, bring, goalSteps, goalStep, goalDisagreements, goalChoiceDuration, escalation, recover, setVitals, serve }
