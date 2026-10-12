package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class InputStateTest {
    @Test
    void partialSetLeavesAbsentUnchanged() {
        InputState s = new InputState();
        assertTrue(s.apply(Map.of("forward", true, "jump", true)));
        assertTrue(s.apply(Map.of("forward", false)));
        assertFalse(s.get("forward"));
        assertTrue(s.get("jump")); // absent = unchanged
        assertTrue(s.anyHeld());
    }

    @Test
    void unknownKeyRejectsWholeDiff() {
        InputState s = new InputState();
        assertFalse(s.apply(Map.of("forward", true, "fly", true)));
        assertFalse(s.anyHeld());
    }

    @Test
    void clearReleasesAll() {
        InputState s = new InputState();
        assertTrue(s.apply(Map.of("sneak", true, "sprint", true)));
        s.clear();
        assertFalse(s.anyHeld());
        assertEquals(7, s.snapshot().size());
    }

    @Test
    void resumeOnlyForOurPauseWithLatchedGoal() {
        assertTrue(InputState.shouldResume(true, true));
        assertFalse(InputState.shouldResume(true, false));
        assertFalse(InputState.shouldResume(false, true));
    }
}
