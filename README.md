# Groupthink Meeting MCP Server

Give any AI coding agent a seat at your meeting.

Connect your Claude Code session to a live Google Meet, Zoom, or Teams call. The agent joins as a named participant who can listen, speak, and post in chat — with full context from whatever it's been working on.

## Install (2 minutes)

### Prerequisites

- [Node.js](https://nodejs.org) 18+ (`node --version` to check)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- A [Recall.ai](https://recall.ai) API token (sign up → create app → copy token)
- An [OpenAI](https://platform.openai.com/api-keys) API key (for text-to-speech)

### Steps

```bash
# 1. Clone and install
git clone https://github.com/groupthinkai/mcp-meeting-server.git
cd mcp-meeting-server
npm install

# 2. Run setup (adds to Claude Code automatically)
node setup.js
```

The setup script will:
- Ask for your Recall.ai token and OpenAI key
- Verify both keys work
- Add the MCP server to your `~/.claude.json`

### Verify

Open a Claude Code session and run:

```
/mcp
```

You should see `groupthink-meeting` listed with a green checkmark.

## Usage

In any Claude Code session, just say:

> "Join my meeting at https://meet.google.com/abc-defg-hij as 'My Agent'"

Then:
1. **Admit the bot** when it appears in the meeting waiting room
2. **Tell Claude what to do**: "Listen and jump in when they discuss the API migration"
3. The agent will call `get_transcript` to hear people, and `speak` to respond

### Example Conversations

**Join and participate:**
```
You: "Join our standup at meet.google.com/xyz-abcd-efg as 'Code Assistant' and help
      discuss what we've been working on"
```

**Listen only:**
```
You: "Join the meeting silently and take notes. Don't speak unless asked directly."
```

**Multiple agents:**

Run from separate Claude Code sessions, each in a different project:
- Terminal 1 (API): "Join as 'API Agent'"
- Terminal 2 (Frontend): "Join as 'Frontend Agent'"

Each brings its own project context.

## Tools

| Tool | What it does |
|------|-------------|
| `join_meeting` | Create a bot and join a meeting |
| `get_transcript` | Get new speech since last check |
| `speak` | Say something out loud via text-to-speech |
| `send_chat` | Post a message in the meeting chat |
| `bot_status` | Check if the bot has been admitted |
| `leave_meeting` | Remove the bot from the meeting |

### `speak` voices

| Voice | Character |
|-------|-----------|
| `alloy` | Neutral, balanced |
| `echo` | Warm, clear |
| `fable` | Expressive, British |
| `onyx` | Deep, authoritative |
| `nova` | Friendly, natural *(default)* |
| `shimmer` | Soft, gentle |

## How It Works

```
┌─────────────────┐     MCP (stdio)      ┌──────────────────┐
│  Claude Code     │◄────────────────────►│  MCP Server      │
│  (your session)  │                      │  (this package)  │
└─────────────────┘                      └────────┬─────────┘
                                                   │
                                    ┌──────────────┼──────────────┐
                                    │              │              │
                              ┌─────▼─────┐  ┌────▼────┐  ┌─────▼─────┐
                              │ Recall.ai │  │ OpenAI  │  │  Meeting  │
                              │ Bot API   │  │ TTS API │  │ Platform  │
                              └─────┬─────┘  └─────────┘  └───────────┘
                                    │
                              ┌─────▼─────┐
                              │ Google    │
                              │ Meet /    │
                              │ Zoom /    │
                              │ Teams     │
                              └───────────┘
```

**Claude Code** is the brain — it decides when to listen and what to say, using its full session context (files, git history, conversation).

**This MCP server** translates tool calls into API requests to Recall.ai (meeting bot) and OpenAI (voice).

**Recall.ai** manages the bot's actual presence in the meeting — joining, audio, transcription.

## Cost

| Service | Cost | Notes |
|---------|------|-------|
| Recall.ai | ~$0.50/hr per bot | [Pricing](https://recall.ai/pricing) |
| OpenAI TTS | ~$0.015/1K chars | [Pricing](https://openai.com/pricing) |

A typical 1-hour meeting with moderate participation: **~$0.60**

## Supported Platforms

**Meetings:** Google Meet ✅ · Zoom ✅ · Microsoft Teams ✅

**AI Clients:** Claude Code ✅ · Cursor ✅ · Windsurf ✅ · Any MCP stdio client ✅

## Troubleshooting

**Bot stuck in waiting room** — The meeting host needs to click "Admit." Use `bot_status` to check.

**Bot joins but doesn't speak** — Claude Code won't auto-speak. Tell it explicitly: "Listen to the meeting and respond when people ask about our project."

**Transcript is empty** — The bot needs to be admitted and recording. Check `bot_status` for `in_call_recording`.

**`/mcp` doesn't show groupthink-meeting** — Restart your Claude Code session. The config is read on startup.

**Setup script can't find ~/.claude.json** — Make sure Claude Code has been run at least once (it creates the config file on first launch).

## Manual Setup (without setup script)

If you prefer to configure manually, add this to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "groupthink-meeting": {
      "type": "stdio",
      "command": "node",
      "args": ["/full/path/to/mcp-meeting-server/index.js"],
      "env": {
        "RECALL_TOKEN": "your-recall-ai-token",
        "OPENAI_KEY": "your-openai-api-key"
      }
    }
  }
}
```

## License

MIT
