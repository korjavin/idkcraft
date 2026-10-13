package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Base64;
import org.junit.jupiter.api.Test;

/** {@link Chunks} wire encoding without the game (idkcraft-neuc.6). */
public class ChunksTest {

    @Test
    public void sectionIndexIsWireOrder() {
        assertEquals(0, Chunks.sectionIndex(0, 0, 0));
        assertEquals(1, Chunks.sectionIndex(1, 0, 0));
        assertEquals(16, Chunks.sectionIndex(0, 0, 1));
        assertEquals(256, Chunks.sectionIndex(0, 1, 0));
        assertEquals(4095, Chunks.sectionIndex(15, 15, 15));
    }

    @Test
    public void allAirSectionEncodesNull() {
        assertNull(Chunks.encodeSection(new int[4096]));
    }

    @Test
    public void encodeSectionIsBase64Int16Le() {
        int[] ids = new int[4096];
        ids[Chunks.sectionIndex(1, 2, 3)] = 0x1234; // stone-class id, LE bytes 34 12
        ids[Chunks.sectionIndex(0, 0, 0)] = 1;
        byte[] raw = Base64.getDecoder().decode(Chunks.encodeSection(ids));
        assertEquals(8192, raw.length);
        assertEquals(1, raw[0] & 0xFF);
        assertEquals(0, raw[1] & 0xFF);
        int at = Chunks.sectionIndex(1, 2, 3) * 2;
        assertEquals(0x34, raw[at] & 0xFF);
        assertEquals(0x12, raw[at + 1] & 0xFF);
    }
}
