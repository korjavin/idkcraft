package idkcraft.bridge;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Minimal RFC 6455 websocket server (idkcraft-neuc.1): text messages only, one
 * path ({@code /rpc}), no extensions, no TLS. Hand-rolled instead of shading
 * Java-WebSocket so the jar has zero bundled dependencies (nothing for the
 * remapper to fight, nothing to keep in sync). Pure {@code java.net} — covered
 * by {@code WsServerTest} over loopback.
 *
 * <p>Threading: one daemon accept thread plus one daemon read thread per
 * connection; {@link #push} is safe from any thread.
 */
public final class WsServer {

    /** Handles one text message; the return value is sent back, null = silence. */
    @FunctionalInterface
    public interface MessageHandler {
        String onMessage(String text);
    }

    private static final Logger LOG = LoggerFactory.getLogger(WsServer.class);
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 §4.2.2
    private static final int MAX_HEAD_BYTES = 16 * 1024;
    private static final int MAX_MESSAGE_BYTES = 1024 * 1024;

    private final ServerSocket server;
    private final MessageHandler handler;
    private volatile Runnable onLastClose = () -> {};
    private final Set<Conn> conns = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread accepter;

    /** Binds (port 0 = ephemeral, for tests) but starts accepting on {@link #start}. */
    public WsServer(InetSocketAddress bind, MessageHandler handler) throws IOException {
        this.server = new ServerSocket();
        this.server.setReuseAddress(true);
        this.server.bind(bind);
        this.handler = handler;
        this.accepter = new Thread(this::acceptLoop, "bridge-ws-accept");
        this.accepter.setDaemon(true);
    }

    public int getPort() {
        return server.getLocalPort();
    }

    /** Fired when the last open connection closes (never on {@link #stop}). */
    public void onLastClose(Runnable hook) {
        this.onLastClose = hook != null ? hook : () -> {};
    }

    public void start() {
        accepter.start();
    }

    /** Broadcast one text message to every open connection. */
    public void push(String text) {
        byte[] raw = text.getBytes(StandardCharsets.UTF_8);
        for (Conn c : new ArrayList<>(conns)) {
            try {
                c.sendText(raw);
            } catch (IOException e) {
                c.closeQuietly();
            }
        }
    }

    public void stop() {
        if (!running.compareAndSet(true, false)) {
            return;
        }
        try {
            server.close();
        } catch (IOException ignored) {
            // Already closed.
        }
        for (Conn c : new ArrayList<>(conns)) {
            c.closeQuietly();
        }
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket sock = server.accept();
                sock.setKeepAlive(true);
                // neuc.67.1.1: replies are small request/response frames; Nagle
                // held each one behind the peer's delayed ACK (~40 ms per RPC).
                sock.setTcpNoDelay(true);
                Conn conn = new Conn(sock);
                conns.add(conn);
                conn.start();
            } catch (IOException e) {
                if (running.get()) {
                    LOG.debug("bridge ws accept failed", e);
                }
            }
        }
    }

    private final class Conn {
        private final Socket sock;
        private final AtomicBoolean closeSent = new AtomicBoolean(false);

        Conn(Socket sock) {
            this.sock = sock;
        }

        void start() {
            Thread t = new Thread(this::run, "bridge-ws-conn");
            t.setDaemon(true);
            t.start();
        }

        void run() {
            try {
                InputStream in = sock.getInputStream();
                if (!handshake(in)) {
                    return;
                }
                readLoop(in);
            } catch (EOFException e) {
                // Clean client drop.
            } catch (IOException e) {
                LOG.debug("bridge ws conn failed", e);
            } finally {
                closeQuietly();
            }
        }

        void closeQuietly() {
            boolean wasOpen = conns.remove(this);
            try {
                sock.close();
            } catch (IOException ignored) {
                // Already closed.
            }
            if (wasOpen && running.get() && conns.isEmpty()) {
                try {
                    onLastClose.run();
                } catch (RuntimeException e) {
                    LOG.warn("bridge ws close hook failed", e);
                }
            }
        }

        // ---- handshake ----

        private boolean handshake(InputStream in) throws IOException {
            byte[] head = readHead(in);
            if (head == null) {
                return false;
            }
            String req = new String(head, StandardCharsets.ISO_8859_1);
            String[] lines = req.split("\r\n");
            String[] first = lines[0].split(" ", 3);
            String path = first.length >= 2 ? first[1] : "";
            String upgrade = header(lines, "upgrade");
            String connection = header(lines, "connection");
            String version = header(lines, "sec-websocket-version");
            String key = header(lines, "sec-websocket-key");
            if (!"GET".equalsIgnoreCase(first.length >= 1 ? first[0] : "") || !"/rpc".equals(path)) {
                deny("404 Not Found");
                return false;
            }
            if (!hasToken(connection, "upgrade") || !hasToken(upgrade, "websocket") || key.isEmpty()) {
                deny("400 Bad Request");
                return false;
            }
            if (!"13".equals(version.trim())) {
                deny("426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
                return false;
            }
            String accept = Base64.getEncoder().encodeToString(sha1(key + GUID));
            String res = "HTTP/1.1 101 Switching Protocols\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + accept + "\r\n"
                    + "\r\n";
            OutputStream out = sock.getOutputStream();
            out.write(res.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            return true;
        }

        private byte[] readHead(InputStream in) throws IOException {
            byte[] buf = new byte[MAX_HEAD_BYTES];
            int n = 0;
            int b;
            while (n < buf.length && (b = in.read()) != -1) {
                buf[n++] = (byte) b;
                if (n >= 4 && buf[n - 4] == '\r' && buf[n - 3] == '\n'
                        && buf[n - 2] == '\r' && buf[n - 1] == '\n') {
                    byte[] head = new byte[n];
                    System.arraycopy(buf, 0, head, 0, n);
                    return head;
                }
            }
            return null;
        }

        private void deny(String status, String... extra) throws IOException {
            StringBuilder res = new StringBuilder("HTTP/1.1 " + status + "\r\n"
                    + "Connection: close\r\n"
                    + "Content-Length: 0\r\n");
            for (String h : extra) {
                res.append(h);
            }
            OutputStream out = sock.getOutputStream();
            out.write(res.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        }

        // ---- frames ----

        private void readLoop(InputStream in) throws IOException {
            byte[] frag = null;
            while (running.get() && !sock.isClosed()) {
                int b0 = in.read();
                if (b0 == -1) {
                    return;
                }
                int b1 = in.read();
                if (b1 == -1) {
                    return;
                }
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = readU16(in);
                } else if (len == 127) {
                    len = readU64(in);
                }
                boolean control = opcode >= 0x8;
                if (control && (!fin || len > 125)) {
                    fail(1002, "bad control frame");
                    return;
                }
                if (!masked) {
                    fail(1002, "client frames must be masked");
                    return;
                }
                if (len > MAX_MESSAGE_BYTES) {
                    fail(1009, "message too big");
                    return;
                }
                byte[] mask = readFully(in, 4);
                byte[] payload = readFully(in, (int) len);
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i % 4];
                }
                switch (opcode) {
                    case 0x0: // continuation
                        if (frag == null) {
                            fail(1002, "stray continuation");
                            return;
                        }
                        frag = join(frag, payload);
                        if (frag.length > MAX_MESSAGE_BYTES) {
                            fail(1009, "message too big");
                            return;
                        }
                        if (fin) {
                            deliver(frag);
                            frag = null;
                        }
                        break;
                    case 0x1: // text
                        if (frag != null) {
                            fail(1002, "text inside fragment");
                            return;
                        }
                        if (fin) {
                            deliver(payload);
                        } else {
                            frag = payload;
                        }
                        break;
                    case 0x2: // binary: the bridge speaks text only
                        fail(1003, "binary not supported");
                        return;
                    case 0x8: // close
                        if (frag != null) {
                            frag = null;
                        }
                        sendClose(payload.length >= 2
                                ? ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF)
                                : 1000);
                        return;
                    case 0x9: // ping
                        sendFrame(0xA, payload);
                        break;
                    case 0xA: // pong
                        break;
                    default:
                        fail(1002, "unknown opcode");
                        return;
                }
            }
        }

        private void deliver(byte[] raw) throws IOException {
            String reply;
            try {
                reply = handler.onMessage(new String(raw, StandardCharsets.UTF_8));
            } catch (RuntimeException e) {
                LOG.warn("bridge ws handler failed", e);
                fail(1011, "handler error");
                return;
            }
            if (reply != null) {
                sendText(reply.getBytes(StandardCharsets.UTF_8));
            }
        }

        synchronized void sendText(byte[] raw) throws IOException {
            sendFrame(0x1, raw);
        }

        private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
            if (sock.isClosed()) {
                throw new EOFException("closed");
            }
            // One write per frame (neuc.67.1.1): header and payload leave in
            // one segment instead of a 2-10 byte header segment first.
            int hl = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
            byte[] frame = new byte[hl + payload.length];
            frame[0] = (byte) (0x80 | opcode);
            if (hl == 2) {
                frame[1] = (byte) payload.length;
            } else if (hl == 4) {
                frame[1] = 126;
                frame[2] = (byte) (payload.length >>> 8);
                frame[3] = (byte) payload.length;
            } else {
                frame[1] = 127;
                // 64-bit length: the shift must be long — an int shift is
                // masked mod 32 and wrote the 4-byte length twice, which
                // strict ws clients reject (first hit by chunk.get replies,
                // the first >64 KB frames on this socket, neuc.6).
                long len = payload.length;
                for (int i = 0; i < 8; i++) {
                    frame[2 + i] = (byte) (len >>> (8 * (7 - i)));
                }
            }
            System.arraycopy(payload, 0, frame, hl, payload.length);
            OutputStream out = sock.getOutputStream();
            out.write(frame);
            out.flush();
        }

        private void sendClose(int status) throws IOException {
            if (!closeSent.compareAndSet(false, true)) {
                return;
            }
            sendFrame(0x8, new byte[] { (byte) ((status >>> 8) & 0xFF), (byte) (status & 0xFF) });
        }

        private void fail(int status, String why) {
            LOG.debug("bridge ws closing: {}", why);
            try {
                sendClose(status);
            } catch (IOException ignored) {
                // Already gone.
            }
        }
    }

    private static int readU16(InputStream in) throws IOException {
        byte[] b = readFully(in, 2);
        return ((b[0] & 0xFF) << 8) | (b[1] & 0xFF);
    }

    private static long readU64(InputStream in) throws IOException {
        byte[] b = readFully(in, 8);
        long v = 0;
        for (int i = 0; i < 8; i++) {
            v = (v << 8) | (b[i] & 0xFF);
        }
        return v;
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r == -1) {
                throw new EOFException("short frame");
            }
            off += r;
        }
        return buf;
    }

    private static byte[] join(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static byte[] sha1(String s) {
        try {
            return MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.ISO_8859_1));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String header(String[] lines, String name) {
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0 && lines[i].substring(0, colon).trim().equalsIgnoreCase(name)) {
                return lines[i].substring(colon + 1).trim();
            }
        }
        return "";
    }

    private static boolean hasToken(String headerValue, String token) {
        for (String part : headerValue.split(",")) {
            if (part.trim().toLowerCase(Locale.ROOT).equals(token)) {
                return true;
            }
        }
        return false;
    }

}
