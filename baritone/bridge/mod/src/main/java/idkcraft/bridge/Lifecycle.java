package idkcraft.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket;
import net.minecraft.network.protocol.game.ClientboundDamageEventPacket;
import net.minecraft.network.protocol.game.ClientboundGameEventPacket;
import net.minecraft.network.protocol.game.ClientboundTakeItemEntityPacket;
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket;

/**
 * Lifecycle + event parity surface (idkcraft-neuc.10).
 *
 * <p>Notifications (mod -&gt; node, folded by bot/src/bridge/lifecycle.js):
 * {@code spawnReset {}}, {@code health {health,food,saturation}},
 * {@code entityHurt {id}}, {@code playerCollect {collectorId,itemId}},
 * {@code rain {raining}}, {@code time {age,timeOfDay}} (once per 20
 * client ticks), {@code kicked {reason}} and {@code end {reason}}.
 *
 * <p>Sources: a per-tick edge detector on the client thread
 * (health/rain/spawn-point changes, time cadence) plus inbound packets
 * via {@link BridgeServer#onPacket} (damage event, item-collect
 * animation, no-respawn-block game event, disconnect packets). Packet
 * hooks run on the netty thread: they only extract primitives and push
 * (WsServer.push is thread-safe).
 *
 * <p>death/respawn are NOT pushed here: neuc.21 owns them in the Node
 * adapter ({@code BaritoneBot._noteLife} drives the Look {@code respawn}
 * RPC off the state.get health edge). A silent disconnect with no
 * disconnect packet is likewise owned there (neuc.20's sustained
 * null-pos grace in the adapter poll).
 */
public final class Lifecycle {
    private final BridgeServer server;
    private volatile boolean endPushed = false;

    // Tick-thread only.
    private float lastHealth = Float.NaN;
    private int lastFood = Integer.MIN_VALUE;
    private float lastSaturation = Float.NaN;
    private boolean lastRaining = false;
    private String lastSpawn = null;
    private long ticks = 0;

    private Lifecycle(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Lifecycle life = new Lifecycle(server);
        server.onClientTick(life::tick);
        server.onPacket(life::onPacket);
    }

    // ---- packet sources (netty thread: primitives + push only) ----

    private void onPacket(Packet<?> packet) {
        if (packet instanceof ClientboundDamageEventPacket p) {
            JsonObject params = new JsonObject();
            params.addProperty("id", p.entityId());
            server.push("entityHurt", params);
        } else if (packet instanceof ClientboundTakeItemEntityPacket p) {
            JsonObject params = new JsonObject();
            params.addProperty("collectorId", p.getPlayerId());
            params.addProperty("itemId", p.getItemId());
            server.push("playerCollect", params);
        } else if (packet instanceof ClientboundGameEventPacket p) {
            if (p.getEvent() == ClientboundGameEventPacket.NO_RESPAWN_BLOCK_AVAILABLE) {
                server.push("spawnReset", new JsonObject());
            }
        } else if (packet instanceof ClientboundDisconnectPacket p) {
            pushEnd(String.valueOf(p.reason().getString()));
        } else if (packet instanceof ClientboundLoginDisconnectPacket p) {
            pushEnd(String.valueOf(p.reason().getString()));
        }
    }

    private void pushEnd(String reason) {
        if (endPushed) {
            return;
        }
        endPushed = true;
        JsonObject kicked = new JsonObject();
        kicked.addProperty("reason", reason);
        kicked.addProperty("loggedIn", true);
        server.push("kicked", kicked);
        JsonObject end = new JsonObject();
        end.addProperty("reason", reason);
        server.push("end", end);
    }

    // ---- tick edge detector (client thread) ----

    private void tick() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer pl = mc != null ? mc.player : null;
        ClientLevel level = mc != null ? mc.level : null;
        if (pl == null || level == null) {
            return;
        }
        endPushed = false;
        ticks++;

        float health = pl.getHealth();
        int food = pl.getFoodData().getFoodLevel();
        float saturation = pl.getFoodData().getSaturationLevel();
        if (health != lastHealth || food != lastFood || saturation != lastSaturation) {
            lastHealth = health;
            lastFood = food;
            lastSaturation = saturation;
            JsonObject p = new JsonObject();
            p.addProperty("health", health);
            p.addProperty("food", food);
            p.addProperty("saturation", saturation);
            server.push("health", p);
        }

        boolean raining = level.isRaining();
        if (raining != lastRaining) {
            lastRaining = raining;
            JsonObject p = new JsonObject();
            p.addProperty("raining", raining);
            server.push("rain", p);
        }

        BlockPos sp = level.getLevelData().getRespawnData().pos();
        String spawnKey = sp == null ? null : sp.getX() + "," + sp.getY() + "," + sp.getZ();
        if (lastSpawn != null && spawnKey != null && !spawnKey.equals(lastSpawn)) {
            server.push("spawnReset", new JsonObject());
        }
        if (spawnKey != null) {
            lastSpawn = spawnKey;
        }

        if (ticks % 20 == 0) {
            long clock = level.getDefaultClockTime();
            if (clock < 0) {
                clock = -clock;
            }
            JsonObject p = new JsonObject();
            p.addProperty("age", level.getLevelData().getGameTime());
            p.addProperty("timeOfDay", clock % 24000);
            server.push("time", p);
        }
    }
}
