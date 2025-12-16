import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const require = createRequire(import.meta.url);

// Load libraries (handle CommonJS/ESM interop)
const GamedigLib = (() => {
  try { return require('gamedig'); } catch (e) { return null; }
})();
const RconLib = (() => {
  try { return require('rcon-client'); } catch (e) { return null; }
})();

// Normalize Rcon constructor/helper
function getRconConstructor() {
  if (!RconLib) return null;
  if (RconLib.Rcon) return RconLib.Rcon;
  if (RconLib.default && RconLib.default.Rcon) return RconLib.default.Rcon;
  return RconLib;
}
const Rcon = getRconConstructor();

// Normalized gamedig query helper — supports multiple export shapes (v3, v5, etc.)
async function gamedigQuery(options) {
  if (!GamedigLib) throw new Error('gamedig module not available');

  // gamedig v5 exports GameDig
  if (GamedigLib.GameDig && typeof GamedigLib.GameDig.query === 'function') {
    return GamedigLib.GameDig.query(options);
  }

  // top-level .query
  if (typeof GamedigLib.query === 'function') {
    return GamedigLib.query(options);
  }

  // callable function export (older)
  if (typeof GamedigLib === 'function') {
    return GamedigLib(options);
  }

  // default interop
  if (GamedigLib.default) {
    const def = GamedigLib.default;
    if (def.GameDig && typeof def.GameDig.query === 'function') return def.GameDig.query(options);
    if (typeof def.query === 'function') return def.query(options);
    if (typeof def === 'function') return def(options);
  }

  throw new Error('Unsupported gamedig export shape. Update gamedig or adjust code.');
}

