package idkcraft.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.entity.player.Player;

/**
 * Entities + roster surface (idkcraft-neuc.3, enabled by neuc.1).
 *
 * <p>Wiring: {@code BridgeMod.onInitializeClient} calls
 * {@code Entities.install(server)} (one line per surface, epic section 2).
 *
 * <p>Methods: {@code entities.list} snapshots every entity in the client
 * world (players + mobs in view distance); {@code roster.get} snapshots the
 * tab list. Notifications: {@code player.joined}/{@code player.left} (tab
 * diff per tick) and {@code entity.gone} (id diff per tick, best-effort —
 * the list diff on the Node side is the reliable channel).
 *
 * <p>Threading (epic section 2): {@link #tick} runs on the client thread via
 * {@code BridgeServer#onClientTick}. The tick rebuilds immutable snapshots
 * and publishes them through volatile fields; the socket thread only ever
 * reads the published reference, never the world. Floodgate dot-names pass
 * through untouched (no normalization anywhere).
 *
 * <p>Wire shapes (see PROTOCOL.md, entities section):
 * entities.list {@code -> {entities:[{id,uuid,type,name?,displayName,kind,
 * pos{x,y,z},vel{x,y,z},yaw,pitch,health?,onGround,pose,self?,item?}]}} where type
 * is 'player' or the mob registry id (e.g. 'zombie') and kind is
 * player|hostile|animal|other from the client's MobCategory. {@code item} is
 * the dropped stack's item registry path (e.g. 'oak_sapling'), present only
 * on item entities (idkcraft-poyd: the skill drop watch).
 * roster.get {@code -> {players:[{name,uuid,ping,gameMode}]}} with the
 * numeric mode id (null when the entry carries none).
 * yaw/pitch ride the mineflayer convention (radians, like state.get —
 * the adapter maps them straight onto bot entities).
 *
 * <p>BridgeServer API: {@code register(String, Rpc.Handler)} with results as
 * Gson {@code JsonObject}s (the snapshots below stay plain Maps/Lists and
 * convert at the boundary); {@code push(String method, JsonObject params)};
 * {@code onClientTick(Runnable)}. A null world with a live handler serves
 * the LAST GOOD snapshot so a transient empty tick never flaps the Node
 * roster diff; a null network handler (real disconnect) clears both
 * snapshots instead, so the polls diff the truth.
 */
public final class Entities {
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private final BridgeServer server;

    private volatile List<Map<String, Object>> entitySnapshot = Collections.emptyList();
    private volatile List<Map<String, Object>> rosterSnapshot = Collections.emptyList();

    // Tick-thread only (written on the client thread, never read elsewhere).
    private Set<Integer> lastIds = new HashSet<>();
    private Map<String, String> lastRoster = new HashMap<>();

    private Entities(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Entities entities = new Entities(server);
        server.onClientTick(entities::tick);
        server.register("entities.list", params -> {
            JsonObject res = new JsonObject();
            res.add("entities", GSON.toJsonTree(entities.entitySnapshot));
            return res;
        });
        server.register("roster.get", params -> {
            JsonObject res = new JsonObject();
            res.add("players", GSON.toJsonTree(entities.rosterSnapshot));
            return res;
        });
    }

    private void tick() {
        Minecraft client = Minecraft.getInstance();
        if (client == null) {
            return;
        }
        if (networkHandler(client) == null) {
            // Real disconnect (kick/restart): drop everything so the Node
            // polls diff the truth (everyone left) instead of frozen ghosts
            // that would hold the leave grace off. A null world WITH a live
            // handler (respawn/dimension swap) keeps last-good below — no
            // flap. No gone/left pushes here: the emptied snapshots drive
            // the same Node diffs without the spam.
            clearSnapshots();
            return;
        }
        ClientLevel level = client.level;
        if (level == null) {
            return;
        }
        tickEntities(client, level);
        tickRoster(client);
    }

    private static ClientPacketListener networkHandler(Minecraft client) {
        LocalPlayer player = client.player;
        return player != null ? player.connection : null;
    }

    private void clearSnapshots() {
        if (entitySnapshot.isEmpty() && rosterSnapshot.isEmpty() && lastIds.isEmpty() && lastRoster.isEmpty()) {
            return;
        }
        entitySnapshot = Collections.emptyList();
        rosterSnapshot = Collections.emptyList();
        lastIds = new HashSet<>();
        lastRoster = new HashMap<>();
    }

