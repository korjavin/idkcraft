package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Queue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** {@link WsServer} over loopback with a raw-socket client: handshake, masked
 * frames, fragmentation, ping/pong, push, and the wrong-path 404. */
public class WsServerTest {

    private WsServer server;

    @AfterEach
    public void stop() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    @Test
    public void callRoundTrip() throws Exception {
        server = new WsServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), msg -> "{\"echo\":" + msg.length() + "}");
        server.start();
        try (RawClient c = new RawClient(server.getPort())) {
            c.sendText("{\"jsonrpc\":\"2.0\",\"id\":1}");
            assertEquals("{\"echo\":24}", c.nextText());
        }
    }

    @Test
    public void fragmentedMessageDeliversOnce() throws Exception {
        server = new WsServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), msg -> "got:" + msg);
        server.start();
        try (RawClient c = new RawClient(server.getPort())) {
            c.sendFrame(0x1, "hel".getBytes(StandardCharsets.UTF_8), false);
            c.sendFrame(0x0, "lo".getBytes(StandardCharsets.UTF_8), true);
            assertEquals("got:hello", c.nextText());
        }
    }

    @Test
    public void pingGetsPongAndPushReachesClient() throws Exception {
        server = new WsServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), msg -> null);
        server.start();
        try (RawClient c = new RawClient(server.getPort())) {
            c.sendFrame(0x9, new byte[] { 1, 2, 3 }, true);
            RawFrame pong = c.next();
            assertEquals(0xA, pong.opcode);
            assertEquals(3, pong.payload.length);
            server.push("note");
            assertEquals("note", c.nextText());
        }
    }

    @Test
    public void lastCloseHookFiresWhenTheOnlyClientDrops() throws Exception {
        server = new WsServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), msg -> null);
        java.util.concurrent.atomic.AtomicInteger closes = new java.util.concurrent.atomic.AtomicInteger();
        server.onLastClose(closes::incrementAndGet);
        server.start();
        RawClient c = new RawClient(server.getPort());
        c.sendText("hello");
        c.close();
        long deadline = System.currentTimeMillis() + 5000;
        while (closes.get() == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertEquals(1, closes.get(), "last-close hook must fire once when the only client drops");
    }

    @Test
    public void wrongPathIs404() throws Exception {
        server = new WsServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), msg -> null);
        server.start();
        try (Socket sock = new Socket(InetAddress.getLoopbackAddress(), server.getPort())) {
            sock.setSoTimeout(5000);
            OutputStream out = sock.getOutputStream();
            out.write(("GET /nope HTTP/1.1\r\nHost: x\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            byte[] head = readHead(sock.getInputStream());
            assertTrue(new String(head, StandardCharsets.ISO_8859_1).startsWith("HTTP/1.1 404"),
                    "want a 404 head");
        }
    }

    private static byte[] readHead(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int[] tail = new int[4];
        int n = 0;
        int b;
        while ((b = in.read()) != -1) {
            buf.write(b);
            tail[n++ % 4] = b;
            if (n >= 4 && tail[n % 4] == '\r' && tail[(n + 1) % 4] == '\n'
                    && tail[(n + 2) % 4] == '\r' && tail[(n + 3) % 4] == '\n') {
                return buf.toByteArray();
            }
            if (n > 8192) {
                throw new IllegalStateException("head too big");
            }
        }
        throw new IllegalStateException("eof in head");
    }

    private record RawFrame(int opcode, byte[] payload) {
    }

    /** Minimal masking ws client (what the spec demands of clients). */
    private static final class RawClient implements AutoCloseable {
        private final Socket sock;
        private final Queue<RawFrame> frames = new ArrayDeque<>();

        RawClient(int port) throws Exception {
            sock = new Socket(InetAddress.getLoopbackAddress(), port);
            sock.setSoTimeout(5000);
            OutputStream out = sock.getOutputStream();
            out.write(("GET /rpc HTTP/1.1\r\n"
                    + "Host: localhost\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            String head = new String(readHead(sock.getInputStream()), StandardCharsets.ISO_8859_1);
            assertTrue(head.startsWith("HTTP/1.1 101"), "want a 101 head, got: " + head.split("\r\n")[0]);
            assertTrue(head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "want the RFC sample accept key");
        }

        void sendText(String text) throws Exception {
            sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8), true);
        }

        void sendFrame(int opcode, byte[] payload, boolean fin) throws Exception {
            OutputStream out = sock.getOutputStream();
            out.write((fin ? 0x80 : 0) | opcode);
            // Masked, short lengths only (the test never sends big frames).
            if (payload.length >= 126) {
                throw new IllegalStateException("test frame too big");
            }
            out.write(0x80 | payload.length);
            byte[] mask = { 0x11, 0x22, 0x33, 0x44 };
            out.write(mask);
            for (int i = 0; i < payload.length; i++) {
                out.write(payload[i] ^ mask[i % 4]);
            }
            out.flush();
        }

        String nextText() throws Exception {
            for (;;) {
                RawFrame f = next();
                if (f.opcode == 0x1) {
                    return new String(f.payload, StandardCharsets.UTF_8);
                }
            }
        }

        RawFrame next() throws Exception {
            if (!frames.isEmpty()) {
                return frames.poll();
            }
            InputStream in = sock.getInputStream();
            int b0 = in.read();
            int b1 = in.read();
            if (b0 == -1 || b1 == -1) {
                throw new IllegalStateException("eof in frame");
            }
            int opcode = b0 & 0x0F;
            long len = b1 & 0x7F;
            if (len == 126) {
                len = (in.read() << 8) | in.read();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) {
                    len = (len << 8) | in.read();
                }
            }
            byte[] payload = in.readNBytes((int) len);
            return new RawFrame(opcode, payload);
        }

        @Override
        public void close() throws Exception {
            sock.close();
        }
    }
}
