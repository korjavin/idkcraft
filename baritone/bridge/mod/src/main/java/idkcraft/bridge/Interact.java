package idkcraft.bridge;

import baritone.api.BaritoneAPI;
import baritone.api.utils.IPlayerController;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Dig / place surface (idkcraft-neuc.7).
 *
 * <p>Methods: {@code dig.start {x,y,z,face,look}} -> {@code {ok}} (the dig
 * runs on the client ticks; the outcome arrives as a notification),
 * {@code dig.abort {}} -> {@code {ok,aborted}}, {@code place.once
 * {x,y,z,face,yaw,pitch,cursor,sneak}} -> {@code {ok,result}} (x,y,z = the
 * target cell; the clicked block is target - face). Notifications:
 * {@code dig.progress {x,y,z,progress}}, {@code dig.done
 * {x,y,z,broke,stateId}}, {@code dig.abort {x,y,z,reason}} with reason
 * moved|changed|timeout|unreachable|cancelled.
 *
 * <p>Digging mirrors Baritone's own BlockBreakHelper through its
 * IPlayerController: clickBlock once, then onPlayerDamageBlock per client
 * tick, then setHittingBlock(false) — that last call is what keeps
 * vanilla's per-tick continueAttack(false) -> stopDestroyBlock() (the
 * headless client never holds the attack key) from aborting the dig every
 * tick. The block is done when its block turns air/liquid on the client
 * (mineflayer parity: mineflayer resolves on its predicted air too; a
 * server refusal comes back as a block.update that restores the cache).
 *
 * <p>Baritone pause/resume around a dig/place is the Node adapter's job
 * (look.js withBaritonePaused), same split as Look.
 */
public final class Interact {
    private static final long DIG_TIMEOUT_MS = 30000;
    /** Server reach slack past blockInteractionRange (vanilla validates 1.0 more). */
    private static final double REACH_SLACK = 1.0;

    private final BridgeServer server;
    /** The one dig in flight; client thread only. */
    private Dig dig;

    private static final class Dig {
        final BlockPos pos;
        final Direction dir;
        final Block block;
        final long startMs;
        int lastStage = -2;

        Dig(BlockPos pos, Direction dir, Block block) {
            this.pos = pos;
            this.dir = dir;
            this.block = block;
            this.startMs = System.currentTimeMillis();
        }
    }

