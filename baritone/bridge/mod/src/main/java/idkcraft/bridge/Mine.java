package idkcraft.bridge;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.ItemStack;

/**
 * Mine surface (idkcraft-neuc.53).
 *
 * <p>Method: {@code baritone.mine {blocks:[names], count:int, radius:int}} ->
 * {@code {id, have, target}}, driving Baritone's MineProcess (#mine) instead
 * of a hand-rolled per-tick dig loop. Quantity is absolute like Baritone's
 * own (MineProcess stops when the inventory holds the quantity), so the
 * target is the current matching count plus the requested count — verified
 * against the baritone-api 1.18.0 jar the Dockerfile ships
 * ({@code IMineProcess.mineByName(int quantity, String... blocks)}; the mod
 * compiles against the same API twin). Notifications: {@code baritone.event
 * {kind:'mine', id, have, target, active}} on each tick the count changes
 * and once on end. {@code #stop} already cancels every process (kept): the
 * Node side stops the mine through the existing {@code baritone.cmd}, and
 * the tick hook below reports the end.
 *
 * <p>Baritone has no per-process region — the radius leash is enforced in
 * Node (bot/src/bridge/mine.js); the mod accepts the radius and ignores it.
 * Block protection (castle floor, porch) rides the existing {@code #set}
 * avoid lists from Movements; the Node forbid predicate is the second
 * guard. The optional {@code guard} box ({x0,y0,z0,x1,y1,z1}, idkcraft-neuc.53
 * round-1 body-3) is the cell-level one: cells inside it that match the
 * requested blocks are snapshotted at begin, and the first break inside
 * stops the process at once. All client/Baritone calls run on the client
 * thread.
 */
public final class Mine {

    private static final AtomicLong MINE_SEQ = new AtomicLong(0);

    /**
     * Drops counted toward a block name: mining stone yields cobblestone
     * (no silk touch) and grass yields dirt, so a mine for those names is
     * only done when the drops land. Callers pass both names anyway
     * (equip digTargets, castlefetch stone leg); the map keeps future
     * single-name callers honest.
     */
    private static final Map<String, String> DROPS = Map.of(
            "grass_block", "dirt",
            "stone", "cobblestone");

    private static volatile long mineId = 0;
    private static volatile boolean active = false;
    private static volatile int target = 0;
    private static volatile List<String> names = List.of();
    private static volatile int lastHave = 0;
    /** Guard box corners {x0,y0,z0,x1,y1,z1}, or null. Client thread only. */
    private static volatile int[] guardBox = null;
    /** idx -> stateId snapshot of guard cells matching the blocks. Client thread only. */
    private static final java.util.Map<Integer, Integer> guardSnap = new java.util.HashMap<>();
    /** Largest guard box by volume (a castle site is ~14k cells). */
    static final int MAX_GUARD_CELLS = 262144;

    private Mine() {
    }

    public static void install(BridgeServer server) {
        server.register("baritone.mine", params -> start(server, params));
        server.onClientTick(() -> tick(server));
    }

    /** Live mine (client thread only) — the baritone.status probe counts it. */
    public static boolean isActive() {
        return active;
    }

    /**
     * Item names accepted toward the requested blocks: the blocks themselves
     * plus their drops above. Pure (game-free) so unit tests reach it.
     */
    static List<String> acceptedItems(List<String> blocks) {
        List<String> out = new ArrayList<>();
        for (String b : blocks) {
            String n = strip(b);
            if (n.isEmpty() || out.contains(n)) {
                continue;
            }
            out.add(n);
            String drop = DROPS.get(n);
            if (drop != null && !out.contains(drop)) {
                out.add(drop);
            }
        }
        return out;
    }

    private static String strip(String name) {
        if (name == null) {
            return "";
        }
        String n = name.trim().toLowerCase(java.util.Locale.ROOT);
        return n.startsWith("minecraft:") ? n.substring("minecraft:".length()) : n;
    }

