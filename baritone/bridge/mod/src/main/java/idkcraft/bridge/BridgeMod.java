package idkcraft.bridge;

import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
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
            BridgeServer server = new BridgeServer(Minecraft.getInstance());
            server.start();
        } catch (Exception e) {
            LOG.error("idkcraft-bridge failed to start; the game continues without it", e);
        }
    }
}
