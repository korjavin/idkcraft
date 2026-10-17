package idkcraft.bridge;

import com.google.gson.JsonObject;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;

/**
 * idkcraft-neuc.67: {@code body.stats} once a minute (client tick hook) —
 * the prod read of the body JVM without JVM tools (the JRE image has no
 * jcmd/jstat). {@code {heapUsedMb,heapMaxMb,gcCount,gcMs,maxTickGapMs,
 * maxPushMs,chunks,entities,rpc}}: gc* = the collections in the last window
 * (all GarbageCollectorMXBeans), maxTickGapMs = the longest wall gap
 * between two client post-ticks in it (50 = smooth; a GC pause or a
 * blocked client thread shows here), maxPushMs = the slowest blocking ws
 * write (WsServer.push) in it, rpc = handler ms per method in it
 * (neuc.67.1, Rpc.takeTimings). Observation only.
 */
final class Stats {
    private static final long WINDOW_MS = 60_000;

    private final BridgeServer server;
    private long lastTickMs;
    private long maxGapMs;
    private long windowStartMs;
    private long gcCount0 = -1;
    private long gcMs0;

    private Stats(BridgeServer server) {
        this.server = server;
    }

    static void install(BridgeServer server) {
        Stats s = new Stats(server);
        server.onClientTick(s::tick);
    }

    /** Client thread. */
    private void tick() {
        long now = System.currentTimeMillis();
        if (lastTickMs > 0 && now - lastTickMs < WINDOW_MS) { // longer = out of world (ticks stop), not a pause
            maxGapMs = Math.max(maxGapMs, now - lastTickMs);
        }
        lastTickMs = now;
        if (gcCount0 >= 0 && now - windowStartMs < WINDOW_MS) {
            return;
        }
        long[] gc = gcTotals();
        if (gcCount0 < 0) { // first in-world tick: open the window
            gcCount0 = gc[0];
            gcMs0 = gc[1];
            windowStartMs = now;
            return;
        }
        Runtime rt = Runtime.getRuntime();
        JsonObject p = new JsonObject();
        p.addProperty("heapUsedMb", (rt.totalMemory() - rt.freeMemory()) >> 20);
        p.addProperty("heapMaxMb", rt.maxMemory() >> 20);
        p.addProperty("gcCount", gc[0] - gcCount0);
        p.addProperty("gcMs", gc[1] - gcMs0);
        p.addProperty("maxTickGapMs", maxGapMs);
        p.addProperty("maxPushMs", server.takeMaxPushMs());
        p.addProperty("rpc", server.takeRpcTimings());
        ClientLevel level = Minecraft.getInstance().level;
        p.addProperty("chunks", level != null ? level.getChunkSource().getLoadedChunksCount() : 0);
        p.addProperty("entities", level != null ? level.getEntityCount() : 0);
        gcCount0 = gc[0];
        gcMs0 = gc[1];
        maxGapMs = 0;
        windowStartMs = now;
        server.push("body.stats", p);
    }

    private static long[] gcTotals() {
        long n = 0;
        long ms = 0;
        for (GarbageCollectorMXBean b : ManagementFactory.getGarbageCollectorMXBeans()) {
            n += Math.max(0, b.getCollectionCount());
            ms += Math.max(0, b.getCollectionTime());
        }
        return new long[] {n, ms};
    }
}
