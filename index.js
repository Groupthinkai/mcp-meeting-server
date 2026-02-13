#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Auth: either direct keys (self-hosted) or Groupthink API token (hosted)
const GROUPTHINK_TOKEN = process.env.GROUPTHINK_TOKEN;
const GROUPTHINK_API = process.env.GROUPTHINK_API || "https://app.groupthink.com";

// Direct mode (self-hosted, no Groupthink account needed)
const RECALL_TOKEN = process.env.RECALL_TOKEN || process.env.RECALLAI_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

const isHostedMode = !!GROUPTHINK_TOKEN;
const isDirectMode = !isHostedMode && RECALL_TOKEN && OPENAI_KEY;

if (!isHostedMode && !isDirectMode) {
  console.error(
    "Authentication required. Either:\n" +
      "  - Set GROUPTHINK_TOKEN (recommended)\n" +
      "  - Or set both RECALL_TOKEN and OPENAI_KEY (self-hosted)\n"
  );
  process.exit(1);
}

// Track active bots and transcript cursors
const activeBots = new Map();

const server = new McpServer({
  name: "groupthink-meeting",
  version: "0.2.0",
});

// ── Timeout & error helpers ──────────────────────────────────────────────────

const RECALL_TIMEOUT = 30_000;
const TTS_TIMEOUT = 60_000;

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

function humanRecallError(status, data) {
  const detail = data?.detail || data?.error || JSON.stringify(data);
  switch (status) {
    case 401: return `Authentication failed — check your Recall token or Groupthink login (${detail})`;
    case 403: return `Not authorized for this bot (${detail})`;
    case 404: return `Bot not found — it may have already left the meeting (${detail})`;
    case 429: return `Rate limited — wait a moment and try again`;
    default:
      if (status >= 500) return `Recall.ai service error — try again in a few seconds (${status})`;
      return `Recall API error ${status}: ${detail}`;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function groupthinApi(method, path, body) {
  const res = await fetch(`${GROUPTHINK_API}/api/v1/mcp${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GROUPTHINK_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutSignal(RECALL_TIMEOUT),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function recallApi(method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Token ${RECALL_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: timeoutSignal(RECALL_TIMEOUT),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.recall.ai/api/v1${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function formatApiError(label, status, data) {
  return `${label}: ${humanRecallError(status, data)}`;
}

// ── join_meeting ──────────────────────────────────────────────────────────────
server.tool(
  "join_meeting",
  "Join a Google Meet, Zoom, or Teams meeting as a named participant with voice capabilities",
  {
    meeting_url: z.string().describe("Meeting URL or Google Meet code (e.g. abc-defg-hij)"),
    bot_name: z.string().default("Agent").describe("Display name in the meeting"),
  },
  async ({ meeting_url, bot_name }) => {
    // Normalize Google Meet codes to full URLs
    let url = meeting_url;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url)) {
      url = `https://meet.google.com/${url}`;
    } else if (!url.startsWith("http")) {
      url = `https://meet.google.com/${url}`;
    }

    let botId;

    if (isHostedMode) {
      const { ok, status, data } = await groupthinApi("POST", "/bots", {
        meeting_url: url,
        bot_name,
      });
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to create bot", status, data) }] };
      }
      botId = data.bot_id;
    } else {
      const { ok, status, data } = await recallApi("POST", "/bot/", {
        bot_name,
        meeting_url: url,
        transcription_options: { provider: "deepgram" },
        real_time_transcription: {
          destination_url: (process.env.RECALL_WEBHOOK_URL || "https://groupthink-elle.ngrok.app/webhooks/v1/recall") + "/transcription",
          partial_results: false,
        },
        chat: {
          on_bot_join: {
            send_to: "everyone",
            message: `👋 ${bot_name} has joined the meeting.`,
          },
        },
      });
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to create bot", status, data) }] };
      }
      botId = data.id;
    }

    activeBots.set(botId, {
      name: bot_name,
      meetingUrl: url,
      lastTranscriptTs: null,
    });

    return {
      content: [
        {
          type: "text",
          text: `✅ Bot "${bot_name}" created (ID: ${botId}). It's joining the meeting now.\n\n` +
            `The host may need to admit the bot from the waiting room.\n\n` +
            `Use get_transcript(bot_id="${botId}") to listen, and speak(bot_id="${botId}", text="...") to talk.\n\n` +
            `**Suggested workflow:**\n` +
            `1. Wait ~15 seconds for the bot to be admitted\n` +
            `2. Call get_transcript to see what people are saying\n` +
            `3. Call speak when you want to say something\n` +
            `4. Call leave_meeting when done`,
        },
      ],
    };
  }
);

