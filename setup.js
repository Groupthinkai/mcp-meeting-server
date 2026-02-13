#!/usr/bin/env node

/**
 * Interactive setup for Groupthink Meeting MCP Server.
 * Authenticates to Groupthink and writes MCP config to ~/.claude.json.
 *
 * Usage: node setup.js
 */

import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
const askHidden = (q) =>
  new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    const onData = (ch) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "\u0003") {
        process.exit();
      } else if (c === "\u007f" || c === "\b") {
        input = input.slice(0, -1);
      } else {
        input += c;
      }
    };
    stdin.on("data", onData);
  });

const GROUPTHINK_API = process.env.GROUPTHINK_API || "https://app.groupthink.com";

async function main() {
  console.log("");
  console.log("🎙️  Groupthink Meeting MCP Server — Setup");
  console.log("==========================================");
  console.log("");

  const mode = await ask("Setup mode:\n  1. Groupthink account (recommended)\n  2. Self-hosted (bring your own keys)\n\nChoice (1/2): ");

  if (mode.trim() === "2") {
    await selfHostedSetup();
  } else {
    await groupthinkSetup();
  }

  rl.close();
}

async function groupthinkSetup() {
  console.log("");
  console.log("Log in with your Groupthink account.");
  console.log("");

  const hasAccount = await ask("Do you have a Groupthink account? (Y/n): ");
  if (hasAccount.trim().toLowerCase() === "n") {
    console.log("");
    console.log("┌─────────────────────────────────────────────────────────┐");
    console.log("│                                                         │");
    console.log("│  Create your free account at:                           │");
    console.log("│                                                         │");
    console.log("│    👉  https://app.groupthink.com/register              │");
    console.log("│                                                         │");
    console.log("│  Once you've signed up, run this setup again:           │");
    console.log("│                                                         │");
    console.log("│    node setup.js                                        │");
    console.log("│                                                         │");
    console.log("└─────────────────────────────────────────────────────────┘");
    console.log("");
    rl.close();
    return;
  }

  console.log("");
  const email = await ask("Email: ");
  const password = await askHidden("Password: ");

  console.log("");
  console.log("🔍 Authenticating...");

  // Get Sanctum token via login
  let token;
  try {
    const res = await fetch(`${GROUPTHINK_API}/api/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        password: password.trim(),
        device_name: "mcp-meeting-server",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 422) {
        console.log("❌ Invalid email or password.");
        console.log("");
        console.log("   Forgot your password?  https://app.groupthink.com/forgot-password");
        console.log("   Need an account?       https://app.groupthink.com/register");
      } else {
        console.log(`❌ Authentication failed: ${res.status} ${body}`);
      }
      process.exit(1);
    }

    const data = await res.json();
    token = data.token || data.plainTextToken || data;
    if (typeof token !== "string") {
      // Some Laravel Sanctum setups return the token differently
      token = data.data?.token || data.data?.plainTextToken || JSON.stringify(data);
    }
    console.log("   ✅ Authenticated!");
  } catch (e) {
    console.log(`❌ Network error: ${e.message}`);
    console.log("");
    console.log("If you can't reach the Groupthink API, use self-hosted mode (option 2).");
    process.exit(1);
  }

  writeConfig({
    GROUPTHINK_TOKEN: token.trim(),
    GROUPTHINK_API,
  });
}

async function selfHostedSetup() {
  console.log("");
  console.log("Self-hosted mode: you provide your own API keys.");
  console.log("");
  console.log("You'll need:");
  console.log("  1. Recall.ai token  → https://recall.ai");
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

  // Verify keys
  console.log("");
  console.log("🔍 Verifying Recall.ai token...");
  try {
    const res = await fetch("https://api.recall.ai/api/v1/bot/", {
      headers: { Authorization: `Token ${recallToken.trim()}` },
    });
    if (res.status === 401) {
      console.log("❌ Invalid Recall.ai token.");
      process.exit(1);
    }
    console.log("   ✅ Valid");
  } catch (e) {
    console.log("   ⚠️  Couldn't verify — continuing");
  }

  console.log("🔍 Verifying OpenAI key...");
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${openaiKey.trim()}` },
    });
    if (res.status === 401) {
      console.log("❌ Invalid OpenAI key.");
      process.exit(1);
    }
    console.log("   ✅ Valid");
  } catch (e) {
    console.log("   ⚠️  Couldn't verify — continuing");
  }

  writeConfig({
    RECALL_TOKEN: recallToken.trim(),
    OPENAI_KEY: openaiKey.trim(),
  });
}

function writeConfig(env) {
  const serverPath = join(__dirname, "index.js");
  const claudeConfigPath = join(homedir(), ".claude.json");
  let config = {};

  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
      console.log(`\n📄 Found existing config: ${claudeConfigPath}`);
    } catch (e) {
      console.log(`⚠️  Couldn't parse ${claudeConfigPath}`);
      process.exit(1);
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers["groupthink-meeting"]) {
    const overwrite = "y"; // Auto-overwrite in non-interactive, TODO: ask
    // Could prompt here but keeping it simple
  }

  config.mcpServers["groupthink-meeting"] = {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env,
  };

  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));

  console.log("");
  console.log("✅ Done! Groupthink Meeting server added to Claude Code.");
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  Next steps:                                            │");
  console.log("│                                                         │");
  console.log("│  1. Open (or restart) a Claude Code session             │");
  console.log("│  2. Run /mcp to verify 'groupthink-meeting' is listed   │");
  console.log("│  3. Say: \"Join my meeting at <url> as 'My Agent'\"      │");
  console.log("│  4. Admit the bot when it appears in the waiting room   │");
  console.log("│  5. Tell Claude to listen and respond when relevant     │");
  console.log("│                                                         │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
