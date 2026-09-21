# idkcraft

`idkcraft` is a production Minecraft deployment designed for seamless cross-play and AI experimentation. It runs a high-performance [Paper](https://papermc.io) Java Minecraft server in Docker, bridged to Bedrock Edition (including Nintendo Switch) via [GeyserMC](https://geysermc.org) and [Floodgate](https://github.com/GeyserMC/Floodgate). An embodied companion bot built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) connects to the server and follows players in real time, driven by sub-40ms reflex decisions powered by [TypeSafe AI JEV](https://typesafe.ai) (a non-autoregressive "System 1" decision engine; see background in the project research report).

---

## How to Join

### Join from Nintendo Switch (Bedrock Edition)

Because Nintendo Switch restricts direct IP entry and disables LAN broadcast discovery, connections route through the public [BedrockConnect](https://github.com/BedrockConnect/BedrockConnect) DNS redirect mechanism.

#### Prerequisites
1. An active **Nintendo Switch Online (NSO)** subscription.
2. A **Microsoft / Xbox Live** account linked in your Nintendo Switch Minecraft client.

#### Step-by-Step Connection Guide
1. **Configure Switch DNS:**
   - From the HOME menu, open **System Settings** > **Internet** > **Internet Settings**.
   - Select your Wi-Fi network and select **Change Settings**.
   - Set **DNS Settings** to **Manual**.
   - **Primary DNS:** Enter a public BedrockConnect IP (consult the [BedrockConnect repository](https://github.com/BedrockConnect/BedrockConnect) README for the current list of public DNS addresses).
   - **Secondary DNS:** Enter a public DNS provider (such as Cloudflare or Google DNS).
   - Save the settings and connect to the network.
2. **Open the Server Picker:**
   - Launch Minecraft and select **Play** > **Servers**.
   - Select any official **Featured Server** (e.g., *The Hive* or *CubeCraft*).
   - The BedrockConnect custom menu will open instead of the featured server.
3. **Add & Join Server:**
   - Select **Add Server**.
   - Server Address: `<server-address>` (ask the server owner for the address)
   - Server Port: `19132`
   - Select the server from your list and connect.

#### Caveats
- **Wi-Fi Profiles:** Switch DNS settings are stored per Wi-Fi network. You must configure these settings again when connecting to a different network, or revert to *Automatic* if required for other games.
- **Whitelist Username Format:** Bedrock players authenticate through Floodgate, which prepends a dot `.` prefix to Gamertags (with spaces converted to underscores, e.g., `.PlayerName`). Provide this prefixed handle to the server owner for whitelisting.

---

### Join from Java Edition

1. Launch Minecraft Java Edition.
2. Navigate to **Multiplayer** > **Direct Connection** (or **Add Server**).
3. Server Address: `<server-address>` (default port `25565`; ask the server owner for the address).
4. **Note:** The server operates in offline mode with a strict whitelist (`ONLINE_MODE=false`, `ENFORCE_WHITELIST=TRUE`). Ask the server owner to add your Minecraft username to the whitelist before connecting.

---

## Companion Bot (`IdkBot`)

- **Automatic Presence:** The bot container joins the server automatically with the username `IdkBot`.
- **Behavior:** Operates a ~1-second System-1 perception-decision loop. Evaluates distance, player velocity, and threat state to follow the nearest player (or a designated player set by `BOT_FOLLOW`).
- **Commands:** Supports in-game chat instructions such as `follow me` and `stop` (see `bot/README.md` for full command documentation and brain options).

---

## Repository Layout

- `docker-compose.yml`: Top-level Docker Compose stack running `mc` (Paper + Geyser) and `bot` (Mineflayer).
- `bot/`: Mineflayer companion bot runtime, test harnesses, and JEV/stub brain interfaces.
- `mc/`: Minecraft server configuration overrides and plugin assets.
- `.github/workflows/deploy.yml`: GitOps workflow that builds `ghcr.io/korjavin/idkcraft:<sha>` and `ghcr.io/korjavin/idkcraft-laya:<sha>`, updates the `deploy` branch, and signals the Portainer webhook.

*Note: Environment variable definitions and deployment configurations live in `.env.example` and the project epic contract. Refer to those files directly for configuration details.*

---

## Prod checklist

1. **Portainer Stack:** Deploy as a Portainer Git stack named `idkcraft` tracking branch `deploy` with compose path `docker-compose.yml`. Commits pushed to `master` trigger CI to build the bot image, force-push `deploy`, and call the webhook in secret `PORTAINER_REDEPLOY_HOOK`.
2. **Environment Variables:** Set in Portainer:
   - `TYPESAFE_API_KEY`: Secret key for the JEV reflex brain.
   - `MC_DATA_PATH`: Set to `/srv/idkcraft/data` (absolute host path so world data persists across redeploys).
   - All other variables rely on defaults documented in `.env.example`.
3. **Player Whitelisting:**
   - **Java Edition:** Add the player's offline UUID to `WHITELIST` in stack env and redeploy, or run on the Portainer host:
     ```bash
     docker exec idkcraft-mc rcon-cli whitelist add <Name>
     ```
   - **Bedrock / Switch Edition:** Run on the Portainer host once the stack is running (spaces in Gamertags become underscores):
     ```bash
     docker exec idkcraft-mc rcon-cli whitelist add .<Gamertag>
     ```
4. **Verification & Logs:**
   - Bot status: Run `docker logs idkcraft-bot` to verify `brain=laya` (or `brain=jev` when `BRAIN_URL` is overridden to JEV) and matching `decision source=` log entries.
   - Server status: Run `docker logs idkcraft-mc` to verify `Started Geyser on UDP port 19132`.
