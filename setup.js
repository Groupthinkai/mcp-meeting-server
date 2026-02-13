#!/usr/bin/env node

/**
 * Interactive setup script for Groupthink Meeting MCP Server.
 * Writes the MCP config to ~/.claude.json so it's available in all Claude Code sessions.
 *
 * Usage: node setup.js
 */

import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log("");
  console.log("🎙️  Groupthink Meeting MCP Server — Setup");
  console.log("==========================================");
  console.log("");
  console.log("This will configure Claude Code to use the Groupthink Meeting server.");
  console.log("You'll need two API keys:");
  console.log("");
  console.log("  1. Recall.ai token  → https://recall.ai (sign up → API token)");
  console.log("  2. OpenAI API key   → https://platform.openai.com/api-keys");
  console.log("");

  const recallToken = await ask("Recall.ai API token: ");
  if (!recallToken.trim()) {
    console.log("❌ Recall token is required.");
    process.exit(1);
  }

  const openaiKey = await ask("OpenAI API key: ");
  if (!openaiKey.trim()) {
    console.log("❌ OpenAI key is required.");
    process.exit(1);
  }

  // Verify keys work
  console.log("");
  console.log("🔍 Verifying Recall.ai token...");
  try {
    const res = await fetch("https://api.recall.ai/api/v1/bot/", {
      headers: { Authorization: `Token ${recallToken.trim()}` },
    });
    if (res.status === 401) {
      console.log("❌ Invalid Recall.ai token. Check your token and try again.");
      process.exit(1);
    }
    console.log("   ✅ Recall.ai token is valid");
  } catch (e) {
    console.log("   ⚠️  Couldn't verify (network issue?) — continuing anyway");
  }

  console.log("🔍 Verifying OpenAI key...");
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${openaiKey.trim()}` },
    });
    if (res.status === 401) {
      console.log("❌ Invalid OpenAI key. Check your key and try again.");
      process.exit(1);
    }
    console.log("   ✅ OpenAI key is valid");
  } catch (e) {
    console.log("   ⚠️  Couldn't verify (network issue?) — continuing anyway");
  }

  // Find the index.js path
  const serverPath = join(__dirname, "index.js");

  // Read or create ~/.claude.json
  const claudeConfigPath = join(homedir(), ".claude.json");
  let config = {};

  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
      console.log("");
      console.log(`📄 Found existing config: ${claudeConfigPath}`);
    } catch (e) {
      console.log(`⚠️  Couldn't parse ${claudeConfigPath} — will add to it carefully`);
      config = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
    }
  }

  // Add MCP server config
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const existing = config.mcpServers["groupthink-meeting"];
  if (existing) {
    const overwrite = await ask("⚠️  groupthink-meeting already configured. Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Skipped. Your existing config is unchanged.");
      rl.close();
      return;
    }
  }

  config.mcpServers["groupthink-meeting"] = {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env: {
      RECALL_TOKEN: recallToken.trim(),
      OPENAI_KEY: openaiKey.trim(),
    },
  };

  // Write config
  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));

  console.log("");
  console.log("✅ Done! Groupthink Meeting server added to Claude Code.");
  console.log("");
  console.log("┌────────────────────────────────────────────────────────┐");
  console.log("│  Next steps:                                           │");
  console.log("│                                                        │");
  console.log("│  1. Open (or restart) a Claude Code session            │");
  console.log("│  2. Run /mcp to verify 'groupthink-meeting' is listed  │");
  console.log("│  3. Say: \"Join my meeting at <meeting-url> as 'Agent'\" │");
  console.log("│  4. Admit the bot when it appears in the waiting room  │");
  console.log("│  5. Tell Claude to listen and respond when relevant    │");
  console.log("│                                                        │");
  console.log("└────────────────────────────────────────────────────────┘");
  console.log("");

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
