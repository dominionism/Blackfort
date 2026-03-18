// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn: childSpawn } = require("child_process");

const { ROOT, runCapture } = require("./runner");
const policies = require("./policies");

const SAFE_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REMOTE_PY = `
import os
import subprocess
import sys
import tempfile

api_key = sys.stdin.readline().rstrip("\\n")
worker_token = sys.stdin.readline().rstrip("\\n")
env = os.environ.copy()
if api_key:
    env["NVIDIA_API_KEY"] = api_key
if worker_token:
    env["GITHUB_TOKEN"] = worker_token
    env["GH_TOKEN"] = worker_token
    env["GIT_TERMINAL_PROMPT"] = "0"
env.setdefault("GIT_AUTHOR_NAME", "NemoClaw Worker")
env.setdefault("GIT_AUTHOR_EMAIL", "nemoclaw@local.invalid")
env.setdefault("GIT_COMMITTER_NAME", env["GIT_AUTHOR_NAME"])
env.setdefault("GIT_COMMITTER_EMAIL", env["GIT_AUTHOR_EMAIL"])
env.setdefault("GIT_EDITOR", "/bin/true")
env.setdefault("VISUAL", env["GIT_EDITOR"])
env.setdefault("EDITOR", env["GIT_EDITOR"])

askpass_path = None
if worker_token:
    fd, askpass_path = tempfile.mkstemp(prefix="nemoclaw-git-askpass-", dir="/tmp")
    with os.fdopen(fd, "w") as handle:
        handle.write("#!/bin/sh\\n")
        handle.write('case "$1" in\\n')
        handle.write('  *Username*) printf "%s\\\\n" "x-access-token" ;;\\n')
        handle.write('  *Password*) printf "%s\\\\n" "$GITHUB_TOKEN" ;;\\n')
        handle.write('  *) printf "%s\\\\n" "$GITHUB_TOKEN" ;;\\n')
        handle.write("esac\\n")
    os.chmod(askpass_path, 0o700)
    env["GIT_ASKPASS"] = askpass_path

cmd = [
    "openclaw",
    "agent",
    "--agent",
    "main",
    "--local",
    "--session-id",
    sys.argv[1],
    "-m",
    sys.argv[2],
]
try:
    raise SystemExit(subprocess.call(cmd, env=env))
finally:
    if askpass_path:
        try:
            os.unlink(askpass_path)
        except OSError:
            pass
`.trim();

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertSafeSessionId(value) {
  if (!SAFE_SESSION_RE.test(value)) {
    throw new Error(`Invalid session id: ${value}`);
  }
}

function extractBranchName(output) {
  const match = String(output || "").match(/Branch name:\s*([^\s]+)/i);
  return match ? match[1].trim() : null;
}

function extractReportedPrUrl(output) {
  const match = String(output || "").match(/PR URL:\s*(https:\/\/github\.com\/[^\s]+)/i);
  return match ? match[1].trim() : null;
}

