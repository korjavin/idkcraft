package idkcraft.bridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Look / attack / interact / sleep surface (idkcraft-neuc.9).
 *
 * <p>Methods: {@code look.set {yaw,pitch,force}}, {@code look.at {x,y,z}},
 * {@code attack {entityId}}, {@code interact.entity {entityId}},
 * {@code interact.block {x,y,z,face,cursor,sneak}},
 * {@code interact.item {hand,holdMs}}, {@code interact.stop {}},
 * {@code sleep {x,y,z}}, {@code wake {}}, {@code respawn {}}. Notifications: {@code sleep {}} /
 * {@code wake {}} on the player's sleeping-state edge (per-tick hook).
 *
 * <p>Yaw/pitch on the wire are mineflayer radians (PROTOCOL.md units);
 * conversion to notch degrees happens here: notchYaw = deg(pi - yaw),
 * notchPitch = deg(-pitch) (mineflayer conversions.js, inverse of
 * {@link BridgeServer#mineflayerYaw}).
 *
 * <p>Baritone pause/resume around an interaction is the NODE adapter's job
 * (bot/src/bridge/look.js {@code withBaritonePaused}, shared with neuc.7):
 * it owns the goal latch, so it can re-check/re-issue after resume. Handlers
 * here run as one client-thread task (via {@link BridgeServer#onClient}), so
 * a look+interact pair inside one call is never split by a Baritone tick.
 *
 * <p>{@code interact.item} with {@code holdMs} auto-stops the use when the
 * deadline passes (tick hook, wall clock); {@code interact.stop} stops now.
 */
public final class Look {
    private final BridgeServer server;
    private volatile boolean wasSleeping;
    private volatile long stopUsingAtMs;

    private Look(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Look look = new Look(server);
        server.onClientTick(look::tick);
        server.register("look.set", params -> {
            double yaw = requiredDouble(params, "yaw");
            double pitch = requiredDouble(params, "pitch");
            return look.onPlayer(player -> {
                applyLook(player, yaw, pitch);
                return ok();
            });
        });
        server.register("look.at", params -> {
            double x = requiredDouble(params, "x");
            double y = requiredDouble(params, "y");
            double z = requiredDouble(params, "z");
            return look.onPlayer(player -> {
                Vec3 eye = player.getEyePosition();
                double dx = x - eye.x;
                double dy = y - eye.y;
                double dz = z - eye.z;
                double yaw = Math.atan2(-dx, -dz);
                double pitch = Math.atan2(dy, Math.hypot(dx, dz));
                applyLook(player, yaw, pitch);
                JsonObject res = ok();
                res.addProperty("yaw", yaw);
                res.addProperty("pitch", pitch);
                return res;
            });
        });
        server.register("attack", params -> {
            int entityId = requiredInt(params, "entityId");
            return look.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.level == null || client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                Entity target = client.level.getEntity(entityId);
                if (target == null) {
                    throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "no such entity " + entityId);
                }
                client.gameMode.attack(player, target);
                player.swing(InteractionHand.MAIN_HAND);
                return ok();
            });
        });
        // idkcraft-h1nl: entity-use (shear sheep, breed, mount) — the use
        // path of use_entity, beside attack's hit path. The caller aims
        // first (Node lookAt, like mineflayer's activateEntity); the client
        // decides reach and validity, same as interact.block.
        server.register("interact.entity", params -> {
            int entityId = requiredInt(params, "entityId");
            return look.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                Entity target = client.level == null ? null : client.level.getEntity(entityId);
                if (target == null) {
                    throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "no such entity " + entityId);
                }
                var result = client.gameMode.interact(player, target, new EntityHitResult(target), InteractionHand.MAIN_HAND);
                JsonObject res = ok();
                res.addProperty("result", String.valueOf(result));
                return res;
            });
        });
        server.register("interact.block", params -> {
            int x = requiredInt(params, "x");
            int y = requiredInt(params, "y");
            int z = requiredInt(params, "z");
            String face = optString(params, "face", "up");
            boolean sneak = optBool(params, "sneak", false);
            double cx = optCursor(params, "x", 0.5);
            double cy = optCursor(params, "y", 0.5);
            double cz = optCursor(params, "z", 0.5);
            return look.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                Direction dir;
                try {
                    dir = Direction.valueOf(face.toUpperCase(java.util.Locale.ROOT));
                } catch (IllegalArgumentException e) {
                    throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad face " + face);
                }
                BlockPos pos = new BlockPos(x, y, z);
                BlockHitResult hit = new BlockHitResult(new Vec3(x + cx, y + cy, z + cz), dir, pos, false);
                boolean wasShift = player.isShiftKeyDown();
                if (sneak) {
                    player.setShiftKeyDown(true);
                }
                try {
                    var result = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
                    JsonObject res = ok();
                    res.addProperty("result", String.valueOf(result));
                    return res;
                } finally {
                    if (sneak) {
                        player.setShiftKeyDown(wasShift);
                    }
                }
            });
        });
        server.register("interact.item", params -> {
            String hand = optString(params, "hand", "main");
            long holdMs = optLong(params, "holdMs", 0);
            return look.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                InteractionHand h = "off".equals(hand) ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
                client.gameMode.useItem(player, h);
                // Continuous uses (eat/drink/bow: a use animation) are
                // cancelled by vanilla next tick unless the use key stays
                // down — hold it until interact.stop / the holdMs deadline.
                // Instant uses (buckets, blocks: animation NONE) must NOT
                // hold: a held key would re-fire the use (fill then pour).
                if (player.getItemInHand(h).getUseAnimation() != net.minecraft.world.item.ItemUseAnimation.NONE) {
                    client.options.keyUse.setDown(true);
                    look.stopUsingAtMs = holdMs > 0 ? System.currentTimeMillis() + holdMs : 0;
                }
                return ok();
            });
        });
        server.register("interact.stop", params -> look.onPlayer(player -> {
            look.stopUsing(player);
            return ok();
        }));
        server.register("sleep", params -> {
            int x = requiredInt(params, "x");
            int y = requiredInt(params, "y");
            int z = requiredInt(params, "z");
            return look.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                BlockPos pos = new BlockPos(x, y, z);
                BlockHitResult hit = new BlockHitResult(
                        new Vec3(x + 0.5, y + 0.5, z + 0.5), Direction.UP, pos, false);
                var result = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
                JsonObject res = ok();
                // consumesAction() is the version-proof verdict (Interact.java
                // and Windows.java read it the same way): false means the
                // client rejected the synthetic hit outright, whatever the
                // InteractionResult representation.
                res.addProperty("accepted", result.consumesAction());
                return res;
            });
        });
        server.register("wake", params -> look.onPlayer(player -> {
            if (player.connection != null) {
                player.connection.send(new ServerboundPlayerCommandPacket(
                        player, ServerboundPlayerCommandPacket.Action.STOP_SLEEPING));
            }
            return ok();
        }));
        // idkcraft-neuc.21: the death-screen respawn click (mineflayer
        // respawn:true parity, driven by the Node adapter on health <= 0).
        // A live player is a no-op, so a late or repeated call is harmless.
        server.register("respawn", params -> look.onPlayer(player -> {
            if (player.isDeadOrDying()) {
                player.respawn();
            }
            return ok();
        }));
    }

    /** One client-thread interaction; NOT_IN_WORLD when there is no player. */
    private JsonObject onPlayer(PlayerAction action) throws Rpc.RpcException {
        // RpcException crosses the client-thread submit in a holder: submit()
        // swallows task failures into a null, which must not mask them.
        Rpc.RpcException[] failure = new Rpc.RpcException[1];
        JsonObject res = server.onClient(() -> {
            Minecraft client = Minecraft.getInstance();
            LocalPlayer player = client != null ? client.player : null;
            if (player == null) {
                return null;
            }
            try {
                return action.run(player);
            } catch (Rpc.RpcException e) {
                failure[0] = e;
                return null;
            }
        });
        if (failure[0] != null) {
            throw failure[0];
        }
        if (res == null) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
        }
        return res;
    }

    @FunctionalInterface
    private interface PlayerAction {
        JsonObject run(LocalPlayer player) throws Rpc.RpcException;
    }

    /** Client thread (tick hook): sleeping edge notifications + item auto-stop. */
    private void tick() {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client != null ? client.player : null;
        if (player == null) {
            wasSleeping = false;
            return;
        }
        boolean sleeping = player.isSleeping();
        if (sleeping != wasSleeping) {
            wasSleeping = sleeping;
            server.push(sleeping ? "sleep" : "wake", new JsonObject());
        }
        long stopAt = stopUsingAtMs;
        if (stopAt > 0 && System.currentTimeMillis() >= stopAt) {
            stopUsing(player);
        }
    }

    /** Release a held use: key up first, then the game-mode release. */
    private void stopUsing(LocalPlayer player) {
        stopUsingAtMs = 0;
        Minecraft client = Minecraft.getInstance();
        if (client != null && client.options != null) {
            client.options.keyUse.setDown(false);
        }
        if (player.isUsingItem() && client != null && client.gameMode != null) {
            client.gameMode.releaseUsingItem(player);
        }
    }

    /** Mineflayer radians -> notch degrees, applied to body + head. */
    private static void applyLook(LocalPlayer player, double yawRad, double pitchRad) {
        float notchYaw = (float) LookMath.notchYawDeg(yawRad);
        float notchPitch = (float) LookMath.notchPitchDeg(pitchRad);
        player.setYRot(notchYaw);
        player.setXRot(notchPitch);
        player.setYHeadRot(notchYaw);
    }

    private static JsonObject ok() {
        JsonObject res = new JsonObject();
        res.addProperty("ok", true);
        return res;
    }

    private static double requiredDouble(JsonObject params, String key) throws Rpc.RpcException {
        if (!params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing number param " + key);
        }
        return params.get(key).getAsDouble();
    }

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        return (int) requiredDouble(params, key);
    }

    private static String optString(JsonObject params, String key, String fallback) {
        return params.has(key) && params.get(key).isJsonPrimitive()
                ? params.get(key).getAsString() : fallback;
    }

    private static boolean optBool(JsonObject params, String key, boolean fallback) {
        return params.has(key) && params.get(key).isJsonPrimitive()
                ? params.get(key).getAsBoolean() : fallback;
    }

    private static long optLong(JsonObject params, String key, long fallback) {
        return params.has(key) && params.get(key).isJsonPrimitive()
                && params.get(key).getAsJsonPrimitive().isNumber()
                ? params.get(key).getAsLong() : fallback;
    }

    private static double optCursor(JsonObject params, String axis, double fallback) {
        if (params.has("cursor") && params.get("cursor").isJsonObject()) {
            JsonObject cursor = params.getAsJsonObject("cursor");
            if (cursor.has(axis) && cursor.get(axis).isJsonPrimitive()
                    && cursor.get(axis).getAsJsonPrimitive().isNumber()) {
                return cursor.get(axis).getAsDouble();
            }
        }
        return fallback;
    }
}
