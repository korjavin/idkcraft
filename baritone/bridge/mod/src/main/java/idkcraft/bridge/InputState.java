package idkcraft.bridge;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Pure held-control state for {@code input.set}/{@code input.clear}
 * (idkcraft-neuc.13). Zero game imports on purpose (see GoalTracker):
 * unit tests cover the merge rules without Minecraft.
 *
 * <p>Wire names are mineflayer's controls; {@code sneak} maps to the
 * client Input record's {@code shift} field at the game boundary.
 */
public final class InputState {
    public static final Set<String> KEYS = Set.of("forward", "back", "left", "right", "jump", "sneak", "sprint");

    private final Map<String, Boolean> states = new LinkedHashMap<>();
    private boolean pausedByInput;

    public InputState() {
        for (String k : new String[] {"forward", "back", "left", "right", "jump", "sneak", "sprint"}) {
            states.put(k, false);
        }
    }

    /** Apply a partial set: present boolean keys overwrite, absent stay. Returns false on a bad key/value. */
    public synchronized boolean apply(Map<String, Boolean> diff) {
        for (Map.Entry<String, Boolean> e : diff.entrySet()) {
            if (!KEYS.contains(e.getKey()) || e.getValue() == null) {
                return false;
            }
        }
        states.putAll(diff);
        return true;
    }

    public synchronized void clear() {
        states.replaceAll((k, v) -> false);
    }

    public synchronized boolean anyHeld() {
        return states.containsValue(Boolean.TRUE);
    }

    public synchronized boolean get(String key) {
        return Boolean.TRUE.equals(states.get(key));
    }

    public synchronized Map<String, Boolean> snapshot() {
        return new LinkedHashMap<>(states);
    }

    /** Record that Baritone was paused by an input press (only we resume it). */
    public synchronized void markPausedByInput() {
        pausedByInput = true;
    }

    public synchronized boolean isPausedByInput() {
        return pausedByInput;
    }

    /** Take back our pause without resuming (the resume itself is game work). */
    public synchronized void clearPausedByInput() {
        pausedByInput = false;
    }

    /**
     * Disconnect release: drop every held key and report whether the
     * caller must resume Baritone — only a pause we issued is resumed,
     * a foreign (in-game) pause is left alone.
     */
    public synchronized boolean releaseOnDisconnect() {
        boolean resume = pausedByInput;
        pausedByInput = false;
        clear();
        return resume;
    }
}
