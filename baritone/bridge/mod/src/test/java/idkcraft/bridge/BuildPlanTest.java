package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@link BuildPlan} wire parsing and progress math without the game: the client
 * thread parts (registry, Baritone) cannot run here, so every pure helper
 * the handler depends on is pinned — a regression fails here, not on the
 * rig.
 */
public class BuildPlanTest {

    private static JsonObject params(String cellsJson) {
        JsonObject params = new JsonObject();
        params.addProperty("name", "house");
        JsonObject origin = new JsonObject();
        origin.addProperty("x", 100);
        origin.addProperty("y", 64);
        origin.addProperty("z", -40);
        params.add("origin", origin);
        params.add("cells", JsonParser.parseString(cellsJson).getAsJsonArray());
        return params;
    }

    private static String cell(int dx, int dy, int dz, String block) {
        return "{\"dx\":" + dx + ",\"dy\":" + dy + ",\"dz\":" + dz + ",\"block\":\"" + block + "\"}";
    }

    @Test
    public void parseKeepsNameOriginAndCells() throws Exception {
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(0, 0, 0, "oak_planks") + ","
                + cell(1, 0, 0, "cobblestone") + "]"));
        assertEquals("house", spec.name);
        assertEquals(100, spec.ox);
        assertEquals(2, spec.cells.size());
        assertEquals("oak_planks", spec.cells.get(0).block);
    }

    @Test
    public void parseStripsMinecraftPrefix() throws Exception {
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(0, 0, 0, "minecraft:oak_planks") + "]"));
        assertEquals("oak_planks", spec.cells.get(0).block);
    }

    @Test
    public void emptyCellsRefused() {
        assertThrows(Rpc.RpcException.class, () -> BuildPlan.parse(params("[]")));
    }

    @Test
    public void missingOriginRefused() {
        JsonObject params = params("[" + cell(0, 0, 0, "oak_planks") + "]");
        params.remove("origin");
        assertThrows(Rpc.RpcException.class, () -> BuildPlan.parse(params));
    }

    @Test
    public void duplicateCellsRefused() {
        assertThrows(Rpc.RpcException.class, () -> BuildPlan.parse(params(
                "[" + cell(0, 0, 0, "oak_planks") + "," + cell(0, 0, 0, "stone") + "]")));
    }

    @Test
    public void badBlockNameRefused() {
        assertThrows(Rpc.RpcException.class, () -> BuildPlan.parse(params("[" + cell(0, 0, 0, "Oak Planks!") + "]")));
    }

    @Test
    public void farOffsetRefused() {
        assertThrows(Rpc.RpcException.class,
                () -> BuildPlan.parse(params("[" + cell(500, 0, 0, "oak_planks") + "]")));
    }

    @Test
    public void originRebasesByBoundsMinimum() throws Exception {
        // The rig killer (send-back 1): schematic (0,0,0) is the minimum
        // cell — without this rebase every negative-offset cell lands
        // shifted, the counter reads 0, and the watchdog calls stall.
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(-2, -1, 0, "oak_planks") + ","
                + cell(3, 2, 5, "oak_planks") + "]"));
        int[] o = BuildPlan.rebasedOrigin(spec);
        assertEquals(98, o[0]);
        assertEquals(63, o[1]);
        assertEquals(-40, o[2]);
    }

    @Test
    public void boundsSpanTheOffsets() throws Exception {
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(-2, 0, 0, "oak_planks") + ","
                + cell(3, 2, 5, "oak_planks") + "]"));
        int[] b = BuildPlan.boundsOf(spec.cells);
        assertEquals(-2, b[0]);
        assertEquals(0, b[1]);
        assertEquals(0, b[2]);
        assertEquals(6, b[3]);
        assertEquals(3, b[4]);
        assertEquals(6, b[5]);
    }

    @Test
    public void woodVariantsSubstituteEachOther() {
        Map<String, List<String>> subs = BuildPlan.substitutesFor(List.of("oak_planks", "cobblestone"),
                List.of("oak_planks", "birch_planks", "spruce_planks", "oak_fence", "cobblestone"));
        assertTrue(subs.get("oak_planks").contains("birch_planks"));
        assertTrue(subs.get("oak_planks").contains("spruce_planks"));
        assertTrue(!subs.containsKey("cobblestone"));
    }

    @Test
    public void fencesAndLogsSubstituteWithinClassOnly() {
        Map<String, List<String>> subs = BuildPlan.substitutesFor(List.of("oak_fence", "oak_log"),
                List.of("oak_fence", "birch_fence", "oak_log", "birch_log", "oak_planks"));
        assertEquals(List.of("birch_fence"), subs.get("oak_fence"));
        assertEquals(List.of("birch_log"), subs.get("oak_log"));
    }

    @Test
    public void countPlacedAcceptsDesiredAndSubstitutes() throws Exception {
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(0, 0, 0, "oak_planks") + ","
                + cell(1, 0, 0, "oak_planks") + "," + cell(2, 0, 0, "cobblestone") + "]"));
        Map<String, List<String>> subs = BuildPlan.substitutesFor(List.of("oak_planks"),
                List.of("oak_planks", "birch_planks"));
        Map<String, String> current = Map.of("0,0,0", "oak_planks", "1,0,0", "birch_planks",
                "2,0,0", "stone");
        assertEquals(2, BuildPlan.countPlaced(spec.cells, current, subs));
    }

    @Test
    public void unreadableCellsReadMissing() throws Exception {
        BuildPlan.Spec spec = BuildPlan.parse(params("[" + cell(0, 0, 0, "oak_planks") + "]"));
        assertEquals(0, BuildPlan.countPlaced(spec.cells, Map.of(), Map.of()));
    }

    @Test
    public void forbidNamesNormalize() throws Exception {
        JsonObject params = params("[" + cell(0, 0, 0, "oak_planks") + "]");
        JsonArray forbid = new JsonArray();
        forbid.add("minecraft:oak_planks");
        params.add("forbid", forbid);
        assertEquals(List.of("oak_planks"), BuildPlan.parse(params).forbid);
    }

    @Test
    public void pauseTapNamesMissingBlocksOfThePausingTick() {
        BuildPlan.PauseTap tap = new BuildPlan.PauseTap();
        // Tick 1: assemble logged a missing list but found a goal (no pause).
        tap.line("[Baritone] Missing materials for at least:", 1);
        tap.line("[Baritone] 3x Block{minecraft:dirt}", 1);
        assertEquals(null, tap.verdict());
        // Tick 5: the rig's real pause shape (body log, 2026-10-16).
        tap.line("[Baritone] Missing materials for at least:", 5);
        tap.line("[Baritone] 95x Block{minecraft:granite}", 5);
        tap.line("[Baritone] 2x Block{minecraft:oak_stairs}[facing=north,half=bottom]", 5);
        tap.line("[Baritone] Unable to do it. Pausing. resume to resume, cancel to cancel", 5);
        assertEquals("missing:granite,oak_stairs", tap.verdict());
        // Tick 9: a pause with no missing line that tick is reach/path.
        tap.line("[Baritone] 3x Block{minecraft:dirt}", 8);
        tap.line("[Baritone] Unable to do it. Pausing. resume to resume, cancel to cancel", 9);
        assertEquals("unable", tap.verdict());
        tap.reset();
        assertEquals(null, tap.verdict());
    }
}
