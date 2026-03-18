// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadHeartbeatModule(tempHome) {
  process.env.HOME = tempHome;
  const modulePath = require.resolve("../bin/lib/heartbeat");
  delete require.cache[modulePath];
  return require("../bin/lib/heartbeat");
}

describe("heartbeat configuration", () => {
  it("loads the checked-in HEARTBEAT template", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-home-"));
    const heartbeat = loadHeartbeatModule(tempHome);
    const config = heartbeat.loadHeartbeatConfig(path.join(__dirname, "..", "HEARTBEAT.md"));
    assert.equal(config.enabled, false);
    assert.equal(config.workerType, "engineering");
    assert.equal(config.sandbox, "nemoclaw");
    assert.equal(config.scheduleMinutes, 30);
    assert.equal(config.maxTasksPerRun, 1);
    assert.equal(config.tasks.length, 1);
    assert.equal(config.tasks[0].type, "github-pr");
  });

  it("computes due tasks from revision changes", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-home-"));
    const heartbeat = loadHeartbeatModule(tempHome);
    const filePath = path.join(tempHome, "HEARTBEAT.md");
    fs.writeFileSync(
      filePath,
      `# test\n\n\`\`\`heartbeat\n${JSON.stringify({
        version: 1,
        enabled: true,
        worker_type: "engineering",
        sandbox: "nemoclaw",
        schedule_minutes: 15,
        max_tasks_per_run: 1,
        tasks: [
          {
            id: "repo-fix",
            enabled: true,
            type: "github-pr",
            repo: "owner/repo",
            revision: "1",
            base_branch: "main",
            branch_prefix: "nemoclaw/fix-",
            workdir: "/sandbox/workspaces/owner-repo",
            allowed_paths: ["src/**"],
            max_runtime_minutes: 15,
            prompt: "Fix the bug.",
          },
        ],
      }, null, 2)}\n\`\`\`\n`,
      "utf-8",
    );
    const config = heartbeat.loadHeartbeatConfig(filePath);
    const state = { taskState: { "repo-fix": { lastSuccessfulRevision: "0" } } };
    assert.deepEqual(heartbeat.dueTasks(config, state).map((task) => task.id), ["repo-fix"]);
    state.taskState["repo-fix"].lastSuccessfulRevision = "1";
    assert.deepEqual(heartbeat.dueTasks(config, state), []);
  });

  it("builds a constrained heartbeat prompt", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-home-"));
    const heartbeat = loadHeartbeatModule(tempHome);
    const prompt = heartbeat.buildTaskPrompt({
      id: "repo-fix",
      repo: "owner/repo",
      baseBranch: "main",
      branchPrefix: "nemoclaw/fix-",
      workdir: "/sandbox/workspaces/owner-repo",
      allowedPaths: ["src/**", "docs/**"],
      prompt: "Fix the issue.",
    });
    assert.match(prompt, /heartbeat hardened mode/);
    assert.match(prompt, /Allowed paths: src\/\*\*, docs\/\*\*/);
    assert.match(prompt, /Do not use any service outside GitHub and NVIDIA inference/);
    assert.match(prompt, /Use non-interactive git commands only/);
    assert.match(prompt, /Status: changed \| no-change \| blocked/);
    assert.match(prompt, /Branch name: <branch-name-or-none>/);
    assert.match(prompt, /PR URL: <url-or-none>/);
  });

  it("prefers a non-repo-installed nemoclaw binary for heartbeat launch", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-home-"));
    const binDir = path.join(tempHome, "bin");
    const installedDir = path.join(tempHome, "installed");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(installedDir, "bin"), { recursive: true });
    fs.symlinkSync(path.join(__dirname, "..", "bin", "nemoclaw.js"), path.join(binDir, "nemoclaw"));
    fs.writeFileSync(path.join(installedDir, "bin", "nemoclaw"), "#!/usr/bin/env bash\n", { mode: 0o755 });

    const heartbeat = loadHeartbeatModule(tempHome);
    process.env.PATH = `${binDir}${path.delimiter}${path.join(installedDir, "bin")}`;
    const resolved = heartbeat.resolveInstalledNemoclawBinary();
    assert.notEqual(resolved, path.join(binDir, "nemoclaw"));
    assert.equal(heartbeat.candidateNemoclawBinaries().includes(resolved), true);
    assert.equal(fs.realpathSync(resolved).startsWith(path.join(__dirname, "..")), false);
  });
});
