// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { ROOT, run, runCapture, commandExists } = require("./runner");
const { securityCheck } = require("./security");
const { getCredential } = require("./credentials");
const policies = require("./policies");
const { runGithubWorkerTask } = require("./github-worker");

const HOME = process.env.HOME || os.homedir();
const HEARTBEAT_DIR = path.join(HOME, ".nemoclaw", "heartbeat");
const HEARTBEAT_STATE_FILE = path.join(HEARTBEAT_DIR, "state.json");
const HEARTBEAT_AUDIT_FILE = path.join(HEARTBEAT_DIR, "audit.jsonl");
const HEARTBEAT_LOCK_FILE = path.join(HEARTBEAT_DIR, "run.lock");
const HEARTBEAT_INSTALLED_FILE = path.join(HEARTBEAT_DIR, "HEARTBEAT.md");
const HEARTBEAT_WRAPPER = path.join(HOME, ".local", "bin", "nemoclaw-heartbeat-run.sh");
const HEARTBEAT_PLIST = path.join(HOME, "Library", "LaunchAgents", "com.nemoclaw.heartbeat.plist");
const DEFAULT_HEARTBEAT_TEMPLATE_FILE = path.join(ROOT, "HEARTBEAT.md");
const HEARTBEAT_BLOCK_RE = /```(?:json\s+)?heartbeat\s*\n([\s\S]*?)```/i;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_REF_RE = /^(?![-/])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SYSTEM_BIN_CANDIDATES = [
  path.join("/opt", "homebrew", "bin", "nemoclaw"),
  path.join("/usr", "local", "bin", "nemoclaw"),
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultHeartbeatFile() {
  return fs.existsSync(HEARTBEAT_INSTALLED_FILE) ? HEARTBEAT_INSTALLED_FILE : DEFAULT_HEARTBEAT_TEMPLATE_FILE;
}

function ensureDir() {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true, mode: 0o700 });
}

function readFileOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function extractHeartbeatBlock(markdown) {
  const match = markdown.match(HEARTBEAT_BLOCK_RE);
  if (!match) {
    throw new Error("HEARTBEAT.md must contain a ```heartbeat fenced JSON block.");
  }
  return match[1];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateAllowedPath(value, taskId) {
  assert(typeof value === "string" && value.trim(), `Task '${taskId}' has an empty allowed path.`);
  assert(!value.startsWith("/"), `Task '${taskId}' allowed_paths entries must be relative, not absolute: ${value}`);
  assert(!value.includes(".."), `Task '${taskId}' allowed_paths entries must not contain '..': ${value}`);
  return value;
}

function validateTask(task) {
  assert(task && typeof task === "object", "Each HEARTBEAT task must be an object.");
  assert(typeof task.id === "string" && SAFE_NAME_RE.test(task.id), `Invalid task id: ${task.id}`);
  assert(task.type === "github-pr", `Task '${task.id}' has unsupported type: ${task.type}`);
  assert(typeof task.repo === "string" && SAFE_REPO_RE.test(task.repo), `Task '${task.id}' has invalid repo: ${task.repo}`);
  assert(typeof task.revision === "string" && task.revision.trim().length > 0, `Task '${task.id}' must set a non-empty revision.`);
  assert(typeof task.base_branch === "string" && SAFE_REF_RE.test(task.base_branch), `Task '${task.id}' has invalid base_branch.`);
  assert(typeof task.branch_prefix === "string" && SAFE_REF_RE.test(task.branch_prefix), `Task '${task.id}' has invalid branch_prefix.`);
  assert(typeof task.workdir === "string" && task.workdir.startsWith("/sandbox/workspaces/"), `Task '${task.id}' workdir must stay under /sandbox/workspaces/.`);
  assert(!task.workdir.includes(".."), `Task '${task.id}' workdir must not contain '..'.`);
  assert(Array.isArray(task.allowed_paths) && task.allowed_paths.length > 0, `Task '${task.id}' must define allowed_paths.`);
  assert(typeof task.prompt === "string" && task.prompt.trim().length > 0, `Task '${task.id}' must define a prompt.`);

  const maxRuntimeMinutes = Number.isInteger(task.max_runtime_minutes) ? task.max_runtime_minutes : 20;
  assert(maxRuntimeMinutes >= 5 && maxRuntimeMinutes <= 120, `Task '${task.id}' max_runtime_minutes must be between 5 and 120.`);

  return {
    id: task.id,
    enabled: task.enabled !== false,
    type: task.type,
    repo: task.repo,
    revision: task.revision.trim(),
    baseBranch: task.base_branch,
    branchPrefix: task.branch_prefix,
    workdir: task.workdir,
    allowedPaths: task.allowed_paths.map((value) => validateAllowedPath(value, task.id)),
    maxRuntimeMinutes,
    prompt: task.prompt.trim(),
  };
}

function loadHeartbeatConfig(filePath = defaultHeartbeatFile()) {
  const absPath = path.resolve(filePath);
  const markdown = fs.readFileSync(absPath, "utf-8");
  const block = extractHeartbeatBlock(markdown);
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    throw new Error(`Invalid HEARTBEAT JSON block: ${err.message}`);
  }

  assert(parsed && typeof parsed === "object", "HEARTBEAT config must be a JSON object.");
  assert(parsed.version === 1, `Unsupported HEARTBEAT version: ${parsed.version}`);
  assert(parsed.worker_type === "engineering", "HEARTBEAT worker_type must be 'engineering' for this hardened build.");
  assert(typeof parsed.sandbox === "string" && SAFE_NAME_RE.test(parsed.sandbox), `Invalid sandbox name: ${parsed.sandbox}`);

  const scheduleMinutes = Number.isInteger(parsed.schedule_minutes) ? parsed.schedule_minutes : 30;
  assert(scheduleMinutes >= 5 && scheduleMinutes <= 1440, "schedule_minutes must be between 5 and 1440.");
  const maxTasksPerRun = Number.isInteger(parsed.max_tasks_per_run) ? parsed.max_tasks_per_run : 1;
  assert(maxTasksPerRun >= 1 && maxTasksPerRun <= 3, "max_tasks_per_run must be between 1 and 3.");
  assert(Array.isArray(parsed.tasks), "HEARTBEAT tasks must be an array.");

  return {
    filePath: absPath,
    enabled: parsed.enabled === true,
    workerType: parsed.worker_type,
    sandbox: parsed.sandbox,
    scheduleMinutes,
    maxTasksPerRun,
    tasks: parsed.tasks.map(validateTask),
    raw: parsed,
  };
}

function loadHeartbeatState() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf-8"));
  } catch {
    return { taskState: {} };
  }
}

