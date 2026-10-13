package idkcraft.bridge;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One-body bridge mod (idkcraft-neuc.1): serves the client's state and
 * Baritone over a websocket so the Node adapter can drive this body with the
 * same logic v1 runs on mineflayer. A bridge failure must never take the
 * game down with it — it logs and the client continues unbridged.
 */
public class BridgeMod implements ClientModInitializer {
    public static final String MOD_ID = "idkcraft-bridge";

    private static final Logger LOG = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitializeClient() {
        try {
            BridgeServer server = new BridgeServer();
            Entities.install(server); // idkcraft-neuc.3, enabled by .1
            Chunks.install(server); // idkcraft-neuc.6, enabled by .1
            Inventory.install(server); // idkcraft-neuc.8
            Look.install(server); // idkcraft-neuc.9
            Input.install(server); // idkcraft-neuc.13: control states
            Windows.install(server); // idkcraft-neuc.11: container windows
            server.start();
        } catch (NoClassDefFoundError e) {
            // The worker runs the API-less standalone Baritone: without
            // baritone/api/** there is nothing to bridge (and nothing ever
            // connects to its unpublished port, so this stays silent).
            if (String.valueOf(e.getMessage()).contains("baritone/api")) {
                LOG.info("idkcraft-bridge disabled: standalone Baritone has no Java API");
            } else {
                LOG.error("idkcraft-bridge failed to start; the game continues without it", e);
            }
        } catch (Throwable t) {
            LOG.error("idkcraft-bridge failed to start; the game continues without it", t);
        }
    }
}
