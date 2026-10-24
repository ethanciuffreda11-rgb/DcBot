--[[
  Put this in a Script under ServerScriptService.
  Polls the new /ask-status endpoint. When Discord says @bot status,
  the bot answers with question "Status?" — then you POST the info back.

  Enable: Game Settings → Security → Allow HTTP Requests
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local BASE_URL = "https://dcbot-1-eqk4.onrender.com"
local API_KEY = "3d780c45f8700ae15af4d329c9b031b04c70b1b9ce6d7ea6b2839ff5ee01481b"
local POLL_SECONDS = 5

local function buildStatusInfo()
	-- Customize this for Jurassic TD
	local lines = {
		"Players: " .. #Players:GetPlayers(),
		-- "Round: " .. tostring(currentRound),
		-- "Wave: " .. tostring(currentWave),
		-- "Map: " .. tostring(currentMap),
	}
	return table.concat(lines, "\n")
end

local function request(method, path, bodyTable)
	local ok, response = pcall(function()
		local opts = {
			Url = BASE_URL .. path,
			Method = method,
			Headers = {
				["Content-Type"] = "application/json",
				["x-api-key"] = API_KEY,
			},
		}
		if bodyTable then
			opts.Body = HttpService:JSONEncode(bodyTable)
		end
		return HttpService:RequestAsync(opts)
	end)

	if not ok then
		warn("[StatusPoller] request failed:", response)
		return nil
	end
	if response.StatusCode < 200 or response.StatusCode >= 300 then
		warn("[StatusPoller] bad status:", response.StatusCode, response.Body)
		return nil
	end

	local decodedOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	return decodedOk and decoded or nil
end

while true do
	-- New endpoint: Discord asks "Status?" here
	local pending = request("GET", "/ask-status")
	if pending and pending.ask == true and pending.requestId then
		print("[StatusPoller] Bot asked:", pending.question)
		request("POST", "/status-reply", {
			requestId = pending.requestId,
			status = buildStatusInfo(),
		})
	end
	task.wait(POLL_SECONDS)
end
