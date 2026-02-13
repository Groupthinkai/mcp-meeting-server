#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RECALL_TOKEN = process.env.RECALL_TOKEN || process.env.RECALLAI_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

if (!RECALL_TOKEN) {
  console.error("RECALL_TOKEN environment variable required");
  process.exit(1);
}
if (!OPENAI_KEY) {
  console.error("OPENAI_KEY environment variable required");
  process.exit(1);
}

// Track active bots and transcript cursors
const activeBots = new Map(); // botId -> { name, meetingUrl, lastTranscriptTs }

const server = new McpServer({
  name: "groupthink-meeting",
  version: "0.1.0",
});

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

    const res = await fetch("https://api.recall.ai/api/v1/bot/", {
      method: "POST",
      headers: {
        Authorization: `Token ${RECALL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bot_name,
        meeting_url: url,
        transcription_options: { provider: "deepgram" },
        real_time_transcription: {
          destination_url: "https://groupthink-elle.ngrok.app/webhooks/v1/recall/transcription",
          partial_results: false,
        },
        chat: {
          on_bot_join: {
            send_to: "everyone",
            message: `👋 ${bot_name} has joined the meeting.`,
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text", text: `Failed to create bot: ${res.status} ${body}` }] };
    }

    const data = await res.json();
    const botId = data.id;

    activeBots.set(botId, {
      name: bot_name,
      meetingUrl: url,
      lastTranscriptTs: null,
      transcriptBuffer: [],
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

    const res = await fetch(`https://api.recall.ai/api/v1/bot/${bot_id}/transcript/`, {
      headers: { Authorization: `Token ${RECALL_TOKEN}` },
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text", text: `Failed to get transcript: ${res.status} ${body}` }] };
    }

    const transcript = await res.json();

    // Filter to new entries since last check
    const lastTs = bot.lastTranscriptTs;
    let newEntries = transcript;

    if (lastTs !== null) {
      newEntries = transcript.filter((entry) => {
        // Each entry has words with start/end timestamps
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
    // 1. Generate TTS audio
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: voice,
        speed: 1.0,
      }),
    });

    if (!ttsRes.ok) {
      return { content: [{ type: "text", text: `TTS failed: ${ttsRes.status}` }] };
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    const b64Audio = Buffer.from(audioBuffer).toString("base64");

    // 2. Push audio to Recall bot
    const pushRes = await fetch(`https://api.recall.ai/api/v1/bot/${bot_id}/output_audio/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${RECALL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "mp3",
        b64_data: b64Audio,
      }),
    });

    if (!pushRes.ok) {
      const body = await pushRes.text();
      return { content: [{ type: "text", text: `Failed to push audio: ${pushRes.status} ${body}` }] };
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
    const res = await fetch(`https://api.recall.ai/api/v1/bot/${bot_id}/send_chat_message/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${RECALL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text", text: `Failed to send chat: ${res.status} ${body}` }] };
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
    const res = await fetch(`https://api.recall.ai/api/v1/bot/${bot_id}/leave_call/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${RECALL_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    activeBots.delete(bot_id);

    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text", text: `Failed to leave: ${res.status} ${body}` }] };
    }

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
    const res = await fetch(`https://api.recall.ai/api/v1/bot/${bot_id}/`, {
      headers: { Authorization: `Token ${RECALL_TOKEN}` },
    });

    if (!res.ok) {
      return { content: [{ type: "text", text: `Failed to check status: ${res.status}` }] };
    }

    const data = await res.json();
    const statuses = data.status_changes || [];
    const latest = statuses[statuses.length - 1];

    return {
      content: [
        {
          type: "text",
          text: `Bot "${data.bot_name}" — Status: ${latest?.code || "unknown"}\n` +
            `Meeting: ${data.meeting_url}\n` +
            `Created: ${data.created_at}`,
        },
      ],
    };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
