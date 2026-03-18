// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `openclaw nemoclaw logs` — stream or tail blueprint execution and sandbox logs.
 */

import { execFile, spawn } from "node:child_process";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import { loadState } from "../blueprint/state.js";

export interface LogsOptions {
  follow: boolean;
  lines: number;
  runId?: string;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8", timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function cliLogs(opts: LogsOptions): Promise<void> {
  const { follow, lines, runId, logger, pluginConfig } = opts;
  const state = loadState();
  const sandboxName = state.sandboxName ?? pluginConfig.sandboxName;

  const targetRunId = runId ?? state.lastRunId;

  if (targetRunId) {
    logger.info(`Blueprint run: ${targetRunId}`);
    logger.info(`Action: ${state.lastAction ?? "unknown"}`);
    logger.info("");
  }

  // Stream sandbox logs via openshell
  const sandboxRunning = await isSandboxRunning(sandboxName);
  if (!sandboxRunning) {
    logger.info(`Sandbox '${sandboxName}' is not running. No live logs available.`);
    return;
  }

  logger.info(`Streaming logs from sandbox '${sandboxName}'...`);
  logger.info("");

  const args = ["sandbox", "connect", sandboxName, "--", "tail"];
  if (follow) args.push("-f");
  args.push("-n", String(lines));
  args.push("/tmp/nemoclaw.log", "/tmp/openclaw.log");

  const proc = spawn("openshell", args, { stdio: ["ignore", "inherit", "inherit"] });

  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
    proc.on("error", (err) => {
      logger.error(`Failed to stream logs: ${err.message}`);
      resolve();
    });
  });
}

async function isSandboxRunning(sandboxName: string): Promise<boolean> {
  try {
    const stdout = await execFileText("openshell", ["sandbox", "get", sandboxName, "--json"], 5000);
    const parsed = JSON.parse(stdout) as { state?: string };
    return parsed.state === "running";
  } catch {
    return false;
  }
}
