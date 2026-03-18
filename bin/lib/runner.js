// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Auto-detect Colima Docker socket (legacy ~/.colima or XDG ~/.config/colima)
if (!process.env.DOCKER_HOST) {
  const home = process.env.HOME || "/tmp";
  const candidates = [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ];
  for (const sock of candidates) {
    if (fs.existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`;
      break;
    }
  }
}

function spawn(command, args = [], opts = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

function run(command, args = [], opts = {}) {
  const result = spawn(command, args, {
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(
      `  Command failed (exit ${result.status || 1}): ${formatCommand(command, args).slice(0, 160)}`,
    );
    process.exit(result.status || 1);
  }
  return result;
}

function runCapture(command, args = [], opts = {}) {
  const result = spawn(command, args, opts);
  if (result.status !== 0) {
    if (opts.ignoreError) return "";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const detail = stderr || formatCommand(command, args);
    throw new Error(detail);
  }
  return (result.stdout || "").trim();
}

function commandExists(command) {
  const result = spawn(process.platform === "win32" ? "where" : "which", [command], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

module.exports = { ROOT, SCRIPTS, run, runCapture, spawn, commandExists, sleep };
