// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { commandExists } = require("./runner");

const CREDS_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");
const KEYCHAIN_ACCOUNT = "nemoclaw";

function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function backendOverride() {
  return (process.env.NEMOCLAW_CREDENTIAL_BACKEND || "").trim().toLowerCase();
}

function hasMacosKeychain() {
  return process.platform === "darwin" && commandExists("security");
}

function hasLibsecret() {
  return process.platform === "linux" && commandExists("secret-tool");
}

function resolveCredentialBackend() {
  const override = backendOverride();
  if (override) {
    switch (override) {
      case "macos-keychain":
      case "keychain":
        return "macos-keychain";
      case "libsecret":
      case "secret-tool":
        return "secret-tool";
      case "file":
        return "file";
      case "env":
      case "ephemeral":
        return "ephemeral";
      default:
        throw new Error(`Unsupported credential backend override: ${override}`);
    }
  }

  if (hasMacosKeychain()) return "macos-keychain";
  if (hasLibsecret()) return "secret-tool";
  if (process.env.NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS === "1") return "file";
  return "ephemeral";
}

function describeCredentialBackend(backend = resolveCredentialBackend()) {
  switch (backend) {
    case "macos-keychain":
      return "macOS Keychain";
    case "secret-tool":
      return "libsecret keyring";
    case "file":
      return "~/.nemoclaw/credentials.json";
    default:
      return "process environment only";
  }
}

