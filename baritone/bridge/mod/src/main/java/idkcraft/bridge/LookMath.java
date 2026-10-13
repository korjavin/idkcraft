package idkcraft.bridge;

/**
 * Pure look conversions (idkcraft-neuc.9). Zero game imports on purpose
 * (same rule as GoalTracker): unit tests can only reach game-free code.
 *
 * <p>Mineflayer yaw/pitch are radians with yaw zeroed on +Z; notch
 * rotation is degrees. mineflayer conversions.js:
 * toNotchianYaw = deg(pi - yaw), toNotchianPitch = deg(-pitch); the
 * inverse (state.get's direction) is BridgeServer.mineflayerYaw/Pitch.
 */
public final class LookMath {
    private LookMath() {
    }

    static double notchYawDeg(double yawRad) {
        return Math.toDegrees(Math.PI - yawRad);
    }

    static double notchPitchDeg(double pitchRad) {
        return Math.toDegrees(-pitchRad);
    }

    static double mineflayerYaw(double notchYawDeg) {
        return euclideanMod(Math.PI - Math.toRadians(notchYawDeg), Math.PI * 2);
    }

    static double mineflayerPitch(double notchPitchDeg) {
        return euclideanMod(Math.toRadians(-notchPitchDeg) + Math.PI, Math.PI * 2) - Math.PI;
    }

    private static double euclideanMod(double x, double n) {
        return ((x % n) + n) % n;
    }
}
