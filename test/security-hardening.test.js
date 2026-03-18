// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

describe("security hardening regressions", () => {
  it("runner no longer shells out through bash -c", () => {
    const runner = read("bin/lib/runner.js");
    assert.ok(!runner.includes('spawnSync("bash"'));
    assert.ok(!runner.includes('["-c",'));
  });

  it("deploy path requires SSH host verification", () => {
    const cli = read("bin/nemoclaw.js");
    assert.ok(!cli.includes("StrictHostKeyChecking=no"));
    assert.ok(cli.includes("StrictHostKeyChecking=yes"));
    assert.ok(cli.includes("UserKnownHostsFile="));
    assert.ok(cli.includes('"security-check"'));
    assert.ok(cli.includes("nemoclaw security-check [host]"));
  });

  it("sandbox startup defaults are secure", () => {
    const startScript = read("scripts/nemoclaw-start.sh");
    assert.ok(startScript.includes("control_ui.pop('allowInsecureAuth', None)"));
    assert.ok(startScript.includes("control_ui.pop('dangerouslyDisableDeviceAuth', None)"));
    assert.ok(startScript.includes('if [ "$NEMOCLAW_ALLOW_INSECURE_UI" = "1" ] && [ "$NEMOCLAW_ENABLE_AUTO_PAIR" = "1" ]; then'));
    assert.ok(startScript.includes('export GIT_SSL_CAINFO="$ca_bundle"'));
    assert.ok(startScript.includes('git config --global http.sslCAInfo "$ca_bundle"'));
    assert.ok(!startScript.includes("#token="));
  });

  it("service launcher disables remote ingress by default", () => {
    const services = read("scripts/start-services.sh");
    assert.ok(services.includes('ENABLE_TELEGRAM="${NEMOCLAW_ENABLE_TELEGRAM:-0}"'));
    assert.ok(services.includes('ENABLE_PUBLIC_EDGE="${NEMOCLAW_ENABLE_PUBLIC_EDGE:-0}"'));
    assert.ok(services.includes('SECURITY_PROFILE="${NEMOCLAW_SECURITY_PROFILE:-prod-secure}"'));
    assert.ok(services.includes("prod-secure requires a fixed Telegram allowlist"));
    assert.ok(services.includes("Raw trycloudflare tunnels are disabled in this hardened build"));
  });

  it("repository includes a loopback-only local UI forward helper", () => {
    const helper = read("scripts/nemoclaw-local-ui-forward.sh");
    assert.ok(helper.includes('ExitOnForwardFailure=yes'));
    assert.ok(helper.includes('ServerAliveInterval=15'));
    assert.ok(helper.includes('-L "127.0.0.1:${UI_PORT}:127.0.0.1:${UI_PORT}"'));
    assert.ok(!helper.includes("0.0.0.0:"));
  });

  it("telegram bridge is deny-by-default, rate limited, and forbids enrollment in prod-secure", () => {
    const bridge = read("scripts/telegram-bridge.js");
    assert.ok(bridge.includes("prod-secure Telegram mode requires a fixed allowlist"));
    assert.ok(bridge.includes("prod-secure Telegram mode forbids enrollment codes"));
    assert.ok(bridge.includes("recordAndCheckRateLimit"));
    assert.ok(bridge.includes("persistAllowedChats"));
  });

  it("runtime build uses the checked-in lockfile", () => {
    const dockerfile = read("Dockerfile");
    assert.ok(dockerfile.includes("COPY nemoclaw/package-lock.json /opt/nemoclaw/"));
    assert.ok(dockerfile.includes("npm ci --omit=dev --ignore-scripts"));
    assert.ok(!dockerfile.includes("npm install --omit=dev"));
  });

  it("production setup paths do not use inference --no-verify", () => {
    const setup = read("scripts/setup.sh");
    const onboard = read("bin/lib/onboard.js");
    assert.ok(!setup.includes("--no-verify"));
    assert.ok(!onboard.includes("--no-verify"));
  });

  it("installer paths require local review and OpenShell checksum verification in prod-secure", () => {
    const installer = read("scripts/install.sh");
    const brevSetup = read("scripts/brev-setup.sh");
    assert.ok(installer.includes("Refusing to run from stdin or curl | bash"));
    assert.ok(installer.includes("prod-secure requires NEMOCLAW_OPENSHELL_SHA256"));
    assert.ok(installer.includes('npm pack --pack-destination "$PACK_DIR" "$REPO_ROOT"'));
    assert.ok(installer.includes('npm install -g "$PACK_TARBALL"'));
    assert.ok(brevSetup.includes("prod-secure requires NEMOCLAW_OPENSHELL_SHA256"));
  });

  it("baseline policy no longer pre-allows GitHub, npm, or Telegram", () => {
    const policy = read("nemoclaw-blueprint/policies/openclaw-sandbox.yaml");
    assert.ok(!policy.includes("github.com"));
    assert.ok(!policy.includes("registry.npmjs.org"));
    assert.ok(!policy.includes("api.telegram.org"));
  });

  it("github preset is narrowed to explicit git and curl binaries", () => {
    const githubPreset = read("nemoclaw-blueprint/policies/presets/github.yaml");
    assert.ok(githubPreset.includes("/usr/bin/git"));
    assert.ok(githubPreset.includes("/usr/bin/curl"));
    assert.ok(githubPreset.includes("/usr/lib/git-core/git-remote-https"));
    assert.ok(githubPreset.includes("method: PATCH"));
    assert.ok(githubPreset.includes("method: PUT"));
  });

  it("migration quarantines imported hooks and extra skill directories", () => {
    const migrationState = read("nemoclaw/src/commands/migration-state.ts");
    const migrate = read("nemoclaw/src/commands/migrate.ts");
    assert.ok(migrationState.includes('const QUARANTINE_DIR_NAME = ".nemoclaw-quarantine"'));
    assert.ok(migrationState.includes('for (const entry of ["hooks", "extensions", "skills"])'));
    assert.ok(migrationState.includes('skillLoad["extraDirs"] = [];'));
    assert.ok(migrate.includes('quarantineManifestPath: "/sandbox/.openclaw/.nemoclaw-quarantine/quarantine.json"'));
  });

  it("security check enforces hardened operator settings", () => {
    const checker = read("bin/lib/security.js");
    assert.ok(checker.includes("detectReadySandboxRuntime"));
    assert.ok(checker.includes("Host OpenClaw install is optional in sandboxed mode"));
    assert.ok(checker.includes("Sandbox egress profile:"));
    assert.ok(checker.includes("Local loopback UI bridge is reachable on http://127.0.0.1:18789/"));
    assert.ok(checker.includes("live sandbox runtime is managing OpenClaw inside the sandbox"));
    assert.ok(checker.includes("Host environment exposes GITHUB_TOKEN"));
    assert.ok(checker.includes("Host environment exposes NEMOCLAW_GITHUB_WORKER_TOKEN"));
    assert.ok(checker.includes("NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN=1 is set"));
    assert.ok(checker.includes("NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS=1 is set"));
    assert.ok(checker.includes("NEMOCLAW_ALLOW_INSECURE_DEMO_TUNNEL=1 is set"));
    assert.ok(checker.includes("NEMOCLAW_ALLOW_INSECURE_UI=1 is set"));
    assert.ok(checker.includes("NEMOCLAW_ENABLE_AUTO_PAIR=1 is set"));
    assert.ok(checker.includes("Hardened operation requires 'prod-secure'"));
    assert.ok(checker.includes("Hardened operation requires fixed allowlists only"));
    assert.ok(checker.includes("No pinned SSH host key found"));
  });

  it("repository includes a hardened instance runbook", () => {
    const runbook = read("docs/deployment/hardened-instance-runbook.md");
    assert.ok(runbook.includes("NEMOCLAW_PUBLIC_EDGE_MODE=access-proxy"));
    assert.ok(runbook.includes("NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS"));
    assert.ok(runbook.includes("nemoclaw security-check"));
    assert.ok(runbook.includes("lockdown github-pr"));
    assert.ok(runbook.includes("auth-github-worker"));
    assert.ok(runbook.includes("NEMOCLAW_OPENSHELL_SHA256"));
  });

  it("installer and docs no longer promote curl-pipe-bash setup", () => {
    const readme = read("README.md");
    const docsIndex = read("docs/index.md");
    const installer = read("scripts/install.sh");
    assert.ok(!readme.includes("curl -fsSL https://nvidia.com/nemoclaw.sh | bash"));
    assert.ok(!docsIndex.includes("curl -fsSL https://nvidia.com/nemoclaw.sh | bash"));
    assert.ok(installer.includes("Refusing to run from stdin or curl | bash"));
  });

  it("plugin commands avoid string-based shell execution for local status and version checks", () => {
    const launch = read("nemoclaw/src/commands/launch.ts");
    const status = read("nemoclaw/src/commands/status.ts");
    const logs = read("nemoclaw/src/commands/logs.ts");
    assert.ok(launch.includes('execFileSync("openshell", ["--version"]'));
    assert.ok(!launch.includes('execSync("openshell --version"'));
    assert.ok(status.includes('execFileText("openshell", ["sandbox", "status", sandboxName, "--json"]'));
    assert.ok(logs.includes('execFileText("openshell", ["sandbox", "get", sandboxName, "--json"]'));
  });

  it("cli exposes sandbox lockdown profiles for exact egress resets", () => {
    const cli = read("bin/nemoclaw.js");
    const policyLib = read("bin/lib/policies.js");
    assert.ok(cli.includes("lockdown <mode>"));
    assert.ok(cli.includes("github-agent"));
    assert.ok(cli.includes("auth-nvidia"));
    assert.ok(cli.includes("auth-github-worker"));
    assert.ok(cli.includes("heartbeat-check"));
    assert.ok(cli.includes("heartbeat-run"));
    assert.ok(cli.includes("heartbeat-install"));
    assert.ok(cli.includes("NEMOCLAW_GITHUB_WORKER_TOKEN"));
    assert.ok(cli.includes('case "lockdown"'));
    assert.ok(cli.includes('case "github-agent"'));
    assert.ok(cli.includes('case "heartbeat-run"'));
    assert.ok(cli.includes("OpenShell sandboxes detected:"));
    assert.ok(cli.includes("openshellSandboxExists"));
    assert.ok(policyLib.includes('"local-only"'));
    assert.ok(policyLib.includes('"github-pr"'));
    assert.ok(policyLib.includes("applyLockdownProfile"));
  });

  it("credentials prompt secrets through a hidden local prompt", () => {
    const creds = read("bin/lib/credentials.js");
    assert.ok(creds.includes("function promptSecret("));
    assert.ok(creds.includes("rl.stdoutMuted = true"));
    assert.ok(creds.includes('await promptSecret("  NVIDIA API Key: ")'));
    assert.ok(creds.includes('await promptSecret("  GitHub Token: ")'));
    assert.ok(creds.includes('await promptSecret("  GitHub worker token: ")'));
  });

  it("repository includes a constrained HEARTBEAT template", () => {
    const heartbeat = read("HEARTBEAT.md");
    assert.ok(heartbeat.includes("```heartbeat"));
    assert.ok(heartbeat.includes('"worker_type": "engineering"'));
    assert.ok(heartbeat.includes('"type": "github-pr"'));
    assert.ok(heartbeat.includes('"enabled": false'));
  });

  it("heartbeat installer requires a non-repo global binary and private working directory", () => {
    const heartbeat = read("bin/lib/heartbeat.js");
    assert.ok(heartbeat.includes("candidateNemoclawBinaries"));
    assert.ok(heartbeat.includes("Remove repo-linked global installs"));
    assert.ok(heartbeat.includes("heartbeatSafeWorkingDirectory"));
  });

  it("github worker sends a safely quoted remote bootstrap instead of raw multiline python args", () => {
    const worker = read("bin/lib/github-worker.js");
    assert.ok(worker.includes('function shellQuote('));
    assert.ok(worker.includes("postflightPullRequest"));
    assert.ok(worker.includes('https.request('));
    assert.ok(worker.includes('Worker changed files outside allowlist'));
    assert.ok(worker.includes('PR status: no changes detected; remote branch cleaned up.'));
    assert.ok(worker.includes('env.setdefault("GIT_AUTHOR_NAME", "NemoClaw Worker")'));
    assert.ok(worker.includes('env.setdefault("GIT_EDITOR", "/bin/true")'));
    assert.ok(worker.includes('Buffer.from(REMOTE_PY, "utf-8").toString("base64")'));
    assert.ok(worker.includes('base64.b64decode'));
    assert.ok(worker.includes('env["GIT_ASKPASS"] = askpass_path'));
    assert.ok(worker.includes('env["GIT_TERMINAL_PROMPT"] = "0"'));
    assert.ok(worker.includes('os.unlink(askpass_path)'));
    assert.ok(!worker.includes('          "python3",\n          "-c",\n          REMOTE_PY,'));
  });
});