// ── get_transcript ────────────────────────────────────────────────────────────
server.tool(
  "get_transcript",
  "Get new transcript lines from the meeting since last check. Call periodically to listen.",
  {
    bot_id: z.string().describe("The bot ID returned from join_meeting"),
  },
  async ({ bot_id }) => {
    const bot = activeBots.get(bot_id);
    if (!bot) {
      return { content: [{ type: "text", text: `Unknown bot ID: ${bot_id}. Call join_meeting first.` }] };
    }

    let transcript;

    if (isHostedMode) {
      const { ok, status, data } = await groupthinApi("GET", `/bots/${bot_id}/transcript`);
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to get transcript", status, data) }] };
      }
      transcript = Array.isArray(data) ? data : data.transcript || [];
    } else {
      const { ok, status, data } = await recallApi("GET", `/bot/${bot_id}/transcript/`);
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to get transcript", status, data) }] };
      }
      transcript = Array.isArray(data) ? data : [];
    }

    // Filter to new entries since last check
    const lastTs = bot.lastTranscriptTs;
    let newEntries = transcript;

    if (lastTs !== null) {
      newEntries = transcript.filter((entry) => {
        const entryTime = entry.words?.[entry.words.length - 1]?.end_timestamp;
        return entryTime && entryTime > lastTs;
      });
    }

    // Update cursor
    if (transcript.length > 0) {
      const last = transcript[transcript.length - 1];
      const lastWord = last.words?.[last.words.length - 1];
      if (lastWord) {
        bot.lastTranscriptTs = lastWord.end_timestamp;
      }
    }

    if (newEntries.length === 0) {
      return { content: [{ type: "text", text: "(No new speech since last check)" }] };
    }

    // Format readable transcript
    const lines = newEntries.map((entry) => {
      const speaker = entry.speaker || "Unknown";
      const text = entry.words?.map((w) => w.text).join(" ") || "";
      return `${speaker}: ${text}`;
    });

    // Filter out the bot's own speech
    const filtered = lines.filter((line) => !line.startsWith(bot.name + ":"));

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: "(Only heard own echo — no new human speech)" }] };
    }

    return {
      content: [{ type: "text", text: filtered.join("\n") }],
    };
  }
);

// ── speak ─────────────────────────────────────────────────────────────────────
server.tool(
  "speak",
  "Say something in the meeting via text-to-speech. Keep it concise — you're speaking out loud.",
  {
    bot_id: z.string().describe("The bot ID returned from join_meeting"),
    text: z.string().describe("What to say (1-3 sentences max — you're speaking, not writing)"),
    voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).default("nova").describe("TTS voice"),
  },
  async ({ bot_id, text, voice }) => {
    if (isHostedMode) {
      const { ok, status, data } = await groupthinApi("POST", `/bots/${bot_id}/speak`, { text, voice });
      if (!ok) {
        // Retry once after 2s
        await sleep(2000);
        const retry = await groupthinApi("POST", `/bots/${bot_id}/speak`, { text, voice });
        if (!retry.ok) {
          return { content: [{ type: "text", text: formatApiError("Failed to speak (after retry)", retry.status, retry.data) }] };
        }
        const est = retry.data.estimated_duration || (text.length * 0.065).toFixed(1);
        return {
          content: [{ type: "text", text: `🔊 Spoke (on retry): "${text}" (est. ${est}s). Wait ${Math.ceil(parseFloat(est) + 2)}s before speaking again.` }],
        };
      }
      const est = data.estimated_duration || (text.length * 0.065).toFixed(1);
      return {
        content: [{ type: "text", text: `🔊 Spoke: "${text}" (est. ${est}s). Wait ${Math.ceil(parseFloat(est) + 2)}s before speaking again.` }],
      };
    }

    // Direct mode: TTS + push audio (with retry)
    async function ttsAndPush() {
      const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "tts-1", input: text, voice, speed: 1.0 }),
        signal: timeoutSignal(TTS_TIMEOUT),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text().catch(() => "");
        throw new Error(`TTS failed: ${ttsRes.status} ${errText}`);
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      const b64Audio = Buffer.from(audioBuffer).toString("base64");

      const pushRes = await recallApi("POST", `/bot/${bot_id}/output_audio/`, {
        kind: "mp3",
        b64_data: b64Audio,
      });

      if (!pushRes.ok) {
        throw new Error(`Failed to push audio: ${humanRecallError(pushRes.status, pushRes.data)}`);
      }
    }

    try {
      await ttsAndPush();
    } catch (firstErr) {
      // Retry once after 2s
      await sleep(2000);
      try {
        await ttsAndPush();
      } catch (retryErr) {
        return { content: [{ type: "text", text: `Failed to speak (after retry): ${retryErr.message}` }] };
      }
      const estimatedDuration = (text.length * 0.065).toFixed(1);
      return {
        content: [{ type: "text", text: `🔊 Spoke (on retry): "${text}" (est. ${estimatedDuration}s). Wait at least ${Math.ceil(parseFloat(estimatedDuration) + 2)}s before speaking again.` }],
      };
    }

    const estimatedDuration = (text.length * 0.065).toFixed(1);
    return {
      content: [
        {
          type: "text",
          text: `🔊 Spoke: "${text}" (est. ${estimatedDuration}s). Wait at least ${Math.ceil(parseFloat(estimatedDuration) + 2)}s before speaking again to avoid overlap.`,
        },
      ],
    };
  }
);

