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
     * {@code near x y z r} (idkcraft-neuc.21): the bridge's own verb for a
     * Baritone GoalNear — no console command keeps a range ({@code #goto x
     * y z} is an exact GoalBlock, which a mineflayer GoalNear centre in the
     * air or inside a block can never satisfy). Returns {x,y,z,r}, or null
     * when the command is not a well-formed near (r >= 0).
     */
    static int[] nearArgs(String command) {
        String c = command.trim();
        if (c.startsWith("#")) {
            c = c.substring(1);
        }
        String[] parts = c.trim().split("\\s+");
        if (parts.length != 5 || !parts[0].equalsIgnoreCase("near")) {
            return null;
        }
        int[] out = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                out[i] = Integer.parseInt(parts[i + 1]);
            }
        } catch (NumberFormatException e) {
            return null;
        }
        return out[3] < 0 ? null : out;
    }

    /**
     * Heuristic penalty per block of depth into a danger disc (idkcraft-neuc.25):
     * about ten walked blocks (Baritone's walk is ~4.6 ticks a block), the
     * v2 twin of v1's PATH_COST 10 per move (bot/src/danger.js).
     */
    static final double AVOID_PER_BLOCK = 50;

    /**
     * Penalty Baritone's A* adds to a node's heuristic at (x, z): for every
     * disc {cx, cz, lim} (flat triples) the node's cell centre is closer
     * than lim to, (lim - d) * AVOID_PER_BLOCK. A heuristic, never a cost or
     * a ban: deep nodes are expanded last and never picked as a partial
     * path's best node, so plans bend around the disc while a goal inside
     * it still plans. Malformed (non-triple) input reads as no disc.
     */
    static double avoidPenalty(double[] discs, int x, int z) {
        if (discs == null || discs.length % 3 != 0) {
            return 0;
        }
        double p = 0;
        for (int i = 0; i < discs.length; i += 3) {
            double d = Math.hypot(x + 0.5 - discs[i], z + 0.5 - discs[i + 1]);
            if (d < discs[i + 2]) {
                p += (discs[i + 2] - d) * AVOID_PER_BLOCK;
            }
        }
        return p;
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
