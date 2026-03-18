#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
const fs = require("fs");
const os = require("os");

const { ROOT, SCRIPTS, run, runCapture, commandExists, sleep, spawn } = require("./lib/runner");
const {
  ensureApiKey,
  ensureGithubToken,
  ensureGithubWorkerToken,
  getCredential,
  isRepoPrivate,
  describeCredentialBackend,
} = require("./lib/credentials");
const { runSecurityCheck } = require("./lib/security");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const { runGithubWorkerTask } = require("./lib/github-worker");
const heartbeat = require("./lib/heartbeat");
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_REF_RE = /^(?![-/])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function assertSafeName(value, label) {
  if (!SAFE_NAME_RE.test(value)) {
    console.error(`  Invalid ${label}: ${value}`);
    console.error("  Use 1-63 characters from: letters, numbers, dot, underscore, hyphen.");
    process.exit(1);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function knownHostsFile() {
  return process.env.NEMOCLAW_SSH_KNOWN_HOSTS || path.join(process.env.HOME || os.homedir(), ".ssh", "known_hosts");
}

function sshBaseArgs() {
  const kh = knownHostsFile();
  if (!fs.existsSync(kh)) {
    console.error(`  SSH known_hosts file not found: ${kh}`);
    console.error("  Pin the target host key before running remote deploy.");
    process.exit(1);
  }

  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${kh}`,
    "-o",
    "LogLevel=ERROR",
  ];
}

function sshRemoteArgs(instanceName, extraArgs = []) {
  return [...sshBaseArgs(), ...extraArgs, instanceName];
}

function rsyncShellCommand() {
  return ["ssh", ...sshBaseArgs()].map(shellQuote).join(" ");
}

function runRemote(instanceName, command, opts = {}) {
  run("ssh", [...sshRemoteArgs(instanceName, opts.tty ? ["-t"] : []), command], opts);
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function listOpenShellSandboxes() {
  if (!commandExists("openshell")) return [];
  const output = runCapture("openshell", ["sandbox", "list"], { ignoreError: true });
  if (!output) return [];

  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts[0] === "NAME") return null;
      if (parts.length < 4) return null;
      return {
        name: parts[0],
        namespace: parts[1],
        phase: parts[parts.length - 1],
      };
    })
    .filter(Boolean);
}

function openshellSandboxExists(name) {
  return listOpenShellSandboxes().some((sandbox) => sandbox.name === name);
}

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "setup-spark",
  "start", "stop", "status", "security-check", "auth-nvidia", "auth-github-worker",
  "heartbeat-check", "heartbeat-run", "heartbeat-status", "heartbeat-install", "heartbeat-uninstall",
  "help", "--help", "-h",
]);

// ── Commands ─────────────────────────────────────────────────────

async function onboard() {
  const { onboard: runOnboard } = require("./lib/onboard");
  await runOnboard();
}

async function setup() {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("     Running legacy setup.sh for backwards compatibility...");
  console.log("");
  await ensureApiKey();
  run("bash", [path.join(SCRIPTS, "setup.sh")]);
}

async function setupSpark() {
  await ensureApiKey();
  run("sudo", ["-E", "bash", path.join(SCRIPTS, "setup-spark.sh")], {
    env: { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY },
  });
}

async function deploy(instanceName) {
  if (!instanceName) {
    console.error("  Usage: nemoclaw deploy <instance-name>");
    console.error("");
    console.error("  Examples:");
    console.error("    nemoclaw deploy my-gpu-box");
    console.error("    nemoclaw deploy nemoclaw-prod");
    console.error("    nemoclaw deploy nemoclaw-test");
    process.exit(1);
  }
  await ensureApiKey();
  if (isRepoPrivate("NVIDIA/OpenShell")) {
    await ensureGithubToken();
  }
  const name = instanceName;
  assertSafeName(name, "instance name");
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  if (!commandExists("brev")) {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  const out = runCapture("brev", ["ls"], { ignoreError: true });
  const exists = out.includes(name);

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run("brev", ["create", name, "--gpu", gpu]);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  run("brev", ["refresh"], { ignoreError: true, stdio: "ignore" });

  console.log("  Waiting for SSH...");
  for (let i = 0; i < 60; i++) {
    const result = spawn("ssh", [...sshRemoteArgs(name, ["-o", "ConnectTimeout=5"]), "true"], {
      stdio: "ignore",
    });
    if (result.status === 0) {
      break;
    }
    if (i === 59) {
      console.error(`  Timed out waiting for SSH to ${name}`);
      process.exit(1);
    }
    sleep(3);
  }

  console.log("  Syncing NemoClaw to VM...");
  runRemote(
    name,
    "mkdir -p /home/ubuntu/nemoclaw /home/ubuntu/nemoclaw/.secrets && chmod 700 /home/ubuntu/nemoclaw/.secrets",
  );
  run("rsync", [
    "-az",
    "--delete",
    "--exclude",
    "node_modules",
    "--exclude",
    ".git",
    "--exclude",
    "src",
    "-e",
    rsyncShellCommand(),
    path.join(ROOT, "scripts"),
    path.join(ROOT, "Dockerfile"),
    path.join(ROOT, "nemoclaw"),
    path.join(ROOT, "nemoclaw-blueprint"),
    path.join(ROOT, "bin"),
    path.join(ROOT, "package.json"),
    path.join(ROOT, "package-lock.json"),
    `${name}:/home/ubuntu/nemoclaw/`,
  ]);

  const envLines = [`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`];
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) envLines.push(`GITHUB_TOKEN=${ghToken}`);
  const envTmp = path.join(os.tmpdir(), `nemoclaw-env-${Date.now()}`);
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  run("scp", [
    "-q",
    ...sshBaseArgs(),
    envTmp,
    `${name}:/home/ubuntu/nemoclaw/.secrets/bootstrap.env`,
  ]);
  fs.unlinkSync(envTmp);

  console.log("  Running setup...");
  runRemote(
    name,
    "cd /home/ubuntu/nemoclaw && chmod 600 .secrets/bootstrap.env && set -a && . .secrets/bootstrap.env && set +a && bash scripts/brev-setup.sh && rm -f .secrets/bootstrap.env",
    { tty: true },
  );

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  console.log("  Public tunnels and Telegram ingress remain disabled until explicitly configured.");
  runRemote(name, "cd /home/ubuntu/nemoclaw && openshell sandbox connect nemoclaw", { tty: true });
}

async function authGithubWorker() {
  await ensureGithubWorkerToken();
}

async function authNvidia() {
  await ensureApiKey();
}

function parseHeartbeatFileArg(args = []) {
  if (args[0] === "--file") {
    if (!args[1]) {
      console.error("  --file requires a path");
      process.exit(1);
    }
    return args[1];
  }
  if (args.length > 0) {
    console.error(`  Unknown heartbeat argument: ${args[0]}`);
    process.exit(1);
  }
  return heartbeat.defaultHeartbeatFile();
}

function heartbeatCheck(args = []) {
  const filePath = parseHeartbeatFileArg(args);
  const status = heartbeat.heartbeatStatus(filePath);
  console.log("");
  console.log("  HEARTBEAT Check");
  console.log("  ---------------");
  console.log(`  File:      ${status.config.filePath}`);
  console.log(`  Enabled:   ${status.config.enabled ? "yes" : "no"}`);
  console.log(`  Sandbox:   ${status.config.sandbox}`);
  console.log(`  Schedule:  every ${status.config.scheduleMinutes} minute(s)`);
  console.log(`  Due tasks: ${status.due.join(", ") || "(none)"}`);
  console.log("");
}

async function heartbeatRun(args = []) {
  const filePath = parseHeartbeatFileArg(args);
  const result = await heartbeat.runHeartbeat(filePath);
  console.log("");
  console.log("  HEARTBEAT Run");
  console.log("  -------------");
  console.log(`  File: ${result.config.filePath}`);
  console.log(`  Due:  ${result.due.join(", ") || "(none)"}`);
  console.log(`  Ran:  ${result.ran.join(", ") || "(none)"}`);
  console.log("");
}

function heartbeatShowStatus(args = []) {
  const filePath = parseHeartbeatFileArg(args);
  const status = heartbeat.heartbeatStatus(filePath);
  console.log("");
  console.log("  HEARTBEAT Status");
  console.log("  ----------------");
  console.log(`  File:             ${status.config.filePath}`);
  console.log(`  LaunchAgent:      ${status.installed ? "installed" : "not installed"}`);
  console.log(`  Wrapper script:   ${status.wrapperInstalled ? "installed" : "not installed"}`);
  console.log(`  Enabled:          ${status.config.enabled ? "yes" : "no"}`);
  console.log(`  Schedule minutes: ${status.config.scheduleMinutes}`);
  console.log(`  Due tasks:        ${status.due.join(", ") || "(none)"}`);
  console.log("");
}

function heartbeatInstall(args = []) {
  const filePath = parseHeartbeatFileArg(args);
  const result = heartbeat.installHeartbeat(filePath);
  console.log("");
  console.log("  HEARTBEAT Installed");
  console.log("  -------------------");
  console.log(`  File:    ${result.config.filePath}`);
  console.log(`  Wrapper: ${result.wrapper}`);
  console.log(`  Plist:   ${result.plist}`);
  console.log("");
}

function heartbeatUninstall() {
  heartbeat.uninstallHeartbeat();
  console.log("");
  console.log("  HEARTBEAT launchd integration removed.");
  console.log("");
}

async function start() {
  run("bash", [path.join(SCRIPTS, "start-services.sh")]);
}

function stop() {
  run("bash", [path.join(SCRIPTS, "start-services.sh"), "--stop"]);
}

function showStatus() {
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      console.log(`    ${sb.name}${def}${model}`);
    }
    console.log("");
  }

  // Show service status
  run("bash", [path.join(SCRIPTS, "start-services.sh"), "--status"]);
}

function securityCheck(remoteHost) {
  runSecurityCheck(remoteHost);
}

function listSandboxes() {
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    const openShellSandboxes = listOpenShellSandboxes();
    if (openShellSandboxes.length > 0) {
      console.log("");
      console.log("  OpenShell sandboxes detected:");
      for (const sb of openShellSandboxes) {
        console.log(`    ${sb.name} (${sb.phase})`);
      }
      console.log("");
      console.log("  These sandboxes are live in OpenShell even though they are not yet in the NemoClaw host registry.");
      console.log("");
      return;
    }
    console.log("");
    console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${sb.name}${def}`);
    console.log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── Sandbox-scoped actions ───────────────────────────────────────

function sandboxConnect(sandboxName) {
  assertSafeName(sandboxName, "sandbox name");
  run("openshell", ["sandbox", "connect", sandboxName]);
}

function parseGithubAgentArgs(actionArgs) {
  const opts = {
    message: "",
    sessionId: `gh-${Date.now().toString(36)}`,
    keepGithubProfile: false,
    repo: "",
    baseBranch: "",
    branchPrefix: "",
    allowedPaths: [],
    prTitle: "",
    prBody: "",
  };

  for (let i = 0; i < actionArgs.length; i += 1) {
    const value = actionArgs[i];
    switch (value) {
      case "-m":
      case "--message":
        opts.message = actionArgs[++i] || "";
        break;
      case "--session-id":
        opts.sessionId = actionArgs[++i] || "";
        break;
      case "--keep-github-profile":
        opts.keepGithubProfile = true;
        break;
      case "--repo":
        opts.repo = actionArgs[++i] || "";
        break;
      case "--base-branch":
        opts.baseBranch = actionArgs[++i] || "";
        break;
      case "--branch-prefix":
        opts.branchPrefix = actionArgs[++i] || "";
        break;
      case "--allowed-path":
        opts.allowedPaths.push(actionArgs[++i] || "");
        break;
      case "--pr-title":
        opts.prTitle = actionArgs[++i] || "";
        break;
      case "--pr-body":
        opts.prBody = actionArgs[++i] || "";
        break;
      default:
        if (!opts.message) {
          opts.message = actionArgs.slice(i).join(" ");
          i = actionArgs.length;
        } else {
          console.error(`  Unknown github-agent argument: ${value}`);
          process.exit(1);
        }
    }
  }

  if (!opts.message) {
    console.error("  Usage: nemoclaw <name> github-agent --message \"<task>\" [--session-id <id>] [--keep-github-profile] [--repo <owner/repo> --base-branch <branch> --branch-prefix <prefix> --allowed-path <path> ...]");
    process.exit(1);
  }

  assertSafeName(opts.sessionId, "session id");
  if (opts.repo && !SAFE_REPO_RE.test(opts.repo)) {
    console.error(`  Invalid repo: ${opts.repo}`);
    process.exit(1);
  }
  if (opts.baseBranch && !SAFE_REF_RE.test(opts.baseBranch)) {
    console.error(`  Invalid base branch: ${opts.baseBranch}`);
    process.exit(1);
  }
  if (opts.branchPrefix && !SAFE_REF_RE.test(opts.branchPrefix)) {
    console.error(`  Invalid branch prefix: ${opts.branchPrefix}`);
    process.exit(1);
  }
  for (const value of opts.allowedPaths) {
    if (!value || value.startsWith("/") || value.includes("..")) {
      console.error(`  Invalid allowed path: ${value}`);
      process.exit(1);
    }
  }
  return opts;
}

async function sandboxGithubAgent(sandboxName, actionArgs) {
  assertSafeName(sandboxName, "sandbox name");
  const opts = parseGithubAgentArgs(actionArgs);

  await ensureApiKey();
  await ensureGithubWorkerToken();

  const apiKey = getCredential("NVIDIA_API_KEY") || process.env.NVIDIA_API_KEY || "";
  const workerToken = getCredential("NEMOCLAW_GITHUB_WORKER_TOKEN") || "";
  if (!workerToken) {
    console.error("  GitHub worker token not available.");
    process.exit(1);
  }

  try {
    await runGithubWorkerTask({
      sandboxName,
      sessionId: opts.sessionId,
      message: opts.message,
      apiKey,
      workerToken,
      keepGithubProfile: opts.keepGithubProfile,
      streamOutput: true,
      repo: opts.repo,
      baseBranch: opts.baseBranch,
      branchPrefix: opts.branchPrefix,
      allowedPaths: opts.allowedPaths,
      prTitle: opts.prTitle,
      prBody: opts.prBody,
    });
  } finally {
    delete process.env.NEMOCLAW_GITHUB_WORKER_TOKEN;
  }
}

function sandboxStatus(sandboxName) {
  assertSafeName(sandboxName, "sandbox name");
  const sb = registry.getSandbox(sandboxName);
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${sb.model || "unknown"}`);
    console.log(`    Provider: ${sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  // openshell info
  run("openshell", ["sandbox", "get", sandboxName], { ignoreError: true });

  // NIM health
  const nimStat = nim.nimStatus(sandboxName);
  console.log(`    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`);
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  assertSafeName(sandboxName, "sandbox name");
  const args = ["sandbox", "logs", sandboxName];
  if (follow) args.push("--follow");
  run("openshell", args);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log("  Available presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await askPrompt("  Preset to apply: ");
  if (!answer) return;

  const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
  if (confirm.toLowerCase() === "n") return;

  policies.applyPreset(sandboxName, answer);
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");
}

function sandboxLockdown(sandboxName, profileName) {
  assertSafeName(sandboxName, "sandbox name");
  if (!profileName) {
    console.log("");
    console.log(`  Lockdown profiles for sandbox '${sandboxName}':`);
    for (const profile of policies.listLockdownProfiles()) {
      console.log(`    ${profile.name} — ${profile.description}`);
    }
    console.log("");
    console.log(`  Apply one with: nemoclaw ${sandboxName} lockdown <profile>`);
    console.log("");
    return;
  }

  if (!policies.applyLockdownProfile(sandboxName, profileName)) {
    process.exit(1);
  }
}

function sandboxDestroy(sandboxName) {
  assertSafeName(sandboxName, "sandbox name");
  console.log(`  Stopping NIM for '${sandboxName}'...`);
  nim.stopNimContainer(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  run("openshell", ["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: "ignore",
  });

  registry.removeSandbox(sandboxName);
  console.log(`  ✓ Sandbox '${sandboxName}' destroyed`);
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  console.log(`
  nemoclaw — NemoClaw CLI

  Getting Started:
    nemoclaw onboard                 Interactive setup wizard (recommended)
    nemoclaw setup                   Legacy setup (deprecated, use onboard)
    nemoclaw setup-spark             Set up on DGX Spark (fixes cgroup v2 + Docker)

  Sandbox Management:
    nemoclaw list                    List all sandboxes
    nemoclaw <name> connect          Connect to a sandbox
    nemoclaw <name> status           Show sandbox status and health
    nemoclaw <name> logs [--follow]  View sandbox logs
    nemoclaw <name> github-agent     Run one GitHub-capable agent task with temporary token injection
    nemoclaw <name> lockdown <mode>  Reset live egress to a named hardened profile
    nemoclaw <name> destroy          Stop NIM + delete sandbox

  Policy Presets:
    nemoclaw <name> policy-add       Add a policy preset to a sandbox
    nemoclaw <name> policy-list      List presets (● = applied)

  Deploy:
    nemoclaw deploy <instance>       Deploy to a Brev VM with host-key pinning

  Services:
    nemoclaw start                   Start explicitly enabled services
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status

  Security:
    nemoclaw security-check [host]   Verify hardened local settings and optional SSH host pinning
    nemoclaw auth-nvidia            Store the NVIDIA API key in the OS credential backend
    nemoclaw auth-github-worker      Store a GitHub worker token in the OS credential backend
    nemoclaw heartbeat-check         Validate HEARTBEAT.md and show due tasks
    nemoclaw heartbeat-run           Run due HEARTBEAT tasks once
    nemoclaw heartbeat-status        Show HEARTBEAT scheduler state
    nemoclaw heartbeat-install       Install the HEARTBEAT launchd scheduler
    nemoclaw heartbeat-uninstall     Remove the HEARTBEAT launchd scheduler

  Credentials are prompted on first use, then stored in
  ${describeCredentialBackend()} when available.
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":     await onboard(); break;
      case "setup":       await setup(); break;
      case "setup-spark": await setupSpark(); break;
      case "deploy":      await deploy(args[0]); break;
      case "auth-nvidia": await authNvidia(); break;
      case "auth-github-worker": await authGithubWorker(); break;
      case "heartbeat-check": heartbeatCheck(args); break;
      case "heartbeat-run": await heartbeatRun(args); break;
      case "heartbeat-status": heartbeatShowStatus(args); break;
      case "heartbeat-install": heartbeatInstall(args); break;
      case "heartbeat-uninstall": heartbeatUninstall(); break;
      case "start":       await start(); break;
      case "stop":        stop(); break;
      case "status":      showStatus(); break;
      case "security-check": securityCheck(args[0]); break;
      case "list":        listSandboxes(); break;
      default:            help(); break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const sandbox = registry.getSandbox(cmd);
  if (sandbox || openshellSandboxExists(cmd)) {
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    switch (action) {
      case "connect":     sandboxConnect(cmd); break;
      case "status":      sandboxStatus(cmd); break;
      case "logs":        sandboxLogs(cmd, actionArgs.includes("--follow")); break;
      case "github-agent": await sandboxGithubAgent(cmd, actionArgs); break;
      case "policy-add":  await sandboxPolicyAdd(cmd); break;
      case "policy-list": sandboxPolicyList(cmd); break;
      case "lockdown":    sandboxLockdown(cmd, actionArgs[0]); break;
      case "destroy":     sandboxDestroy(cmd); break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, status, logs, github-agent, policy-add, policy-list, lockdown, destroy`);
        process.exit(1);
    }
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
})().catch((err) => {
  console.error(`  ${String(err.message || err)}`);
  process.exit(1);
});
