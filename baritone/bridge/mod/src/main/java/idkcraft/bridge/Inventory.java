package idkcraft.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;

/**
 * Inventory surface (idkcraft-neuc.8).
 *
 * <p>Methods: {@code inventory.get} -> {@code {selected, slots:[{slot,name,
 * count,damage,maxDamage,enchantments,customName}]}} with mineflayer window
 * slot numbering (5-8 armor, 9-35 main, 36-44 hotbar, 45 offhand);
 * {@code inventory.select {hotbar}}; {@code inventory.equip {slot,dest}}
 * (dest: hand|off-hand|head|torso|legs|feet, or a numeric slot for the
 * adapter's unequip move); {@code inventory.toss {slot,count}}.
 * Notification: {@code inventory.update {slot,item|null,selected}} per
 * changed slot, diffed per client tick.
 *
 * <p>Threading (epic section 2): actions queue from the socket thread and
 * run one at a time on the client thread in {@link #tick} (via
 * {@code BridgeServer#onClientTick}), through the player's own
 * {@code inventoryMenu} — clickSlot pickup/swap, no window open needed.
 * An equip resolves only when the destination slot actually holds the item
 * afterwards (the vanilla click predicts locally, the server confirms on
 * the same tick stream; a rejected armor piece never lands and fails).
 * Reads come from the per-tick snapshot, never cross-thread world access.
 */
public final class Inventory {
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final long OP_WAIT_MS = 3000;

    private static final Map<String, Integer> DEST_SLOTS = Map.of(
            "head", 5, "torso", 6, "legs", 7, "feet", 8, "off-hand", 45);

    private final BridgeServer server;

    private volatile List<Map<String, Object>> slotSnapshot = Collections.emptyList();
    private volatile int selectedSnapshot = 0;

    // Tick-thread only.
    private Map<Integer, String> lastSent = new LinkedHashMap<>();

    private record Op(String kind, JsonObject params, CompletableFuture<JsonObject> future) {
    }

    private final ConcurrentLinkedQueue<Op> queue = new ConcurrentLinkedQueue<>();

    private Inventory(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Inventory inv = new Inventory(server);
        server.onClientTick(inv::tick);
        server.register("inventory.get", params -> {
            JsonObject res = new JsonObject();
            res.addProperty("selected", inv.selectedSnapshot);
            res.add("slots", GSON.toJsonTree(inv.slotSnapshot));
            return res;
        });
        server.register("inventory.select", params -> inv.enqueue("select", params));
        server.register("inventory.equip", params -> inv.enqueue("equip", params));
        server.register("inventory.toss", params -> inv.enqueue("toss", params));
    }

    private JsonObject enqueue(String kind, JsonObject params) throws Rpc.RpcException {
        Op op = new Op(kind, params, new CompletableFuture<>());
        queue.add(op);
        try {
            return op.future().get(OP_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            if (e instanceof java.util.concurrent.ExecutionException ee
                    && ee.getCause() instanceof Rpc.RpcException re) {
                throw re;
            }
            throw new Rpc.RpcException(Rpc.CLIENT_BUSY, "client thread did not answer");
        }
    }

    private void tick() {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client == null ? null : client.player;
        if (player == null || client.level == null || player.connection == null) {
            Op op;
            while ((op = queue.poll()) != null) {
                op.future().completeExceptionally(
                        new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world"));
            }
            slotSnapshot = Collections.emptyList();
            lastSent = new LinkedHashMap<>();
            return;
        }
        // Serialised: one inventory op at a time, in arrival order.
        Op op;
        while ((op = queue.poll()) != null) {
            try {
                op.future().complete(execute(client, player, op));
            } catch (Rpc.RpcException e) {
                op.future().completeExceptionally(e);
            } catch (Exception e) {
                op.future().completeExceptionally(
                        new Rpc.RpcException(Rpc.INTERNAL_ERROR, String.valueOf(e.getMessage())));
            }
        }
        rebuildSnapshot(player);
    }

    private JsonObject execute(Minecraft client, LocalPlayer player, Op op) throws Rpc.RpcException {
        return switch (op.kind()) {
            case "select" -> doSelect(player, op.params());
            case "equip" -> doEquip(client, player, op.params());
            case "toss" -> doToss(client, player, op.params());
            default -> throw new Rpc.RpcException(Rpc.METHOD_NOT_FOUND, "unknown op " + op.kind());
        };
    }

    private JsonObject doSelect(LocalPlayer player, JsonObject params) throws Rpc.RpcException {
        int hotbar = requiredInt(params, "hotbar");
        if (hotbar < 0 || hotbar > 8) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "hotbar must be 0..8");
        }
        select(player, hotbar);
        rebuildSnapshot(player);
        return snapshotJson();
    }

