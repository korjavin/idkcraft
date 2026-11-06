package idkcraft.bridge;

import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.Map;

/** Bounded raw path events, scoped to one build. */
final class BuildDiagnostics {
    private static final int MAX_COUNT = 999999;
    private static final java.util.regex.Pattern EVENT_NAME = java.util.regex.Pattern.compile("[A-Z_]{1,48}");
    private final Map<String, Integer> counts = new LinkedHashMap<>();
    private boolean active;
    private String last;

    synchronized void start() {
        counts.clear();
        last = null;
        active = true;
    }

    synchronized void stop() {
        active = false;
    }

    synchronized void event(String event) {
        if (!active || event == null) return;
        // PathEvent is an enum; never retain an arbitrary string or unbounded keys.
        if (!EVENT_NAME.matcher(event).matches()) return;
        if (!counts.containsKey(event) && counts.size() >= 32) return;
        counts.put(event, Math.min(MAX_COUNT, counts.getOrDefault(event, 0) + 1));
        last = event;
    }

    synchronized JsonObject snapshot() {
        JsonObject out = new JsonObject();
        JsonObject events = new JsonObject();
        counts.forEach(events::addProperty);
        out.add("pathEvents", events);
        if (last != null) out.addProperty("lastPathEvent", last);
        return out;
    }
}
