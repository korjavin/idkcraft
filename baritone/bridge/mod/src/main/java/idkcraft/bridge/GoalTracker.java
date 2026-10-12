package idkcraft.bridge;

/**
 * Pure goal-tracker decisions for {@code baritone.cmd} and the goal watchdog.
 * Zero game imports on purpose: the Baritone API jar and Minecraft are
 * compile-only, so unit tests can only reach code that never loads them.
 */
public final class GoalTracker {

    private GoalTracker() {
    }

    /**
     * Goal-issuing process commands (first verb, lowercased): unlike #goto
     * they never touch the custom goal, so the goal-identity check would
     * miss them. Each send supersedes like a setGoal. Unknown process
     * commands share the live goal's id until a caller appears (no wave-1/2
     * traffic sends any).
     */
    private static final java.util.Set<String> PROCESS_CMDS =
            java.util.Set.of("follow", "mine", "build", "explore", "farm", "elytra");
    private static final java.util.Set<String> PAUSE_CMDS = java.util.Set.of("pause", "p", "paws");
    private static final java.util.Set<String> RESUME_CMDS = java.util.Set.of("resume", "r", "unpause", "unpaws");
    private static final java.util.Set<String> STOP_CMDS =
            java.util.Set.of("stop", "cancel", "c", "forcecancel");

    /** First whitespace-separated verb, lowercased; "" when blank. */
    static String firstToken(String command) {
        String c = command.trim();
        if (c.startsWith("#")) {
            c = c.substring(1);
        }
        String[] parts = c.trim().split("\\s+", 2);
        return parts.length == 0 || parts[0].isEmpty() ? "" : parts[0].toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * A command re-arms the goal tracker when it changed the custom goal
     * (identity — Baritone news a Goal per setGoal, so even a same-spot
     * re-issue counts), when another process took control ({@code #goto
     * <block>} routes to GetToBlock and never touches the custom goal), or
     * when a process command re-issues onto its live process (same
     * instance, so the control check misses it). A malformed #goto that
     * parsed nothing leaves the live goal armed. Identity is all it reads,
     * hence {@code Object} (keeps this class game-free). Stops never
     * re-arm: releasing control must not look like a takeover.
     */
    static boolean rearmsTracker(Object before, Object after, Object beforeProc, Object afterProc, String verb) {
        if (STOP_CMDS.contains(verb)) {
            return false;
        }
        return after != before || afterProc != beforeProc || PROCESS_CMDS.contains(verb);
    }

    /**
     * Pause-flag update for a control verb: true on #pause, false on
     * #resume/#stop, null (untouched) for anything else.
     */
    static Boolean pauseFlagFor(String verb) {
        if (PAUSE_CMDS.contains(verb)) {
            return true;
        }
        if (RESUME_CMDS.contains(verb) || STOP_CMDS.contains(verb)) {
            return false;
        }
        return null;
    }

    /** Watchdog decision. */
    enum TimeoutDecision {
        SILENT,
        FREEZE,
        FIRE
    }

    static TimeoutDecision timeoutDecision(
            long tracked, boolean terminal, boolean paused, long tick, long deadline) {
        if (tracked <= 0 || terminal) {
            return TimeoutDecision.SILENT;
        }
        if (paused) {
            return TimeoutDecision.FREEZE;
        }
        return tick < deadline ? TimeoutDecision.SILENT : TimeoutDecision.FIRE;
    }
}
