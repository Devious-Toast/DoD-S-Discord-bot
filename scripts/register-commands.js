import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const __dirname = path.resolve();
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error('Please set DISCORD_TOKEN in .env or environment.');
  process.exit(1);
}

const serverCommand = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Get Day of Defeat: Source server info')
  .addStringOption(opt => opt.setName('ip').setDescription('Server IP (overrides config)').setRequired(false))
  .addIntegerOption(opt => opt.setName('port').setDescription('Server port (overrides config)').setRequired(false));

const commands = [serverCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (CLIENT_ID && GUILD_ID) {
      console.log('Registering commands to guild', GUILD_ID);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered to guild.');
    } else if (CLIENT_ID) {
      console.log('Registering global commands (may take up to an hour)');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands.');
    } else {
      console.error('CLIENT_ID not set — cannot register commands. Set CLIENT_ID and optionally GUILD_ID.');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();