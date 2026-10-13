package idkcraft.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Container windows surface (idkcraft-neuc.11).
 *
 * <p>Methods: {@code window.open {x,y,z}} clicks the block and waits for the
 * server's window -> the menu ({@code {windowId,type,title,size,slots,cursor}});
 * {@code window.click {windowId,slot,mouseButton,mode}} runs one vanilla
 * click through {@code handleContainerInput} (the client tracks the server's
 * state id, so window-id/revision churn never reaches Node) -> the menu
 * after the click; {@code window.close {windowId}}. Notifications, diffed per
 * client tick: {@code window.open} (menu), {@code window.slot
 * {windowId,slot,item|null}}, {@code window.close {windowId}}.
 *
 * <p>Slot numbering is the vanilla menu order, which is mineflayer's window
 * numbering: container slots first, then the player's 27 main + 9 hotbar.
 * Window id 0 is the player inventory menu (clicks only). Baritone
 * pause/resume around a click lives in the Node adapter (.9's rule).
 */
public final class Windows {
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    // ponytail: blocks this connection's read thread (Inventory's ops do too);
    // a tick-completed future if a stalled poll ever matters.
    private static final long OPEN_WAIT_MS = 1500;
    // mineflayer click modes 0..6 (protocol ids, same order as the enum).
    private static final ContainerInput[] MODES = {
        ContainerInput.PICKUP, ContainerInput.QUICK_MOVE, ContainerInput.SWAP, ContainerInput.CLONE,
        ContainerInput.THROW, ContainerInput.QUICK_CRAFT, ContainerInput.PICKUP_ALL,
    };

    private final BridgeServer server;

    // Tick-thread only: the open container (-1 = none) and its slot fingerprints.
    private int lastId = -1;
    private Map<Integer, String> lastSlots = new HashMap<>();

    private Windows(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Windows w = new Windows(server);
        server.onClientTick(w::tick);
        server.register("window.open", w::open);
        server.register("window.click", params -> {
            int windowId = requiredInt(params, "windowId");
            int slot = requiredInt(params, "slot");
            int button = requiredInt(params, "mouseButton");
            int mode = requiredInt(params, "mode");
            if (mode < 0 || mode >= MODES.length) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad mode " + mode);
            }
            return w.onPlayer((client, player) -> {
                AbstractContainerMenu menu = player.containerMenu;
                if (menu.containerId != windowId) {
                    throw new Rpc.RpcException(Rpc.INVALID_PARAMS,
                            "stale window " + windowId + " (open: " + menu.containerId + ")");
                }
                if (slot != -999 && (slot < 0 || slot >= menu.slots.size())) {
                    throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad slot " + slot);
                }
                if (client.gameMode == null) {
                    throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "no game mode");
                }
                client.gameMode.handleContainerInput(menu.containerId, slot, button, MODES[mode], player);
                return describe(client, player, menu);
            });
        });
        server.register("window.close", params -> {
            int windowId = requiredInt(params, "windowId");
            return w.onPlayer((client, player) -> {
                AbstractContainerMenu menu = player.containerMenu;
                if (menu != player.inventoryMenu && menu.containerId == windowId) {
                    player.closeContainer(); // sends the close packet + drops the screen
                }
                JsonObject res = new JsonObject();
                res.addProperty("ok", true);
                return res;
            });
        });
    }

    /** Socket thread: click the block on the client, then wait for a new menu. */
    private JsonObject open(JsonObject params) throws Rpc.RpcException {
        int x = requiredInt(params, "x");
        int y = requiredInt(params, "y");
        int z = requiredInt(params, "z");
        JsonObject before = onPlayer((client, player) -> {
            if (client.gameMode == null) {
                throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "no game mode");
            }
            JsonObject prev = new JsonObject();
            prev.addProperty("id", openId(player));
            BlockHitResult hit = new BlockHitResult(
                    new Vec3(x + 0.5, y + 0.5, z + 0.5), Direction.UP, new BlockPos(x, y, z), false);
            // Fail fast when the click did nothing (not a container, out of
            // reach client-side): the wait below holds this connection's
            // read thread, so only a click that took may pay for it.
            if (!client.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit).consumesAction()) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS,
                        "window.open: block at " + x + " " + y + " " + z + " did not take the click");
            }
            return prev;
        });
        int prevId = before.get("id").getAsInt();
        long deadline = System.currentTimeMillis() + OPEN_WAIT_MS;
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            JsonObject menu = onPlayer((client, player) -> {
                int id = openId(player);
                JsonObject res = id != -1 && id != prevId
                        ? describe(client, player, player.containerMenu) : new JsonObject();
                return res;
            });
            if (menu.has("windowId")) {
                return menu;
            }
        }
        throw new Rpc.RpcException(Rpc.INTERNAL_ERROR, "window.open: no window opened at " + x + " " + y + " " + z);
    }

    /** Client thread (tick hook): open/close edges + per-slot diffs of the open container. */
    private void tick() {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client != null ? client.player : null;
        int id = player == null ? -1 : openId(player);
        if (id != lastId) {
            if (lastId != -1) {
                JsonObject p = new JsonObject();
                p.addProperty("windowId", lastId);
                server.push("window.close", p);
            }
            lastId = id;
            lastSlots = new HashMap<>();
            if (id != -1) {
                lastSlots = fingerprints(player.containerMenu);
                server.push("window.open", describe(client, player, player.containerMenu));
            }
            return;
        }
        if (id == -1) {
            return;
        }
        AbstractContainerMenu menu = player.containerMenu;
        Map<Integer, String> now = fingerprints(menu);
        for (int slot = 0; slot < menu.slots.size(); slot++) {
            if (Objects.equals(lastSlots.get(slot), now.get(slot))) {
                continue;
            }
            JsonObject p = new JsonObject();
            p.addProperty("windowId", id);
            p.addProperty("slot", slot);
            ItemStack stack = menu.slots.get(slot).getItem();
            p.add("item", stack == null || stack.isEmpty()
                    ? JsonNull.INSTANCE : GSON.toJsonTree(Inventory.describe(slot, stack)));
            server.push("window.slot", p);
        }
        lastSlots = now;
    }

    /** Open container id, -1 when only the player inventory is up. */
    private static int openId(LocalPlayer player) {
        AbstractContainerMenu menu = player.containerMenu;
        return menu == null || menu == player.inventoryMenu ? -1 : menu.containerId;
    }

    private static Map<Integer, String> fingerprints(AbstractContainerMenu menu) {
        Map<Integer, String> out = new HashMap<>();
        for (int slot = 0; slot < menu.slots.size(); slot++) {
            ItemStack stack = menu.slots.get(slot).getItem();
            if (stack != null && !stack.isEmpty()) {
                out.put(slot, Inventory.fingerprint(Inventory.describe(slot, stack)));
            }
        }
        return out;
    }

    private static JsonObject describe(Minecraft client, LocalPlayer player, AbstractContainerMenu menu) {
        JsonObject res = new JsonObject();
        res.addProperty("windowId", menu.containerId);
        String type;
        if (menu == player.inventoryMenu) {
            type = "minecraft:inventory";
        } else {
            try {
                type = String.valueOf(BuiltInRegistries.MENU.getKey(menu.getType()));
            } catch (UnsupportedOperationException e) {
                type = "minecraft:container"; // a menu without a registered type
            }
        }
        res.addProperty("type", type);
        res.addProperty("title", client.screen != null ? client.screen.getTitle().getString() : "");
        res.addProperty("size", menu.slots.size());
        List<Map<String, Object>> slots = new ArrayList<>();
        for (int slot = 0; slot < menu.slots.size(); slot++) {
            ItemStack stack = menu.slots.get(slot).getItem();
            if (stack != null && !stack.isEmpty()) {
                slots.add(Inventory.describe(slot, stack));
            }
        }
        res.add("slots", GSON.toJsonTree(slots));
        ItemStack carried = menu.getCarried();
        res.add("cursor", carried == null || carried.isEmpty()
                ? JsonNull.INSTANCE : GSON.toJsonTree(Inventory.describe(-1, carried)));
        return res;
    }

    @FunctionalInterface
    private interface PlayerAction {
        JsonObject run(Minecraft client, LocalPlayer player) throws Rpc.RpcException;
    }

    /** One client-thread task; NOT_IN_WORLD when there is no player (Look's holder pattern). */
    private JsonObject onPlayer(PlayerAction action) throws Rpc.RpcException {
        Rpc.RpcException[] failure = new Rpc.RpcException[1];
        JsonObject res = server.onClient(() -> {
            Minecraft client = Minecraft.getInstance();
            LocalPlayer player = client != null ? client.player : null;
            if (player == null) {
                return null;
            }
            try {
                return action.run(client, player);
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

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        if (!params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing int param " + key);
        }
        return params.get(key).getAsInt();
    }
}
