#!/bin/sh
# Baritone worker entrypoint (idkcraft-jlda.1): gate on the stored account,
# launch the client with the HMC console on a FIFO, expose the write-only
# control bridge (socat TCP -> FIFO). The head drives connect/disconnect over
# the bridge; docker logs = the client log (Baritone's [CHAT] [Baritone] ...
# lines land there). No HTTP, no auto-connect, no status endpoint.
# Any args replace the worker run (one-time login: --command login, README).
set -e
cd /headlessmc
# One-time login first: it CREATES the account the gate below wants.
if [ $# -gt 0 ]; then
  exec java -jar headlessmc-launcher-wrapper.jar "$@"
fi
HMC_PROPS="-Dhmc.jvmargs=-Dhmc.jline.dumb=true" # no TTY: the in-game JLine reader crashes init unless dumb
HMC_OFFLINE=
if [ "${BARITONE_OFFLINE:-}" = 1 ]; then # local rig opt-in only, never prod
  HMC_PROPS="$HMC_PROPS -Dhmc.offline.username=${BOT:-BaritoneBot}"; HMC_OFFLINE=-offline
elif [ ! -s /headlessmc/HeadlessMC/auth/.accounts.json ]; then
  echo "no account: one-time login, see baritone/README.md"
  exec sleep infinity # default-off: no JVM, ~0 RAM
fi
mkfifo /tmp/console
exec 8<> /tmp/console # held open: an EOF on stdin kills the HMC console
# Write-only line port: whatever a client writes is typed into the console.
# One connection per line (socat fork + cat exits on EOF); small writes are
# atomic on the FIFO, so concurrent senders cannot interleave mid-line.
# 7777 = the WORKER_PORT/bot default and the rig publish in run.sh.
socat "TCP-LISTEN:${BRIDGE_PORT:-7777},reuseaddr,fork" SYSTEM:'cat >> /tmp/console' &
SOCAT=$!
# sh stays pid 1 and forwards stops to both children (docker stop only
# signals pid 1; without this the client would hang till the kill timeout).
trap 'kill $CLIENT $SOCAT 2>/dev/null' TERM INT
# No -commands: it starts the runtime's own stdin reader, which splits input
# with hmc-specifics' (only hmc-specifics has connect/msg). connect arrives
# over the bridge only after HMC-Specifics initialized (the head/run.sh wait).
java $HMC_PROPS -jar headlessmc-launcher-wrapper.jar \
  --command launch fabric-loader-0.19.5-26.1.2 -lwjgl $HMC_OFFLINE < /tmp/console &
CLIENT=$!
wait $CLIENT