    private void tickEntities(Minecraft client, ClientLevel level) {
        List<Map<String, Object>> ents = new ArrayList<>();
        Set<Integer> ids = new HashSet<>();
        Entity self = client.player;
        Registry<EntityType<?>> entityTypes = level.registryAccess().lookupOrThrow(Registries.ENTITY_TYPE);
        Registry<net.minecraft.world.item.Item> items = level.registryAccess().lookupOrThrow(Registries.ITEM);
        for (Entity e : level.entitiesForRendering()) {
            if (e == null) {
                continue;
            }
            boolean player = e instanceof Player;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.getId());
            m.put("uuid", e.getUUID().toString());
            if (player) {
                m.put("type", "player");
                m.put("name", e.getName().getString());
            } else {
                m.put("type", entityPath(entityTypes, e.getType()));
            }
            m.put("displayName", e.getDisplayName().getString());
            m.put("kind", kindOf(e, player));
            m.put("pos", vec(e.getX(), e.getY(), e.getZ()));
            m.put("vel", vec(e.getDeltaMovement().x, e.getDeltaMovement().y, e.getDeltaMovement().z));
            m.put("yaw", BridgeServer.mineflayerYaw(e.getYRot()));
            m.put("pitch", BridgeServer.mineflayerPitch(e.getXRot()));
            m.put("health", e instanceof LivingEntity ? ((LivingEntity) e).getHealth() : null);
            // idkcraft-poyd: dropped-stack identity for the skill drop
            // watch — the item registry path (e.g. 'oak_sapling'), so a v2
            // skill can tell sapling drops from every other entity.
            if (e instanceof ItemEntity drop) {
                Identifier itemId = items.getKey(drop.getItem().getItem());
                if (itemId != null) {
                    m.put("item", itemId.getPath());
                }
            }
            m.put("onGround", e.onGround());
            m.put("pose", e.getPose().name().toLowerCase(Locale.ROOT));
            if (e == self) {
                m.put("self", true);
            }
            ents.add(m);
            ids.add(e.getId());
        }
        for (Integer id : lastIds) {
            if (!ids.contains(id)) {
                server.push("entity.gone", json(Collections.singletonMap("id", id)));
            }
        }
        lastIds = ids;
        entitySnapshot = ents;
    }

    private static String entityPath(Registry<EntityType<?>> entityTypes, EntityType<?> type) {
        Identifier id = entityTypes.getKey(type);
        return id != null ? id.getPath() : "unknown";
    }

    private void tickRoster(Minecraft client) {
        ClientPacketListener handler = networkHandler(client);
        if (handler == null) {
            return;
        }
        List<Map<String, Object>> roster = new ArrayList<>();
        Map<String, String> names = new HashMap<>();
        for (PlayerInfo entry : handler.getOnlinePlayers()) {
            String name = entry.getProfile().name();
            String uuid = entry.getProfile().id().toString();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", name);
            m.put("uuid", uuid);
            m.put("ping", entry.getLatency());
            m.put("gameMode", entry.getGameMode() == null ? null : entry.getGameMode().getId());
            roster.add(m);
            names.put(name, uuid);
        }
        for (Map.Entry<String, String> n : names.entrySet()) {
            if (!lastRoster.containsKey(n.getKey())) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("name", n.getKey());
                p.put("uuid", n.getValue());
                server.push("player.joined", json(p));
            }
        }
        for (Map.Entry<String, String> n : lastRoster.entrySet()) {
            if (!names.containsKey(n.getKey())) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("name", n.getKey());
                p.put("uuid", n.getValue());
                server.push("player.left", json(p));
            }
        }
        lastRoster = names;
        rosterSnapshot = roster;
    }

    private static String kindOf(Entity e, boolean player) {
        if (player) {
            return "player";
        }
        MobCategory group = e.getType().getCategory();
        if (group == MobCategory.MONSTER) {
            return "hostile";
        }
        if (group == MobCategory.MISC) {
            return "other";
        }
        return "animal";
    }

    private static Map<String, Double> vec(double x, double y, double z) {
        Map<String, Double> m = new LinkedHashMap<>();
        m.put("x", x);
        m.put("y", y);
        m.put("z", z);
        return m;
    }

    private static JsonObject json(Map<String, ?> m) {
        return GSON.toJsonTree(m).getAsJsonObject();
    }
}
