package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Goal-tracker arming without the game: only goal-issuing commands re-arm
 * (a changed custom goal, a control takeover, or a process-command
 * re-issue); controls keep the live goal's id armed and a bridge-issued
 * #pause freezes the watchdog.
 */
public class BridgeTrackerTest {

    // Identity is all rearmsTracker reads, so plain Objects stand in for
    // Goals and processes (GoalTracker is game-free on purpose — see its
    // javadoc).
    private static Object fakeGoal() {
        return new Object();
    }

    private static Object fakeProc() {
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
    public void avoidPenaltyGrowsWithDepthIntoADisc() {
        double[] disc = {0.5, 0.5, 32};
        assertEquals(32 * GoalTracker.AVOID_PER_BLOCK, GoalTracker.avoidPenalty(disc, 0, 0), 1e-9); // centre
        assertEquals(2 * GoalTracker.AVOID_PER_BLOCK, GoalTracker.avoidPenalty(disc, 30, 0), 1e-9); // 2 deep
        assertEquals(0, GoalTracker.avoidPenalty(disc, 32, 0), 1e-9); // on the rim
        assertEquals(0, GoalTracker.avoidPenalty(disc, 40, 40), 1e-9); // outside
        assertEquals(0, GoalTracker.avoidPenalty(null, 0, 0), 1e-9);
        assertEquals(0, GoalTracker.avoidPenalty(new double[] {0.5, 0.5}, 0, 0), 1e-9); // malformed
        double[] two = {0.5, 0.5, 32, 10.5, 0.5, 5};
        assertEquals(22 * GoalTracker.AVOID_PER_BLOCK + 5 * GoalTracker.AVOID_PER_BLOCK,
                GoalTracker.avoidPenalty(two, 10, 0), 1e-9); // discs add
    }

    @Test
    public void nearArgsParsesOnlyAWellFormedRangedGoal() {
        org.junit.jupiter.api.Assertions.assertArrayEquals(new int[] {8, 70, -18, 2}, GoalTracker.nearArgs("#near 8 70 -18 2"));
        org.junit.jupiter.api.Assertions.assertArrayEquals(new int[] {0, 64, 0, 0}, GoalTracker.nearArgs("NEAR 0 64 0 0"));
        assertNull(GoalTracker.nearArgs("#goto 8 70 18"));
        assertNull(GoalTracker.nearArgs("#near 8 70 18"));
        assertNull(GoalTracker.nearArgs("#near 8 70 18 -1"));
        assertNull(GoalTracker.nearArgs("#near 8.5 70 18 2"));
        assertNull(GoalTracker.nearArgs("#near 8 70 18 2 9"));
    }

    @Test
    public void changedGoalRearmsWhateverTheVerb() {
        Object before = fakeGoal();
        Object proc = fakeProc();
        assertTrue(GoalTracker.rearmsTracker(before, fakeGoal(), proc, proc, "goto"));
        assertTrue(GoalTracker.rearmsTracker(before, fakeGoal(), proc, proc, "path"));
        assertTrue(GoalTracker.rearmsTracker(null, fakeGoal(), null, proc, "goto"));
        assertTrue(GoalTracker.rearmsTracker(before, null, proc, proc, "goto"));
    }

    @Test
    public void takeoverRearmsAndStopsNeverDo() {
        Object goal = fakeGoal();
        Object proc = fakeProc();
        // #goto <block> routes to GetToBlock: same custom goal, new control.
        assertTrue(GoalTracker.rearmsTracker(goal, goal, proc, fakeProc(), "goto"));
        assertTrue(GoalTracker.rearmsTracker(goal, goal, null, proc, "goto"));
        // A stop releases control — that must not look like a takeover.
        assertFalse(GoalTracker.rearmsTracker(goal, goal, proc, fakeProc(), "stop"));
        assertFalse(GoalTracker.rearmsTracker(goal, goal, proc, null, "cancel"));
        assertFalse(GoalTracker.rearmsTracker(fakeGoal(), fakeGoal(), proc, fakeProc(), "c"));
    }

    @Test
    public void unchangedGoalRearmsOnlyForProcessTakeover() {
        Object same = fakeGoal();
        Object proc = fakeProc();
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "goto"));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "path"));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "set"));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "pause"));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "stop"));
        assertFalse(GoalTracker.rearmsTracker(null, null, null, null, "set"));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, ""));
        assertFalse(GoalTracker.rearmsTracker(same, same, proc, proc, "getto"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "follow"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "mine"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "build"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "explore"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "farm"));
        assertTrue(GoalTracker.rearmsTracker(same, same, proc, proc, "elytra"));
    }

    @Test
    public void pauseFlagFollowsPauseResumeStop() {
        assertEquals(Boolean.TRUE, GoalTracker.pauseFlagFor("pause"));
        assertEquals(Boolean.TRUE, GoalTracker.pauseFlagFor("p"));
        assertEquals(Boolean.TRUE, GoalTracker.pauseFlagFor("paws"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("resume"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("r"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("unpause"));
        assertEquals(Boolean.FALSE, GoalTracker.pauseFlagFor("unpaws"));
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
