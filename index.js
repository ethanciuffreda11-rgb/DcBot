require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_KEY = process.env.API_KEY;
const VOTE_CHANNEL_ID = process.env.VOTE_CHANNEL_ID || "";
const VOTE_CHANNEL_NAME = process.env.VOTE_CHANNEL_NAME || "";

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("Missing API_KEY environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

/** guildId -> channelId set by "@bot here" */
const statusChannels = new Map();

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

function checkApiKey(req) {
  const headerKey =
    req.header("x-api-key") ||
    req.header("X-API-Key") ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "");

  const queryKey = typeof req.query.key === "string" ? req.query.key : "";
  const provided = headerKey || queryKey;

  return Boolean(provided) && provided === API_KEY;
}

async function findTargetChannel(guild) {
  const rememberedId = statusChannels.get(guild.id);
  if (rememberedId) {
    const remembered = await guild.channels.fetch(rememberedId).catch(() => null);
    if (remembered && remembered.isTextBased()) return remembered;
  }

  if (VOTE_CHANNEL_ID) {
    const byId = await guild.channels.fetch(VOTE_CHANNEL_ID).catch(() => null);
    if (byId && byId.isTextBased()) return byId;
  }

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

  if (guild.systemChannel && guild.systemChannel.isTextBased()) {
    return guild.systemChannel;
  }

  const channels = await guild.channels.fetch();
  const me = guild.members.me;
  return (
    channels.find((ch) => {
      if (!ch || ch.type !== ChannelType.GuildText) return false;
      if (!me) return true;
      const perms = ch.permissionsFor(me);
      return (
        perms?.has(PermissionFlagsBits.ViewChannel) &&
        perms?.has(PermissionFlagsBits.SendMessages)
      );
    }) || null
  );
}

async function announceWinningVote(winningVote) {
  const message = `The Vote has Ended and the people want "${winningVote}"!`;
  const results = [];

  for (const [, guild] of client.guilds.cache) {
    try {
      const channel = await findTargetChannel(guild);
      if (!channel) {
        results.push({ guild: guild.name, ok: false, error: "No usable channel" });
        continue;
      }
      await channel.send(message);
      results.push({ guild: guild.name, ok: true, channel: channel.name });
    } catch (err) {
      results.push({
        guild: guild.name,
        ok: false,
        error: err.message || String(err),
      });
    }
  }

  return { message, results };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "dcbot-vote-relay",
    discordReady: client.isReady(),
    guilds: client.guilds.cache.size,
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

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`In ${client.guilds.cache.size} guild(s)`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !client.user) return;
  if (!message.mentions.users.has(client.user.id)) return;

  const text = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim()
    .toLowerCase();

  try {
    if (/\bhere\b/.test(text)) {
      if (message.guild) {
        statusChannels.set(message.guild.id, message.channel.id);
      }
      await message.reply(
        "This is the chat I will upload my Jurassic TD status to."
      );
      return;
    }

    await message.reply("Hello, I'm here for Jurassic TD.");
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
