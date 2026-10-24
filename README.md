# Discord Vote Relay Bot

Receives vote results from Roblox Studio and posts them to every Discord server the bot is in.

**Discord message:**
> The Vote has Ended and the people want "Winning vote name"!

## Setup

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Open **Bot** → **Reset Token** → copy the token
3. Privileged intents can stay off (mentions still work without Message Content Intent)
4. **OAuth2 → URL Generator**: scopes `bot`, permission **Send Messages**
5. Open the invite URL and add the bot to your server(s)

### 2. Deploy on Render

1. Push this repo to GitHub
2. On [Render](https://render.com): **New → Web Service** → connect the repo
3. Settings:
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `npm start`
4. Environment variables:

| Variable | Value |
|----------|--------|
| `DISCORD_TOKEN` | Your Discord bot token |
| `API_KEY` | `3d780c45f8700ae15af4d329c9b031b04c70b1b9ce6d7ea6b2839ff5ee01481b` |
| `VOTE_CHANNEL_NAME` | Optional, e.g. `announcements` |
| `VOTE_CHANNEL_ID` | Optional, preferred channel ID |

Or use the included `render.yaml` Blueprint.

Copy the service URL, e.g. `https://dcbot-vote-relay.onrender.com`.

### 3. Call from Roblox

Enable **HttpService** in Studio (Game Settings → Security → Allow HTTP Requests).

```lua
local HttpService = game:GetService("HttpService")

HttpService:RequestAsync({
	Url = "https://YOUR-SERVICE.onrender.com/vote-ended",
	Method = "POST",
	Headers = {
		["Content-Type"] = "application/json",
		["x-api-key"] = "3d780c45f8700ae15af4d329c9b031b04c70b1b9ce6d7ea6b2839ff5ee01481b",
	},
	Body = HttpService:JSONEncode({
		winningVote = "Pizza Party",
	}),
})
```

See `examples/roblox-vote-sender.lua` for a reusable module.

### Discord commands

| Message | What happens |
|---------|----------------|
| `@VoteBot` | Hello reply |
| `@VoteBot here` | Sets this channel for status/vote posts |
| `@VoteBot status` | Asks Roblox `Status?`; game must be polling |

Roblox status poller: `examples/roblox-status-poller.lua`

## API

### `GET /ask-status` (new)

Roblox polls this. After someone runs `@VoteBot status` in Discord:

```json
{ "ok": true, "ask": true, "question": "Status?", "requestId": "..." }
```

If nothing is pending:

```json
{ "ok": true, "ask": false, "question": null, "requestId": null }
```

### `POST /status-reply`

Roblox answers the ask:

```json
{ "requestId": "...", "status": "Players: 5\nRound: 3" }
```

### `POST /vote-ended`

**Auth:** header `x-api-key: <API_KEY>` (or `Authorization: Bearer <API_KEY>`)

**JSON body (recommended):**
```json
{ "winningVote": "Pizza Party" }
```

**Also accepted:**
```json
{ "message": "Vote Ended wining vote is.. \"Pizza Party\"!" }
```

**Plain text body:**
```
Vote Ended wining vote is.. "Pizza Party"!
```

**Success response:**
```json
{
  "ok": true,
  "winningVote": "Pizza Party",
  "message": "The Vote has Ended and the people want \"Pizza Party\"!",
  "results": [{ "guild": "My Server", "ok": true, "channel": "announcements" }]
}
```

### `GET /health`

Used by Render health checks.

## Local run

```bash
cp .env.example .env
# edit .env with DISCORD_TOKEN and API_KEY
npm install
npm start
```

## Notes

- Free Render services sleep after idle time; the first Roblox request may take ~30–60s while it wakes up.
- Without `VOTE_CHANNEL_ID` / `VOTE_CHANNEL_NAME`, the bot uses the server system channel, or the first text channel it can post in.
- Keep `API_KEY` secret; anyone with it can trigger announcements.
