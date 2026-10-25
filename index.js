require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_KEY = process.env.API_KEY;
const VOTE_CHANNEL_ID = process.env.VOTE_CHANNEL_ID || "";
const VOTE_CHANNEL_NAME = process.env.VOTE_CHANNEL_NAME || "";
/** Optional webhook URL — bypasses channel Send Messages issues */
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const STATUS_TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS || 90000);
const PLAYERS_INTERVAL_MS = Number(
  process.env.PLAYERS_INTERVAL_MS || 30 * 60 * 1000
);

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("Missing API_KEY environment variable.");
  process.exit(1);
}

// Message Content is privileged — only enable if toggled ON in the Discord
// Developer Portal (Bot → Privileged Gateway Intents) AND ENABLE_MESSAGE_CONTENT=true.
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
];
if (process.env.ENABLE_MESSAGE_CONTENT === "true") {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({ intents });

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("hello")
    .setDescription("Check that VoteBot is online"),
  new SlashCommandBuilder()
    .setName("here")
    .setDescription("Use this channel for Jurassic TD vote/status posts"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("List VoteBot commands"),
  new SlashCommandBuilder()
    .setName("players")
    .setDescription("Post player counts every 30 minutes"),
  new SlashCommandBuilder()
    .setName("noplayers")
    .setDescription("Stop 30-minute player count posts"),
  new SlashCommandBuilder()
    .setName("ph")
    .setDescription("Get player count once in this channel"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Ask Roblox for Jurassic TD status"),
  new SlashCommandBuilder()
    .setName("checkperms")
    .setDescription("Show what permissions VoteBot has in this channel"),
].map((c) => c.toJSON());

/** guildId -> channelId set by "/here" */
const statusChannels = new Map();

function loadStatusChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    for (const [guildId, channelId] of Object.entries(raw || {})) {
      if (guildId && channelId) statusChannels.set(guildId, channelId);
    }
    console.log(`Loaded ${statusChannels.size} saved status channel(s)`);
  } catch (err) {
    console.error("Failed to load channels.json:", err.message || err);
  }
}

function saveStatusChannels() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(statusChannels);
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("Failed to save channels.json:", err.message || err);
  }
}

loadStatusChannels();

/** guildId -> true when @Players auto-reports are on */
const playersTracking = new Map();

/** requestId -> pending Discord status ask */
const pendingStatusAsks = new Map();

/** requestId -> pending Players ask */
const pendingPlayersAsks = new Map();

let playersIntervalStarted = false;

const app = express();
app.use(express.json());
app.use(express.text({ type: "text/plain" }));

function extractWinningVote(body) {
  if (typeof body === "string") {
    const quoted = body.match(/"([^"]+)"/);
    if (quoted) return quoted[1].trim();
    return body.trim();
  }

  if (body && typeof body === "object") {
    const candidates = [
      body.winningVote,
      body.winning_vote,
      body.vote,
      body.name,
      body.message,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        const quoted = value.match(/"([^"]+)"/);
        return (quoted ? quoted[1] : value).trim();
      }
    }
  }

  return null;
}

function formatStatusInfo(body) {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (!body || typeof body !== "object") return null;

  if (typeof body.status === "string" && body.status.trim()) return body.status.trim();
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  if (typeof body.info === "string" && body.info.trim()) return body.info.trim();

  const parts = [];
  if (body.players != null) parts.push(`Players: ${body.players}`);
  if (body.round != null) parts.push(`Round: ${body.round}`);
  if (body.wave != null) parts.push(`Wave: ${body.wave}`);
  if (body.map != null) parts.push(`Map: ${body.map}`);
  if (body.vote != null) parts.push(`Vote: ${body.vote}`);
  if (Array.isArray(body.lines)) {
    for (const line of body.lines) {
      if (typeof line === "string" && line.trim()) parts.push(line.trim());
    }
  }

  return parts.length ? parts.join("\n") : null;
}

function extractPlayerCount(body) {
  if (typeof body === "string") {
    const n = body.match(/\d+/);
    return n ? Number(n[0]) : null;
  }
  if (!body || typeof body !== "object") return null;

  const raw =
    body.players ?? body.playerCount ?? body.player_count ?? body.count ?? body.status;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = raw.match(/\d+/);
    if (n) return Number(n[0]);
  }
  return null;
}

