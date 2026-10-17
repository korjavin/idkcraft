package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

/** {@link Rpc} without the game: dispatch, errors, ids, batches. */
public class RpcTest {

    private static Rpc rpc() {
        Rpc rpc = new Rpc();
        rpc.register("echo", params -> params.get("v"));
        rpc.register("fail", params -> {
            throw new Rpc.RpcException(Rpc.INVALID_PARAMS, "nope");
        });
        rpc.register("boom", params -> {
            throw new IllegalStateException("bug");
        });
        return rpc;
    }

    @Test
    public void callReturnsResultWithEchoedId() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"echo\",\"params\":{\"v\":3}}");
        JsonObject obj = JsonParser.parseString(reply).getAsJsonObject();
        assertEquals(7, obj.get("id").getAsInt());
        assertEquals(3, obj.get("result").getAsInt());
    }

    @Test
    public void stringIdsEchoVerbatim() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":\"a1\",\"method\":\"echo\",\"params\":{\"v\":1}}");
        assertEquals("a1", JsonParser.parseString(reply).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void takeTimingsCountsPerMethodThenResets() {
        Rpc rpc = rpc();
        rpc.handle("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\",\"params\":{\"v\":1}}");
        rpc.handle("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"echo\",\"params\":{\"v\":2}}");
        rpc.handle("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"fail\"}");
        String t = rpc.takeTimings(6);
        assertTrue(t.startsWith("busy="), t);
        assertTrue(t.matches(".* echo=2/\\d+/\\d+.*"), t);
        assertTrue(t.matches(".* fail=1/\\d+/\\d+.*"), t); // failed calls still occupied the read thread
        assertEquals("busy=0", rpc.takeTimings(6));
    }

    @Test
    public void unknownMethodIs32601() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"nope\"}");
        assertEquals(-32601, JsonParser.parseString(reply).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    public void handlerErrorCodePassesThrough() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"fail\"}");
        JsonObject err = JsonParser.parseString(reply).getAsJsonObject().getAsJsonObject("error");
        assertEquals(Rpc.INVALID_PARAMS, err.get("code").getAsInt());
        assertEquals("nope", err.get("message").getAsString());
    }

    @Test
    public void handlerBugsAre32603NotThrows() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"boom\"}");
        assertEquals(Rpc.INTERNAL_ERROR, JsonParser.parseString(reply).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    public void nonObjectParamsAre32602() {
        String reply = rpc().handle("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\",\"params\":[1]}");
        assertEquals(Rpc.INVALID_PARAMS, JsonParser.parseString(reply).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    public void notificationRunsSilent() {
        final boolean[] ran = { false };
        Rpc rpc = new Rpc();
        rpc.register("ping", params -> {
            ran[0] = true;
            return null;
        });
        assertNull(rpc.handle("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}"));
        assertTrue(ran[0]);
    }

    @Test
    public void batchAnswersPerElement() {
        String reply = rpc().handle("["
                + "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\",\"params\":{\"v\":9}},"
                + "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"nope\"},"
                + "{\"jsonrpc\":\"2.0\",\"method\":\"echo\",\"params\":{\"v\":1}}"
                + "]");
        var arr = JsonParser.parseString(reply).getAsJsonArray();
        assertEquals(2, arr.size());
        assertEquals(9, arr.get(0).getAsJsonObject().get("result").getAsInt());
        assertEquals(-32601, arr.get(1).getAsJsonObject()
                .getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    public void garbageIsParseErrorWithNullId() {
        String reply = rpc().handle("{oops");
        JsonObject obj = JsonParser.parseString(reply).getAsJsonObject();
        assertTrue(obj.get("id").isJsonNull());
        assertEquals(Rpc.PARSE_ERROR, obj.getAsJsonObject("error").get("code").getAsInt());
    }
}