function runCredentialCommand(command, args, opts = {}) {
  return spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

function credentialServiceName(key) {
  return `com.nvidia.nemoclaw.${key}`;
}

function getMacosKeychainCredential(key) {
  const result = runCredentialCommand("security", [
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    credentialServiceName(key),
    "-w",
  ]);
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

function saveMacosKeychainCredential(key, value) {
  const result = runCredentialCommand("security", [
    "add-generic-password",
    "-U",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    credentialServiceName(key),
    "-w",
    value,
  ]);
  if (result.status !== 0) {
    throw new Error((result.stderr || "").trim() || "failed to write macOS Keychain item");
  }
}

function getLibsecretCredential(key) {
  const result = runCredentialCommand("secret-tool", [
    "lookup",
    "service",
    "nemoclaw",
    "key",
    key,
  ]);
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

function saveLibsecretCredential(key, value) {
  const result = runCredentialCommand(
    "secret-tool",
    ["store", "--label", `NemoClaw ${key}`, "service", "nemoclaw", "key", key],
    { input: `${value}\n` },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "").trim() || "failed to write libsecret credential");
  }
}

function saveFileCredential(key, value) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const creds = loadCredentials();
  creds[key] = value;
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function migrateLegacyFileIfPossible() {
  const backend = resolveCredentialBackend();
  if (backend === "file" || backend === "ephemeral" || !fs.existsSync(CREDS_FILE)) {
    return;
  }

  const creds = loadCredentials();
  const entries = Object.entries(creds).filter(([, value]) => typeof value === "string" && value);
  if (entries.length === 0) {
    fs.rmSync(CREDS_FILE, { force: true });
    return;
  }

  try {
    for (const [key, value] of entries) {
      saveCredential(key, value);
    }
    fs.rmSync(CREDS_FILE, { force: true });
  } catch {
    // Leave the legacy file untouched if migration fails.
  }
}

function saveCredential(key, value) {
  const backend = resolveCredentialBackend();
  switch (backend) {
    case "macos-keychain":
      saveMacosKeychainCredential(key, value);
      return;
    case "secret-tool":
      saveLibsecretCredential(key, value);
      return;
    case "file":
      saveFileCredential(key, value);
      return;
    default:
      throw new Error(
        "No secure credential backend is available. Export the credential in your environment for this session or set NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS=1 for an explicit file-based fallback.",
      );
  }
}

function getCredential(key) {
  if (process.env[key]) return process.env[key];
  migrateLegacyFileIfPossible();
  const backend = resolveCredentialBackend();
  switch (backend) {
    case "macos-keychain":
      return getMacosKeychainCredential(key);
    case "secret-tool":
      return getLibsecretCredential(key);
    case "file": {
      const creds = loadCredentials();
      return creds[key] || null;
    }
    default:
      return null;
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSecret(question) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    rl.stdoutMuted = true;
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      if (!rl.stdoutMuted) {
        rl.output.write(stringToWrite);
      }
    };
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

function rememberCredential(key, value, label) {
  process.env[key] = value;
  try {
    saveCredential(key, value);
    console.log("");
    console.log(`  ${label} stored in ${describeCredentialBackend()}`);
    console.log("");
  } catch (err) {
    console.log("");
    console.log(`  ${label} loaded for this process only.`);
    console.log(`  ${String(err.message || err)}`);
    console.log("");
  }
}

function validateGithubWorkerToken(token) {
  if (!token) {
    return "Token required.";
  }
  if (token.startsWith("github_pat_") || token.startsWith("ghs_") || token.startsWith("ghu_")) {
    return null;
  }
  if (token.startsWith("ghp_")) {
    if (process.env.NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN === "1") {
      return null;
    }
    return "Classic GitHub personal access tokens are too broad for hardened operation. Use a fine-grained PAT (github_pat_) or a short-lived GitHub App token (ghs_/ghu_).";
  }
  return "Unrecognized GitHub token format. Use a fine-grained PAT (github_pat_) or a short-lived GitHub App token (ghs_/ghu_).";
}

async function ensureApiKey() {
  let key = getCredential("NVIDIA_API_KEY");
  if (key) {
    process.env.NVIDIA_API_KEY = key;
    return;
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────────────────┐");
  console.log("  │  NVIDIA API Key required                                        │");
  console.log("  │                                                                 │");
  console.log("  │  1. Go to https://build.nvidia.com/settings/api-keys            │");
  console.log("  │  2. Sign in with your NVIDIA account                            │");
  console.log("  │  3. Click 'Generate API Key' button                             │");
  console.log("  │  4. Paste the key below (starts with nvapi-)                    │");
  console.log("  └─────────────────────────────────────────────────────────────────┘");
  console.log("");

  key = await promptSecret("  NVIDIA API Key: ");

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    process.exit(1);
  }

  rememberCredential("NVIDIA_API_KEY", key, "NVIDIA API key");
}

function isRepoPrivate(repo) {
  const result = runCredentialCommand("gh", ["api", `repos/${repo}`, "--jq", ".private"]);
  return result.status === 0 && (result.stdout || "").trim() === "true";
}

async function ensureGithubToken() {
  let token = getCredential("GITHUB_TOKEN");
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  const ghToken = runCredentialCommand("gh", ["auth", "token"]);
  token = ghToken.status === 0 ? (ghToken.stdout || "").trim() : "";
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)   │");
  console.log("  │                                                  │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)    │");
  console.log("  │  Option B: Paste a PAT with read:packages scope  │");
  console.log("  └──────────────────────────────────────────────────┘");
  console.log("");

  token = await promptSecret("  GitHub Token: ");

  if (!token) {
    console.error("  Token required for deploy (repo is private).");
    process.exit(1);
  }

  rememberCredential("GITHUB_TOKEN", token, "GitHub token");
}

async function ensureGithubWorkerToken() {
  let token = getCredential("NEMOCLAW_GITHUB_WORKER_TOKEN");
  if (token) {
    const validationError = validateGithubWorkerToken(token);
    if (!validationError) {
      process.env.NEMOCLAW_GITHUB_WORKER_TOKEN = token;
      return;
    }
    console.error(`  Stored GitHub worker token rejected: ${validationError}`);
    console.error("  Remove the old credential and store a fine-grained or short-lived token.");
    process.exit(1);
  }

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────────────────┐");
  console.log("  │  GitHub worker token required                                    │");
  console.log("  │                                                                  │");
  console.log("  │  Use a fine-grained PAT or short-lived GitHub App token only.    │");
  console.log("  │  Minimum expected scope for PR work:                             │");
  console.log("  │    - Metadata: read-only                                         │");
  console.log("  │    - Contents: read and write                                    │");
  console.log("  │    - Pull requests: read and write                               │");
  console.log("  │                                                                  │");
  console.log("  │  Scope it only to the repository or repositories the worker      │");
  console.log("  │  actually needs. Do not use a broad classic PAT.                 │");
  console.log("  └──────────────────────────────────────────────────────────────────┘");
  console.log("");

  token = await promptSecret("  GitHub worker token: ");
  const validationError = validateGithubWorkerToken(token);
  if (validationError) {
    console.error(`  ${validationError}`);
    process.exit(1);
  }

  rememberCredential("NEMOCLAW_GITHUB_WORKER_TOKEN", token, "GitHub worker token");
}

module.exports = {
  CREDS_DIR,
  CREDS_FILE,
  loadCredentials,
  resolveCredentialBackend,
  describeCredentialBackend,
  saveCredential,
  getCredential,
  prompt,
  promptSecret,
  ensureApiKey,
  ensureGithubToken,
  ensureGithubWorkerToken,
  validateGithubWorkerToken,
  isRepoPrivate,
};
