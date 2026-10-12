package idkcraft.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.Base64;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundForgetLevelChunkPacket;
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;

/**
 * Chunk cache surface (idkcraft-neuc.6, enabled by neuc.1).
 *
 * <p>Wiring: {@code BridgeMod.onInitializeClient} calls
 * {@code Chunks.install(server)} (one line per surface, epic section 2).
 *
 * <p>Methods: {@code chunk.get {cx,cz}} snapshots one loaded column as
 * global block-state-id sections; {@code chunks.list} serves the loaded
 * column coords. Notifications: {@code chunk.loaded {cx,cz}},
 * {@code chunk.unloaded {cx,cz}}, {@code block.update {x,y,z,stateId}}
 * (multi-block packets fan out to one per cell).
 *
 * <p>State ids are the client's own global ids ({@code Block.getId(state)}
 * over {@code BLOCK_STATE_REGISTRY}) — the same numbering minecraft-data
 * 26.1.2 uses for prismarine-block (asserted on the rig smoke: stone,
 * air, water, oak_log). Section payloads are base64 int16-LE arrays of
 * 4096 ids in {@code (y<<8)|(z<<4)|x} section-local order, or null for
 * an all-air section.
 *
 * <p>Threading (epic section 2): chunk.get copies the sections into int
 * arrays on the CLIENT thread (via {@code BridgeServer.submit}); base64
 * encoding runs afterwards on the socket thread. The loaded set is fed
 * by inbound chunk packets on the netty thread (concurrent set, packet
 * payloads only — no world access there) and cleared on the client tick
 * when the world goes away.
 */
public final class Chunks {
    private final BridgeServer server;
    private final Set<Long> loaded = ConcurrentHashMap.newKeySet();

    private Chunks(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Chunks chunks = new Chunks(server);
        server.onPacket(chunks::onPacket);
        server.onClientTick(chunks::tick);
        server.register("chunks.list", params -> {
            JsonArray cols = new JsonArray();
            for (Long packed : chunks.loaded) {
                JsonObject c = new JsonObject();
                c.addProperty("cx", ChunkPos.getX(packed));
                c.addProperty("cz", ChunkPos.getZ(packed));
                cols.add(c);
            }
            JsonObject res = new JsonObject();
            res.add("columns", cols);
            return res;
        });
        server.register("chunk.get", params -> chunks.chunkGet(params));
    }

    // ---- wire helpers (pure, unit-tested without the game) ----

    /** Section-local index in wire order: (y<<8)|(z<<4)|x. */
    static int sectionIndex(int x, int y, int z) {
        return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    }

    /** 4096 global state ids -> base64 int16-LE, or null when all air. */
    static String encodeSection(int[] stateIds) {
        boolean allAir = true;
        for (int id : stateIds) {
            if (id != 0) {
                allAir = false;
                break;
            }
        }
        if (allAir) {
            return null;
        }
        byte[] bytes = new byte[stateIds.length * 2];
        for (int i = 0; i < stateIds.length; i++) {
            bytes[i * 2] = (byte) (stateIds[i] & 0xFF);
            bytes[i * 2 + 1] = (byte) ((stateIds[i] >> 8) & 0xFF);
        }
        return Base64.getEncoder().encodeToString(bytes);
    }

    static long pack(int cx, int cz) {
        return ChunkPos.pack(cx, cz);
    }

    // ---- packets (netty thread: immutable packet data only) ----

    private void onPacket(Packet<?> packet) {
        if (packet instanceof ClientboundLevelChunkWithLightPacket p) {
            loaded.add(pack(p.getX(), p.getZ()));
            JsonObject note = new JsonObject();
            note.addProperty("cx", p.getX());
            note.addProperty("cz", p.getZ());
            server.push("chunk.loaded", note);
        } else if (packet instanceof ClientboundForgetLevelChunkPacket p) {
            loaded.remove(pack(p.pos().x(), p.pos().z()));
            JsonObject note = new JsonObject();
            note.addProperty("cx", p.pos().x());
            note.addProperty("cz", p.pos().z());
            server.push("chunk.unloaded", note);
        } else if (packet instanceof ClientboundBlockUpdatePacket p) {
            pushBlockUpdate(p.getPos(), p.getBlockState());
        } else if (packet instanceof ClientboundSectionBlocksUpdatePacket p) {
            p.runUpdates(this::pushBlockUpdate);
        }
    }

    private void pushBlockUpdate(BlockPos pos, BlockState state) {
        JsonObject note = new JsonObject();
        note.addProperty("x", pos.getX());
        note.addProperty("y", pos.getY());
        note.addProperty("z", pos.getZ());
        note.addProperty("stateId", Block.getId(state));
        server.push("block.update", note);
    }

    // ---- client tick: a gone world clears the loaded set ----

    private void tick() {
        Minecraft client = Minecraft.getInstance();
        if (client != null && client.level == null && !loaded.isEmpty()) {
            loaded.clear();
        }
    }

    // ---- chunk.get (socket thread; world copy on the client thread) ----

    private record SectionCopy(int sectionY, int[] stateIds) {
    }

    private record ColumnCopy(int minY, java.util.List<SectionCopy> sections) {
    }

    private JsonObject chunkGet(JsonObject params) throws Rpc.RpcException {
        int cx = requiredInt(params, "cx");
        int cz = requiredInt(params, "cz");
        // Level.getChunk would fabricate an empty column for an unloaded
        // coord; the packet-fed loaded set is the truth.
        if (!loaded.contains(pack(cx, cz))) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "chunk not loaded: " + cx + "," + cz);
        }
        ColumnCopy copy = server.submit(() -> {
            Minecraft client = Minecraft.getInstance();
            ClientLevel level = client != null ? client.level : null;
            if (level == null) {
                return null;
            }
            LevelChunk chunk = level.getChunk(cx, cz);
            if (chunk == null) {
                return null;
            }
            int count = level.getSectionsCount();
            java.util.List<SectionCopy> sections = new java.util.ArrayList<>(count);
            for (int i = 0; i < count; i++) {
                LevelChunkSection section = chunk.getSection(i);
                int sectionY = level.getSectionYFromSectionIndex(i);
                if (section == null || section.hasOnlyAir()) {
                    sections.add(new SectionCopy(sectionY, null));
                    continue;
                }
                int[] ids = new int[4096];
                for (int y = 0; y < 16; y++) {
                    for (int z = 0; z < 16; z++) {
                        for (int x = 0; x < 16; x++) {
                            ids[sectionIndex(x, y, z)] = Block.getId(section.getBlockState(x, y, z));
                        }
                    }
                }
                sections.add(new SectionCopy(sectionY, ids));
            }
            return new ColumnCopy(level.getMinY(), sections);
        });
        if (copy == null) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "chunk not loaded: " + cx + "," + cz);
        }
        // Socket thread from here: encode the copied arrays.
        JsonObject res = new JsonObject();
        res.addProperty("cx", cx);
        res.addProperty("cz", cz);
        res.addProperty("minY", copy.minY());
        JsonArray sections = new JsonArray();
        for (SectionCopy sec : copy.sections()) {
            JsonObject s = new JsonObject();
            s.addProperty("y", sec.sectionY());
            String encoded = sec.stateIds() == null ? null : encodeSection(sec.stateIds());
            if (encoded == null) {
                s.add("states", JsonNull.INSTANCE);
            } else {
                s.addProperty("states", encoded);
            }
            sections.add(s);
        }
        res.add("sections", sections);
        loaded.add(pack(cx, cz));
        return res;
    }

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        if (params == null || !params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing int param " + key);
        }
        return params.get(key).getAsInt();
    }
}