    private Interact(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Interact in = new Interact(server);
        server.onClientTick(in::tick);
        server.register("dig.start", params -> {
            int x = requiredInt(params, "x");
            int y = requiredInt(params, "y");
            int z = requiredInt(params, "z");
            Direction dir = direction(params);
            boolean look = !params.has("look") || !params.get("look").isJsonPrimitive()
                    || params.get("look").getAsBoolean();
            return in.onPlayer(player -> in.start(player, new BlockPos(x, y, z), dir, look));
        });
        server.register("dig.abort", params -> in.onPlayer(player -> {
            JsonObject res = ok();
            res.addProperty("aborted", in.dig != null);
            in.abort("cancelled");
            return res;
        }));
        server.register("place.once", params -> {
            int x = requiredInt(params, "x");
            int y = requiredInt(params, "y");
            int z = requiredInt(params, "z");
            Direction dir = direction(params);
            Double yaw = optDouble(params, "yaw");
            Double pitch = optDouble(params, "pitch");
            boolean sneak = params.has("sneak") && params.get("sneak").isJsonPrimitive()
                    && params.get("sneak").getAsBoolean();
            double cx = cursor(params, "x", 0.5 + dir.getStepX() * 0.5);
            double cy = cursor(params, "y", 0.5 + dir.getStepY() * 0.5);
            double cz = cursor(params, "z", 0.5 + dir.getStepZ() * 0.5);
            return in.onPlayer(player -> {
                Minecraft client = Minecraft.getInstance();
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
                }
                BlockPos ref = new BlockPos(x, y, z).relative(dir.getOpposite());
                if (yaw != null && pitch != null) {
                    applyLook(player, yaw, pitch);
                }
                BlockHitResult hit = new BlockHitResult(
                        new Vec3(ref.getX() + cx, ref.getY() + cy, ref.getZ() + cz), dir, ref, false);
                boolean wasShift = player.isShiftKeyDown();
                if (sneak) {
                    player.setShiftKeyDown(true);
                }
                try {
                    var result = client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit);
                    if (result.consumesAction()) {
                        player.swing(InteractionHand.MAIN_HAND);
                    }
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
    }

    /** Client thread: begin a dig (replacing any dig in flight). */
    private JsonObject start(LocalPlayer player, BlockPos pos, Direction dir, boolean look)
            throws Rpc.RpcException {
        Minecraft client = Minecraft.getInstance();
        ClientLevel level = client.level;
        if (level == null || client.gameMode == null) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
        }
        abort("changed"); // mineflayer: a new dig cancels the old one
        BlockState state = level.getBlockState(pos);
        if (state.isAir()) { // already gone (Node's cache lagged): done at once, the write-through fixes it
            JsonObject p = at(pos);
            p.addProperty("broke", false);
            p.addProperty("stateId", Block.getId(state));
            server.push("dig.done", p);
            return ok();
        }
        if (state.getDestroySpeed(level, pos) < 0) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "not diggable at " + pos.toShortString());
        }
        selectBestTool(player, state);
        if (look) {
            Vec3 eye = player.getEyePosition();
            double px = pos.getX() + 0.5 + dir.getStepX() * 0.5;
            double py = pos.getY() + 0.5 + dir.getStepY() * 0.5;
            double pz = pos.getZ() + 0.5 + dir.getStepZ() * 0.5;
            double dx = px - eye.x;
            double dy = py - eye.y;
            double dz = pz - eye.z;
            applyLook(player, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
        }
        IPlayerController pc = controller();
        pc.syncHeldItem();
        pc.clickBlock(pos, dir);
        player.swing(InteractionHand.MAIN_HAND);
        pc.setHittingBlock(false);
        dig = new Dig(pos, dir, state.getBlock());
        return ok();
    }

    /** Client thread (tick hook): drive the dig in flight one tick. */
    private void tick() {
        Dig d = dig;
        if (d == null) {
            return;
        }
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client != null ? client.player : null;
        ClientLevel level = client != null ? client.level : null;
        if (player == null || level == null || client.gameMode == null || player.isDeadOrDying()) {
            abort("unreachable");
            return;
        }
        if (finished(level, d)) {
            return;
        }
        if (System.currentTimeMillis() - d.startMs > DIG_TIMEOUT_MS) {
            abort("timeout");
            return;
        }
        if (!player.isWithinBlockInteractionRange(d.pos, REACH_SLACK)) {
            abort("moved");
            return;
        }
        IPlayerController pc = controller();
        if (pc.onPlayerDamageBlock(d.pos, d.dir)) {
            player.swing(InteractionHand.MAIN_HAND);
        }
        pc.setHittingBlock(false);
        if (finished(level, d)) {
            return;
        }
        int stage = client.gameMode.getDestroyStage();
        if (stage != d.lastStage) {
            d.lastStage = stage;
            JsonObject p = at(d.pos);
            p.addProperty("progress", Math.max(0, stage + 1) / 10.0);
            server.push("dig.progress", p);
        }
    }

    /**
     * The block left: air/liquid = broken (dig.done), anything else =
     * swapped under us (dig.abort changed). Property-only changes (leaf
     * distance, a door swing) keep digging.
     */
    private boolean finished(ClientLevel level, Dig d) {
        BlockState now = level.getBlockState(d.pos);
        if (now.getBlock() == d.block) {
            return false;
        }
        if (now.isAir() || now.liquid()) {
            dig = null;
            JsonObject p = at(d.pos);
            p.addProperty("broke", true);
            p.addProperty("stateId", Block.getId(now));
            server.push("dig.done", p);
        } else {
            abort("changed");
        }
        return true;
    }

    /** Client thread: cancel the dig in flight (vanilla ABORT packet) and push dig.abort. */
    private void abort(String reason) {
        Dig d = dig;
        if (d == null) {
            return;
        }
        dig = null;
        try {
            Minecraft client = Minecraft.getInstance();
            if (client != null && client.player != null && client.gameMode != null) {
                IPlayerController pc = controller();
                pc.setHittingBlock(true); // re-arm so stopDestroyBlock sends the abort
                client.gameMode.stopDestroyBlock();
            }
        } finally {
            JsonObject p = at(d.pos);
            p.addProperty("reason", reason);
            server.push("dig.abort", p);
        }
    }

    /**
     * Hotbar tool for the block (pathfinder bestHarvestTool, simplified):
     * highest progress per tick = tool speed / (30 harvestable | 100 not).
     * Switches only when strictly faster than the held stack, so a logic
     * site that equipped its own tool keeps it.
     * ponytail: efficiency enchants/effects ignored (equal-speed ties keep the hand).
     */
    private static void selectBestTool(LocalPlayer player, BlockState state) {
        Inventory inv = player.getInventory();
        int cur = inv.getSelectedSlot();
        int bestSlot = cur;
        float best = toolScore(inv.getItem(cur), state);
        for (int i = 0; i < 9; i++) {
            float s = toolScore(inv.getItem(i), state);
            if (s > best) {
                best = s;
                bestSlot = i;
            }
        }
        if (bestSlot != cur) {
            inv.setSelectedSlot(bestSlot); // syncHeldItem in start() sends the carried-item packet
        }
    }

    private static float toolScore(ItemStack stack, BlockState state) {
        boolean harvest = !state.requiresCorrectToolForDrops() || stack.isCorrectToolForDrops(state);
        return stack.getDestroySpeed(state) / (harvest ? 30f : 100f);
    }

    private static IPlayerController controller() {
        return BaritoneAPI.getProvider().getPrimaryBaritone().getPlayerContext().playerController();
    }

    /** One client-thread interaction; NOT_IN_WORLD when there is no player. */
    private JsonObject onPlayer(PlayerAction action) throws Rpc.RpcException {
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

    /** Mineflayer radians -> notch degrees on body + head (same as Look). */
    private static void applyLook(LocalPlayer player, double yawRad, double pitchRad) {
        float notchYaw = (float) LookMath.notchYawDeg(yawRad);
        float notchPitch = (float) LookMath.notchPitchDeg(pitchRad);
        player.setYRot(notchYaw);
        player.setXRot(notchPitch);
        player.setYHeadRot(notchYaw);
    }

    private static JsonObject at(BlockPos pos) {
        JsonObject p = new JsonObject();
        p.addProperty("x", pos.getX());
        p.addProperty("y", pos.getY());
        p.addProperty("z", pos.getZ());
        return p;
    }

    private static JsonObject ok() {
        JsonObject res = new JsonObject();
        res.addProperty("ok", true);
        return res;
    }

    private static Direction direction(JsonObject params) throws Rpc.RpcException {
        String face = params.has("face") && params.get("face").isJsonPrimitive()
                ? params.get("face").getAsString() : "up";
        try {
            return Direction.valueOf(face.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad face " + face);
        }
    }

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        if (!params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing number param " + key);
        }
        return (int) Math.floor(params.get(key).getAsDouble());
    }

    private static Double optDouble(JsonObject params, String key) {
        return params.has(key) && params.get(key).isJsonPrimitive()
                && params.get(key).getAsJsonPrimitive().isNumber()
                ? params.get(key).getAsDouble() : null;
    }

    private static double cursor(JsonObject params, String axis, double fallback) {
        if (params.has("cursor") && params.get("cursor").isJsonObject()) {
            JsonObject c = params.getAsJsonObject("cursor");
            if (c.has(axis) && c.get(axis).isJsonPrimitive() && c.get(axis).getAsJsonPrimitive().isNumber()) {
                return c.get(axis).getAsDouble();
            }
        }
        return fallback;
    }
}
