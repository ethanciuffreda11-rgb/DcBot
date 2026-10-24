require("dotenv").config();

const crypto = require("crypto");
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
const STATUS_TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS || 90000);

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

/** requestId -> pending Discord status ask */
const pendingStatusAsks = new Map();

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

function expireOldStatusAsks() {
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
}

setInterval(expireOldStatusAsks, 15000).unref?.();

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "dcbot-vote-relay",
    discordReady: client.isReady(),
    guilds: client.guilds.cache.size,
    pendingStatusAsks: pendingStatusAsks.size,
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

/** Roblox polls this endpoint. When Discord ran @bot status, it returns question "Status?". */
function handleAskStatus(req, res) {
  if (!checkApiKey(req)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  expireOldStatusAsks();

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

/** Roblox answers a Status? ask from /ask-status. */
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

app.get("/ask-status", handleAskStatus);
app.post("/status-reply", handleStatusReply);
// Aliases
app.get("/roblox/ask-status", handleAskStatus);
app.post("/roblox/status", handleStatusReply);

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

    if (/\bstatus\b/.test(text)) {
      const reply = await message.reply("Asking Roblox for status…");
      const id = crypto.randomUUID();
      pendingStatusAsks.set(id, {
        id,
        channelId: message.channel.id,
        replyMessageId: reply.id,
        createdAt: Date.now(),
        claimed: false,
      });
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