function checkApiKey(req) {
  const headerKey =
    req.header("x-api-key") ||
    req.header("X-API-Key") ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "");

  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const provided = headerKey || queryKey;

  return Boolean(provided) && provided === API_KEY;
}

function canSendTo(channel, member) {
  if (!channel || !channel.isTextBased?.()) return false;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    // still allow other text-based guild channels if sendable
    if (!channel.isTextBased()) return false;
  }
  if (!member) return true;
  const perms = channel.permissionsFor(member);
  return Boolean(
    perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms?.has(PermissionFlagsBits.SendMessages)
  );
}

/** Only the configured channel — never spray every chat. */
async function findTargetChannel(guild) {
  // 1) Explicit env channel (preferred)
  if (VOTE_CHANNEL_ID) {
    const byId = await guild.channels.fetch(VOTE_CHANNEL_ID).catch(() => null);
    if (byId) return byId;
  }

  // 2) Channel saved by /here
  const rememberedId = statusChannels.get(guild.id);
  if (rememberedId) {
    const remembered = await guild.channels.fetch(rememberedId).catch(() => null);
    if (remembered) return remembered;
  }

  // 3) Optional name match
  if (VOTE_CHANNEL_NAME) {
    const channels = await guild.channels.fetch();
    const byName = channels.find(
      (ch) =>
        ch &&
        ch.type === ChannelType.GuildText &&
        ch.name.toLowerCase() === VOTE_CHANNEL_NAME.toLowerCase()
    );
    if (byName) return byName;
  }

  return null;
}

function describeChannelPerms(channel, member) {
  if (!channel) return { ok: false, reason: "channel missing" };
  if (!member) return { ok: false, reason: "bot member missing from cache" };

  const perms = channel.permissionsFor(member);
  if (!perms) return { ok: false, reason: "could not resolve permissions" };

  return {
    channelType: channel.type,
    channelName: channel.name,
    viewChannel: perms.has(PermissionFlagsBits.ViewChannel),
    sendMessages: perms.has(PermissionFlagsBits.SendMessages),
    sendMessagesInThreads: perms.has(PermissionFlagsBits.SendMessagesInThreads),
    embedLinks: perms.has(PermissionFlagsBits.EmbedLinks),
    readHistory: perms.has(PermissionFlagsBits.ReadMessageHistory),
    administrator: perms.has(PermissionFlagsBits.Administrator),
  };
}

async function postViaWebhook(content) {
  if (!DISCORD_WEBHOOK_URL) return false;
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return true;
}

async function announceWinningVote(winningVote) {
  const message = `The Vote has Ended and the people want "${winningVote}"!`;
  const results = [];

  // Prefer webhook if configured — does not need bot Send Messages
  if (DISCORD_WEBHOOK_URL) {
    try {
      await postViaWebhook(message);
      results.push({
        guild: "webhook",
        ok: true,
        via: "webhook",
      });
      return { message, results };
    } catch (err) {
      results.push({
        guild: "webhook",
        ok: false,
        via: "webhook",
        error: err.message || String(err),
      });
      // fall through to channel send
    }
  }

  for (const [, guild] of client.guilds.cache) {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    const channel = await findTargetChannel(guild);
    if (!channel) {
      results.push({
        guild: guild.name,
        ok: false,
        error:
          "No vote channel set. Set VOTE_CHANNEL_ID on Render or run /here in the target channel.",
      });
      continue;
    }

    const permInfo = describeChannelPerms(channel, me);

    try {
      if (!channel.isTextBased()) {
        throw new Error(`Channel type ${channel.type} is not text-based`);
      }
      await channel.send({ content: message });
      results.push({
        guild: guild.name,
        ok: true,
        channel: channel.name,
        channelId: channel.id,
        via: "bot",
      });
    } catch (err) {
      results.push({
        guild: guild.name,
        ok: false,
        channel: channel.name,
        channelId: channel.id,
        error: err.message || String(err),
        permissions: permInfo,
        hint:
          "In #rawry-info → Permissions, add the VoteBot role (not only @everyone) and allow View Channel + Send Messages. Or create a channel webhook and set DISCORD_WEBHOOK_URL on Render.",
      });
    }
  }

  return { message, results };
}