    private static void select(LocalPlayer player, int hotbar) {
        player.getInventory().setSelectedSlot(hotbar);
        if (player.connection != null) {
            player.connection.send(new ServerboundSetCarriedItemPacket(hotbar));
        }
    }

    private JsonObject doEquip(Minecraft client, LocalPlayer player, JsonObject params)
            throws Rpc.RpcException {
        int slot = requiredInt(params, "slot");
        AbstractContainerMenu menu = player.inventoryMenu;
        if (slot < 0 || slot >= menu.slots.size()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad slot " + slot);
        }
        ItemStack src = menu.slots.get(slot).getItem();
        if (src == null || src.isEmpty()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "equip source slot empty");
        }
        String wantName = itemName(src);
        int destSlot = destSlot(player, params);
        if (destSlot < 0 || destSlot >= menu.slots.size()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad destination");
        }
        if (slot == destSlot) {
            rebuildSnapshot(player);
            return snapshotJson();
        }
        // mineflayer parity: equipping a hotbar stack to the hand only moves
        // the selection.
        JsonElement destEl = params.get("dest");
        if (destEl != null && destEl.isJsonPrimitive() && "hand".equals(destEl.getAsString())
                && slot >= 36 && slot <= 44) {
            select(player, slot - 36);
            rebuildSnapshot(player);
            return snapshotJson();
        }
        if (client.gameMode == null) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "no game mode");
        }
        // Pickup/swap through the player's own container: take the source,
        // place it on the destination, put any swapped stack back.
        client.gameMode.handleContainerInput(menu.containerId, slot, 0, ContainerInput.PICKUP, player);
        client.gameMode.handleContainerInput(menu.containerId, destSlot, 0, ContainerInput.PICKUP, player);
        if (!menu.getCarried().isEmpty()) {
            client.gameMode.handleContainerInput(menu.containerId, slot, 0, ContainerInput.PICKUP, player);
        }
        ItemStack landed = menu.slots.get(destSlot).getItem();
        if (landed == null || landed.isEmpty() || !wantName.equals(itemName(landed))) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS,
                    "equip did not land: " + wantName + " not at destination");
        }
        rebuildSnapshot(player);
        return snapshotJson();
    }

    private JsonObject doToss(Minecraft client, LocalPlayer player, JsonObject params)
            throws Rpc.RpcException {
        int slot = requiredInt(params, "slot");
        int count = requiredInt(params, "count");
        AbstractContainerMenu menu = player.inventoryMenu;
        if (slot < 0 || slot >= menu.slots.size()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad slot " + slot);
        }
        ItemStack stack = menu.slots.get(slot).getItem();
        if (stack == null || stack.isEmpty()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "toss slot empty");
        }
        if (client.gameMode == null) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "no game mode");
        }
        if (count >= stack.getCount()) {
            // THROW button 1 = drop the whole stack (vanilla Ctrl+Q).
            client.gameMode.handleContainerInput(menu.containerId, slot, 1, ContainerInput.THROW, player);
        } else {
            for (int i = 0; i < count; i++) {
                client.gameMode.handleContainerInput(menu.containerId, slot, 0, ContainerInput.THROW, player);
            }
        }
        rebuildSnapshot(player);
        return snapshotJson();
    }

    private int destSlot(LocalPlayer player, JsonObject params) throws Rpc.RpcException {
        JsonElement dest = params.get("dest");
        if (dest == null || dest.isJsonNull()) {
            return 36 + player.getInventory().getSelectedSlot();
        }
        if (dest.isJsonPrimitive() && dest.getAsJsonPrimitive().isNumber()) {
            return dest.getAsInt();
        }
        String name = dest.getAsString();
        if ("hand".equals(name)) {
            return 36 + player.getInventory().getSelectedSlot();
        }
        Integer slot = DEST_SLOTS.get(name);
        if (slot == null) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "invalid destination: " + name);
        }
        return slot;
    }

    // ---- snapshot (client thread) ----

    private void rebuildSnapshot(LocalPlayer player) {
        AbstractContainerMenu menu = player.inventoryMenu;
        List<Map<String, Object>> slots = new ArrayList<>();
        Map<Integer, String> now = new LinkedHashMap<>();
        for (int slot = 5; slot <= 45 && slot < menu.slots.size(); slot++) {
            ItemStack stack = menu.slots.get(slot).getItem();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            Map<String, Object> m = describe(slot, stack);
            slots.add(m);
            now.put(slot, fingerprint(m));
        }
        int selected = player.getInventory().getSelectedSlot();
        // Diff against the last pushed state: one update per changed slot.
        for (int slot = 5; slot <= 45; slot++) {
            String before = lastSent.get(slot);
            String after = now.get(slot);
            if (java.util.Objects.equals(before, after)) {
                continue;
            }
            JsonObject p = new JsonObject();
            p.addProperty("slot", slot);
            if (after == null) {
                p.add("item", com.google.gson.JsonNull.INSTANCE);
            } else {
                for (Map<String, Object> m : slots) {
                    if (m.get("slot").equals(slot)) {
                        p.add("item", GSON.toJsonTree(m));
                        break;
                    }
                }
            }
            p.addProperty("selected", selected);
            server.push("inventory.update", p);
        }
        lastSent = now;
        slotSnapshot = slots;
        selectedSnapshot = selected;
    }

    private JsonObject snapshotJson() {
        JsonObject res = new JsonObject();
        res.addProperty("selected", selectedSnapshot);
        res.add("slots", GSON.toJsonTree(slotSnapshot));
        return res;
    }

    private static Map<String, Object> describe(int slot, ItemStack stack) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("slot", slot);
        m.put("name", itemName(stack));
        m.put("count", stack.getCount());
        m.put("damage", stack.getMaxDamage() > 0 ? stack.getDamageValue() : 0);
        m.put("maxDamage", stack.getMaxDamage());
        List<Map<String, Object>> ench = new ArrayList<>();
        for (var e : stack.getEnchantments().entrySet()) {
            Holder<Enchantment> holder = e.getKey();
            Map<String, Object> em = new LinkedHashMap<>();
            em.put("name", holder.unwrapKey()
                    .map(k -> k.identifier().toString())
                    .orElse("unknown"));
            em.put("level", e.getIntValue());
            ench.add(em);
        }
        m.put("enchantments", ench);
        m.put("customName", stack.getCustomName() == null ? null : stack.getCustomName().getString());
        return m;
    }

    private static String itemName(ItemStack stack) {
        var id = BuiltInRegistries.ITEM.getKey(stack.getItem());
        return id == null ? "unknown" : id.toString();
    }

    private static String fingerprint(Map<String, Object> m) {
        return m.get("name") + "|" + m.get("count") + "|" + m.get("damage") + "|"
                + m.get("enchantments") + "|" + m.get("customName");
    }

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        if (!params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing int param " + key);
        }
        return params.get(key).getAsInt();
    }
}
