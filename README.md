# idkcraft

`idkcraft` is a production Minecraft deployment designed for seamless cross-play and AI experimentation. It runs a [Paper](https://papermc.io) Java server in Docker, bridged to Bedrock Edition (including Nintendo Switch) via [GeyserMC](https://geysermc.org) and [Floodgate](https://github.com/GeyserMC/Floodgate). Embodied companion bots built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) (and a Baritone-driven second body) join the server, follow players and work on their own goals. A rule-based FSM decides every tick; LLM/JEV planners are opt-in and only consulted when a goal stalls.

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

## Bots

- **v1 (`bot`, default `IdkBot`):** Mineflayer body. Joins automatically; with no `BOT_FOLLOW` target it works on its own goal, and `follow me` switches it to following you.
- **v2 (`bot2` + `body2`, `BOT_BODY=baritone`):** same brain driving a Baritone pilot over an internal bridge. Off unless `BOT2_USERNAME` is set. A separate `baritone` worker container is optional (`WORKER_NAME`).
- **Swarm (`swarm1`..`swarm32`):** extra helper bots, idle unless `BOT_SWARM_N` is set; they split a `flat` job into strips.
- **Work-mode goals** (nobody followed): night shelter, craft, equip, build the house, gather wood, deliver, forage, explore, rest, plus the castle project, `flat` (level ground), and stockpile. `fight` always preempts.
- **Chat commands:** plain text, no leading slash (T on Java, D-pad Right on Switch). Common ones: `follow me`, `stop`, `go work`, `come home`, `build here`, `build castle`, `go castle`, `castle`, `find me <block>`, `bring me <item>`, `flat [radius]`, `status`, `share`. Say `help` in game for the list; see [bot/README.md](bot/README.md#chat-commands) for full docs. Prefix `<BotName>: ` to address one bot.

---

## Repository Layout

- `docker-compose.yml`: the stack: `mc` (Paper + Geyser), `bot`, `baritone`, `bot2`, `body2`, `swarm1`..`swarm32`.
- `bot/`: bot runtime (`bot/src`), tests, and rigs/tools (see [bot/tools/README.md](bot/tools/README.md)).
- `baritone/`: Baritone worker/pilot image.
- `mc/`: Minecraft server configuration overrides and plugin assets.
- `.github/workflows/deploy.yml`: GitOps workflow (see Deploy).

Environment variables are listed in [CLAUDE.md](CLAUDE.md) (Shared Contract) and `.env.example`.

---

## Run and test locally

```bash
docker compose up            # needs Docker; first Paper boot downloads plugins, ~1-2 min
cd bot && npm ci && npm test # no Minecraft client needed (fake-player e2e harness)
```

---

## Deploy

Push to `master` -> GitHub Actions builds the bot image `ghcr.io/korjavin/idkcraft:<sha>` -> force-pushes the `deploy` branch -> calls the Portainer webhook. Portainer tracks `deploy`, never `master`.

---

## Prod checklist

1. **Portainer Stack:** Deploy as a Portainer Git stack named `idkcraft` tracking branch `deploy` with compose path `docker-compose.yml`. Commits pushed to `master` trigger CI to build the bot image, force-push `deploy`, and call the webhook in secret `PORTAINER_REDEPLOY_HOOK`.
2. **Environment Variables:** Set in Portainer:
   - `TYPESAFE_API_KEY` / `ANTHROPIC_API_KEY`: optional planner keys; without them the bot runs the stub brain.
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
   - Bot status: Run `docker logs idkcraft-bot` to verify `brain=stub planner=<jev|llm|none>` plus `decision source=` log entries.
   - Server status: Run `docker logs idkcraft-mc` to verify `Started Geyser on UDP port 19132`.
