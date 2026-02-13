# Groupthink Meeting MCP Server

Give any AI coding agent a seat at your meeting.

Connect your Claude Code session to a live Google Meet, Zoom, or Teams call. The agent joins as a named participant who can listen, speak, and post in chat — with full context from whatever it's been working on.

## Install (2 minutes)

```bash
git clone https://github.com/groupthinkai/mcp-meeting-server.git
cd mcp-meeting-server
npm install
node setup.js
```

The setup script will ask you to log in with your **Groupthink account** — that's it. No other API keys needed.

> **Don't have a Groupthink account?** Sign up at [groupthink.com](https://groupthink.com). There's also a self-hosted option if you want to bring your own Recall.ai + OpenAI keys.

### Verify

Open (or restart) a Claude Code session and run:

```
/mcp
```

You should see `groupthink-meeting` with a green checkmark. ✅

## Usage

In any Claude Code session, say:

> "Join my meeting at https://meet.google.com/abc-defg-hij as 'My Agent'"

Then:
1. **Admit the bot** when it appears in the meeting waiting room
2. **Tell Claude what to do**: "Listen and jump in when they discuss the API migration"
3. The agent calls `get_transcript` to hear people, and `speak` to respond out loud

The agent has full context from your coding session — it knows what files you're editing, what bugs you're fixing, what you've been discussing. That context goes straight into the meeting.

### Examples

**Join and participate:**
```
"Join our standup at meet.google.com/xyz-abcd-efg as 'Code Assistant'
 and help discuss what we've been working on"
```

**Listen only:**
```
"Join the meeting silently and take notes. Don't speak unless directly asked."
```

**Multiple agents from different sessions:**
- Terminal 1 (API repo): "Join as 'API Agent'"
- Terminal 2 (Frontend repo): "Join as 'Frontend Agent'"
- Terminal 3 (Cooking repo): "Join as 'Chef'"

Each brings its own project context. Each has a separate voice and identity in the meeting.

## Tools

| Tool | What it does |
|------|-------------|
| `join_meeting` | Create a bot and join a meeting |
| `get_transcript` | Get new speech since last check |
| `speak` | Say something out loud via text-to-speech |
| `send_chat` | Post a message in the meeting chat |
| `bot_status` | Check if the bot has been admitted |
| `leave_meeting` | Remove the bot from the meeting |

### Voices

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
                                           ┌───────▼────────┐
                                           │  Groupthink    │
                                           │  API           │
                                           └───────┬────────┘
                                                   │
                                    ┌──────────────┼──────────────┐
                                    │              │              │
                              ┌─────▼─────┐  ┌────▼────┐  ┌─────▼─────┐
                              │ Recall.ai │  │ OpenAI  │  │  Meeting  │
                              │ Bots      │  │ TTS     │  │ Platform  │
                              └───────────┘  └─────────┘  └───────────┘
```

**Claude Code** is the brain — it decides when to listen and what to say, using its full session context.

**This MCP server** translates tool calls into Groupthink API requests.

**Groupthink** handles bot management, voice synthesis, and billing.

## Pricing

Included with your Groupthink plan. See [groupthink.com/pricing](https://groupthink.com/pricing) for details.

## Supported Platforms

### Meeting Platforms
| Platform | Status |
|----------|--------|
| Google Meet | ✅ Supported |
| Zoom | ✅ Supported |
| Microsoft Teams | ✅ Supported |

### AI Coding Assistants
Works with any tool that supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io):

| Client | Type | MCP Support |
|--------|------|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | CLI agent | ✅ Built-in (`/mcp add`) |
| [OpenClaw](https://openclaw.ai) | Autonomous agent | ✅ Built-in |
| [Codex CLI](https://github.com/openai/codex) | CLI agent | ✅ Via config |
| [Cursor](https://cursor.com) | IDE | ✅ Built-in |
| [Windsurf](https://codeium.com/windsurf) | IDE | ✅ Built-in |
| [Cline](https://github.com/cline/cline) | VS Code extension | ✅ Built-in |
| [Continue](https://continue.dev) | IDE extension | ✅ Built-in |
| [Zed](https://zed.dev) | Editor | ✅ Built-in |
| [Sourcegraph Amp](https://sourcegraph.com) | Code AI | ✅ Built-in |
| [GitHub Copilot](https://github.com/features/copilot) | IDE extension | ✅ Via MCP registry |

> **Any MCP-compatible client works.** If your tool supports MCP stdio servers, it can join meetings. See the [MCP clients list](https://modelcontextprotocol.io/clients) for the full ecosystem.

## Self-Hosted Mode

If you want to use your own API keys instead of a Groupthink account, select option 2 during `node setup.js`. You'll need:

- [Recall.ai](https://recall.ai) API token (~$0.50/hr per bot)
- [OpenAI](https://platform.openai.com/api-keys) API key (~$0.015/1K chars for TTS)

## Troubleshooting

**Bot stuck in waiting room** — The meeting host needs to click "Admit." Use `bot_status` to check.

**Bot joins but doesn't speak** — Tell Claude explicitly: "Listen to the meeting and respond when people ask about our project."

**Transcript is empty** — Bot needs to be admitted and recording. Check `bot_status` for `in_call_recording`.

**`/mcp` doesn't show groupthink-meeting** — Restart your Claude Code session. Config is read on startup.

## License

MIT
