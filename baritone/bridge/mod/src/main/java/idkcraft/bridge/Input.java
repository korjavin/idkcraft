package idkcraft.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.ClientInput;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.phys.Vec2;

/**
 * Control-state surface (idkcraft-neuc.13): {@code input.set} /
 * {@code input.clear} drive the hand-driven moves (recover pillar/jump,
 * home door nudges, deep descent, water-bucket climb) on the Baritone body.
 *
 * <p>Applied per client tick by swapping {@code LocalPlayer.input} for an
 * adapter-owned {@link ClientInput} while any key is held (the original —
 * normally KeyboardInput — is restored on clear/all-off). Setting
 * KeyBinding/Input fields directly does not survive: KeyboardInput.tick()
 * and Baritone's input override rewrite them every tick, and HeadlessMc
 * (-lwjgl) has no real key context. A swapped input object is read by
 * LocalPlayer.applyInput after both writers, so held jump repeats on
 * ground and sprint/sneak ride the Input record exactly like v1.
 *
 * <p>Baritone pause/resume: the first held key pauses Baritone via the
 * bridge command path (which also freezes the goal watchdog); clear (or
 * the last key released) resumes it. Pause/resume never clears the goal
 * id, so a latched goal
 * continues after the hand-driven episode — no re-issue, no path_reset.
 */
public final class Input {
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static volatile Input active;

    private final BridgeServer server;
    private final InputState state = new InputState();
    private volatile boolean pausedByInput = false;
    private ClientInput original; // client thread only
    private AdapterInput adapter; // client thread only

    private Input(BridgeServer server) {
        this.server = server;
    }

    public static void install(BridgeServer server) {
        Input input = new Input(server);
        active = input;
        server.onClientTick(input::tick);
        server.register("input.set", input::set);
        server.register("input.clear", input::clear);
    }

    /** Current held states for state.get ({@code input:{states:{...}}}); empty object offline. */
    static JsonObject snapshotJson() {
        JsonObject wrap = new JsonObject();
        Input in = active;
        JsonObject states = new JsonObject();
        if (in != null) {
            for (Map.Entry<String, Boolean> e : in.state.snapshot().entrySet()) {
                states.addProperty(e.getKey(), e.getValue());
            }
        }
        wrap.add("states", states);
        return wrap;
    }

    private JsonElement set(JsonObject params) throws Rpc.RpcException {
        Map<String, Boolean> diff = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : params.entrySet()) {
            if (!e.getValue().isJsonPrimitive() || !e.getValue().getAsJsonPrimitive().isBoolean()) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "input.set values must be booleans: " + e.getKey());
            }
            diff.put(e.getKey(), e.getValue().getAsBoolean());
        }
        boolean wasHeld = state.anyHeld();
        if (!state.apply(diff)) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "input.set unknown control");
        }
        afterChange(wasHeld);
        return result();
    }

    private JsonElement clear(JsonObject params) {
        boolean wasHeld = state.anyHeld();
        state.clear();
        afterChange(wasHeld);
        return result();
    }

    private void afterChange(boolean wasHeld) {
        boolean held = state.anyHeld();
        if (held && !wasHeld && !pausedByInput) {
            if (server.executeBaritone("pause")) {
                pausedByInput = true;
            }
        } else if (!held && wasHeld && pausedByInput) {
            pausedByInput = false;
            // Resume unconditionally: a latched goal continues (same id,
            // never cleared by pause), and with no goal this just
            // un-pauses so the next goal is not wedged.
            server.executeBaritone("resume");
        }
    }

    private JsonObject result() {
        JsonObject res = new JsonObject();
        res.add("states", GSON.toJsonTree(state.snapshot()));
        return res;
    }

    // Client thread (BridgeServer tick hook, post-tick): swap/restore.
    private void tick() {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.player == null) {
            return;
        }
        LocalPlayer player = client.player;
        if (state.anyHeld()) {
            if (adapter == null) {
                adapter = new AdapterInput();
            }
            if (player.input != adapter) {
                if (player.input != null && original == null) {
                    original = player.input;
                }
                player.input = adapter;
            }
            adapter.apply(state);
        } else if (adapter != null && player.input == adapter) {
            player.input = original != null ? original : new net.minecraft.client.player.KeyboardInput(client.options);
            original = null;
        }
    }

    /** Adapter-owned input: tick() republishes the held states every tick. */
    private static final class AdapterInput extends ClientInput {
        void apply(InputState s) {
            this.keyPresses = new net.minecraft.world.entity.player.Input(
                    s.get("forward"), s.get("back"), s.get("left"), s.get("right"),
                    s.get("jump"), s.get("sneak"), s.get("sprint"));
            float fwd = impulse(s.get("forward"), s.get("back"));
            float strafe = impulse(s.get("left"), s.get("right"));
            Vec2 v = new Vec2(strafe, fwd);
            this.moveVector = v.lengthSquared() > 0 ? v.normalized() : v;
        }

        @Override
        public void tick() {
            // Held until changed: keyPresses/moveVector already carry the
            // latest states (republished by Input.tick after this runs in
            // player order; LocalPlayer reads them in applyInput).
        }

        private static float impulse(boolean pos, boolean neg) {
            return pos == neg ? 0f : (pos ? 1f : -1f);
        }
    }
}
