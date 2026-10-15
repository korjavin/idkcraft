package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
}