    private static JsonObject start(BridgeServer server, JsonObject params) throws Rpc.RpcException {
        List<String> blocks = new ArrayList<>();
        if (params.has("blocks") && params.get("blocks").isJsonArray()) {
            for (var el : params.getAsJsonArray("blocks")) {
                if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()) {
                    String n = strip(el.getAsString());
                    if (!n.isEmpty() && !blocks.contains(n)) {
                        blocks.add(n);
                    }
                }
            }
        }
        if (blocks.isEmpty()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: want non-empty blocks:[names]");
        }
        if (!params.has("count") || !params.get("count").isJsonPrimitive()
                || !params.get("count").getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: want number count");
        }
        int count = (int) Math.floor(params.get("count").getAsDouble());
        if (count <= 0) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: want positive count");
        }
        final List<String> want = List.copyOf(blocks);
        final int need = count;
        final int[] guard = guardBox(params);
        Rpc.RpcException[] failure = new Rpc.RpcException[1];
        JsonObject res = server.onClient(() -> {
            Minecraft client = Minecraft.getInstance();
            LocalPlayer player = client != null ? client.player : null;
            if (player == null || client.level == null) {
                return null;
            }
            try {
                return begin(want, need, guard);
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

    /**
     * Optional guard box from the params (socket thread — pure). Null when
     * absent; INVALID_PARAMS when malformed or absurdly large. Corners are
     * normalized to min/max.
     */
    static int[] guardBox(JsonObject params) throws Rpc.RpcException {
        if (!params.has("guard") || params.get("guard").isJsonNull()) {
            return null;
        }
        if (!params.get("guard").isJsonObject()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: guard wants {x0,y0,z0,x1,y1,z1}");
        }
        JsonObject g = params.getAsJsonObject("guard");
        int[] c = new int[6];
        String[] keys = {"x0", "y0", "z0", "x1", "y1", "z1"};
        for (int i = 0; i < 6; i++) {
            if (!g.has(keys[i]) || !g.get(keys[i]).isJsonPrimitive()
                    || !g.get(keys[i]).getAsJsonPrimitive().isNumber()) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: guard wants {x0,y0,z0,x1,y1,z1}");
            }
            c[i] = (int) Math.floor(g.get(keys[i]).getAsDouble());
        }
        int[] box = {
            Math.min(c[0], c[3]), Math.min(c[1], c[4]), Math.min(c[2], c[5]),
            Math.max(c[0], c[3]), Math.max(c[1], c[4]), Math.max(c[2], c[5]),
        };
        long vol = (long) (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
        if (vol > MAX_GUARD_CELLS) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: guard box too big");
        }
        return box;
    }

    /** Client thread: arm the mine and start the process. */
    private static JsonObject begin(List<String> blocks, int count, int[] guard) throws Rpc.RpcException {
        IBaritone b = BaritoneAPI.getProvider().getPrimaryBaritone();
        int have = countInventory(acceptedItems(blocks));
        int goal = have + count;
        try {
            b.getMineProcess().mineByName(goal, blocks.toArray(new String[0]));
        } catch (IllegalArgumentException e) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "baritone.mine: " + e.getMessage());
        }
        mineId = MINE_SEQ.incrementAndGet();
        names = blocks;
        target = goal;
        lastHave = have;
        active = true;
        guardBox = guard;
        snapshotGuard(blocks, guard);
        JsonObject res = new JsonObject();
        res.addProperty("id", mineId);
        res.addProperty("have", have);
        res.addProperty("target", goal);
        return res;
    }

    /** Client thread: record stateIds of guard cells matching the blocks. */
    private static void snapshotGuard(List<String> blocks, int[] box) {
        guardSnap.clear();
        if (box == null) {
            return;
        }
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.level == null) {
            return;
        }
        int sx = box[3] - box[0] + 1;
        int sy = box[4] - box[1] + 1;
        try {
            for (int x = box[0]; x <= box[3]; x++) {
                for (int y = box[1]; y <= box[4]; y++) {
                    for (int z = box[2]; z <= box[5]; z++) {
                        var pos = new net.minecraft.core.BlockPos(x, y, z);
                        var state = client.level.getBlockState(pos);
                        String n = BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath();
                        if (!blocks.contains(n)) {
                            continue;
                        }
                        int idx = (x - box[0]) + sx * ((y - box[1]) + sy * (z - box[2]));
                        guardSnap.put(idx, net.minecraft.world.level.block.Block.getId(state));
                    }
                }
            }
        } catch (Exception e) {
            guardSnap.clear();
        }
    }

    /**
     * Client thread: true when a watched guard cell changed (broken or
     * swapped) since begin. Unreadable cells read as unchanged.
     */
    private static boolean guardTripped(int[] box) {
        if (box == null || guardSnap.isEmpty()) {
            return false;
        }
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.level == null) {
            return false;
        }
        int sx = box[3] - box[0] + 1;
        int sy = box[4] - box[1] + 1;
        try {
            for (var e : guardSnap.entrySet()) {
                int idx = e.getKey();
                int z = idx / (sx * sy);
                int rest = idx - z * sx * sy;
                int y = rest / sx;
                int x = rest - y * sx;
                var pos = new net.minecraft.core.BlockPos(box[0] + x, box[1] + y, box[2] + z);
                int now = net.minecraft.world.level.block.Block.getId(client.level.getBlockState(pos));
                if (now != e.getValue()) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            return false;
        }
        return false;
    }

    /** Client thread (tick hook): progress on change, one end event. */
    private static void tick(BridgeServer server) {
        if (!active) {
            return;
        }
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client != null ? client.player : null;
        if (player == null || client.level == null) {
            end(server, lastHave, "noPath");
            return;
        }
        int have = countInventory(acceptedItems(names));
        IBaritone b = BaritoneAPI.getProvider().getPrimaryBaritone();
        if (guardTripped(guardBox)) {
            // A guarded cell broke (castle floor/wall inside the site box):
            // stop at once — one cell of damage, then the Node side ends
            // the leg instead of quarrying on.
            try {
                b.getCommandManager().execute("stop");
            } catch (Exception ignored) {
                // Stopping is best-effort; the end event still lands.
            }
            end(server, have, "guard");
            return;
        }
        boolean procActive;
        try {
            procActive = b.getMineProcess().isActive();
        } catch (Exception e) {
            procActive = false;
        }
        if (have != lastHave) {
            lastHave = have;
            push(server, have, true, have >= target ? "done" : null);
        }
        if (have >= target) {
            end(server, have, "done");
        } else if (!procActive) {
            // The process gave up by itself (no path to any match —
            // MineProcess cancels on an unreachable scan); the Node stall
            // watchdog covers a process that stays live without gaining.
            end(server, have, "noPath");
        }
    }

    private static void end(BridgeServer server, int have, String status) {
        if (!active) {
            return;
        }
        active = false;
        lastHave = have;
        push(server, have, false, status);
    }

    private static void push(BridgeServer server, int have, boolean live, String status) {
        JsonObject p = new JsonObject();
        p.addProperty("kind", "mine");
        p.addProperty("id", mineId);
        p.addProperty("have", have);
        p.addProperty("target", target);
        p.addProperty("active", live);
        if (status != null) {
            p.addProperty("status", status);
        }
        server.push("baritone.event", p);
    }

    /** Client thread: matching items in the main inventory. */
    private static int countInventory(List<String> want) {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client != null ? client.player : null;
        if (player == null) {
            return 0;
        }
        int n = 0;
        try {
            // Same read as Baritone's own completion check (MineProcess
            // counts getNonEquipmentItems against the filter).
            for (ItemStack stack : player.getInventory().getNonEquipmentItems()) {
                if (stack == null || stack.isEmpty()) {
                    continue;
                }
                String item = BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
                if (want.contains(item)) {
                    n += stack.getCount();
                }
            }
        } catch (Exception e) {
            return 0;
        }
        return n;
    }
}
