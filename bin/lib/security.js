// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { CREDS_FILE, resolveCredentialBackend, describeCredentialBackend } = require("./credentials");
const { commandExists } = require("./runner");
const policies = require("./policies");

const HOME = process.env.HOME || os.homedir();
const OPENCLAW_CONFIG = path.join(HOME, ".openclaw", "openclaw.json");
const TELEGRAM_ALLOWLIST =
  process.env.NEMOCLAW_TELEGRAM_ALLOWLIST_FILE ||
  path.join(HOME, ".nemoclaw", "telegram-allowlist.json");

function normalizeOrigin(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = new URL(rawValue);
    if (!parsed.protocol || !parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function checkFileMode(filePath, expectedMask) {
  const mode = fs.statSync(filePath).mode & 0o777;
  return (mode & ~expectedMask) === 0;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function detectReadySandboxRuntime() {
  if (!commandExists("openshell")) return null;
  const result = spawnSync("openshell", ["sandbox", "list"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const output = stripAnsi(result.stdout || "");
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line === "NAME    NAMESPACE  CREATED             PHASE") continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const phase = parts[parts.length - 1];
    const name = parts[0];
    if (phase === "Ready") {
      return { name };
    }
  }
  return null;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sandboxPolicyProfile(hosts) {
  const normalized = [...new Set(hosts)].sort();
  for (const profile of policies.listLockdownProfiles()) {
    const expectedHosts = policies.extractPolicyHosts(policies.buildPolicyFromPresets(profile.presets));
    if (arraysEqual(normalized, expectedHosts)) {
      return { name: profile.name, hosts: normalized };
    }
  }
  return { name: null, hosts: normalized };
}

function httpReachable(url) {
  if (!commandExists("curl")) return false;
  const result = spawnSync("curl", ["-fsSI", "--max-time", "3", url], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function sshKnownHostsFile() {
  return process.env.NEMOCLAW_SSH_KNOWN_HOSTS || path.join(HOME, ".ssh", "known_hosts");
}

function hasKnownHost(host) {
  const knownHosts = sshKnownHostsFile();
  if (!fs.existsSync(knownHosts)) return false;
  const result = spawnSync("ssh-keygen", ["-F", host, "-f", knownHosts], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function collectCloudflaredExposure() {
  const tmpDir = os.tmpdir();
  const results = [];
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("nemoclaw-services-")) {
      continue;
    }
    const logPath = path.join(tmpDir, entry.name, "cloudflared.log");
    if (!fs.existsSync(logPath)) continue;
    const log = fs.readFileSync(logPath, "utf-8");
    const match = log.match(/https:\/\/[a-z0-9-]*\.trycloudflare\.com/);
    if (match) {
      results.push({ dir: entry.name, url: match[0] });
    }
  }
  return results;
}

function securityCheck(remoteHost) {
  const failures = [];
  const warnings = [];
  const passes = [];
  const readySandbox = detectReadySandboxRuntime();

  if (process.env.NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS === "1") {
    failures.push("NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS=1 is set. Hardened operation requires OS-backed secret storage.");
  }
  if (process.env.NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN === "1") {
    failures.push("NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN=1 is set. Hardened operation requires fine-grained or short-lived GitHub worker tokens.");
  }
  if (process.env.GITHUB_TOKEN) {
    failures.push("Host environment exposes GITHUB_TOKEN. Store GitHub credentials in the OS-backed backend and inject them only for explicit sandbox sessions.");
  }
  if (process.env.NEMOCLAW_GITHUB_WORKER_TOKEN) {
    failures.push("Host environment exposes NEMOCLAW_GITHUB_WORKER_TOKEN. Store it in the OS-backed backend and inject it only for explicit sandbox sessions.");
  }

  const backend = resolveCredentialBackend();
  if (backend === "file") {
    failures.push("Credential backend is plaintext file mode. Unset NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS and migrate secrets to OS-backed storage.");
  } else if (backend === "ephemeral") {
    warnings.push("No persistent secure credential backend detected. Credentials will only live in the process environment unless you install one.");
  } else {
    passes.push(`Credential backend: ${describeCredentialBackend(backend)}`);
  }

  if (fs.existsSync(CREDS_FILE)) {
    failures.push(`Legacy plaintext credential file still exists: ${CREDS_FILE}`);
  } else {
    passes.push("No legacy plaintext credential file detected");
  }

  const missingRuntime = [];
  for (const [binary, label] of [
    ["openshell", "OpenShell"],
    ["openclaw", "OpenClaw"],
    ["docker", "Docker"],
  ]) {
    if (!commandExists(binary)) missingRuntime.push(label);
  }
  if (missingRuntime.length === 0) {
    passes.push("Local runtime prerequisites detected: OpenShell, OpenClaw, Docker");
  } else if (
    readySandbox &&
    missingRuntime.length === 1 &&
    missingRuntime[0] === "OpenClaw"
  ) {
    passes.push(`Live sandbox runtime detected via OpenShell: ${readySandbox.name} (Ready)`);
    passes.push("Host OpenClaw install is optional in sandboxed mode");
  } else {
    warnings.push(
      `Local runtime components not installed on this host yet: ${missingRuntime.join(", ")}. Current assessment covers repo posture and local config more than a live instance.`,
    );
  }

  if (readySandbox) {
    try {
      const profile = sandboxPolicyProfile(policies.getEffectivePolicyHosts(readySandbox.name));
      if (profile.name) {
        passes.push(`Sandbox egress profile: ${profile.name} (${profile.hosts.join(", ")})`);
      } else if (profile.hosts.length > 0) {
        warnings.push(
          `Sandbox egress includes non-baseline hosts not covered by a known hardened profile: ${profile.hosts.join(", ")}`,
        );
      } else {
        warnings.push(`Could not determine effective sandbox egress profile for ${readySandbox.name}`);
      }
    } catch (err) {
      warnings.push(`Could not inspect effective sandbox policy for ${readySandbox.name}: ${err.message}`);
    }

    if (httpReachable("http://127.0.0.1:18789/")) {
      passes.push("Local loopback UI bridge is reachable on http://127.0.0.1:18789/");
    } else {
      warnings.push("Live sandbox detected, but the local loopback UI bridge is not currently reachable on http://127.0.0.1:18789/");
    }
  }

  const publicEdgeEnabled = process.env.NEMOCLAW_ENABLE_PUBLIC_EDGE === "1";
  const publicEdgeMode = process.env.NEMOCLAW_PUBLIC_EDGE_MODE || "none";
  const accessProxyUrl = process.env.NEMOCLAW_ACCESS_PROXY_URL || "";
  const accessProxyOrigin = normalizeOrigin(accessProxyUrl);
  if (!publicEdgeEnabled) {
    passes.push("Public edge disabled by default");
  } else if (publicEdgeMode !== "access-proxy") {
    failures.push(`Public edge mode is '${publicEdgeMode}'. Hardened deployments require access-proxy mode.`);
  } else if (!accessProxyUrl.startsWith("https://")) {
    failures.push("NEMOCLAW_ACCESS_PROXY_URL must be set to an https:// URL when public edge is enabled.");
  } else {
    passes.push(`Public edge uses authenticated access proxy: ${accessProxyUrl}`);
  }

  if (process.env.NEMOCLAW_ALLOW_INSECURE_DEMO_TUNNEL === "1") {
    failures.push("NEMOCLAW_ALLOW_INSECURE_DEMO_TUNNEL=1 is set. Disable it for hardened operation.");
  }
  if (process.env.NEMOCLAW_ALLOW_INSECURE_UI === "1") {
    failures.push("NEMOCLAW_ALLOW_INSECURE_UI=1 is set. Insecure control UI mode is for isolated lab use only.");
  }
  if (process.env.NEMOCLAW_ENABLE_AUTO_PAIR === "1") {
    failures.push("NEMOCLAW_ENABLE_AUTO_PAIR=1 is set. Automatic device approval is not allowed in hardened mode.");
  }
  const securityProfile = process.env.NEMOCLAW_SECURITY_PROFILE || "prod-secure";
  if (securityProfile !== "prod-secure") {
    failures.push(`NEMOCLAW_SECURITY_PROFILE is '${securityProfile}'. Hardened operation requires 'prod-secure'.`);
  } else {
    passes.push("Security profile is set to prod-secure");
  }

  const cloudflaredExposure = collectCloudflaredExposure();
  if (cloudflaredExposure.length > 0) {
    for (const exposure of cloudflaredExposure) {
      failures.push(`Detected trycloudflare exposure in ${exposure.dir}: ${exposure.url}`);
    }
  } else {
    passes.push("No active or recent trycloudflare exposure detected in local service logs");
  }

  if (process.env.NEMOCLAW_ENABLE_TELEGRAM === "1") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      failures.push("Telegram ingress is enabled but TELEGRAM_BOT_TOKEN is not set.");
    }
    if (!process.env.ALLOWED_CHAT_IDS && !fs.existsSync(TELEGRAM_ALLOWLIST)) {
      failures.push("Telegram ingress is enabled without a fixed allowlist. Hardened mode requires ALLOWED_CHAT_IDS or a pre-created allowlist file.");
    } else {
      passes.push("Telegram ingress is gated by a fixed allowlist");
    }
    if (process.env.NEMOCLAW_ALLOW_TELEGRAM_ENROLLMENT === "1" || process.env.NEMOCLAW_TELEGRAM_ENROLLMENT_CODE) {
      failures.push("Telegram enrollment mode is enabled. Hardened operation requires fixed allowlists only.");
    }
    if (fs.existsSync(TELEGRAM_ALLOWLIST) && !checkFileMode(TELEGRAM_ALLOWLIST, 0o600)) {
      failures.push(`Telegram allowlist permissions are too broad: ${TELEGRAM_ALLOWLIST}`);
    }
  } else {
    passes.push("Telegram ingress disabled by default");
  }

  if (process.env.NEMOCLAW_ENABLE_EXPERIMENTAL_LOCAL_INFERENCE === "1") {
    warnings.push("Experimental local inference bootstrap is enabled. Leave it off for the narrowest attack surface.");
  } else {
    passes.push("Experimental local inference bootstrap disabled");
  }

  if (fs.existsSync(OPENCLAW_CONFIG)) {
    try {
      const cfg = loadJson(OPENCLAW_CONFIG);
      const controlUi = cfg?.gateway?.controlUi || {};
      const configuredOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
      if (controlUi.allowInsecureAuth === true || controlUi.dangerouslyDisableDeviceAuth === true) {
        failures.push(`OpenClaw config still enables insecure control UI flags: ${OPENCLAW_CONFIG}`);
      } else {
        passes.push("OpenClaw config does not expose insecure control UI flags");
      }
      if (configuredOrigins.length === 0) {
        warnings.push(`OpenClaw config has no explicit allowedOrigins list: ${OPENCLAW_CONFIG}`);
      } else {
        passes.push(`OpenClaw config has ${configuredOrigins.length} explicit allowed origin(s)`);
      }
      if (publicEdgeEnabled && publicEdgeMode === "access-proxy" && accessProxyOrigin && !configuredOrigins.includes(accessProxyOrigin)) {
        failures.push(`OpenClaw allowedOrigins does not include the configured access proxy origin: ${accessProxyOrigin}`);
      }
    } catch (err) {
      warnings.push(`Could not parse ${OPENCLAW_CONFIG}: ${err.message}`);
    }
  } else if (readySandbox) {
    passes.push("Host OpenClaw config not present; live sandbox runtime is managing OpenClaw inside the sandbox");
  } else {
    warnings.push(`OpenClaw config not found yet: ${OPENCLAW_CONFIG}`);
  }

  if (remoteHost) {
    if (!fs.existsSync(sshKnownHostsFile())) {
      failures.push(`SSH known_hosts file is missing: ${sshKnownHostsFile()}`);
    } else if (!hasKnownHost(remoteHost)) {
      failures.push(`No pinned SSH host key found for ${remoteHost} in ${sshKnownHostsFile()}`);
    } else {
      passes.push(`Pinned SSH host key found for ${remoteHost}`);
    }
  } else if (fs.existsSync(sshKnownHostsFile())) {
    passes.push(`SSH known_hosts file present: ${sshKnownHostsFile()}`);
  } else {
    warnings.push(`SSH known_hosts file not present yet: ${sshKnownHostsFile()}`);
  }

  return { failures, warnings, passes };
}

function runSecurityCheck(remoteHost) {
  const { failures, warnings, passes } = securityCheck(remoteHost);

  console.log("");
  console.log("  NemoClaw Security Check");
  console.log("  -----------------------");

  for (const line of passes) {
    console.log(`  [pass] ${line}`);
  }
  for (const line of warnings) {
    console.log(`  [warn] ${line}`);
  }
  for (const line of failures) {
    console.log(`  [fail] ${line}`);
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`  Result: FAIL (${failures.length} blocking issue(s))`);
    process.exit(2);
  }

  if (warnings.length > 0) {
    console.log(`  Result: PASS WITH WARNINGS (${warnings.length})`);
    return;
  }

  console.log("  Result: PASS");
}

module.exports = {
  securityCheck,
  runSecurityCheck,
};
