#!/usr/bin/env python3
"""LAYA sidecar smoke test (stdlib only: urllib, json, statistics).

Usage: python smoke.py [base_url]  (default http://127.0.0.1:8000)

NOTE: test/request.json must be kept in sync with what bot/src/brain.js
sends (model, state text, questions) -- it is the exact JEV-shaped body.

Waits for /health (up to 120 s), POSTs request.json 20x asserting
answers.action.choice in {fight, follow} (the model is only consulted on
hard states, and every hard case is fight-vs-follow; no sprint question is
asked), then prints p50/p95 ms plus the answers for the 8 hard-case states
as a table for the human quality check. Exit non-zero on any shape failure.
Latency is printed, not asserted.
"""

import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LAYA_URL", "http://127.0.0.1:8000")
HERE = os.path.dirname(os.path.abspath(__file__))

# NOTE: "H1 repeat" and "H3 repeat" re-post the same wire state on purpose:
# posting the same state twice probes whether the model answers
# deterministically. A split answer across the two rows means model jitter,
# not a state difference.
# Rows H1-H4b cover the four named hard cases (epic catalogue) x the two
# plausible answers: the base row and a "b" variant with the severity flipped
# (near vs far/adjacent hostile, low vs ok health, player far vs away,
# hostile_near_player yes vs no).
STATES = [
    ("H1 low-health",
     "hard=low-health-hostile player=away player_moving=yes hostile=far hostile_near_player=yes hostile_reachable=yes health=low food=ok"),
    ("H1b near",
     "hard=low-health-hostile player=far player_moving=yes hostile=near hostile_near_player=yes hostile_reachable=yes health=low food=ok"),
    ("H2 crowd",
     "hard=crowd player=far player_moving=no hostile=none hostile_near_player=no hostile_reachable=yes health=ok food=ok"),
    ("H2b crowd weak",
     "hard=crowd player=far player_moving=no hostile=near hostile_near_player=no hostile_reachable=yes health=low food=ok"),
    ("H3 far-player",
     "hard=hostile-vs-far-player player=away player_moving=yes hostile=adjacent hostile_near_player=no hostile_reachable=yes health=ok food=ok"),
    ("H3b far weak",
     "hard=hostile-vs-far-player player=away player_moving=yes hostile=near hostile_near_player=no hostile_reachable=yes health=low food=ok"),
    ("H4 unreachable",
     "hard=unreachable-hostile player=away player_moving=no hostile=near hostile_near_player=no hostile_reachable=no health=ok food=ok"),
    ("H4b unreach-near-p",
     "hard=unreachable-hostile player=away player_moving=no hostile=near hostile_near_player=yes hostile_reachable=no health=ok food=ok"),
    ("H1 repeat",
     "hard=low-health-hostile player=away player_moving=yes hostile=far hostile_near_player=yes hostile_reachable=yes health=low food=ok"),
    ("H3 repeat",
     "hard=hostile-vs-far-player player=away player_moving=yes hostile=adjacent hostile_near_player=no hostile_reachable=yes health=ok food=ok"),
]


def call(body):
    req = urllib.request.Request(
        BASE + "/v1/systemone", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=180) as res:
        data = json.load(res)
    return (time.perf_counter() - t0) * 1000, data


def check(data):
    try:
        action = data["answers"]["action"]["choice"]
    except (KeyError, TypeError) as e:
        return "missing field: %s" % e
    if action not in ("fight", "follow"):
        return "bad choice: %r" % (action,)
    return None


def main():
    deadline = time.time() + 120
    while True:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=5) as res:
                if json.load(res).get("status") == "ok":
                    break
        except Exception:
            pass
        if time.time() > deadline:
            print("FAIL: /health not ready within 120 s")
            return 1
        time.sleep(2)

    with open(os.path.join(HERE, "test", "request.json")) as f:
        template = json.load(f)

    lat, fails, rows = [], 0, []
    for i in range(20):  # latency sample + shape asserts on the exact bot body
        ms, data = call(template)
        err = check(data)
        if err:
            print("FAIL post %d: %s" % (i, err))
            fails += 1
        lat.append(ms)
        if i == 0:
            rows.append((STATES[0][0], ms, data))
    for label, state in STATES[1:]:  # one post per state for the quality table
        body = dict(template, state=state)
        ms, data = call(body)
        err = check(data)
        if err:
            print("FAIL %s: %s" % (label, err))
            fails += 1
        rows.append((label, ms, data))
    if fails:
        return 1

    ordered = sorted(lat)
    p50 = statistics.median(lat)
    p95 = ordered[min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1)]
    print("posts=%d p50=%.0fms p95=%.0fms" % (len(lat), p50, p95))
    print("%-16s %-8s %s" % ("state", "action", "ms"))
    for label, ms, data in rows:
        print("%-16s %-8s %.0f" % (
            label, data["answers"]["action"]["choice"], ms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
