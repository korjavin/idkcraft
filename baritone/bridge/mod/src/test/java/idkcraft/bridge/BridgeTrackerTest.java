package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Goal-tracker arming without the game: only goal-issuing commands re-arm
 * (a changed custom goal, or a process takeover); controls keep the live
 * goal's id armed and a bridge-issued #pause freezes the watchdog.
 */
public class BridgeTrackerTest {

    // Identity is all rearmsTracker reads, so plain Objects stand in for Goals
    // (GoalTracker is game-free on purpose — see its javadoc).
    private static Object fakeGoal() {
        return new Object();
    }

    @Test
    public void firstTokenStripsHashAndLowercases() {
        assertEquals("goto", GoalTracker.firstToken("#goto 1 2 3"));
        assertEquals("set", GoalTracker.firstToken("  #SET x  "));
        assertEquals("pause", GoalTracker.firstToken("pause"));
        assertEquals("p", GoalTracker.firstToken("P"));
        assertEquals("", GoalTracker.firstToken("#"));
        assertEquals("", GoalTracker.firstToken("   "));
    }

    @Test
    public void changedGoalRearmsWhateverTheToken() {
        Object before = fakeGoal();
        assertTrue(GoalTracker.rearmsTracker(before, fakeGoal(), "goto"));
        assertTrue(GoalTracker.rearmsTracker(before, fakeGoal(), "stop"));
        assertTrue(GoalTracker.rearmsTracker(null, fakeGoal(), "goto"));
        assertTrue(GoalTracker.rearmsTracker(before, null, "stop"));
    }

    @Test
    public void unchangedGoalRearmsOnlyForProcessTakeover() {
        Object same = fakeGoal();
        assertFalse(GoalTracker.rearmsTracker(same, same, "goto"));
        assertFalse(GoalTracker.rearmsTracker(same, same, "set"));
        assertFalse(GoalTracker.rearmsTracker(same, same, "pause"));
        assertFalse(GoalTracker.rearmsTracker(same, same, "stop"));
        assertFalse(GoalTracker.rearmsTracker(null, null, "set"));
        assertFalse(GoalTracker.rearmsTracker(same, same, ""));
        assertTrue(GoalTracker.rearmsTracker(same, same, "follow"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "mine"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "build"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "explore"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "farm"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "elytra"));
        assertTrue(GoalTracker.rearmsTracker(same, same, "getto"));
    }

    @Test
    public void pauseFlagFollowsPauseResumeStop() {
        assertEquals(Boolean.TRUE, GoalTracker.pauseFlagFor("pause"));
        assertEquals(Boolean.TRUE, GoalTracker.pauseFlagFor("p"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("resume"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("r"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("stop"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("cancel"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("c"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("forcecancel"));
        assertNull(GoalTracker.pauseFlagFor("set"));
        assertNull(GoalTracker.pauseFlagFor("goto"));
        assertNull(GoalTracker.pauseFlagFor(""));
    }

    @Test
    public void watchdogStaysSilentWithoutAnArmedGoal() {
        assertEquals(
                GoalTracker.TimeoutDecision.SILENT, GoalTracker.timeoutDecision(0, false, false, 999, 10));
        assertEquals(
                GoalTracker.TimeoutDecision.SILENT, GoalTracker.timeoutDecision(3, true, false, 999, 10));
        assertEquals(
                GoalTracker.TimeoutDecision.SILENT, GoalTracker.timeoutDecision(3, false, false, 5, 10));
    }

    @Test
    public void watchdogFreezesWhilePausedAndFiresPastDeadline() {
        assertEquals(
                GoalTracker.TimeoutDecision.FREEZE, GoalTracker.timeoutDecision(3, false, true, 999, 10));
        assertEquals(
                GoalTracker.TimeoutDecision.FIRE, GoalTracker.timeoutDecision(3, false, false, 10, 10));
        assertEquals(
                GoalTracker.TimeoutDecision.FIRE, GoalTracker.timeoutDecision(3, false, false, 999, 10));
    }
}