async function editDiscordMessage(channelId, messageId, content) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const msg = await channel.messages.fetch(messageId);
    await msg.edit(content);
  } catch (err) {
    console.error("Failed to edit Discord message:", err.message || err);
  }
}

function playersMessage(count) {
  return `Players online in Jurassic TD: **${count}**`;
}

async function postPlayersToVoteChannels(count) {
  const text = playersMessage(count);
  for (const guildId of playersTracking.keys()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      const channel = await findTargetChannel(guild);
      if (!channel) continue;
      await channel.send(text);
    } catch (err) {
      console.error(`Failed to post players in ${guild.name}:`, err.message || err);
    }
  }
}

function queuePlayersAsk({ mode, channelId, replyMessageId, guildId }) {
  const id = crypto.randomUUID();
  pendingPlayersAsks.set(id, {
    id,
    mode, // "once" | "broadcast"
    channelId: channelId || null,
    replyMessageId: replyMessageId || null,
    guildId: guildId || null,
    createdAt: Date.now(),
    claimed: false,
  });
  return id;
}

function requestBroadcastPlayers() {
  if (playersTracking.size === 0) return;
  const alreadyPending = [...pendingPlayersAsks.values()].some(
    (ask) => ask.mode === "broadcast" && !ask.claimed
  );
  if (alreadyPending) return;
  queuePlayersAsk({ mode: "broadcast" });
}

function ensurePlayersInterval() {
  if (playersIntervalStarted) return;
  playersIntervalStarted = true;
  setInterval(() => {
    requestBroadcastPlayers();
  }, PLAYERS_INTERVAL_MS).unref?.();
}

function expireOldAsks() {
  const now = Date.now();

  for (const [id, ask] of pendingStatusAsks) {
    if (now - ask.createdAt < STATUS_TIMEOUT_MS) continue;
    pendingStatusAsks.delete(id);
    editDiscordMessage(
      ask.channelId,
      ask.replyMessageId,
      "Roblox did not respond with a status in time. Is the game running?"
    );
  }

  for (const [id, ask] of pendingPlayersAsks) {
    if (now - ask.createdAt < STATUS_TIMEOUT_MS) continue;
    pendingPlayersAsks.delete(id);
    if (ask.mode === "once" && ask.channelId && ask.replyMessageId) {
      editDiscordMessage(
        ask.channelId,
        ask.replyMessageId,
        "Roblox did not respond with a player count in time. Is the game running?"
      );
    }
  }
}

setInterval(expireOldAsks, 15000).unref?.();

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "dcbot-vote-relay",
    discordReady: client.isReady(),
    guilds: client.guilds.cache.size,
    pendingStatusAsks: pendingStatusAsks.size,
    pendingPlayersAsks: pendingPlayersAsks.size,
    playersTrackingGuilds: playersTracking.size,
  });
});

app.get("/health", (_req, res) => {
  res.status(client.isReady() ? 200 : 503).json({
    ok: client.isReady(),
    uptime: process.uptime(),
  });
});

app.post("/vote-ended", async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  if (!client.isReady()) {
    return res.status(503).json({ ok: false, error: "Discord bot not ready yet" });
  }

  const winningVote = extractWinningVote(req.body);
  if (!winningVote) {
    return res.status(400).json({
      ok: false,
      error:
        'Provide winningVote in JSON, or a string like: Vote Ended wining vote is.. "Name"!',
    });
  }

  try {
    const announcement = await announceWinningVote(winningVote);
    return res.json({
      ok: true,
      winningVote,
      ...announcement,
    });
  } catch (err) {
    console.error("Failed to announce vote:", err);
    return res.status(500).json({ ok: false, error: "Failed to send Discord messages" });
  }
});

/** Roblox polls this. When Discord asked for status, returns question "Status?". */
function handleAskStatus(req, res) {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  expireOldAsks();

  const next = [...pendingStatusAsks.values()].find((ask) => !ask.claimed);
  if (!next) {
    return res.json({ ok: true, ask: false, question: null, requestId: null });
  }

  next.claimed = true;
  return res.json({
    ok: true,
    ask: true,
    question: "Status?",
    requestId: next.id,
  });
}