function isConcretePullRequestUrl(url) {
  return /\/pull\/\d+(?:[/?#]|$)/.test(String(url || ""));
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function isAllowedPathMatch(filename, allowedPath) {
  const file = normalizePath(filename);
  const rule = normalizePath(allowedPath);
  if (!file || !rule) return false;
  if (rule.endsWith("/**")) {
    const prefix = normalizePath(rule.slice(0, -3));
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return file === rule || file.startsWith(`${rule}/`);
}

function githubApiRequest({ method = "GET", endpoint, token, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.github.com",
        path: endpoint,
        method,
        headers: {
          "User-Agent": "nemoclaw-github-worker",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          const parsed = raw ? JSON.parse(raw) : null;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(parsed);
            return;
          }
          const err = new Error(`GitHub API ${method} ${endpoint} failed with status ${statusCode}`);
          err.statusCode = statusCode;
          err.response = parsed;
          reject(err);
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadCompare(repo, baseBranch, branchName, token) {
  return githubApiRequest({
    endpoint: `/repos/${repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branchName)}`,
    token,
  });
}

async function findExistingPullRequest(repo, owner, branchName, token) {
  const query = new URLSearchParams({
    head: `${owner}:${branchName}`,
    state: "all",
  }).toString();
  const pulls = await githubApiRequest({
    endpoint: `/repos/${repo}/pulls?${query}`,
    token,
  });
  return Array.isArray(pulls) && pulls.length > 0 ? pulls[0] : null;
}

async function createPullRequest(repo, baseBranch, branchName, title, body, token) {
  return githubApiRequest({
    method: "POST",
    endpoint: `/repos/${repo}/pulls`,
    token,
    body: {
      title,
      head: branchName,
      base: baseBranch,
      body,
      draft: false,
    },
  });
}

async function deleteBranch(repo, branchName, token) {
  try {
    await githubApiRequest({
      method: "DELETE",
      endpoint: `/repos/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`,
      token,
    });
  } catch (err) {
    if (err.statusCode !== 422 && err.statusCode !== 404) {
      throw err;
    }
  }
}

function summarizeChangedFiles(compare) {
  return Array.isArray(compare?.files)
    ? compare.files
        .map((file) => normalizePath(file.filename))
        .filter(Boolean)
    : [];
}

function derivePullRequestContent(compare, branchName, prTitle, prBody) {
  if (prTitle && prBody) {
    return {
      title: prTitle.trim(),
      body: prBody.trim(),
    };
  }

  const lastCommit = Array.isArray(compare?.commits) && compare.commits.length > 0
    ? compare.commits[compare.commits.length - 1]
    : null;
  const commitMessage = String(lastCommit?.commit?.message || "").trim();
  const [subject = "", ...rest] = commitMessage.split(/\r?\n/);
  const title = String(prTitle || subject || `Automated update from ${branchName}`).trim();
  let body = String(prBody || rest.join("\n").trim()).trim();

  if (!body) {
    const changedFiles = summarizeChangedFiles(compare);
    body = [
      "Automated update proposed by NemoClaw hardened mode.",
      "",
      "Changed files:",
      ...changedFiles.map((value) => `- ${value}`),
      "",
      "Review carefully before merging.",
    ].join("\n");
  }

  return { title, body };
}

async function postflightPullRequest({
  repo,
  baseBranch,
  branchName,
  branchPrefix,
  allowedPaths = [],
  prTitle,
  prBody,
  workerToken,
}) {
  if (!repo || !baseBranch || !branchName) {
    return null;
  }
  if (!SAFE_REPO_RE.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  if (branchPrefix && !branchName.startsWith(branchPrefix)) {
    throw new Error(`Worker returned branch outside required prefix: ${branchName}`);
  }

  const compare = await loadCompare(repo, baseBranch, branchName, workerToken);
  const changedFiles = summarizeChangedFiles(compare);

  if (changedFiles.length === 0 || Number(compare?.ahead_by || 0) === 0) {
    await deleteBranch(repo, branchName, workerToken);
    return {
      status: "no_changes",
      branchName,
      prUrl: null,
      changedFiles,
      compare,
    };
  }

  const disallowed = changedFiles.filter(
    (file) => !allowedPaths.some((allowedPath) => isAllowedPathMatch(file, allowedPath)),
  );
  if (disallowed.length > 0) {
    await deleteBranch(repo, branchName, workerToken);
    throw new Error(`Worker changed files outside allowlist: ${disallowed.join(", ")}`);
  }

  const owner = repo.split("/")[0];
  const existing = await findExistingPullRequest(repo, owner, branchName, workerToken);
  if (existing) {
    return {
      status: "existing_pr",
      branchName,
      prUrl: existing.html_url,
      changedFiles,
      compare,
    };
  }

  const { title, body } = derivePullRequestContent(compare, branchName, prTitle, prBody);
  const created = await createPullRequest(repo, baseBranch, branchName, title, body, workerToken);
  return {
    status: "created_pr",
    branchName,
    prUrl: created?.html_url || null,
    changedFiles,
    compare,
    prNumber: created?.number || null,
  };
}

async function runGithubWorkerTask({
  sandboxName,
  sessionId,
  message,
  apiKey,
  workerToken,
  keepGithubProfile = false,
  timeoutMs = 0,
  streamOutput = false,
  repo = "",
  baseBranch = "",
  branchPrefix = "",
  allowedPaths = [],
  prTitle = "",
  prBody = "",
}) {
  assertSafeSessionId(sessionId);
  if (!message) throw new Error("Task message is required");
  if (!apiKey) throw new Error("NVIDIA API key is required");
  if (!workerToken) throw new Error("GitHub worker token is required");

  if (!policies.applyLockdownProfile(sandboxName, "github-pr")) {
    throw new Error("Could not apply github-pr lockdown profile");
  }

  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gh-ssh-"));
  const confPath = path.join(confDir, "config");
  fs.writeFileSync(
    confPath,
    runCapture("openshell", ["sandbox", "ssh-config", sandboxName]),
    { mode: 0o600 },
  );
  const childEnv = { ...process.env };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.NEMOCLAW_GITHUB_WORKER_TOKEN;
  delete childEnv.NVIDIA_API_KEY;

  let timedOut = false;

  try {
    const remotePyB64 = Buffer.from(REMOTE_PY, "utf-8").toString("base64");
    const remoteCommand = [
      "python3",
      "-c",
      shellQuote(`import base64; exec(base64.b64decode("${remotePyB64}").decode("utf-8"))`),
      shellQuote(sessionId),
      shellQuote(message),
    ].join(" ");

    const result = await new Promise((resolve, reject) => {
      const proc = childSpawn(
        "ssh",
        [
          "-T",
          "-F",
          confPath,
          `openshell-${sandboxName}`,
          remoteCommand,
        ],
        {
          cwd: ROOT,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      let timeoutHandle = null;

      const killTimer = () => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(killTimer, timeoutMs);
        timeoutHandle.unref?.();
      }

      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (streamOutput) process.stdout.write(text);
      });
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (streamOutput) process.stderr.write(text);
      });

      proc.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });
      proc.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut) {
          reject(new Error(`github worker timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          const err = new Error(`github worker exited with status ${code ?? 1}`);
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      proc.stdin.write(`${apiKey}\n${workerToken}\n`);
      proc.stdin.end();
    });

    const branchName = extractBranchName(result.stdout || "");
    const reportedPrUrl = extractReportedPrUrl(result.stdout || "");
    const postflight = await postflightPullRequest({
      repo,
      baseBranch,
      branchName,
      branchPrefix,
      allowedPaths,
      prTitle,
      prBody,
      workerToken,
    });

    let stdout = result.stdout || "";
    if (postflight?.status === "created_pr" && postflight.prUrl && reportedPrUrl !== postflight.prUrl) {
      stdout = `${stdout.trimEnd()}\nPR URL: ${postflight.prUrl}\n`;
    }
    if (postflight?.status === "existing_pr" && postflight.prUrl && reportedPrUrl !== postflight.prUrl) {
      stdout = `${stdout.trimEnd()}\nPR URL: ${postflight.prUrl}\n`;
    }
    if (postflight?.status === "no_changes") {
      stdout = `${stdout.trimEnd()}\nPR status: no changes detected; remote branch cleaned up.\n`;
    }

    return {
      ...result,
      stdout,
      branchName: postflight?.branchName || branchName,
      prUrl: postflight?.prUrl || (isConcretePullRequestUrl(reportedPrUrl) ? reportedPrUrl : null),
      changedFiles: postflight?.changedFiles || [],
      postflightStatus: postflight?.status || null,
    };
  } finally {
    try {
      fs.rmSync(confDir, { recursive: true, force: true });
    } catch {}

    if (!keepGithubProfile) {
      policies.applyLockdownProfile(sandboxName, "local-only");
    }
  }
}

module.exports = {
  runGithubWorkerTask,
  _internal: {
    extractBranchName,
    extractReportedPrUrl,
    isAllowedPathMatch,
    derivePullRequestContent,
    isConcretePullRequestUrl,
  },
};
