package idkcraft.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Minimal JSON-RPC 2.0 dispatcher (idkcraft-neuc.1). Pure Gson, no Minecraft
 * classes — covered by {@code RpcTest} without the game.
 *
 * <p>Wire shape (see {@code baritone/bridge/PROTOCOL.md}): one call =
 * {@code {jsonrpc:'2.0',id,method,params}}; reply =
 * {@code {jsonrpc:'2.0',id,result|error}}. Unknown methods fail {@code -32601}
 * (the Node adapter treats unimplemented surfaces as best-effort), bad params
 * {@code -32602}, handler bugs {@code -32603}. Client notifications (no id)
 * run without a reply; batches answer per element.
 */
public final class Rpc {

    /** A JSON-RPC error thrown by handlers to fail the call with a code. */
    public static final class RpcException extends Exception {
        private final int code;

        public RpcException(int code, String message) {
            super(message);
            this.code = code;
        }

        public int code() {
            return code;
        }
    }

    /** Handler for one method: params object in, result element out. */
    @FunctionalInterface
    public interface Handler {
        JsonElement handle(JsonObject params) throws RpcException;
    }

    public static final int PARSE_ERROR = -32700;
    public static final int INVALID_REQUEST = -32600;
    public static final int METHOD_NOT_FOUND = -32601;
    public static final int INVALID_PARAMS = -32602;
    public static final int INTERNAL_ERROR = -32603;
    /** The client thread did not answer in time (or the call needs the world). */
    public static final int CLIENT_BUSY = -32001;
    /** The call needs an in-world player and the client is at the menu. */
    public static final int NOT_IN_WORLD = -32002;

    private static final Logger LOG = LoggerFactory.getLogger(Rpc.class);
    // serializeNulls: error replies carry an explicit null id per the spec,
    // and handlers use JsonNull for unknown fields (a missing key and an
    // explicit null must not be conflated on the wire).
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();

    /** Register (or replace) a method. Future surfaces add theirs here. */
    public Rpc register(String method, Handler handler) {
        handlers.put(method, handler);
        return this;
    }

    /**
     * Handle one websocket text message. Returns the reply text, or null when
     * the message warrants no reply (a notification, or an unparseable frame
     * whose id cannot be recovered — the one exception is malformed JSON,
     * which answers {@code -32700} with a null id per the spec).
     */
    public String handle(String message) {
        final JsonElement parsed;
        try {
            parsed = JsonParser.parseString(message);
        } catch (JsonSyntaxException e) {
            return error(null, PARSE_ERROR, "parse error");
        }
        if (parsed.isJsonArray()) {
            JsonArray replies = new JsonArray();
            for (JsonElement el : parsed.getAsJsonArray()) {
                String reply = handleOne(el);
                if (reply != null) {
                    replies.add(JsonParser.parseString(reply));
                }
            }
            return replies.size() == 0 ? null : GSON.toJson(replies);
        }
        return handleOne(parsed);
    }

    private String handleOne(JsonElement parsed) {
        if (!parsed.isJsonObject()) {
            return error(null, INVALID_REQUEST, "invalid request");
        }
        JsonObject req = parsed.getAsJsonObject();
        JsonElement id = req.has("id") ? req.get("id") : null;
        boolean notification = id == null;
        if (!req.has("method") || !req.get("method").isJsonPrimitive()
                || !"2.0".equals(optString(req, "jsonrpc"))) {
            return notification ? null : error(id, INVALID_REQUEST, "invalid request");
        }
        String method = req.get("method").getAsString();
        Handler handler = handlers.get(method);
        if (handler == null) {
            return notification ? null : error(id, METHOD_NOT_FOUND, "unknown method " + method);
        }
        JsonObject params;
        if (!req.has("params") || req.get("params").isJsonNull()) {
            params = new JsonObject();
        } else if (req.get("params").isJsonObject()) {
            params = req.get("params").getAsJsonObject();
        } else {
            return notification ? null : error(id, INVALID_PARAMS, "params must be an object");
        }
        final JsonElement result;
        long t0 = System.nanoTime();
        try {
            result = handler.handle(params);
        } catch (RpcException e) {
            return notification ? null : error(id, e.code(), e.getMessage());
        } catch (Exception e) {
            LOG.warn("bridge rpc {} failed", method, e);
            return notification ? null : error(id, INTERNAL_ERROR, "internal error");
        } finally {
            time(method, (System.nanoTime() - t0) / 1_000_000);
        }
        if (notification) {
            return null;
        }
        JsonObject reply = new JsonObject();
        reply.addProperty("jsonrpc", "2.0");
        reply.add("id", id);
        reply.add("result", result == null ? new JsonObject() : result);
        return GSON.toJson(reply);
    }

    /** neuc.67.1: per-method handler ms since the last {@link #takeTimings}: method -> {n, sumMs, maxMs}. */
    private final Map<String, long[]> timings = new java.util.HashMap<>();

    private synchronized void time(String method, long ms) {
        long[] t = timings.computeIfAbsent(method, k -> new long[3]);
        t[0]++;
        t[1] += ms;
        t[2] = Math.max(t[2], ms);
    }

    /**
     * neuc.67.1 (body.stats {@code rpc}): the window's handler time per
     * method, heaviest total first, as {@code method=n/sumMs/maxMs ...}
     * (top {@code top}; {@code busy=<sumMs>} first = the read thread's
     * total, all methods), then reset. Observation only.
     */
    public synchronized String takeTimings(int top) {
        long busy = 0;
        for (long[] t : timings.values()) {
            busy += t[1];
        }
        StringBuilder sb = new StringBuilder("busy=").append(busy);
        timings.entrySet().stream()
                .sorted((a, b) -> Long.compare(b.getValue()[1], a.getValue()[1]))
                .limit(top)
                .forEach(e -> sb.append(' ').append(e.getKey()).append('=').append(e.getValue()[0])
                        .append('/').append(e.getValue()[1]).append('/').append(e.getValue()[2]));
        timings.clear();
        return sb.toString();
    }

    private static String error(JsonElement id, int code, String message) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code);
        err.addProperty("message", message == null ? "error" : message);
        JsonObject reply = new JsonObject();
        reply.addProperty("jsonrpc", "2.0");
        reply.add("id", id == null ? com.google.gson.JsonNull.INSTANCE : id);
        reply.add("error", err);
        return GSON.toJson(reply);
    }

    private static String optString(JsonObject obj, String key) {
        return obj.has(key) && obj.get(key).isJsonPrimitive() ? obj.get(key).getAsString() : null;
    }
}
