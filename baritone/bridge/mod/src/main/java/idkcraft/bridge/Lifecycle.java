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
import net.minecraft.network.protocol.game.ClientboundRespawnPacket;
import net.minecraft.network.protocol.game.ClientboundTakeItemEntityPacket;
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket;

/**
 * Lifecycle + event parity surface (idkcraft-neuc.10).
 *
 * <p>Notifications (mod -&gt; node, folded by bot/src/bridge/lifecycle.js):
 * {@code death {}}, {@code respawn {}}, {@code spawnReset {}},
 * {@code health {health,food,saturation}}, {@code entityHurt {id}},
 * {@code playerCollect {collectorId,itemId}}, {@code rain {raining}},
 * {@code time {age,timeOfDay}} (once per 20 client ticks),
 * {@code kicked {reason}} and {@code end {reason}}.
 *
 * <p>Sources: a per-tick edge detector on the client thread (death =
 * health &le; 0 edge, respawn = dead -&gt; alive, health/rain/spawn-point
 * changes, time cadence, disconnect fallback) plus inbound packets via
 * {@link BridgeServer#onPacket} (damage event, item-collect animation,
 * respawn packet, no-respawn-block game event, disconnect packets).
 * Packet hooks run on the netty thread: they only extract primitives and
 * push (WsServer.push is thread-safe) or set volatile flags the tick
 * consumes.
 *
 * <p>Auto-respawn (mineflayer parity): on the death edge the client sends
 * the respawn request itself ({@link LocalPlayer#respawn()}), retried
 * every 20 ticks while still dead, unless disabled via
 * {@code respawn.set {auto:false}}. {@code respawn.now {}} sends one now.
 */
public final class Lifecycle {
    private final BridgeServer server;
    private volatile boolean autoRespawn = true;
    private volatile boolean dead = false;
    private volatile boolean endPushed = false;

    // Tick-thread only.
    private boolean wasInWorld = false;
    private float lastHealth = Float.NaN;
    private int lastFood = Integer.MIN_VALUE;
    private float lastSaturation = Float.NaN;
    private boolean lastRaining = false;
    private String lastSpawn = null;
    private long ticks = 0;
    private long deathTick = 0;

    private Lifecycle(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Lifecycle life = new Lifecycle(server);
        server.onClientTick(life::tick);
        server.onPacket(life::onPacket);
        server.register("respawn.now", params -> {
            JsonObject res = new JsonObject();
            res.addProperty("ok", server.onClient(() -> {
                Minecraft mc = Minecraft.getInstance();
                LocalPlayer pl = mc != null ? mc.player : null;
                if (pl == null) {
                    return null;
                }
                pl.respawn();
                return Boolean.TRUE;
            }) != null);
            return res;
        });
        server.register("respawn.set", params -> {
            boolean auto = !params.has("auto") || params.get("auto").getAsBoolean();
            life.autoRespawn = auto;
            JsonObject res = new JsonObject();
            res.addProperty("ok", true);
            res.addProperty("auto", auto);
            return res;
        });
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
        } else if (packet instanceof ClientboundRespawnPacket) {
            // Death respawn only: the dead flag keeps a dimension-change
            // respawn packet from double-firing with the tick edge (the
            // Node lifecycle pairs respawn lines to deaths anyway).
            if (dead) {
                dead = false;
                server.push("respawn", new JsonObject());
            }
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
            if (wasInWorld && !endPushed) {
                // No disconnect packet (socket drop / back to menu): the
                // same end a v1 dropped connection produces.
                pushEnd("disconnected");
            }
            wasInWorld = false;
            return;
        }
        wasInWorld = true;
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

        if (health <= 0 && !dead) {
            dead = true;
            deathTick = ticks;
            server.push("death", new JsonObject());
        }
        if (dead && health > 0) {
            dead = false;
            server.push("respawn", new JsonObject());
        }
        if (dead && autoRespawn && (ticks == deathTick || (ticks - deathTick) % 20 == 0)) {
            try {
                pl.respawn();
            } catch (Exception ignored) {
                // Retried on the next 20-tick boundary while still dead.
            }
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
