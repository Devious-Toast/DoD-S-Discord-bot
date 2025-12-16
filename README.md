```markdown
# Day of Defeat: Source — Discord Server Info Bot (A2S + optional RCON)

This Node.js bot queries a Day of Defeat: Source server and reports:
- Server name (hostname)
- Online / offline status
- Current map
- Next map (if available via A2S rules or RCON)
- Time left (if available via A2S rules or RCON)
- Player count

This project does NOT use python-valve. It uses `gamedig` for A2S queries and `rcon-client` for optional RCON.

## Files of interest
- src/index.js — main bot code (A2S queries, optional RCON, updater, command handling)
- scripts/register-commands.js — helper to register slash commands (global or guild)
- Dockerfile, docker-compose.yml — dockerized run example
- service/dods-discord.service — systemd unit example
- config.example.json — bot configuration
- .env.example — environment variables

## Setup (quick)
1. Copy `.env.example` -> `.env` and set:
   - DISCORD_TOKEN
   - CLIENT_ID (optional but recommended for command registration)
   - GUILD_ID (optional for testing)
2. Copy `config.example.json` -> `config.json` and set:
   - defaultServer.host / port
   - Optionally enable RCON (rcon.enabled = true) and provide host, port, password
   - Optionally enable updateMessage and set `channelId` (the bot will post or update a message)
3. Install dependencies:
   ```
   npm install
   ```
4. (Optional) Register commands to a guild (fast) or globally:
   - For fast testing in a guild:
     ```
     CLIENT_ID=<client_id> GUILD_ID=<guild_id> DISCORD_TOKEN=<token> npm run register-commands
     ```
   - For global registration (can take up to an hour to propagate):
     ```
     CLIENT_ID=<client_id> DISCORD_TOKEN=<token> npm run register-commands
     ```
5. Start:
   ```
   npm start
   ```

## Docker
- Build and run with Docker:
  ```
  docker build -t dods-discord-bot .
  docker run --env-file .env -v $(pwd)/config.json:/app/config.json dods-discord-bot
  ```
- Or use docker-compose (see docker-compose.yml).

## systemd
Example unit provided in `service/dods-discord.service`. Copy to `/etc/systemd/system/dods-discord.service`, edit paths, then:
```
sudo systemctl daemon-reload
sudo systemctl enable --now dods-discord.service
```

## RCON notes
- RCON is optional and used only when enabled in `config.json.rcon`.
- The bot will attempt several RCON commands to fetch `nextmap` and `timeleft` values:
  - It tries SourceMod-style `sm_cvar nextmap` / `sm_cvar timeleft`
  - It tries raw `status` output parsing as a fallback
  - Because RCON environments vary, these are best-effort. If your server exposes those values with different commands, you can extend `src/index.js` to try them.
- RCON credentials are required (host/port/password). Only enable RCON if you control the server and have a secure password.

## Persistence of updater message
- When `updateMessage.enabled` is true and the bot posts a new message, the bot writes `state.json` to persist `messageId`. This ensures subsequent restarts will edit the same message.

## Registering commands via script
- `scripts/register-commands.js` lets you register commands to a guild for testing or globally. Provide `CLIENT_ID`, `GUILD_ID` (optional), and `DISCORD_TOKEN` in environment.

## Extending
- Want tighter parsing of `time left` or `next map`? If your server has specific commands/plugins, tell me which you use (e.g., SourceMod plugin) and I can adjust RCON commands to match.
- Want persistent storage in a database instead of `state.json`? I can add an example with SQLite or Redis.

```