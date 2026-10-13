package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * Mineflayer-radians -> notch-degrees conversion (idkcraft-neuc.9).
 * The expected values are the four cardinal looks through mineflayer's
 * own conversions (toNotchianYaw = deg(pi - yaw), toNotchianPitch =
 * deg(-pitch)); the round trip back is BridgeServer.mineflayerYaw.
 */
class LookMathTest {
    private static final double EPS = 1e-9;

    @Test
    void cardinalYawTable() {
        assertEquals(180.0, LookMath.notchYawDeg(0), EPS); // mineflayer north
        assertEquals(0.0, LookMath.notchYawDeg(Math.PI), EPS); // south
        assertEquals(270.0, LookMath.notchYawDeg(-Math.PI / 2), EPS); // east
        assertEquals(90.0, LookMath.notchYawDeg(Math.PI / 2), EPS); // west
    }

    @Test
    void pitchTable() {
        assertEquals(0.0, LookMath.notchPitchDeg(0), EPS);
        assertEquals(-90.0, LookMath.notchPitchDeg(Math.PI / 2), EPS); // looking up
        assertEquals(90.0, LookMath.notchPitchDeg(-Math.PI / 2), EPS); // looking down
    }

    @Test
    void roundTripThroughStateConversion() {
        for (double yaw : new double[] {0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.234}) {
            double back = LookMath.mineflayerYaw(LookMath.notchYawDeg(yaw));
            double want = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            double got = ((back % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            assertEquals(want, got, 1e-6, "yaw " + yaw);
        }
    }
}
