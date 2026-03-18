#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram → NemoClaw bridge.
 *
 * Messages from Telegram are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Telegram.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN              — from @BotFather
 *   NVIDIA_API_KEY                  — for inference
 *   SANDBOX_NAME                    — sandbox name (default: nemoclaw)
 *   ALLOWED_CHAT_IDS                — comma-separated Telegram chat IDs to accept
 *   NEMOCLAW_TELEGRAM_ALLOWLIST_FILE — persistent allowlist path
 *   NEMOCLAW_TELEGRAM_ENROLLMENT_CODE — optional one-time enrollment code outside prod-secure
 *   NEMOCLAW_ALLOW_TELEGRAM_ENROLLMENT — must be 1 to allow enrollment mode
 */

const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const SECURITY_PROFILE = process.env.NEMOCLAW_SECURITY_PROFILE || "prod-secure";
const ALLOWLIST_FILE =
  process.env.NEMOCLAW_TELEGRAM_ALLOWLIST_FILE ||
  path.join(process.env.HOME || os.homedir(), ".nemoclaw", "telegram-allowlist.json");
const ENROLLMENT_CODE = process.env.NEMOCLAW_TELEGRAM_ENROLLMENT_CODE || "";
const ALLOW_ENROLLMENT = process.env.NEMOCLAW_ALLOW_TELEGRAM_ENROLLMENT === "1";
const RATE_LIMIT_WINDOW_MS = Number.parseInt(
  process.env.NEMOCLAW_TELEGRAM_RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = Number.parseInt(
  process.env.NEMOCLAW_TELEGRAM_RATE_LIMIT_MAX || "3",
  10,
);
const MAX_MESSAGE_CHARS = Number.parseInt(
  process.env.NEMOCLAW_TELEGRAM_MAX_MESSAGE_CHARS || "2000",
  10,
);

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let offset = 0;
const rateLimitState = new Map();

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function loadAllowedChats() {
  const allowed = new Set();
  if (process.env.ALLOWED_CHAT_IDS) {
    for (const chatId of process.env.ALLOWED_CHAT_IDS.split(",")) {
      const trimmed = chatId.trim();
      if (trimmed) allowed.add(trimmed);
    }
  }

  try {
    if (fs.existsSync(ALLOWLIST_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf-8"));
      for (const entry of parsed.allowedChats || []) {
        if (typeof entry === "string" && entry.trim()) {
          allowed.add(entry.trim());
        }
      }
    }
  } catch (err) {
    console.error(`Failed to read allowlist file ${ALLOWLIST_FILE}: ${err.message}`);
    process.exit(1);
  }

  return allowed;
}

function persistAllowedChats(allowedChats) {
  fs.mkdirSync(path.dirname(ALLOWLIST_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    ALLOWLIST_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        allowedChats: [...allowedChats].sort(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function sanitizeSessionId(chatId) {
  return Buffer.from(String(chatId)).toString("hex").slice(0, 24);
}

function recordAndCheckRateLimit(chatId) {
  const now = Date.now();
  const existing = rateLimitState.get(chatId) || [];
  const recent = existing.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitState.set(chatId, recent);
  return recent.length > RATE_LIMIT_MAX;
}

const ALLOWED_CHATS = loadAllowedChats();
if (SECURITY_PROFILE === "prod-secure") {
  if (ALLOWED_CHATS.size === 0) {
    console.error(
      "prod-secure Telegram mode requires a fixed allowlist through ALLOWED_CHAT_IDS or the allowlist file.",
    );
    process.exit(1);
  }
  if (ALLOW_ENROLLMENT || ENROLLMENT_CODE) {
    console.error("prod-secure Telegram mode forbids enrollment codes. Use a fixed allowlist only.");
    process.exit(1);
  }
} else if (ENROLLMENT_CODE && !ALLOW_ENROLLMENT) {
  console.error("Set NEMOCLAW_ALLOW_TELEGRAM_ENROLLMENT=1 to use Telegram enrollment mode.");
  process.exit(1);
} else if (ALLOWED_CHATS.size === 0 && !(ALLOW_ENROLLMENT && ENROLLMENT_CODE)) {
  console.error(
    "Telegram bridge requires ALLOWED_CHAT_IDS or explicit enrollment mode. Refusing to accept arbitrary chats.",
  );
  process.exit(1);
}

// ── Telegram API helpers ──────────────────────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, replyTo) {
  // Telegram max message length is 4096
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      // Retry without markdown if it fails (unbalanced formatting)
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync("openshell", ["sandbox", "ssh-config", SANDBOX], {
      encoding: "utf-8",
    });

    // Write temp ssh config
    const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tg-ssh-"));
    const confPath = path.join(confDir, "config");
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = `tg-${sanitizeSessionId(sessionId)}`;
    const cmd = [
      `export NVIDIA_API_KEY=${shellQuote(API_KEY)}`,
      `exec nemoclaw-start openclaw agent --agent main --local --session-id ${shellQuote(safeSessionId)} -m ${shellQuote(message)}`,
    ].join(" && ");

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { fs.rmSync(confDir, { recursive: true, force: true }); } catch {}

      // Extract the actual agent response — skip setup lines
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });

    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Access control
        if (!ALLOWED_CHATS.has(chatId)) {
          const enrollMatch = msg.text.match(/^\/enroll\s+(.+)$/);
          if (ALLOW_ENROLLMENT && ENROLLMENT_CODE && enrollMatch && enrollMatch[1]?.trim() === ENROLLMENT_CODE) {
            ALLOWED_CHATS.add(chatId);
            persistAllowedChats(ALLOWED_CHATS);
            console.log(`[enrolled] chat ${chatId} added to allowlist`);
            await sendMessage(chatId, "Chat enrolled for NemoClaw access.", msg.message_id);
          } else {
            console.log(`[ignored] unauthorized chat ${chatId}`);
            await sendMessage(chatId, "This chat is not authorized for NemoClaw.", msg.message_id);
          }
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        console.log(`[${chatId}] ${userName}: ${msg.text}`);

        // Handle /start
        if (msg.text === "/start") {
          await sendMessage(
            chatId,
            "🦀 *NemoClaw* — powered by Nemotron 3 Super 120B\n\n" +
              "Send me a message and I'll run it through the OpenClaw agent " +
              "inside an OpenShell sandbox.\n\n" +
              "If the agent needs external access, the TUI will prompt for approval.",
            msg.message_id,
          );
          continue;
        }

        // Handle /reset
        if (msg.text === "/reset") {
          await sendMessage(chatId, "Session reset.", msg.message_id);
          continue;
        }

        if (msg.text.length > MAX_MESSAGE_CHARS) {
          await sendMessage(
            chatId,
            `Message too large. Limit is ${String(MAX_MESSAGE_CHARS)} characters.`,
            msg.message_id,
          );
          continue;
        }

        if (recordAndCheckRateLimit(chatId)) {
          await sendMessage(
            chatId,
            "Rate limit exceeded. Wait a minute before sending more prompts.",
            msg.message_id,
          );
          continue;
        }

        // Send typing indicator
        await sendTyping(chatId);

        // Keep a typing indicator going while agent runs
        const typingInterval = setInterval(() => sendTyping(chatId), 4000);

        try {
          const response = await runAgentInSandbox(msg.text, chatId);
          clearInterval(typingInterval);
          console.log(`[${chatId}] agent: ${response.slice(0, 100)}...`);
          await sendMessage(chatId, response, msg.message_id);
        } catch (err) {
          clearInterval(typingInterval);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Continue polling
  setTimeout(poll, 100);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log(`  │  Allowed:   ${String(ALLOWED_CHATS.size).padEnd(39)}│`);
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

main();
