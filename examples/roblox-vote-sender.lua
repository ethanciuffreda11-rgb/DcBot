--[[
  Call this from Roblox Studio when a vote ends.
  Replace WEBHOOK_URL and API_KEY with your Render URL and key.
]]

local HttpService = game:GetService("HttpService")

local WEBHOOK_URL = "https://YOUR-SERVICE.onrender.com/vote-ended"
local API_KEY = "3d780c45f8700ae15af4d329c9b031b04c70b1b9ce6d7ea6b2839ff5ee01481b"

local function announceVoteEnded(winningVoteName)
	local body = HttpService:JSONEncode({
		winningVote = winningVoteName,
		-- Or send a full sentence:
		-- message = string.format('Vote Ended wining vote is.. "%s"!', winningVoteName),
	})

	local success, response = pcall(function()
		return HttpService:RequestAsync({
			Url = WEBHOOK_URL,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["x-api-key"] = API_KEY,
			},
			Body = body,
		})
	end)

	if not success then
		warn("[VoteRelay] Request failed:", response)
		return false
	end

	if response.StatusCode < 200 or response.StatusCode >= 300 then
		warn("[VoteRelay] Bad status:", response.StatusCode, response.Body)
		return false
	end

	print("[VoteRelay] Discord notified:", response.Body)
	return true
end

-- Example:
-- announceVoteEnded("Pizza Party")

return announceVoteEnded
