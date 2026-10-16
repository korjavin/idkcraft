package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Mine item matching without the game: drops count toward their block
 * (stone->cobblestone, grass_block->dirt), names dedupe and strip the
 * registry prefix.
 */
public class MineTest {

    @Test
    public void stoneCountsItselfAndItsDrop() {
        List<String> got = Mine.acceptedItems(List.of("stone", "cobblestone"));
        assertTrue(got.contains("stone"));
        assertTrue(got.contains("cobblestone"));
        assertEquals(2, got.size());
    }

    @Test
    public void grassCountsDirtToo() {
        List<String> got = Mine.acceptedItems(List.of("grass_block"));
        assertTrue(got.contains("grass_block"));
        assertTrue(got.contains("dirt"));
        assertEquals(2, got.size());
    }

    @Test
    public void dirtStaysItself() {
        assertEquals(List.of("dirt"), Mine.acceptedItems(List.of("dirt", "minecraft:dirt", " dirt ")));
    }

    private static JsonObject paramsWithGuard(int x0, int y0, int z0, int x1, int y1, int z1) {
        JsonObject g = new JsonObject();
        g.addProperty("x0", x0);
        g.addProperty("y0", y0);
        g.addProperty("z0", z0);
        g.addProperty("x1", x1);
        g.addProperty("y1", y1);
        g.addProperty("z1", z1);
        JsonObject p = new JsonObject();
        p.add("guard", g);
        return p;
    }

    @Test
    public void guardAbsentReadsNull() throws Exception {
        assertNull(Mine.guardBox(new JsonObject()));
    }

    @Test
    public void guardCornersNormalizeToMinMax() throws Exception {
        assertArrayEquals(
                new int[] {0, 60, 0, 10, 70, 10},
                Mine.guardBox(paramsWithGuard(10, 70, 10, 0, 60, 0)));
    }

    @Test
    public void guardTooBigFails() {
        JsonObject p = paramsWithGuard(0, 0, 0, 1000, 1000, 1000);
        assertThrows(Rpc.RpcException.class, () -> Mine.guardBox(p));
    }

    @Test
    public void guardMalformedFails() {
        JsonObject p = new JsonObject();
        JsonObject g = new JsonObject();
        g.addProperty("x0", 0);
        p.add("guard", g);
        assertThrows(Rpc.RpcException.class, () -> Mine.guardBox(p));
    }

    @Test
    public void dropTargetsKeepsEverythingElse() {
        assertEquals(
                List.of("oak_planks", "dirt"),
                Mine.dropTargets(
                        List.of("cobblestone", "oak_planks", "granite", "dirt"),
                        List.of("stone", "cobblestone", "granite")));
    }

    @Test
    public void dropTargetsEmptyTargetsChangesNothing() {
        assertEquals(List.of("cobblestone"), Mine.dropTargets(List.of("cobblestone"), List.of()));
    }
}
