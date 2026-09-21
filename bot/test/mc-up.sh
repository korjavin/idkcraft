#!/bin/sh
# Throwaway Paper server for local bot testing (no Geyser needed).
# Usage: sh test/mc-up.sh   (Ctrl-C to stop; data is ephemeral)
# Flat world: default worldgen spawn can trap pathfinding bots in holes or
# cliffs and fail the follow check for terrain reasons; flat keeps e2e
# deterministic. Override with MC_VERSION (default matches infra pin 26.1.2).
set -e
exec docker run --rm -i \
  -e EULA=TRUE \
  -e TYPE=PAPER \
  -e ONLINE_MODE=FALSE \
  -e ENABLE_WHITELIST=FALSE \
  -e VERSION="${MC_VERSION:-26.1.2}" \
  -e LEVEL_TYPE=flat \
  -p 25565:25565 \
  itzg/minecraft-server
