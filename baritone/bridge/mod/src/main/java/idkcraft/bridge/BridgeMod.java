package idkcraft.bridge;

import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.MinecraftClient;

/**
 * One-body bridge mod (idkcraft-kqzf spike SKELETON — does not compile yet).
 *
 * <p>Shape of the real mod: a small websocket server on the render thread's
 * client reading {@link MinecraftClient#player}/{@link MinecraftClient#world}
 * and driving {@code ClientPlayerInteractionManager} + Baritone's command
 * manager. Every method below names the exact client/Baritone call the epic
 * pins against the 26.1.2 yarn build + Baritone 1.18.0 sources. The spike
 * proves the Node side against {@code FakeTransport}, which mirrors this
 * method table 1:1 (see {@code ../PROTOCOL.md}).
 */
public class BridgeMod implements ClientModInitializer {
    /** Bridge port: next to the 7777 write-only console bridge, never published. */
    public static final int PORT = 7778;

    @Override
    public void onInitializeClient() {
        // TODO(kqzf-epic):
        //   server = new BridgeServer(PORT,
        //       MinecraftClient.getInstance(),
        //       BaritoneAPI.getProvider().getPrimaryBaritone());
        //   server.start();
        //   Entities.install(server); // idkcraft-neuc.3 (uncomment with the block when .1 lands)
        //   ClientPlayConnectionEvents.DISCONNECT.register((h, c) -> server.dropState());
        //   ClientReceiveMessageEvents.GAME.register((msg, overlay) ->
        //       server.push("chat", ChatCodec.of(msg)));
    }

    // ---- spike method table (names match FakeTransport 1:1) ----
    //
    // hello -> {mod,v,mc,baritone}: version gate, rejects a stale adapter.
    //
    // state.get -> pos/health/food + baritone status:
    //   player.getPos(), getYaw/getPitch, isOnGround(),
    //   player.getHealth(), getHungerManager().getFoodLevel(),
    //   baritone.getPathingBehavior().isPathing() (pin name vs 1.18.0
    //   sources; fallback: parse the [CHAT] [Baritone] lines the rig
    //   already sees in the client log).
    //
    // block.get {x,y,z} -> {name,x,y,z}:
    //   world.getBlockState(pos); Registries.BLOCK.getId(state.getBlock()).
    //   Null world/pos outside render distance -> {name:'air'} is WRONG;
    //   return {name:null} so the adapter cache reads unloaded, like
    //   mineflayer. (Spike FakeTransport says 'air'; prod must not.)
    //
    // inventory.get -> {items:[{slot,name,count,type}]}:
    //   player.getInventory().main (+armor/offhand in the touch phase).
    //
    // dig.once {x,y,z} -> {broke}:
    //   select best tool (mirror bestHarvestTool: lowest dig time),
    //   interactionManager.attackBlock + updateBlockBreakingProgress per
    //   client tick until air; resolve on break, reject on abort
    //   (displacement, 30 s cap). Must run on the client thread
    //   (client.execute) — the socket thread only queues.
    //
    // place.once {x,y,z} -> {placed}:
    //   interactBlock on the face the adapter names; resolve when the
    //   slot count drops / the block appears, reject on reach/fail.
    //
    // chat.send {message} -> player.networkHandler.sendChatMessage.
    //
    // baritone.cmd {command} -> commandManager.execute(stripHash(command)).
    // baritone.status -> {pathing,last} (last: success|noPath|timeout|
    //   stopped; latched from the PathEvent listener below).
    //
    // ---- events (mod -> node notifications) ----
    //
    // chat/death/respawn: ClientReceiveMessageEvents.GAME + a client-tick
    //   health watcher (health<=0 edge, respawn screen edge).
    // block.update: ClientChunkEvents + world.setBlockState hook (one mixin,
    //   or poll the adapter's watched set at 10 Hz — no mixin for walk).
    // baritone.event: Baritone PathEvent listener (AT_GOAL/DISCARD/
    //   CALC_FAILED -> success/noPath/timeout); pin class names vs 1.18.0.
}
