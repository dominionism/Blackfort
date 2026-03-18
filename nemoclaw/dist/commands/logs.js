"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliLogs = cliLogs;
/**
 * `openclaw nemoclaw logs` — stream or tail blueprint execution and sandbox logs.
 */
const node_child_process_1 = require("node:child_process");
const state_js_1 = require("../blueprint/state.js");
async function cliLogs(opts) {
    const { follow, lines, runId, logger, pluginConfig } = opts;
    const state = (0, state_js_1.loadState)();
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
    if (follow)
        args.push("-f");
    args.push("-n", String(lines));
    args.push("/tmp/nemoclaw.log", "/tmp/openclaw.log");
    const proc = (0, node_child_process_1.spawn)("openshell", args, { stdio: ["ignore", "inherit", "inherit"] });
    await new Promise((resolve) => {
        proc.on("close", () => resolve());
        proc.on("error", (err) => {
            logger.error(`Failed to stream logs: ${err.message}`);
            resolve();
        });
    });
}
function execFileText(file, args, timeout) {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(file, args, { encoding: "utf-8", timeout }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}
async function isSandboxRunning(sandboxName) {
    try {
        const stdout = await execFileText("openshell", ["sandbox", "get", sandboxName, "--json"], 5000);
        const parsed = JSON.parse(stdout);
        return parsed.state === "running";
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=logs.js.map
