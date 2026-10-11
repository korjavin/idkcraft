# Baritone spike client (idkcraft-vhlb.6): HeadlessMc + Fabric + Baritone,
# a real Minecraft client without a screen. Local rig only, never prod.
# MC 26.1.2 (= the rig Paper) needs Java 25; the HeadlessMc image ships 21,
# so the launcher is copied onto a Temurin 25 base.
FROM 3arthqu4ke/headlessmc:2.10.0 AS hmc

FROM eclipse-temurin:25-jre
COPY --from=hmc /headlessmc /headlessmc
COPY config.properties /headlessmc/HeadlessMC/config.properties
# Baritone v1.18.0 = "For Minecraft 26.1" (fabric.mod.json: minecraft 26.1.*);
# hmc-specifics adds the in-game console commands (connect, msg) the driver uses.
ADD --checksum=sha256:c50e46003e77e13e6d703d83fad51b03b200912994ccf4d174db7025a1c5b682 \
  https://github.com/cabaletta/baritone/releases/download/v1.18.0/baritone-standalone-fabric-1.18.0.jar \
  /headlessmc/HeadlessMC/run/mods/baritone.jar
ADD --checksum=sha256:d81456a494f88810603b5c1c38946a0dad7fd24f93c9ea649eb48937a8a0a7dc \
  https://github.com/headlesshq/hmc-specifics/releases/download/26.1.2-latest/hmc-specifics-26.1.2-fabric-latest.jar \
  /headlessmc/HeadlessMC/run/mods/hmc-specifics.jar
WORKDIR /headlessmc
# Downloads the vanilla client + Fabric loader at build time (no account needed
# to download; launching is gated by run.sh, see README).
RUN java -jar headlessmc-launcher-wrapper.jar --command fabric 26.1.2 \
 && java -jar headlessmc-launcher-wrapper.jar --command versions
ENTRYPOINT ["java", "-jar", "headlessmc-launcher-wrapper.jar"]
