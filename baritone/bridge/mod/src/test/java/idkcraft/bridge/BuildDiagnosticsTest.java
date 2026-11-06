package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

final class BuildDiagnosticsTest {
    @Test void eventsAreRawBoundedAndResetPerBuild() {
        BuildDiagnostics d = new BuildDiagnostics();
        d.event("CANCELED");
        assertEquals(0, d.snapshot().getAsJsonObject("pathEvents").size());
        d.start();
        d.event("NEXT_CALC_FAILED");
        d.event("CANCELED");
        assertEquals("CANCELED", d.snapshot().get("lastPathEvent").getAsString());
        assertEquals(1, d.snapshot().getAsJsonObject("pathEvents").get("NEXT_CALC_FAILED").getAsInt());
        for (int i = 0; i < 1000005; i++) d.event("CALC_FAILED");
        assertEquals(999999, d.snapshot().getAsJsonObject("pathEvents").get("CALC_FAILED").getAsInt());
        d.stop();
        d.event("CANCELED");
        assertEquals(1, d.snapshot().getAsJsonObject("pathEvents").get("CANCELED").getAsInt());
        d.start();
        assertEquals(0, d.snapshot().getAsJsonObject("pathEvents").size());
        assertFalse(d.snapshot().has("lastPathEvent"));
    }
}
