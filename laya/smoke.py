#!/usr/bin/env python3
"""LAYA sidecar smoke test (stdlib only: urllib, json, statistics).

Usage: python smoke.py [base_url]  (default http://127.0.0.1:8000)

NOTE: test/request.json must be kept in sync with what bot/src/brain.js
sends (model, state text, questions) -- it is the exact JEV-shaped body.

Waits for /health (up to 120 s), POSTs request.json 20x asserting
answers.action.choice in {fight, follow, roam, idle} and answers.sprint.noul is a float
in [0,1], then prints p50/p95 ms plus the answers for 5 canned states as a
table for the human quality check. Exit non-zero on any shape failure.
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

STATES = [
    ("dist 12 moving",
     "distance_to_player=12.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false"),
    ("dist 5",
     "distance_to_player=5.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false"),
    ("dist 1",
     "distance_to_player=1.0 player_visible=true player_moving=false bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false"),
    ("hostile 4",
     "distance_to_player=5.0 player_visible=true player_moving=false bot_health=20 bot_food=20 nearby_hostiles=1 hostile_distance=4.0 hostile_near_player=false"),
    ("dist 1 still",
     "distance_to_player=1.0 player_visible=true player_moving=false bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false"),
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
        sprint = data["answers"]["sprint"]["noul"]
    except (KeyError, TypeError) as e:
        return "missing field: %s" % e
    if action not in ("fight", "follow", "roam", "idle"):
        return "bad choice: %r" % (action,)
    if isinstance(sprint, bool) or not isinstance(sprint, (int, float)) or not 0 <= sprint <= 1:
        return "bad noul: %r" % (sprint,)
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
    print("%-14s %-8s %-8s %s" % ("state", "action", "sprint", "ms"))
    for label, ms, data in rows:
        print("%-14s %-8s %-8.3f %.0f" % (
            label, data["answers"]["action"]["choice"],
            data["answers"]["sprint"]["noul"], ms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