const __dirname = path.resolve();
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json. Copy config.example.json -> config.json and edit it.');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Load or init state
let STATE = {};
if (fs.existsSync(STATE_PATH)) {
  try { STATE = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { STATE = {}; }
}

// Env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
let CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error('Please set DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Slash command definition
const serverCommand = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Get Day of Defeat: Source server info')
  .addStringOption(opt => opt.setName('ip').setDescription('Server IP (overrides config)').setRequired(false))
  .addIntegerOption(opt => opt.setName('port').setDescription('Server port (overrides config)').setRequired(false));

// Register commands helper (uses provided CLIENT_ID or the logged-in application's id)
async function registerCommands(appId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [serverCommand.toJSON()];
  const useAppId = CLIENT_ID || appId;
  if (!useAppId) {
    console.warn('No application id available; skipping automatic command registration.');
    return;
  }

  try {
    if (GUILD_ID) {
      console.log(`Registering commands to guild ${GUILD_ID} for application ${useAppId}`);
      await rest.put(Routes.applicationGuildCommands(useAppId, GUILD_ID), { body: commands });
      console.log('Registered guild commands.');
    } else {
      console.log(`Registering global commands for application ${useAppId} (may take ~1 hour to propagate)`);
      await rest.put(Routes.applicationCommands(useAppId), { body: commands });
      console.log('Registered global commands.');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// Query server using Gamedig A2S (uses gamedigQuery normalization)
async function queryServerA2S(host, port) {
  const options = { type: 'dod', host, port };
  try {
    const res = await gamedigQuery(options);
    // attempt rules query for nextmap / timeleft
    let rules = {};
    try {
      const rulesRes = await gamedigQuery({ ...options, queryType: 'rules' });
      if (rulesRes && rulesRes.raw) {
        if (rulesRes.raw.rules) rules = rulesRes.raw.rules;
        else rules = rulesRes.raw;
      } else if (rulesRes && rulesRes.rules) {
        rules = rulesRes.rules;
      }
    } catch (e) {
      // Non-fatal: rules may be disabled
      rules = {};
    }

    return {
      online: true,
      name: res.name || res.hostname || 'Unknown',
      map: res.map || 'Unknown',
      players: res.players || [],
      maxplayers: res.maxplayers || null,
      raw: res.raw || {},
      rules
    };
  } catch (err) {
    return { online: false, error: err.message || String(err) };
  }
}

// RCON helper — tuned for SourceMod outputs (handles `nextmap` and `timeleft` output)
async function attemptRconFetch(rconConfig) {
  if (!rconConfig && !(CONFIG.rcon && CONFIG.rcon.enabled)) return {};
  if (!Rcon) return {};

  // Resolve fields from either passed object or CONFIG.rcon
  const host = (rconConfig && rconConfig.host) || (CONFIG.rcon && CONFIG.rcon.host);
  const port = (rconConfig && rconConfig.port) || (CONFIG.rcon && CONFIG.rcon.port);
  const password = (rconConfig && rconConfig.password) || (CONFIG.rcon && CONFIG.rcon.password);

  if (!host || !port || !password) return {};

  let rcon;
  try {
    if (typeof Rcon.connect === 'function') {
      rcon = await Rcon.connect({ host, port, password, timeout: 5000 });
    } else if (typeof Rcon === 'function') {
      rcon = await (Rcon.connect?.({ host, port, password, timeout: 5000 }) || Rcon({ host, port, password, timeout: 5000 }));
    } else {
      return {};
    }
  } catch (e) {
    // connection/auth failed
    try { if (rcon && typeof rcon.end === 'function') await rcon.end(); } catch {}
    return {};
  }

  const tryCommands = [
    'nextmap',
    'timeleft',
    'sm_cvar nextmap',
    'sm_cvar timeleft',
    'sm_cvar mp_nextmap',
    'sm_cvar mp_timelimit',
    'mp_nextmap',
    'mp_timelimit',
    'status'
  ];

  const results = {};
  try {
    for (const cmd of tryCommands) {
      try {
        const resp = await rcon.send(cmd);
        const out = resp == null ? '' : String(resp).trim();
        if (!out) continue;

        // Parse nextmap from multiple possible outputs
        if (!results.nextmap) {
          let m = out.match(/Next\s+Map:\s*([^\s"']+)/i);
          if (m) results.nextmap = m[1];

          if (!results.nextmap) {
            m = out.match(/"nextmap"\s+(?:is|=)\s+"?([^"\s]+)"?/i);
            if (m) results.nextmap = m[1];
          }

          if (!results.nextmap) {
            m = out.match(/Next\s+map\s+(?:set\s+to|is)\s*[:\s]*([^\s"']+)/i);
            if (m) results.nextmap = m[1];
          }
        }

        // Parse timeleft
        if (!results.timeleft) {
          let t = out.match(/Time\s+Left[:\s]*([\d:]+)/i);
          if (t) results.timeleft = t[1];

          if (!results.timeleft) {
            t = out.match(/timeleft[:\s]*([\d:]+)/i);
            if (t) results.timeleft = t[1];
          }

          if (!results.timeleft && /no\s+timelimit/i.test(out)) {
            results.timeleft = 'No timelimit';
          }

          if (!results.timeleft) {
            const mpt = out.match(/"mp_timelimit"\s*(?:=|:)\s*"?(?<mins>\d+)"?/i);
            if (mpt && mpt.groups && mpt.groups.mins) {
              const mins = Number(mpt.groups.mins);
              results.timeleft = mins > 0 ? `${mins} minutes (timelimit)` : 'No timelimit';
            } else {
              const mpt2 = out.match(/mp_timelimit\s*[:=]\s*([0-9]+)/i);
              if (mpt2) {
                const mins = Number(mpt2[1]);
                results.timeleft = mins > 0 ? `${mins} minutes (timelimit)` : 'No timelimit';
              }
            }
          }
        }

        if (results.nextmap && results.timeleft) break;
      } catch (cmdErr) {
        // ignore individual command failures
      }
    }
  } finally {
    try { if (rcon && typeof rcon.end === 'function') await rcon.end(); } catch {}
  }

  return results;
}

function buildEmbedFromResult(host, port, result, rconInfo = {}) {
  // If A2S failed but we have RCON info, present an informative embed.
  const online = result.online || (rconInfo && (rconInfo.nextmap || rconInfo.timeleft || result.raw));
  if (!online) {
    return new EmbedBuilder()
      .setTitle(`Server: ${host}:${port}`)
      .setDescription('Status: Offline or unreachable')
      .setColor(0xFF0000)
      .addFields([{ name: 'Error', value: result.error || 'Query failed' }])
      .setTimestamp();
  }

  const playerCount = Array.isArray(result.players) ? `${result.players.length}/${result.maxplayers ?? '??'}` : `Unknown`;
  const nextMap = rconInfo.nextmap || result.rules.nextmap || result.rules['nextmap'] || result.rules['mp_nextmap'] || 'Unknown';
  const timeLeft = rconInfo.timeleft || result.rules.timeleft || result.rules['timeleft'] || result.rules['mp_timelimit'] || 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle(`${result.name || 'Unknown Server'}`)
    .setDescription(`Status: Online — ${host}:${port}`)
    .setColor(0x00FF00)
    .addFields(
      { name: 'Current Map', value: `${result.map || 'Unknown'}`, inline: true },
      { name: 'Next Map', value: `${nextMap}`, inline: true },
      { name: 'Time Left', value: `${timeLeft}`, inline: true },
      { name: 'Players', value: `${playerCount}`, inline: true }
    )
    .setFooter({ text: 'Queried via A2S (gamedig) — RCON used if configured' })
    .setTimestamp();

  return embed;
}

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'server') {
    await interaction.deferReply();
    const ipOpt = interaction.options.getString('ip');
    const portOpt = interaction.options.getInteger('port');

    const host = ipOpt || (CONFIG.defaultServer && CONFIG.defaultServer.host) || '127.0.0.1';
    const port = portOpt || (CONFIG.defaultServer && CONFIG.defaultServer.port) || 27015;

    let res = await queryServerA2S(host, port);

    // If RCON configured and enabled, try to enhance nextmap/timeleft
    let rconInfo = {};
    if (CONFIG.rcon && CONFIG.rcon.enabled) {
      const rconf = {
        host: CONFIG.rcon.host || host,
        port: CONFIG.rcon.port || port,
        password: CONFIG.rcon.password
      };

      rconInfo = await attemptRconFetch(rconf);

      // If A2S reported offline, but RCON returned useful info, mark res as online-ish
      if (!res.online && (rconInfo.nextmap || rconInfo.timeleft)) {
        res.online = true;
        res.name = res.name || 'Unknown (A2S failed)';
        res.map = res.map || 'Unknown';
        res.players = res.players || [];
        res.maxplayers = res.maxplayers || null;
      }
    }

    const embed = buildEmbedFromResult(host, port, res, rconInfo);
    await interaction.editReply({ embeds: [embed] });
  }
});

// Auto-updater: posts or updates a message periodically and persists the messageId in state.json
async function startUpdater() {
  if (!CONFIG.updateMessage || !CONFIG.updateMessage.enabled) return;
  if (!CONFIG.updateMessage.channelId) {
    console.warn('updateMessage enabled but channelId missing in config.json');
    return;
  }

  const channel = await client.channels.fetch(CONFIG.updateMessage.channelId).catch(() => null);
  if (!channel) return console.error('Could not fetch channel for updates. Check channelId.');
  const interval = (CONFIG.updateMessage.intervalSeconds || 60) * 1000;
  let msg = null;

  if (STATE.messageId) {
    msg = await channel.messages.fetch(STATE.messageId).catch(() => null);
    if (!msg) {
      delete STATE.messageId;
      fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 2));
      msg = null;
    }
  } else if (CONFIG.updateMessage.messageId) {
    msg = await channel.messages.fetch(CONFIG.updateMessage.messageId).catch(() => null);
    if (msg) {
      STATE.messageId = CONFIG.updateMessage.messageId;
      fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 2));
    }
  }

  const updateOnce = async () => {
    const host = (CONFIG.defaultServer && CONFIG.defaultServer.host) || '127.0.0.1';
    const port = (CONFIG.defaultServer && CONFIG.defaultServer.port) || 27015;
    let res = await queryServerA2S(host, port);

    let rconInfo = {};
    if (CONFIG.rcon && CONFIG.rcon.enabled) {
      const rconf = {
        host: CONFIG.rcon.host || host,
        port: CONFIG.rcon.port || port,
        password: CONFIG.rcon.password
      };

      if (rconf.host && rconf.port && rconf.password) {
        rconInfo = await attemptRconFetch(rconf);
        if (!res.online && (rconInfo.nextmap || rconInfo.timeleft)) {
          res.online = true;
          res.name = res.name || 'Unknown (A2S failed)';
          res.map = res.map || 'Unknown';
          res.players = res.players || [];
          res.maxplayers = res.maxplayers || null;
        }
      }
    }

    const embed = buildEmbedFromResult(host, port, res, rconInfo);

    try {
      if (!msg) {
        const sent = await channel.send({ embeds: [embed] });
        msg = sent;
        STATE.messageId = msg.id;
        fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 2));
        console.log('Posted new status message:', msg.id);
      } else {
        await msg.edit({ embeds: [embed] });
      }
    } catch (e) {
      console.error('Failed to post/update message:', e);
    }
  };

  await updateOnce();
  setInterval(updateOnce, interval);
}

// Use clientReady only (clean, avoids deprecation duplication)
const onClientReady = async () => {
  try {
    // Ensure we have the application id if not provided via env
    try {
      if (!CLIENT_ID && client.application && client.application.id) CLIENT_ID = client.application.id;
      if (!CLIENT_ID && client.application) {
        await client.application.fetch();
        if (client.application.id) CLIENT_ID = client.application.id;
      }
    } catch (e) {
      // ignore
    }

    await registerCommands(CLIENT_ID);
    console.log(`Logged in as ${client.user.tag}`);
    await startUpdater();
  } catch (e) {
    console.error('Error in client ready handler:', e);
  }
};

client.once('clientReady', onClientReady);

(async () => {
  client.login(DISCORD_TOKEN);
})();