function saveHeartbeatState(state) {
  ensureDir();
  fs.writeFileSync(HEARTBEAT_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function lastAuditHash() {
  const content = readFileOrEmpty(HEARTBEAT_AUDIT_FILE).trim();
  if (!content) return null;
  const lastLine = content.split("\n").filter(Boolean).pop();
  if (!lastLine) return null;
  try {
    return JSON.parse(lastLine).hash || null;
  } catch {
    return null;
  }
}

function appendAuditEvent(event) {
  ensureDir();
  const payload = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  const prevHash = lastAuditHash();
  const hash = sha256(`${prevHash || ""}\n${JSON.stringify(payload)}`);
  const record = { ...payload, prevHash, hash };
  fs.appendFileSync(HEARTBEAT_AUDIT_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function acquireLock() {
  ensureDir();
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  const tryWrite = () => {
    const fd = fs.openSync(HEARTBEAT_LOCK_FILE, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(payload));
    fs.closeSync(fd);
  };

  try {
    tryWrite();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      const existing = JSON.parse(fs.readFileSync(HEARTBEAT_LOCK_FILE, "utf-8"));
      const staleByAge = Date.now() - Date.parse(existing.startedAt || 0) > 24 * 60 * 60 * 1000;
      let live = false;
      if (typeof existing.pid === "number") {
        try {
          process.kill(existing.pid, 0);
          live = true;
        } catch {
          live = false;
        }
      }
      if (live && !staleByAge) {
        throw new Error(`Heartbeat run already active (pid ${existing.pid}).`);
      }
    } catch (parseErr) {
      if (parseErr.message.startsWith("Heartbeat run already active")) throw parseErr;
    }
    fs.rmSync(HEARTBEAT_LOCK_FILE, { force: true });
    tryWrite();
  }

  return () => fs.rmSync(HEARTBEAT_LOCK_FILE, { force: true });
}

function dueTasks(config, state) {
  return config.tasks.filter((task) => {
    if (!task.enabled) return false;
    const previous = state.taskState?.[task.id];
    return !previous || previous.lastSuccessfulRevision !== task.revision;
  });
}

function buildTaskPrompt(task) {
  return [
    "You are running in NemoClaw heartbeat hardened mode.",
    `Task id: ${task.id}`,
    `Repository: ${task.repo}`,
    `Base branch: ${task.baseBranch}`,
    `Branch prefix: ${task.branchPrefix}`,
    `Workspace path: ${task.workdir}`,
    `Allowed paths: ${task.allowedPaths.join(", ")}`,
    "",
    "Hard constraints:",
    `- Work only on repository ${task.repo}.`,
    `- Clone or fetch it into ${task.workdir} if needed, over HTTPS.`,
    `- Do not modify files outside: ${task.allowedPaths.join(", ")}.`,
    "- Do not use any service outside GitHub and NVIDIA inference.",
    "- If the task requires broader network, secrets, or scope, stop and explain instead of improvising.",
    "- Use non-interactive git commands only. If you commit, use git commit -m and do not open an editor.",
    "- If you make changes, commit them on a branch using the required prefix and open a PR.",
    "- End with these exact lines so the host can verify the run:",
    "  Status: changed | no-change | blocked",
    "  Branch name: <branch-name-or-none>",
    "  PR URL: <url-or-none>",
    "  Blocker: <short-text-or-none>",
    "",
    "Operator task:",
    task.prompt,
  ].join("\n");
}

function heartbeatPreflight(config) {
  if (!commandExists("openshell")) {
    throw new Error("OpenShell CLI is required for heartbeat mode.");
  }

  policies.applyLockdownProfile(config.sandbox, "local-only");
  const result = securityCheck();
  if (result.failures.length > 0 || result.warnings.length > 0) {
    throw new Error(
      `Heartbeat preflight failed. failures=${result.failures.length} warnings=${result.warnings.length}`,
    );
  }

  const apiKey = getCredential("NVIDIA_API_KEY");
  if (!apiKey) {
    throw new Error("No stored NVIDIA API key available for unattended heartbeat mode.");
  }
  const workerToken = getCredential("NEMOCLAW_GITHUB_WORKER_TOKEN");
  if (!workerToken) {
    throw new Error("No stored GitHub worker token available for unattended heartbeat mode.");
  }

  return { apiKey, workerToken };
}

async function runHeartbeat(filePath = defaultHeartbeatFile()) {
  const config = loadHeartbeatConfig(filePath);
  const releaseLock = acquireLock();
  appendAuditEvent({
    event: "heartbeat_run_started",
    heartbeatFile: config.filePath,
    sandbox: config.sandbox,
    configSha256: sha256(JSON.stringify(config.raw)),
  });

  try {
    if (!config.enabled) {
      appendAuditEvent({ event: "heartbeat_disabled", heartbeatFile: config.filePath });
      return { config, due: [], ran: [] };
    }

    const credentials = heartbeatPreflight(config);
    const state = loadHeartbeatState();
    const pending = dueTasks(config, state).slice(0, config.maxTasksPerRun);
    appendAuditEvent({
      event: "heartbeat_due_tasks",
      heartbeatFile: config.filePath,
      dueTaskIds: pending.map((task) => task.id),
    });

    const ran = [];
    for (const task of pending) {
      const startedAt = Date.now();
      appendAuditEvent({
        event: "heartbeat_task_started",
        taskId: task.id,
        revision: task.revision,
        repo: task.repo,
        promptSha256: sha256(task.prompt),
      });

      try {
        const result = await runGithubWorkerTask({
          sandboxName: config.sandbox,
          sessionId: `hb-${task.id.slice(0, 10)}-${sha256(task.revision).slice(0, 8)}`.slice(0, 24),
          message: buildTaskPrompt(task),
          apiKey: credentials.apiKey,
          workerToken: credentials.workerToken,
          timeoutMs: task.maxRuntimeMinutes * 60 * 1000,
          streamOutput: false,
          repo: task.repo,
          baseBranch: task.baseBranch,
          branchPrefix: task.branchPrefix,
          allowedPaths: task.allowedPaths,
        });

        state.taskState[task.id] = {
          lastSuccessfulRevision: task.revision,
          lastRunAt: new Date().toISOString(),
          repo: task.repo,
        };
        saveHeartbeatState(state);
        ran.push(task.id);
        appendAuditEvent({
          event: "heartbeat_task_succeeded",
          taskId: task.id,
          revision: task.revision,
          durationMs: Date.now() - startedAt,
          stdoutSha256: sha256(result.stdout || ""),
          stderrSha256: sha256(result.stderr || ""),
          stdoutBytes: Buffer.byteLength(result.stdout || ""),
          stderrBytes: Buffer.byteLength(result.stderr || ""),
        });
      } catch (err) {
        appendAuditEvent({
          event: "heartbeat_task_failed",
          taskId: task.id,
          revision: task.revision,
          durationMs: Date.now() - startedAt,
          error: String(err.message || err),
          stdoutSha256: sha256(err.stdout || ""),
          stderrSha256: sha256(err.stderr || ""),
          stdoutBytes: Buffer.byteLength(err.stdout || ""),
          stderrBytes: Buffer.byteLength(err.stderr || ""),
        });
        throw err;
      } finally {
        policies.applyLockdownProfile(config.sandbox, "local-only");
      }
    }

    appendAuditEvent({
      event: "heartbeat_run_finished",
      heartbeatFile: config.filePath,
      ranTaskIds: ran,
    });
    return { config, due: pending.map((task) => task.id), ran };
  } finally {
    releaseLock();
  }
}

function heartbeatStatus(filePath = defaultHeartbeatFile()) {
  const config = loadHeartbeatConfig(filePath);
  const state = loadHeartbeatState();
  return {
    config,
    installed: fs.existsSync(HEARTBEAT_PLIST),
    wrapperInstalled: fs.existsSync(HEARTBEAT_WRAPPER),
    due: dueTasks(config, state).map((task) => task.id),
    state,
  };
}

function heartbeatSafeWorkingDirectory() {
  ensureDir();
  return HEARTBEAT_DIR;
}

function candidateNemoclawBinaries() {
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "nemoclaw"));
  const userCandidates = [path.join(HOME, ".local", "bin", "nemoclaw")];
  const seen = new Set();
  return [...SYSTEM_BIN_CANDIDATES, ...pathDirs, ...userCandidates].filter((candidate) => {
    if (!candidate || seen.has(candidate)) return false;
    seen.add(candidate);
    return fs.existsSync(candidate);
  });
}

function isRepoLinkedBinary(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    const rootPath = path.resolve(ROOT);
    return resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`);
  } catch {
    return true;
  }
}

function resolveInstalledNemoclawBinary() {
  const candidates = candidateNemoclawBinaries();
  for (const candidate of candidates) {
    if (!isRepoLinkedBinary(candidate)) {
      return candidate;
    }
  }

  if (!commandExists("nemoclaw")) {
    throw new Error("A user-local nemoclaw binary is required for heartbeat mode. Install NemoClaw from a packed tarball so the global binary does not point back into the repo.");
  }
  throw new Error("Heartbeat mode requires an installed nemoclaw binary outside the protected repo path. Remove repo-linked global installs and reinstall from a packed release or tarball.");
}

function installHeartbeat(filePath = defaultHeartbeatFile()) {
  const config = loadHeartbeatConfig(filePath);
  ensureDir();
  fs.mkdirSync(path.dirname(HEARTBEAT_WRAPPER), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(HEARTBEAT_PLIST), { recursive: true, mode: 0o700 });
  fs.copyFileSync(config.filePath, HEARTBEAT_INSTALLED_FILE);
  fs.chmodSync(HEARTBEAT_INSTALLED_FILE, 0o600);

  const installedBinary = resolveInstalledNemoclawBinary();

  const wrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    `PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`,
    `exec ${JSON.stringify(installedBinary)} heartbeat-run --file ${JSON.stringify(HEARTBEAT_INSTALLED_FILE)}`,
  ].join("\n");
  fs.writeFileSync(HEARTBEAT_WRAPPER, `${wrapper}\n`, { mode: 0o700 });

  const logOut = path.join(HEARTBEAT_DIR, "launchd.out.log");
  const logErr = path.join(HEARTBEAT_DIR, "launchd.err.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.nemoclaw.heartbeat</string>
    <key>ProgramArguments</key>
    <array>
      <string>${HEARTBEAT_WRAPPER}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${config.scheduleMinutes * 60}</integer>
    <key>StandardOutPath</key>
    <string>${logOut}</string>
    <key>StandardErrorPath</key>
    <string>${logErr}</string>
    <key>WorkingDirectory</key>
    <string>${heartbeatSafeWorkingDirectory()}</string>
  </dict>
</plist>
`;
  fs.writeFileSync(HEARTBEAT_PLIST, plist, { mode: 0o600 });

  if (commandExists("launchctl")) {
    run("launchctl", ["bootout", `gui/${process.getuid()}`, HEARTBEAT_PLIST], { ignoreError: true, stdio: "ignore" });
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, HEARTBEAT_PLIST], { ignoreError: true });
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.nemoclaw.heartbeat`], { ignoreError: true });
  }

  return { config: loadHeartbeatConfig(HEARTBEAT_INSTALLED_FILE), wrapper: HEARTBEAT_WRAPPER, plist: HEARTBEAT_PLIST, installedFile: HEARTBEAT_INSTALLED_FILE };
}

function uninstallHeartbeat() {
  if (commandExists("launchctl") && fs.existsSync(HEARTBEAT_PLIST)) {
    run("launchctl", ["bootout", `gui/${process.getuid()}`, HEARTBEAT_PLIST], { ignoreError: true, stdio: "ignore" });
  }
  fs.rmSync(HEARTBEAT_PLIST, { force: true });
  fs.rmSync(HEARTBEAT_WRAPPER, { force: true });
}

module.exports = {
  DEFAULT_HEARTBEAT_TEMPLATE_FILE,
  HEARTBEAT_INSTALLED_FILE,
  HEARTBEAT_AUDIT_FILE,
  HEARTBEAT_STATE_FILE,
  HEARTBEAT_PLIST,
  HEARTBEAT_WRAPPER,
  defaultHeartbeatFile,
  loadHeartbeatConfig,
  heartbeatStatus,
  installHeartbeat,
  uninstallHeartbeat,
  runHeartbeat,
  buildTaskPrompt,
  dueTasks,
  candidateNemoclawBinaries,
  resolveInstalledNemoclawBinary,
};