async function handleStatusReply(req, res) {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  if (!client.isReady()) {
    return res.status(503).json({ ok: false, error: "Discord bot not ready yet" });
  }

  const body = typeof req.body === "string" ? { status: req.body } : req.body || {};
  const requestId = body.requestId || body.request_id || req.query.requestId;
  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }

  const ask = pendingStatusAsks.get(requestId);
  if (!ask) {
    return res.status(404).json({
      ok: false,
      error: "No pending status ask for that requestId",
    });
  }

  const info = formatStatusInfo(body);
  if (!info) {
    return res.status(400).json({
      ok: false,
      error:
        "Provide status/info/message text, or fields like players, round, wave, map",
    });
  }

  pendingStatusAsks.delete(requestId);

  const reply = `**Jurassic TD Status**\n${info}`;
  await editDiscordMessage(ask.channelId, ask.replyMessageId, reply);

  return res.json({ ok: true, posted: true });
}

/**
 * Roblox polls this (pair with the vote flow).
 * When Discord ran @Players / @PH, returns question "Players".
 */
function handleAskPlayers(req, res) {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  expireOldAsks();

  const next = [...pendingPlayersAsks.values()].find((ask) => !ask.claimed);
  if (!next) {
    return res.json({ ok: true, ask: false, question: null, requestId: null });
  }

  next.claimed = true;
  return res.json({
    ok: true,
    ask: true,
    question: "Players",
    requestId: next.id,
  });
}

async function handlePlayersReply(req, res) {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  if (!client.isReady()) {
    return res.status(503).json({ ok: false, error: "Discord bot not ready yet" });
  }

  const body = typeof req.body === "string" ? { players: req.body } : req.body || {};
  const requestId = body.requestId || body.request_id || req.query.requestId;
  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }

  const ask = pendingPlayersAsks.get(requestId);
  if (!ask) {
    return res.status(404).json({
      ok: false,
      error: "No pending players ask for that requestId",
    });
  }

  const count = extractPlayerCount(body);
  if (count == null) {
    return res.status(400).json({
      ok: false,
      error: "Provide players as a number, e.g. { \"players\": 12 }",
    });
  }

  pendingPlayersAsks.delete(requestId);

  if (ask.mode === "once" && ask.channelId && ask.replyMessageId) {
    await editDiscordMessage(ask.channelId, ask.replyMessageId, playersMessage(count));
  } else {
    await postPlayersToVoteChannels(count);
  }

  return res.json({ ok: true, posted: true, players: count });
}

app.get("/ask-status", handleAskStatus);
app.post("/status-reply", handleStatusReply);
app.get("/ask-players", handleAskPlayers);
app.post("/players-reply", handlePlayersReply);
// Aliases
app.get("/roblox/ask-status", handleAskStatus);
app.post("/roblox/status", handleStatusReply);
app.get("/roblox/ask-players", handleAskPlayers);
app.post("/roblox/players", handlePlayersReply);

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const appId = client.user.id;

  try {
    await rest.put(Routes.applicationCommands(appId), { body: SLASH_COMMANDS });
    console.log(`Registered ${SLASH_COMMANDS.length} global slash commands`);
  } catch (err) {
    console.error("Failed to register global slash commands:", err);
  }

  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), {
        body: SLASH_COMMANDS,
      });
      console.log(`Registered slash commands in guild ${guildId}`);
    } catch (err) {
      console.error(`Failed to register guild commands for ${guildId}:`, err);
    }
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`In ${client.guilds.cache.size} guild(s)`);
  ensurePlayersInterval();
  await registerSlashCommands();
});

client.on("guildCreate", async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
      body: SLASH_COMMANDS,
    });
  } catch (err) {
    console.error("Failed to register commands for new guild:", err);
  }
});

async function respond(message, content) {
  try {
    return await message.reply(content);
  } catch (err) {
    console.error("reply failed, falling back to send:", err.message || err);
    return message.channel.send(content);
  }
}

