package idkcraft.bridge;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.event.events.PacketEvent;
import baritone.api.event.events.PathEvent;
import baritone.api.event.events.TickEvent;
import baritone.api.event.events.WorldEvent;
import baritone.api.event.events.type.EventState;
import baritone.api.event.listener.AbstractGameEventListener;
import baritone.api.pathing.goals.Goal;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The bridge core (idkcraft-neuc.1): a websocket JSON-RPC server on the
 * client that serves {@code hello}, {@code state.get}, {@code chat.send},
 * {@code baritone.cmd} and {@code baritone.status}, and pushes {@code chat},
 * {@code message} and {@code baritone.event} notifications. Wire shape and
 * field units live in {@code baritone/bridge/PROTOCOL.md}.
 *
 * <p>Threading: the socket threads only queue work and read the volatile
 * snapshot. All client/Baritone calls run on the client thread (via
 * {@link Minecraft#submit} from socket threads, directly from the Baritone
 * tick listener); reads come from the per-tick snapshot built on the Baritone
 * post-tick. No fabric-api: ticks, path events and inbound packets all arrive
 * over Baritone's {@code IEventBus}, so the mod needs no mixins.
 *
 * <p>The client side starts lazy: the constructor only binds the socket (safe
 * at mod-init time), and the first client-touching call grabs the running
 * game and registers the Baritone listener. Before that the server answers
 * static data and offline nulls — the worker, which nothing connects to,
 * never touches Baritone at all.
 *
 * <p>Future surfaces (epic idkcraft-neuc §2) add one class each with a
 * {@code static void install(BridgeServer s)} that calls
 * {@link #register} / {@link #push}.
 */
public final class BridgeServer {

    public static final int DEFAULT_PORT = 7778;

    /** Goal watchdog: no terminal Baritone event within 120 s → timeout. */
    private static final long GOAL_TIMEOUT_TICKS = 20L * 120;
    /**
     * A re-issued goal cancels the old segment on the next tick; that CANCELED
     * belongs to the superseded goal, not the new id, so out-of-goal cancels
     * this soon after the cmd are swallowed (genuine stops land later).
     */
    private static final long CANCELED_SWALLOW_TICKS = 10;
    private static final long SUBMIT_TIMEOUT_MS = 3000;
    private static final int MAX_CHAT_QUEUE = 1000;
    private static final int MAX_CHAT_LEN = 1000;

    private static final Logger LOG = LoggerFactory.getLogger(BridgeServer.class);

    private volatile Minecraft client;
    private volatile IBaritone baritone;
    private final WsServer ws;
    private final Rpc rpc = new Rpc();
    private final Gson gson = new GsonBuilder().serializeNulls().create();

    private volatile String mcVersion = "unknown";
    private final String modVersion;
    private final String baritoneVersion;

    /** Latest in-world snapshot; null while the client is at the menu. */
    private volatile JsonObject snapshot;
    private final AtomicLong cmdSeq = new AtomicLong(0);
    private volatile long currentId = 0;
    private volatile String last = "none";
    private volatile boolean pathing = false;
    private volatile boolean terminalReceived = false;
    private volatile long tickCount = 0;
    private volatile long deadlineTick = 0;
    private volatile long cmdTick = 0;
    /** Bridge-issued #pause outstanding (cleared by #resume/#stop/a goal). */
    private volatile boolean pausedLocal = false;
    private volatile long lastSnapWarnTick = -100000;

    private record ChatLine(boolean playerChat, String sender, String text, boolean overlay) {
    }

    private final ConcurrentLinkedQueue<ChatLine> chatQueue = new ConcurrentLinkedQueue<>();

    public BridgeServer() throws IOException {
        rpc.register("hello", this::hello)
                .register("state.get", this::stateGet)
                .register("chat.send", this::chatSend)
                .register("baritone.cmd", this::baritoneCmd)
                .register("baritone.status", this::baritoneStatus);
        // Wildcard bind: the v2 adapter lives in another container on the
        // compose network (unpublished outside it; the rig publishes it).
        this.ws = new WsServer(new java.net.InetSocketAddress(port()), rpc::handle);
        this.modVersion = modVersion(BridgeMod.MOD_ID);
        this.baritoneVersion = modVersion("baritone");
    }

    public void start() {
        ws.start();
        LOG.info("idkcraft-bridge {} listening on {}", modVersion, ws.getPort());
    }

    /**
     * Grab the running game and register the Baritone listener, once. Runs the
     * Baritone side on the client thread; safe from any thread. Returns false
     * while the game is still booting (callers fail retryably).
     */
    private synchronized boolean ensureClient() {
        if (baritone != null) {
            return true;
        }
        Minecraft mc;
        try {
            mc = Minecraft.getInstance();
        } catch (Exception e) {
            return false;
        }
        if (mc == null) {
            return false;
        }
        final Minecraft game = mc;
        IBaritone b;
        if (game.isSameThread()) {
            b = initBaritone();
        } else {
            CompletableFuture<IBaritone> future = game.submit(this::initBaritone);
            try {
                b = future.get(SUBMIT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException | ExecutionException | InterruptedException e) {
                if (e instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                }
                return false;
            }
        }
        if (b == null) {
            return false;
        }
        client = game;
        baritone = b;
        return true;
    }

    /** Client thread only (called under ensureClient's lock). */
    private IBaritone initBaritone() {
        IBaritone b = BaritoneAPI.getProvider().getPrimaryBaritone();
        b.getGameEventHandler().registerEventListener(new Events());
        return b;
    }

    public void stop() {
        ws.stop();
    }

    /** Register a JSON-RPC method (future surfaces add theirs via install). */
    public void register(String method, Rpc.Handler handler) {
        rpc.register(method, handler);
    }

    private final java.util.concurrent.CopyOnWriteArrayList<Runnable> tickHooks =
            new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * Run on every client post-tick, after the core snapshot (surfaces refresh
     * their own snapshots here). A throwing hook is dropped with a throttled
     * warn — it must never take the core tick down with it.
     */
    public void onClientTick(Runnable hook) {
        tickHooks.add(hook);
    }

    /**
     * neuc.13: run a Baritone control command on the client thread (used by
     * Input for pause/resume). Mirrors baritone.cmd's pausedLocal bookkeeping
     * so the goal watchdog freeze stays correct. Never throws.
     */
    boolean executeBaritone(String verb) {
        try {
            Boolean ok = submit(() -> baritone.getCommandManager().execute(verb));
            if (ok == null || !ok) {
                return false;
            }
            Boolean paused = GoalTracker.pauseFlagFor(verb);
            if (paused != null) {
                pausedLocal = paused;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Push a mod→node notification to every connected client. */
    public void push(String method, JsonObject params) {
        JsonObject note = new JsonObject();
        note.addProperty("jsonrpc", "2.0");
        note.addProperty("method", method);
        note.add("params", params);
        ws.push(gson.toJson(note));
    }

    // ---- rpc methods (socket threads; client work goes through submit) ----

    private com.google.gson.JsonElement hello(JsonObject params) {
        // The game version may not exist yet at mod-init time; keep asking
        // until it does (the adapter gates its registry on this value).
        if ("unknown".equals(mcVersion)) {
            mcVersion = mcVersion();
        }
        JsonObject res = new JsonObject();
        res.addProperty("mod", BridgeMod.MOD_ID);
        res.addProperty("v", 1);
        res.addProperty("mc", mcVersion);
        res.addProperty("baritone", baritoneVersion);
        return res;
    }

    private com.google.gson.JsonElement stateGet(JsonObject params) {
        // Kicks the lazy client init: without this nothing would ever
        // register the tick listener before the first chat/cmd call, and the
        // adapter (which waits for pos before driving anything) would hang.
        ensureClient();
        JsonObject snap = snapshot;
        if (snap == null) {
            return nullSnapshot();
        }
        // neuc.13 (revmux 01 core-1): input states change on the ws thread
        // at input.set time, up to a tick before the cached snapshot is
        // rebuilt — serve them live so a poll can never roll back an
        // already-acked press/release on the Node mirror.
        JsonObject live = snap.deepCopy();
        live.add("input", Input.snapshotJson());
        return live;
    }

    private com.google.gson.JsonElement chatSend(JsonObject params) throws Rpc.RpcException {
        String message = requiredString(params, "message");
        if (message.isEmpty() || message.length() > MAX_CHAT_LEN) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "message must be 1.." + MAX_CHAT_LEN + " chars");
        }
        Boolean sent = submit(() -> {
            LocalPlayer pl = client.player;
            if (pl == null || pl.connection == null) {
                return false;
            }
            if (message.startsWith("/")) {
                pl.connection.sendCommand(message.substring(1));
            } else {
                pl.connection.sendChat(message);
            }
            return true;
        });
        if (sent == null) {
            throw new Rpc.RpcException(Rpc.CLIENT_BUSY, "client thread did not answer");
        }
        if (!sent) {
            throw new Rpc.RpcException(Rpc.NOT_IN_WORLD, "not in world");
        }
        JsonObject res = new JsonObject();
        res.addProperty("sent", true);
        return res;
    }

    /**
     * Every accepted command mints a fresh id, but only a goal-issuing one
     * re-arms the tracker (a changed custom goal, or a process takeover).
     * Controls (#stop/#pause/#resume/#set/…) return their id and leave the
     * live goal armed; their ids never resolve.
     */
    private com.google.gson.JsonElement baritoneCmd(JsonObject params) throws Rpc.RpcException {
        String command = requiredString(params, "command");
        if (command.startsWith("#")) {
            command = command.substring(1);
        }
        command = command.trim();
        if (command.isEmpty()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "command is empty");
        }
        final String cmd = command;
        final String verb = GoalTracker.firstToken(cmd);
        record Probe(boolean ok, Goal before, Goal after, Object beforeProc, Object afterProc) {
        }
        Probe probe = submit(() -> {
            Goal before = baritone.getCustomGoalProcess().mostRecentGoal();
            Object beforeProc = baritone.getPathingControlManager().mostRecentInControl().orElse(null);
            boolean ok = baritone.getCommandManager().execute(cmd);
            Goal after = ok ? baritone.getCustomGoalProcess().mostRecentGoal() : before;
            Object afterProc =
                    ok ? baritone.getPathingControlManager().mostRecentInControl().orElse(null) : beforeProc;
            return new Probe(ok, before, after, beforeProc, afterProc);
        });
        if (probe == null) {
            throw new Rpc.RpcException(Rpc.CLIENT_BUSY, "client thread did not answer");
        }
        if (!probe.ok()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "unknown baritone command: " + cmd);
        }
        long id = cmdSeq.incrementAndGet();
        if (GoalTracker.rearmsTracker(probe.before(), probe.after(), probe.beforeProc(), probe.afterProc(), verb)) {
            currentId = id;
            terminalReceived = false;
            cmdTick = tickCount;
            deadlineTick = tickCount + GOAL_TIMEOUT_TICKS;
            pausedLocal = false;
        } else {
            Boolean paused = GoalTracker.pauseFlagFor(verb);
            if (paused != null) {
                pausedLocal = paused;
            }
        }
        JsonObject res = new JsonObject();
        res.addProperty("id", id);
        return res;
    }

    private com.google.gson.JsonElement baritoneStatus(JsonObject params) {
        JsonObject res = new JsonObject();
        res.addProperty("id", currentId);
        res.addProperty("pathing", pathing);
        res.addProperty("last", last);
        return res;
    }

    // ---- Baritone events (client thread for ticks, any thread for path) ----

    private final class Events implements AbstractGameEventListener {
        @Override
        public void onPostTick(TickEvent event) {
            if (event.getType() != TickEvent.Type.IN) {
                snapshot = null;
                return;
            }
            tickCount++;
            try {
                snapshot = buildSnapshot();
            } catch (Exception e) {
                // A throwing snapshot must never spam: one warn per 20 s, the
                // last good snapshot keeps serving until the next good tick.
                if (tickCount - lastSnapWarnTick > 400) {
                    lastSnapWarnTick = tickCount;
                    LOG.warn("bridge snapshot failed", e);
                }
            }
            flushChat();
            checkTimeout();
            for (Runnable hook : tickHooks) {
                try {
                    hook.run();
                } catch (Exception e) {
                    if (tickCount - lastSnapWarnTick > 400) {
                        lastSnapWarnTick = tickCount;
                        LOG.warn("bridge tick hook failed", e);
                    }
                }
            }
        }

        @Override
        public void onPathEvent(PathEvent event) {
            // NEXT_CALC_FAILED is transient (a lookahead segment failed; the
            // main path continues and terminates on its own event).
            String status = switch (event) {
                case AT_GOAL -> "success";
                case CALC_FAILED -> "noPath";
                case CANCELED -> canceledStatus();
                default -> null;
            };
            if (status == null || currentId <= 0 || terminalReceived) {
                return;
            }
            terminalReceived = true;
            last = status;
            JsonObject p = new JsonObject();
            p.addProperty("id", currentId);
            p.addProperty("status", status);
            push("baritone.event", p);
        }

        @Override
        public void onReceivePacket(PacketEvent event) {
            // POST = vanilla accepted the packet; PRE would also see drops.
            // Runs on the netty thread: capture immutable packet data only,
            // names resolve on the client tick in flushChat().
            if (event.getState() != EventState.POST) {
                return;
            }
            captureChat(event.getPacket());
        }

        @Override
        public void onWorldEvent(WorldEvent event) {
            if (event.getWorld() == null) {
                snapshot = null;
            }
        }
    }

    /**
     * Disambiguate CANCELED (client thread only — path events dispatch from
     * the client tick). Baritone fires it for routine segment cleanup, not
     * just user stops: on arrival (the goal process notices feet and segment
     * start in goal and cancels the finished segment — AT_GOAL never fires
     * then), on goal switches (the old segment's cancel), and on real stops.
     * In-goal (against mostRecentGoal, which survives the arrival cleanup
     * that nulls the live goal) reports success; offline reports stopped; an
     * out-of-goal cancel within {@link #CANCELED_SWALLOW_TICKS} of the cmd is
     * the superseded segment's and is swallowed (null); anything later is a
     * genuine stop.
     */
    private String canceledStatus() {
        Minecraft mc = client;
        IBaritone b = baritone;
        if (mc == null || b == null || mc.player == null || mc.level == null) {
            return "stopped";
        }
        try {
            Goal goal = b.getCustomGoalProcess().mostRecentGoal();
            if (goal != null && goal.isInGoal(b.getPlayerContext().playerFeet())) {
                return "success";
            }
        } catch (Exception e) {
            return "stopped";
        }
        if (tickCount - cmdTick < CANCELED_SWALLOW_TICKS) {
            return null;
        }
        return "stopped";
    }

    /** Client thread only. Reads every field fresh; throws stay with the caller. */
    private JsonObject buildSnapshot() {
        LocalPlayer pl = client.player;
        ClientLevel level = client.level;
        if (pl == null || level == null) {
            return null;
        }
        pathing = baritone.getPathingBehavior().isPathing();

        JsonObject pos = new JsonObject();
        pos.addProperty("x", pl.getX());
        pos.addProperty("y", pl.getY());
        pos.addProperty("z", pl.getZ());
        pos.addProperty("yaw", mineflayerYaw(pl.getYRot()));
        pos.addProperty("pitch", mineflayerPitch(pl.getXRot()));
        pos.addProperty("onGround", pl.onGround());
        Vec3 v = pl.getDeltaMovement();
        JsonObject vel = new JsonObject();
        vel.addProperty("x", v.x);
        vel.addProperty("y", v.y);
        vel.addProperty("z", v.z);
        pos.add("vel", vel);

        long age = level.getLevelData().getGameTime();
        long clock = level.getDefaultClockTime();
        if (clock < 0) {
            clock = -clock; // frozen daylight cycle parks the clock negative
        }
        long timeOfDay = clock % 24000;
        long day = clock / 24000;
        JsonObject time = new JsonObject();
        time.addProperty("age", age);
        time.addProperty("timeOfDay", timeOfDay);
        time.addProperty("day", day);
        time.addProperty("isDay", timeOfDay >= 0 && timeOfDay < 13000);

        JsonObject snap = new JsonObject();
        snap.add("pos", pos);
        snap.addProperty("health", pl.getHealth());
        snap.addProperty("food", pl.getFoodData().getFoodLevel());
        snap.addProperty("oxygen", (int) Math.round(pl.getAirSupply() / 15.0));
        snap.add("time", time);
        BlockPos sp = level.getLevelData().getRespawnData().pos();
        if (sp != null) {
            JsonObject spawn = new JsonObject();
            spawn.addProperty("x", sp.getX());
            spawn.addProperty("y", sp.getY());
            spawn.addProperty("z", sp.getZ());
            snap.add("spawn", spawn);
        } else {
            snap.add("spawn", JsonNull.INSTANCE);
        }
        snap.add("input", Input.snapshotJson());
        snap.addProperty("isRaining", level.isRaining());
        snap.addProperty("isSleeping", pl.isSleeping());
        snap.addProperty("dimension", level.dimension().identifier().toString());
        snap.add("gameMode", JsonNull.INSTANCE);
        ClientPacketListener conn = pl.connection;
        if (conn != null) {
            PlayerInfo pi = conn.getPlayerInfo(pl.getUUID());
            if (pi != null && pi.getGameMode() != null) {
                snap.addProperty("gameMode", pi.getGameMode().getName());
            }
        }
        return snap;
    }

    /** Offline shape: every key present and null (the adapter polls for pos). */
    private static JsonObject nullSnapshot() {
        JsonObject snap = new JsonObject();
        snap.add("pos", JsonNull.INSTANCE);
        snap.add("health", JsonNull.INSTANCE);
        snap.add("food", JsonNull.INSTANCE);
        snap.add("oxygen", JsonNull.INSTANCE);
        snap.add("input", Input.snapshotJson());
        snap.add("time", JsonNull.INSTANCE);
        snap.add("spawn", JsonNull.INSTANCE);
        snap.add("isRaining", JsonNull.INSTANCE);
        snap.add("isSleeping", JsonNull.INSTANCE);
        snap.add("dimension", JsonNull.INSTANCE);
        snap.add("gameMode", JsonNull.INSTANCE);
        return snap;
    }

    /** Any thread (called on netty). Reads immutable packet data, queues it. */
    private void captureChat(Packet<?> packet) {
        if (packet instanceof ClientboundPlayerChatPacket p) {
            Component unsigned = p.unsignedContent();
            String text = unsigned != null ? unsigned.getString() : p.body().content();
            offer(new ChatLine(true, p.sender().toString(), text, false));
        } else if (packet instanceof ClientboundSystemChatPacket p) {
            offer(new ChatLine(false, null, p.content().getString(), p.overlay()));
        } else if (packet instanceof ClientboundDisguisedChatPacket p) {
            offer(new ChatLine(false, null, p.message().getString(), false));
        }
    }

    private void offer(ChatLine line) {
        while (chatQueue.size() >= MAX_CHAT_QUEUE) {
            chatQueue.poll();
        }
        chatQueue.offer(line);
    }

    /** Client thread only. Resolves sender names, pushes chat/message events. */
    private void flushChat() {
        ChatLine line;
        while ((line = chatQueue.poll()) != null) {
            if (line.playerChat) {
                JsonObject p = new JsonObject();
                p.addProperty("username", playerName(line.sender));
                p.addProperty("uuid", line.sender);
                p.addProperty("message", line.text);
                p.addProperty("position", "chat");
                push("chat", p);
            } else {
                JsonObject p = new JsonObject();
                p.addProperty("message", line.text);
                p.addProperty("position", line.overlay ? "game_info" : "system");
                push("message", p);
            }
        }
    }

    /** Client thread only. Best-effort: '' when the sender already left. */
    private String playerName(String senderUuid) {
        try {
            LocalPlayer pl = client.player;
            ClientPacketListener conn = pl != null ? pl.connection : null;
            if (conn != null && senderUuid != null) {
                PlayerInfo pi = conn.getPlayerInfo(UUID.fromString(senderUuid));
                if (pi != null && pi.getProfile() != null && pi.getProfile().name() != null) {
                    return pi.getProfile().name();
                }
            }
        } catch (Exception ignored) {
            // Name resolution must never fail the chat event.
        }
        return "";
    }

    /**
     * Client thread only. No terminal event within the window → timeout. A
     * bridge-issued #pause freezes the watchdog: the 120 s budget bills
     * walking time, not paused time.
     */
    private void checkTimeout() {
        GoalTracker.TimeoutDecision decision =
                GoalTracker.timeoutDecision(currentId, terminalReceived, pausedLocal, tickCount, deadlineTick);
        if (decision == GoalTracker.TimeoutDecision.FREEZE) {
            deadlineTick = tickCount + GOAL_TIMEOUT_TICKS;
            return;
        }
        if (decision == GoalTracker.TimeoutDecision.SILENT) {
            return;
        }
        terminalReceived = true;
        last = "timeout";
        JsonObject p = new JsonObject();
        p.addProperty("id", currentId);
        p.addProperty("status", "timeout");
        push("baritone.event", p);
        try {
            baritone.getCommandManager().execute("stop");
        } catch (Exception e) {
            LOG.warn("bridge timeout stop failed", e);
        }
    }

    // ---- helpers ----

    /**
     * Run on the client thread, waiting up to {@link #SUBMIT_TIMEOUT_MS}.
     * Returns null when the game is still booting or the call times out;
     * re-entrant when already on the client thread.
     */
    private <V> V submit(java.util.concurrent.Callable<V> task) {
        if (!ensureClient()) {
            return null;
        }
        Minecraft mc = client;
        if (mc.isSameThread()) {
            try {
                return task.call();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        CompletableFuture<V> future = mc.submit(() -> {
            try {
                return task.call();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        try {
            return future.get(SUBMIT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException | ExecutionException e) {
            LOG.warn("bridge client call failed", e);
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    private static String requiredString(JsonObject params, String key) throws Rpc.RpcException {
        if (!params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isString()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing string param " + key);
        }
        return params.get(key).getAsString();
    }

    // Mineflayer rotation convention (mineflayer conversions.js,
    // fromNotchianYaw/fromNotchianPitch): radians, yaw zeroed on +Z.
    // Package-visible: entity surfaces convert the same way.
    static double mineflayerYaw(float yRotDegrees) {
        return euclideanMod(Math.PI - Math.toRadians(yRotDegrees), Math.PI * 2);
    }

    static double mineflayerPitch(float xRotDegrees) {
        return euclideanMod(Math.toRadians(-xRotDegrees) + Math.PI, Math.PI * 2) - Math.PI;
    }

    private static double euclideanMod(double x, double n) {
        return ((x % n) + n) % n;
    }

    private static int port() {
        String raw = System.getenv("BRIDGE_WS_PORT");
        if (raw == null || raw.isBlank()) {
            return DEFAULT_PORT;
        }
        try {
            int p = Integer.parseInt(raw.trim());
            if (p > 0 && p < 65536) {
                return p;
            }
        } catch (NumberFormatException ignored) {
            // Falls through to the warn below.
        }
        LOG.warn("bridge ignoring bad BRIDGE_WS_PORT={}", raw);
        return DEFAULT_PORT;
    }

    private static String mcVersion() {
        try {
            return SharedConstants.getCurrentVersion().name();
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String modVersion(String id) {
        try {
            return FabricLoader.getInstance().getModContainer(id)
                    .map(c -> c.getMetadata().getVersion().getFriendlyString())
                    .orElse("unknown");
        } catch (Exception e) {
            return "unknown";
        }
    }
}
