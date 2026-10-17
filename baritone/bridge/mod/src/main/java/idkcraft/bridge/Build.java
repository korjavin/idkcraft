package idkcraft.bridge;

import baritone.api.BaritoneAPI;
import baritone.api.Settings;
import baritone.api.schematic.ISchematic;
import com.google.gson.JsonObject;
import idkcraft.bridge.BuildPlan.Cell;
import idkcraft.bridge.BuildPlan.Spec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * Builder surface (idkcraft-neuc.54).
 *
 * <p>Methods: {@code baritone.build
 * {name, origin:{x,y,z}, cells:[{dx,dy,dz,block,props?}], forbid?}} ->
 * {@code {ok, cells, missing}} (the build runs on Baritone's BuilderProcess;
 * progress arrives as notifications). Notifications: {@code baritone.event
 * {kind:'build', name, placed, missing, active}} every second while a build
 * is live, plus a final {@code active:false} when the builder goes idle
 * (done, out of world, or cancelled — {@code #stop} cancels the builder
 * like any other process, and the tick below reports it).
 *
 * <p>The schematic is sparse: bounds come from the cell offsets and only
 * listed cells read as in-schematic. Desired states are the block's default
 * plus the optional {@code props} overrides (matched by serialized value
 * name, so facing/waterlogged spell like the world reads them). Wood-variant
 * substitution is the FSM's rule (castle kinds accept any {@code *_planks} /
 * {@code *_fence} / {@code *_log} like craftNames): a desired
 * {@code oak_planks} counts any laid {@code *_planks} as placed, same for
 * fences and logs. Settings at build start: {@code buildIgnoreExisting
 * false}, {@code buildInLayers false}, {@code okIfAir} empty,
 * {@code allowInventory true} (the builder places from the hotbar only;
 * restored on end); {@code forbid} block names join {@code blocksToDisallowBreaking} for the
 * build's duration (restored on end) so the pathfinder never eats the fresh
 * work. Substitutes ride {@code buildValidSubstitutes} (accept in place),
 * never {@code buildSubstitutes} (build-this-instead): the cell's block is
 * already the held item, so "instead" would demand a variant nobody holds
 * (core-1).
 *
 * <p>Wire parsing and progress math live in the game-free {@link BuildPlan}
 * (unit-tested without the client). Threading: the rpc handler parses on
 * the socket thread and starts on the client thread (via
 * {@link BridgeServer#onClient}); progress runs on the tick hook.
 */
public final class Build {
    /** Ticks between progress notifications (20 = ~1 s). */
    static final int PROGRESS_EVERY_TICKS = 20;

    private final BridgeServer server;
    /** Live build; client thread only. */
    private Active active;
    private long ticks;

    private static final class Active {
        final Spec spec;
        final BlockPos origin;
        final CellSchematic schematic;
        final Map<String, List<String>> substitutes;
        final List<Block> savedDisallow;
        final boolean savedAllowInventory;
        int lastPlaced;
        int lastMissing;

        Active(Spec spec, BlockPos origin, CellSchematic schematic,
                Map<String, List<String>> substitutes, List<Block> savedDisallow,
                boolean savedAllowInventory) {
            this.spec = spec;
            this.origin = origin;
            this.schematic = schematic;
            this.substitutes = substitutes;
            this.savedDisallow = savedDisallow;
            this.savedAllowInventory = savedAllowInventory;
        }
    }

    private Build(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Build build = new Build(server);
        server.onClientTick(build::tick);
        server.register("baritone.build", params -> {
            Spec spec = BuildPlan.parse(params);
            return build.onClientStart(spec);
        });
    }

    // ---- client thread ----

    /** Sparse schematic over the listed cells (bounds from the offsets). */
    private static final class CellSchematic implements ISchematic {
        final int minX;
        final int minY;
        final int minZ;
        final int sx;
        final int sy;
        final int sz;
        final Map<String, BlockState> desired;

        CellSchematic(List<Cell> cells, Map<String, BlockState> desired) {
            int[] b = BuildPlan.boundsOf(cells);
            this.minX = b[0];
            this.minY = b[1];
            this.minZ = b[2];
            this.sx = b[3];
            this.sy = b[4];
            this.sz = b[5];
            this.desired = desired;
        }

        private String key(int x, int y, int z) {
            return (x + minX) + "," + (y + minY) + "," + (z + minZ);
        }

        @Override
        public boolean inSchematic(int x, int y, int z, BlockState currentState) {
            return desired.containsKey(key(x, y, z));
        }

        @Override
        public BlockState desiredState(int x, int y, int z, BlockState current,
                List<BlockState> approx) {
            BlockState want = desired.get(key(x, y, z));
            return want != null ? want : current;
        }

        @Override
        public int widthX() {
            return sx;
        }

        @Override
        public int heightY() {
            return sy;
        }

        @Override
        public int lengthZ() {
            return sz;
        }
    }

    private static Block blockOf(String path) throws Rpc.RpcException {
        // BLOCK is a DefaultedRegistry: unknown ids read back as air, so an
        // air answer for a non-air name is the unknown-block signal.
        Block block;
        try {
            block = BuiltInRegistries.BLOCK.getValue(Identifier.parse("minecraft:" + path));
        } catch (Exception e) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "unknown block: " + path);
        }
        if ("air".equals(BuiltInRegistries.BLOCK.getKey(block).getPath()) && !"air".equals(path)) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "unknown block: " + path);
        }
        return block;
    }

    private static BlockState desiredState(Block block, Map<String, String> props) throws Rpc.RpcException {
        BlockState state = block.defaultBlockState();
        for (Map.Entry<String, String> e : props.entrySet()) {
            Property<?> prop = block.getStateDefinition().getProperty(e.getKey());
            if (prop == null) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "unknown property: " + e.getKey());
            }
            state = withValue(state, prop, e.getValue());
        }
        return state;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static BlockState withValue(BlockState state, Property<?> prop, String want)
            throws Rpc.RpcException {
        Property raw = (Property) prop;
        java.util.Optional<?> found = raw.getValue(want);
        if (found.isEmpty()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS,
                    "bad value " + want + " for property " + prop.getName());
        }
        return state.setValue(raw, (Comparable) found.get());
    }

    private JsonObject onClientStart(Spec spec) throws Rpc.RpcException {
        Rpc.RpcException[] failure = new Rpc.RpcException[1];
        JsonObject res = server.onClient(() -> {
            Minecraft client = Minecraft.getInstance();
            ClientLevel level = client != null ? client.level : null;
            if (client == null || client.player == null || level == null) {
                return null;
            }
            try {
                return start(client, spec);
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

    /** Client thread: resolve blocks, arm settings, hand the schematic to the builder. */
    private JsonObject start(Minecraft client, Spec spec) throws Rpc.RpcException {
        Map<String, BlockState> desired = new HashMap<>();
        Set<String> names = new HashSet<>();
        for (Cell c : spec.cells) {
            names.add(c.block);
        }
        // Resolve every block before touching Baritone: a refusal leaves no
        // half-armed settings behind.
        Map<String, Block> blocks = new HashMap<>();
        for (String path : names) {
            blocks.put(path, blockOf(path));
        }
        List<String> forbidBlocks = new ArrayList<>();
        for (String path : spec.forbid) {
            blockOf(path);
            forbidBlocks.add(path);
        }
        List<String> candidates = new ArrayList<>();
        for (Block b : BuiltInRegistries.BLOCK) {
            candidates.add(BuiltInRegistries.BLOCK.getKey(b).getPath());
        }
        Map<String, List<String>> substitutes = BuildPlan.substitutesFor(names, candidates);
        for (Cell c : spec.cells) {
            desired.put(c.key(), desiredState(blocks.get(c.block), spec.props));
        }
        // A replaced build ends now with its final event, so no name hangs
        // without one (the adapter settles a build on its own final only).
        if (active != null) {
            push(active.spec.name, active.lastPlaced, active.lastMissing, false);
            restore(active);
            active = null;
        }
        Settings settings = BaritoneAPI.getSettings();
        settings.buildIgnoreExisting.value = false;
        settings.buildInLayers.value = false;
        settings.okIfAir.value = new ArrayList<>();
        List<Block> savedDisallow = new ArrayList<>(settings.blocksToDisallowBreaking.value);
        // idkcraft-pwoi: BuilderProcess places from the hotbar only; with
        // allowInventory off it still paths to cells it could place from the
        // main inventory and wedges there (crafted house planks land in
        // slots 9-35: 0 placed, build-stall). On, it swaps stacks to the
        // hotbar itself. Build-scoped, restored on end like the ban list.
        boolean savedAllowInventory = settings.allowInventory.value;
        settings.allowInventory.value = true;
        if (!forbidBlocks.isEmpty()) {
            Set<Block> disallow = new HashSet<>(savedDisallow);
            for (String path : forbidBlocks) {
                disallow.add(blockOf(path));
            }
            settings.blocksToDisallowBreaking.value = new ArrayList<>(disallow);
        }
        CellSchematic schematic = new CellSchematic(spec.cells, desired);
        // Rebase by the bounds minimum (BuildPlan.rebasedOrigin): the
        // schematic's (0,0,0) is the minimum cell, not the caller's origin.
        int[] o = BuildPlan.rebasedOrigin(spec);
        BlockPos origin = new BlockPos(o[0], o[1], o[2]);
        baritone.api.IBaritone baritone = BaritoneAPI.getProvider().getPrimaryBaritone();
        Map<Block, List<Block>> javaSubstitutes = new HashMap<>();
        for (Map.Entry<String, List<String>> e : substitutes.entrySet()) {
            List<Block> alts = new ArrayList<>();
            for (String path : e.getValue()) {
                alts.add(blockOf(path));
            }
            javaSubstitutes.put(blocks.get(e.getKey()), alts);
        }
        settings.buildValidSubstitutes.value = javaSubstitutes;
        baritone.getBuilderProcess().build(spec.name, schematic, origin);
        active = new Active(spec, origin, schematic, substitutes, savedDisallow, savedAllowInventory);
        int missing = countNow(spec, substitutes);
        active.lastPlaced = spec.cells.size() - missing;
        active.lastMissing = missing;
        push(spec.name, active.lastPlaced, missing, true);
        JsonObject res = new JsonObject();
        res.addProperty("ok", true);
        res.addProperty("cells", spec.cells.size());
        res.addProperty("missing", missing);
        return res;
    }

    private void restore(Active a) {
        try {
            Settings settings = BaritoneAPI.getSettings();
            settings.blocksToDisallowBreaking.value = new ArrayList<>(a.savedDisallow);
            settings.allowInventory.value = a.savedAllowInventory;
        } catch (Exception e) {
            // restore best-effort: the next build re-arms its own set
        }
    }

    /** Client thread: current block paths by cell key. */
    private Map<String, String> currentByKey(Spec spec) {
        Map<String, String> out = new HashMap<>();
        Minecraft client = Minecraft.getInstance();
        ClientLevel level = client != null ? client.level : null;
        if (level == null) {
            return out;
        }
        for (Cell c : spec.cells) {
            BlockPos pos = new BlockPos(spec.ox + c.dx, spec.oy + c.dy, spec.oz + c.dz);
            try {
                BlockState state = level.getBlockState(pos);
                out.put(c.key(), BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath());
            } catch (Exception e) {
                // unreadable reads missing
            }
        }
        return out;
    }

    private int countNow(Spec spec, Map<String, List<String>> substitutes) {
        return spec.cells.size() - BuildPlan.countPlaced(spec.cells, currentByKey(spec), substitutes);
    }

    private void push(String name, int placed, int missing, boolean live) {
        JsonObject note = new JsonObject();
        note.addProperty("kind", "build");
        note.addProperty("name", name);
        note.addProperty("placed", placed);
        note.addProperty("missing", missing);
        note.addProperty("active", live);
        server.push("baritone.event", note);
    }

    /** Client thread, every post-tick: secondly progress, end when the builder idles. */
    private void tick() {
        Active a = active;
        if (a == null) {
            return;
        }
        Minecraft client = Minecraft.getInstance();
        boolean inWorld = client != null && client.player != null && client.level != null;
        boolean building = false;
        try {
            building = inWorld
                    && BaritoneAPI.getProvider().getPrimaryBaritone().getBuilderProcess().isActive();
        } catch (Exception e) {
            building = false;
        }
        if (!building) {
            // Done, out of world, or #stop took the builder: the final event
            // settles the adapter's build (a quiet world still counts what
            // stands, so a re-issue repairs the rest).
            int missing = inWorld ? countNow(a.spec, a.substitutes) : a.lastMissing;
            push(a.spec.name, a.spec.cells.size() - missing, missing, false);
            restore(a);
            active = null;
            return;
        }
        ticks++;
        if (ticks % PROGRESS_EVERY_TICKS != 0) {
            return;
        }
        int missing = countNow(a.spec, a.substitutes);
        a.lastPlaced = a.spec.cells.size() - missing;
        a.lastMissing = missing;
        push(a.spec.name, a.lastPlaced, missing, true);
    }
}
