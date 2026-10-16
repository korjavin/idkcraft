package idkcraft.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure build-plan core for {@link Build} (idkcraft-neuc.54): wire parsing
 * and progress math with no game classes on it, so {@code BuildPlanTest}
 * covers it without the client (the LookMath precedent — the test runtime
 * has no Minecraft).
 */
final class BuildPlan {
    /** Largest schematic a single call may carry (the v2 castle is ~2048 cells). */
    static final int MAX_CELLS = 4096;
    /** A build may not wander further than this from its origin on any axis. */
    static final int MAX_OFFSET = 96;

    static final class Cell {
        final int dx;
        final int dy;
        final int dz;
        final String block;

        Cell(int dx, int dy, int dz, String block) {
            this.dx = dx;
            this.dy = dy;
            this.dz = dz;
            this.block = block;
        }

        String key() {
            return dx + "," + dy + "," + dz;
        }
    }

    /** Parsed + validated build params. */
    static final class Spec {
        final String name;
        final int ox;
        final int oy;
        final int oz;
        final List<Cell> cells;
        final Map<String, String> props;
        final List<String> forbid;

        Spec(String name, int ox, int oy, int oz, List<Cell> cells, Map<String, String> props,
                List<String> forbid) {
            this.name = name;
            this.ox = ox;
            this.oy = oy;
            this.oz = oz;
            this.cells = cells;
            this.props = props;
            this.forbid = forbid;
        }
    }

    private BuildPlan() {
    }

    static String normalizeBlock(String raw) throws Rpc.RpcException {
        if (raw == null) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "cell is missing block");
        }
        String name = raw.startsWith("minecraft:") ? raw.substring("minecraft:".length()) : raw;
        if (!name.matches("[a-z0-9_]+(/[a-z0-9_]+)*") || name.length() > 128) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad block name: " + raw);
        }
        return name;
    }

    static Spec parse(JsonObject params) throws Rpc.RpcException {
        if (params == null) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "params must be an object");
        }
        String name = "bridge";
        if (params.has("name") && params.get("name").isJsonPrimitive()
                && params.get("name").getAsJsonPrimitive().isString()) {
            name = params.get("name").getAsString();
        }
        if (name.isEmpty() || name.length() > 64) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "bad build name");
        }
        JsonObject origin = params.has("origin") && params.get("origin").isJsonObject()
                ? params.get("origin").getAsJsonObject()
                : null;
        if (origin == null) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing origin {x,y,z}");
        }
        int ox = requiredInt(origin, "x");
        int oy = requiredInt(origin, "y");
        int oz = requiredInt(origin, "z");
        JsonElement cellsEl = params.get("cells");
        if (cellsEl == null || !cellsEl.isJsonArray()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing cells [{dx,dy,dz,block}]");
        }
        JsonArray arr = cellsEl.getAsJsonArray();
        if (arr.size() == 0 || arr.size() > MAX_CELLS) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "cells must hold 1.." + MAX_CELLS);
        }
        List<Cell> cells = new ArrayList<>(arr.size());
        Set<String> seen = new HashSet<>();
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "cell must be an object");
            }
            JsonObject c = el.getAsJsonObject();
            int dx = requiredInt(c, "dx");
            int dy = requiredInt(c, "dy");
            int dz = requiredInt(c, "dz");
            if (Math.abs(dx) > MAX_OFFSET || Math.abs(dy) > MAX_OFFSET || Math.abs(dz) > MAX_OFFSET) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "cell offset out of range");
            }
            String block = c.has("block") && c.get("block").isJsonPrimitive()
                    ? normalizeBlock(c.get("block").getAsString())
                    : null;
            if (block == null) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "cell is missing block");
            }
            Cell cell = new Cell(dx, dy, dz, block);
            if (!seen.add(cell.key())) {
                throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "duplicate cell " + cell.key());
            }
            cells.add(cell);
        }
        Map<String, String> props = new HashMap<>();
        if (params.has("props") && params.get("props").isJsonObject()) {
            for (Map.Entry<String, JsonElement> e : params.get("props").getAsJsonObject().entrySet()) {
                if (e.getValue().isJsonPrimitive()) {
                    props.put(e.getKey(), e.getValue().getAsString());
                }
            }
        }
        List<String> forbid = new ArrayList<>();
        if (params.has("forbid") && params.get("forbid").isJsonArray()) {
            for (JsonElement el : params.get("forbid").getAsJsonArray()) {
                if (el.isJsonPrimitive()) {
                    forbid.add(normalizeBlock(el.getAsString()));
                }
            }
        }
        return new Spec(name, ox, oy, oz, cells, props, forbid);
    }

    /** Inclusive cell bounds {minX,minY,minZ,sx,sy,sz} over the offsets. */
    static int[] boundsOf(List<Cell> cells) {
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        int maxZ = Integer.MIN_VALUE;
        for (Cell c : cells) {
            minX = Math.min(minX, c.dx);
            minY = Math.min(minY, c.dy);
            minZ = Math.min(minZ, c.dz);
            maxX = Math.max(maxX, c.dx);
            maxY = Math.max(maxY, c.dy);
            maxZ = Math.max(maxZ, c.dz);
        }
        return new int[] {minX, minY, minZ, maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1};
    }

    /**
     * Substitute lists per desired block over the candidate paths: a desired
     * {@code *_planks} accepts every candidate {@code *_planks}, same for
     * {@code *_fence} and {@code *_log} (the FSM's wood-variant rule). Other
     * blocks substitute nothing.
     */
    static Map<String, List<String>> substitutesFor(Collection<String> desired, Collection<String> candidates) {
        Map<String, List<String>> out = new HashMap<>();
        for (String want : desired) {
            String suffix = suffixClass(want);
            if (suffix == null) {
                continue;
            }
            List<String> alts = new ArrayList<>();
            for (String cand : candidates) {
                if (!cand.equals(want) && cand.endsWith(suffix)) {
                    alts.add(cand);
                }
            }
            if (!alts.isEmpty()) {
                out.put(want, alts);
            }
        }
        return out;
    }

    private static String suffixClass(String block) {
        if (block.endsWith("_planks")) {
            return "_planks";
        }
        if (block.endsWith("_fence")) {
            return "_fence";
        }
        if (block.endsWith("_log")) {
            return "_log";
        }
        return null;
    }

    /**
     * Placed count over current block paths by cell key: a cell counts when
     * its current block is the desired one or a substitute for it.
     */
    static int countPlaced(List<Cell> cells, Map<String, String> currentByKey,
            Map<String, List<String>> substitutes) {
        int n = 0;
        for (Cell c : cells) {
            String cur = currentByKey.get(c.key());
            if (cur == null) {
                continue;
            }
            if (cur.equals(c.block)) {
                n++;
                continue;
            }
            List<String> alts = substitutes.get(c.block);
            if (alts != null && alts.contains(cur)) {
                n++;
            }
        }
        return n;
    }

    private static int requiredInt(JsonObject params, String key) throws Rpc.RpcException {
        if (params == null || !params.has(key) || !params.get(key).isJsonPrimitive()
                || !params.get(key).getAsJsonPrimitive().isNumber()) {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "missing int param " + key);
        }
        return params.get(key).getAsInt();
    }
}