// ── send_chat ─────────────────────────────────────────────────────────────────
server.tool(
  "send_chat",
  "Send a text message in the meeting chat (visible to all participants)",
  {
    bot_id: z.string().describe("The bot ID returned from join_meeting"),
    message: z.string().describe("Message to post in meeting chat"),
  },
  async ({ bot_id, message }) => {
    if (isHostedMode) {
      const { ok, status, data } = await groupthinApi("POST", `/bots/${bot_id}/chat`, { message });
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to send chat", status, data) }] };
      }
    } else {
      const { ok, status, data } = await recallApi("POST", `/bot/${bot_id}/send_chat_message/`, { message });
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to send chat", status, data) }] };
      }
    }

    return { content: [{ type: "text", text: `💬 Sent in meeting chat: "${message}"` }] };
  }
);

// ── leave_meeting ─────────────────────────────────────────────────────────────
server.tool(
  "leave_meeting",
  "Remove the bot from the meeting",
  {
    bot_id: z.string().describe("The bot ID returned from join_meeting"),
  },
  async ({ bot_id }) => {
    try {
      if (isHostedMode) {
        await groupthinApi("POST", `/bots/${bot_id}/leave`);
      } else {
        await recallApi("POST", `/bot/${bot_id}/leave_call/`);
      }
    } catch (err) {
      // Best-effort — bot may already be gone
    }

    activeBots.delete(bot_id);
    return { content: [{ type: "text", text: `👋 Bot left the meeting.` }] };
  }
);

// ── bot_status ────────────────────────────────────────────────────────────────
server.tool(
  "bot_status",
  "Check if the bot has been admitted to the meeting and is active",
  {
    bot_id: z.string().describe("The bot ID returned from join_meeting"),
  },
  async ({ bot_id }) => {
    if (isHostedMode) {
      const { ok, status, data } = await groupthinApi("GET", `/bots/${bot_id}/status`);
      if (!ok) {
        return { content: [{ type: "text", text: formatApiError("Failed to check status", status, data) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Bot "${data.bot_name}" — Status: ${data.status}\nMeeting: ${data.meeting_url}\nCreated: ${data.created_at}`,
          },
        ],
      };
    }

    const { ok, status, data } = await recallApi("GET", `/bot/${bot_id}/`);
    if (!ok) {
      return { content: [{ type: "text", text: formatApiError("Failed to check status", status, data) }] };
    }

    const statuses = data.status_changes || [];
    const latest = statuses[statuses.length - 1];

    return {
      content: [
        {
          type: "text",
          text: `Bot "${data.bot_name}" — Status: ${latest?.code || "unknown"}\nMeeting: ${typeof data.meeting_url === 'string' ? data.meeting_url : JSON.stringify(data.meeting_url)}\nCreated: ${data.created_at}`,
        },
      ],
    };
  }
);

// ── check_connection ──────────────────────────────────────────────────────────
server.tool(
  "check_connection",
  "Verify that API credentials are valid without creating a bot. Use for setup verification.",
  {},
  async () => {
    const results = [];

    if (isHostedMode) {
      try {
        const { ok, status } = await groupthinApi("GET", "/bots");
        results.push(ok
          ? "✅ Groupthink API: connected"
          : `❌ Groupthink API: ${humanRecallError(status, {})}`);
      } catch (err) {
        results.push(`❌ Groupthink API: ${err.message}`);
      }
    } else {
      // Check Recall
      try {
        const { ok, status } = await recallApi("GET", "/bot/?limit=1");
        results.push(ok
          ? "✅ Recall.ai API: connected"
          : `❌ Recall.ai API: ${humanRecallError(status, {})}`);
      } catch (err) {
        results.push(`❌ Recall.ai API: ${err.message}`);
      }

      // Check OpenAI — lightweight models list call
      try {
        const res = await fetch("https://api.openai.com/v1/models?limit=1", {
          headers: { Authorization: `Bearer ${OPENAI_KEY}` },
          signal: timeoutSignal(RECALL_TIMEOUT),
        });
        results.push(res.ok
          ? "✅ OpenAI API: connected"
          : `❌ OpenAI API: ${res.status} — check your OPENAI_KEY`);
      } catch (err) {
        results.push(`❌ OpenAI API: ${err.message}`);
      }
    }

    results.push(`\nMode: ${isHostedMode ? "Groupthink hosted" : "Direct (self-hosted)"}`);
    results.push(`Active bots: ${activeBots.size}`);

    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

// ── Graceful shutdown: clean up active bots ──────────────────────────────────
async function gracefulShutdown() {
  if (activeBots.size === 0) process.exit(0);

  console.error(`Shutting down — removing ${activeBots.size} active bot(s) from meetings...`);

  const leavePromises = [...activeBots.keys()].map(async (botId) => {
    try {
      if (isHostedMode) {
        await groupthinApi("POST", `/bots/${botId}/leave`);
      } else {
        await recallApi("POST", `/bot/${botId}/leave_call/`);
      }
    } catch {
      // Best-effort cleanup
    }
  });

  await Promise.allSettled(leavePromises);
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
