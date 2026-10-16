# Baritone worker (idkcraft-jlda.1): HeadlessMc + Fabric + Baritone, a real
# Minecraft client without a screen. Deployable service (compose: baritone);
# the rig (run.sh) exercises the same image, entrypoint and bridge.
# MC 26.1.2 (= the prod Paper) needs Java 25; the HeadlessMc image ships 21,
# so the launcher is copied onto a Temurin 25 base.
#
# The one-body bridge mod (idkcraft-neuc.1) builds in the mod stage below
# and lands in run/mods next to baritone.jar; it serves the ws the v2
# adapter (BOT_BODY=baritone) drives. No published ws port here — the rig
# publishes it, compose keeps it internal.
FROM 3arthqu4ke/headlessmc:2.10.0 AS hmc

# Bridge mod (idkcraft-neuc.1): JDK 25 + Gradle compiles bridge/mod. Build
# files copy first so the dependency layer caches across mod-source edits
# (same rule as the client-download layer in the final stage).
FROM eclipse-temurin:25-jdk AS mod
WORKDIR /src
COPY bridge/mod/settings.gradle bridge/mod/gradle.properties bridge/mod/build.gradle ./
COPY bridge/mod/gradlew bridge/mod/gradlew.bat ./
COPY bridge/mod/gradle ./gradle
RUN chmod +x gradlew && ./gradlew --no-daemon warmDeps
COPY bridge/mod/src ./src
RUN ./gradlew --no-daemon build

FROM eclipse-temurin:25-jre
COPY --from=hmc /headlessmc /headlessmc
COPY config.properties /headlessmc/HeadlessMC/config.properties
# socat = the write-only control bridge (start.sh): one TCP line port whose
# bytes are typed into the HMC console FIFO. No other net tools in the image.
RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*
# Baritone v1.18.0 = "For Minecraft 26.1" (fabric.mod.json: minecraft 26.1.*);
# hmc-specifics adds the in-game console commands (connect, msg) the driver uses.
# Both jars pin immutable versioned release assets (idkcraft-jlda.9): the
# 26.1.2-latest moving tag was re-uploaded under us and broke master CI.
ADD --checksum=sha256:c50e46003e77e13e6d703d83fad51b03b200912994ccf4d174db7025a1c5b682 \
  https://github.com/cabaletta/baritone/releases/download/v1.18.0/baritone-standalone-fabric-1.18.0.jar \
  /headlessmc/HeadlessMC/run/mods/baritone.jar
ADD --checksum=sha256:2e5e4378727532db567ff648087f64f8f98ee7d1fad2b15193d7f0b2acc86aef \
  https://github.com/headlesshq/hmc-specifics/releases/download/2.5.0/hmc-specifics-26.1.2-2.5.0-fabric-release.jar \
  /headlessmc/HeadlessMC/run/mods/hmc-specifics.jar
# The API-visible twin of baritone.jar (idkcraft-neuc.1): the same 1.18.0
# code, but the standalone above is proguarded past baritone/api/**, so the
# v2 body (BARITONE_API=1, see start.sh) runs on this one instead. Staged
# outside mods/ — only one baritone id may load. Inert for the worker.
ADD --checksum=sha256:beec850e73591ab1dc81cb359d1d224ef3230a35d21dc6e72f8e8d287e7b79d2 \
  https://github.com/cabaletta/baritone/releases/download/v1.18.0/baritone-api-fabric-1.18.0.jar \
  /headlessmc/baritone-api.jar
WORKDIR /headlessmc
# Downloads the vanilla client + Fabric loader at build time (no account needed
# to download; launching is gated by start.sh, see README).
RUN java -jar headlessmc-launcher-wrapper.jar --command fabric 26.1.2 \
 && java -jar headlessmc-launcher-wrapper.jar --command versions
# Warm layer (idkcraft-6x7.28): launch the client offline once so the ~600 MB
# of libraries + assets the first launch downloads live in the image, then
# kill it. Waits on the start.sh/client.sh marker, not a sleep; 300 s cap =
# the build fails loud. Before the mod/start.sh/settings COPYs below, so
# their edits reuse this layer (libraries do not depend on them). Leaves no
# account (auth/.accounts.json stays empty: offline); drops logs, the lock
# and the per-launch natives dir.
RUN mkfifo /tmp/warm-in && exec 8<> /tmp/warm-in \
 && (java -Dhmc.jvmargs=-Dhmc.jline.dumb=true -Dhmc.offline.username=warm \
      -jar headlessmc-launcher-wrapper.jar \
      --command launch fabric-loader-0.19.5-26.1.2 -lwjgl -offline \
      < /tmp/warm-in > /tmp/warm.log 2>&1 &) \
 && for _ in $(seq 1 100); do grep -q "HMC-Specifics initialized" /tmp/warm.log && break; sleep 3; done \
 && if ! grep -q "HMC-Specifics initialized" /tmp/warm.log; then tail -50 /tmp/warm.log; exit 1; fi \
 && grep -c "is missing, downloading" /tmp/warm.log || true \
 && pkill -f headlessmc ; pkill java ; sleep 3 \
 ; rm -rf /tmp/warm-in /tmp/warm.log HeadlessMC/run/logs HeadlessMC/run/crash-reports \
   HeadlessMC/headlessmc.log.lck HeadlessMC/*-*-*-*-*/ \
 && test ! -s HeadlessMC/auth/.accounts.json
# Worker entrypoint + Baritone presets AFTER the download layer: shell edits
# must not invalidate the ~100 MB client fetch. Game dir = HeadlessMC/run.
COPY start.sh ./start.sh
COPY settings.txt ./HeadlessMC/run/baritone/settings.txt
COPY --from=mod /src/build/libs/idkcraft-bridge-0.1.0.jar ./HeadlessMC/run/mods/idkcraft-bridge.jar
RUN chmod +x start.sh
ENTRYPOINT ["./start.sh"]
