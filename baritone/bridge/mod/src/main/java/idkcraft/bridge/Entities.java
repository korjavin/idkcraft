package idkcraft.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.SpawnGroup;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;

/**
 * Entities + roster surface (idkcraft-neuc.3).
 *
 * <p>Wiring: {@code BridgeMod.onInitializeClient} adds one line,
 * {@code Entities.install(server);} — that line is .1's until it merges.
 *
 * <p>Methods: {@code entities.list} snapshots every entity in the client
 * world (players + mobs in view distance); {@code roster.get} snapshots the
 * tab list. Notifications: {@code player.joined}/{@code player.left} (tab
 * diff per tick) and {@code entity.gone} (id diff per tick, best-effort —
 * the list diff on the Node side is the reliable channel).
 *
 * <p>Threading (epic section 2): {@link #tick} runs on the client thread via
 * the one seam this class needs from .1 — {@code BridgeServer#onClientTick},
 * a per-tick hook taking a {@code Runnable}. The tick rebuilds immutable
 * snapshots and publishes them through volatile fields; the socket thread
 * only ever reads the published reference, never the world. Floodgate
 * dot-names pass through untouched (no normalization anywhere).
 *
 * <p>Wire shapes (see PROTOCOL.md, entities section):
 * entities.list {@code -> {entities:[{id,uuid,type,name?,displayName,kind,
 * pos{x,y,z},vel{x,y,z},yaw,pitch,health?,onGround,pose,self?}]}} where type
 * is 'player' or the mob registry id (e.g. 'zombie') and kind is
 * player|hostile|animal|other from the client's SpawnGroup.
 * roster.get {@code -> {players:[{name,uuid,ping,gameMode}]}} with the
 * numeric mode id (null when the entry carries none).
 *
 * <p>Assumed BridgeServer API (all .1, single-threaded-client safe):
 * {@code register(String, Handler)} with {@code Handler} a functional
 * interface {@code Object handle(Map<String, Object> params)};
 * {@code push(String method, Object params)} (thread-safe queue);
 * replies/params are plain Maps/Lists/primitives (Gson-serializable, no new
 * deps). A null world with a live handler serves the LAST GOOD snapshot so
 * a transient empty tick never flaps the Node roster diff; a null network
 * handler (real disconnect) clears both snapshots instead, so the polls
 * diff the truth.
 */
public final class Entities {
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
        server.register("entities.list", params -> Collections.singletonMap("entities", entities.entitySnapshot));
        server.register("roster.get", params -> Collections.singletonMap("players", entities.rosterSnapshot));
    }

    private void tick() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null) {
            return;
        }
        if (client.getNetworkHandler() == null) {
            // Real disconnect (kick/restart): drop everything so the Node
            // polls diff the truth (everyone left) instead of frozen ghosts
            // that would hold the leave grace off. A null world WITH a live
            // handler (respawn/dimension swap) keeps last-good below — no
            // flap. No gone/left pushes here: the emptied snapshots drive
            // the same Node diffs without the spam.
            clearSnapshots();
            return;
        }
        if (client.world == null) {
            return;
        }
        tickEntities(client);
        tickRoster(client);
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

    private void tickEntities(MinecraftClient client) {
        List<Map<String, Object>> ents = new ArrayList<>();
        Set<Integer> ids = new HashSet<>();
        Entity self = client.player;
        for (Entity e : client.world.getEntities()) {
            if (e == null) {
                continue;
            }
            boolean player = e instanceof PlayerEntity;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.getId());
            m.put("uuid", e.getUuid().toString());
            if (player) {
                m.put("type", "player");
                m.put("name", e.getName().getString());
            } else {
                m.put("type", Registries.ENTITY_TYPE.getId(e.getType()).getPath());
            }
            m.put("displayName", e.getDisplayName().getString());
            m.put("kind", kindOf(e, player));
            m.put("pos", vec(e.getPos().x, e.getPos().y, e.getPos().z));
            m.put("vel", vec(e.getVelocity().x, e.getVelocity().y, e.getVelocity().z));
            m.put("yaw", e.getYaw());
            m.put("pitch", e.getPitch());
            m.put("health", e instanceof LivingEntity ? ((LivingEntity) e).getHealth() : null);
            m.put("onGround", e.isOnGround());
            m.put("pose", e.getPose().name().toLowerCase(Locale.ROOT));
            if (e == self) {
                m.put("self", true);
            }
            ents.add(m);
            ids.add(e.getId());
        }
        for (Integer id : lastIds) {
            if (!ids.contains(id)) {
                server.push("entity.gone", Collections.singletonMap("id", id));
            }
        }
        lastIds = ids;
        entitySnapshot = ents;
    }

    private void tickRoster(MinecraftClient client) {
        if (client.getNetworkHandler() == null) {
            return;
        }
        List<Map<String, Object>> roster = new ArrayList<>();
        Map<String, String> names = new HashMap<>();
        for (PlayerListEntry entry : client.getNetworkHandler().getPlayerList()) {
            String name = entry.getProfile().getName();
            String uuid = entry.getProfile().getId().toString();
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
                server.push("player.joined", p);
            }
        }
        for (Map.Entry<String, String> n : lastRoster.entrySet()) {
            if (!names.containsKey(n.getKey())) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("name", n.getKey());
                p.put("uuid", n.getValue());
                server.push("player.left", p);
            }
        }
        lastRoster = names;
        rosterSnapshot = roster;
    }

    private static String kindOf(Entity e, boolean player) {
        if (player) {
            return "player";
        }
        SpawnGroup group = e.getType().getSpawnGroup();
        if (group == SpawnGroup.MONSTER) {
            return "hostile";
        }
        if (group == SpawnGroup.MISC) {
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
}
