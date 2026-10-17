package idkcraft.bridge;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Shared holder for Baritone's {@code allowInventory} (idkcraft-605b).
 * Build (pwoi) and Mine (605b) each need it on for their call; separate
 * snapshots break when they overlap (a holder saves the other's {@code true},
 * restores mid-call, and the setting leaks on). Refcount: the first acquire
 * saves the live value and sets it on, the last release puts the saved value
 * back. Client thread only. Callers pass the setting as get/set so unit tests
 * run without the game.
 */
final class AllowInventory {

    private static int holders = 0;
    private static boolean saved = false;

    private AllowInventory() {
    }

    static void acquire(BooleanSupplier get, Consumer<Boolean> set) {
        if (holders++ == 0) {
            saved = get.getAsBoolean();
        }
        set.accept(true);
    }

    static void release(Consumer<Boolean> set) {
        if (holders <= 0) {
            return;
        }
        if (--holders == 0) {
            set.accept(saved);
        }
    }

    /** Test hook: forget every holder. */
    static void reset() {
        holders = 0;
        saved = false;
    }
}