const HELP_TEXT = [
  "**VoteBot commands**",
  "`/hello` or `@VoteBot` — check the bot is online",
  "`/here` or `@VoteBot here` — set this channel for posts",
  "`/players` — post player counts every 30 min",
  "`/noplayers` — stop player counts",
  "`/ph` — player count once here",
  "`/status` — ask Roblox for status",
].join("\n");

async function runCommand(name, ctx) {
  const { guild, channel, reply } = ctx;

  if (name === "help") {
    await reply(HELP_TEXT);
    return;
  }

  if (name === "hello" || name === "") {
    await reply("Hello, I'm here for Jurassic TD.");
    return;
  }

  if (name === "checkperms") {
    const me =
      guild?.members?.me ||
      (guild ? await guild.members.fetchMe().catch(() => null) : null);
    const info = describeChannelPerms(channel, me);
    await reply("```json\n" + JSON.stringify(info, null, 2) + "\n```");
    return;
  }

  if (name === "here") {
    if (guild) {
      statusChannels.set(guild.id, channel.id);
      saveStatusChannels();
    }
    const me =
      guild?.members?.me ||
      (guild ? await guild.members.fetchMe().catch(() => null) : null);
    const info = describeChannelPerms(channel, me);
    await reply(
      `This is the chat I will upload my Jurassic TD status to.\n(Channel ID: \`${channel.id}\`)\nView: ${info.viewChannel} | Send: ${info.sendMessages}`
    );
    return;
  }

  if (name === "noplayers") {
    if (guild) playersTracking.delete(guild.id);
    await reply("Stopped. I will no longer post player counts every 30 minutes.");
    return;
  }

  if (name === "players") {
    if (!guild) {
      await reply("Use this command in a server.");
      return;
    }
    playersTracking.set(guild.id, true);
    ensurePlayersInterval();
    await reply(
      "Got it. I'll post player counts to the vote/status channel every 30 minutes. Use `/noplayers` to stop."
    );
    requestBroadcastPlayers();
    return;
  }

  if (name === "ph") {
    const sent = await reply("Asking Roblox for player count…");
    queuePlayersAsk({
      mode: "once",
      channelId: channel.id,
      replyMessageId: sent?.id,
      guildId: guild?.id || null,
    });
    return;
  }

  if (name === "status") {
    const sent = await reply("Asking Roblox for status…");
    const id = crypto.randomUUID();
    pendingStatusAsks.set(id, {
      id,
      channelId: channel.id,
      replyMessageId: sent?.id,
      createdAt: Date.now(),
      claimed: false,
    });
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await runCommand(interaction.commandName, {
      guild: interaction.guild,
      channel: interaction.channel,
      reply: async (content) => {
        if (interaction.deferred || interaction.replied) {
          return interaction.followUp(content);
        }
        await interaction.reply(content);
        return interaction.fetchReply();
      },
    });
  } catch (err) {
    console.error("Slash command failed:", err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "Something went wrong.", ephemeral: true });
      } else {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      }
    } catch (_) {
      /* ignore */
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !client.user) return;

  const mentioned =
    message.mentions.users.has(client.user.id) ||
    message.content.includes(`<@${client.user.id}>`) ||
    message.content.includes(`<@!${client.user.id}>`);

  if (!mentioned) return;

  console.log(
    `Mention from ${message.author.tag} in ${message.guild?.name || "DM"}: ${message.content}`
  );

  const text = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim()
    .toLowerCase();

  let name = "";
  if (/\bnoplayers\b/.test(text)) name = "noplayers";
  else if (/\bplayers\b/.test(text)) name = "players";
  else if (/\bph\b/.test(text)) name = "ph";
  else if (/\bhere\b/.test(text)) name = "here";
  else if (/\bstatus\b/.test(text)) name = "status";
  else if (/\bhelp\b/.test(text)) name = "help";
  else name = "hello";

  try {
    await runCommand(name, {
      guild: message.guild,
      channel: message.channel,
      reply: (content) => respond(message, content),
    });
  } catch (err) {
    console.error("Failed to reply to mention:", err);
  }
});

client.on("error", (err) => {
  console.error("Discord client error:", err);
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Discord login failed:", err);
  process.exit(1);
});
