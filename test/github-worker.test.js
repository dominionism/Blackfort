// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _internal } = require("../bin/lib/github-worker");

describe("github worker helpers", () => {
  it("parses reported branch names and PR URLs", () => {
    const output = [
      "Status: changed",
      "Branch name: nemoclaw/example-1",
      "PR URL: https://github.com/example/repo/pull/42",
      "Blocker: none",
    ].join("\n");
    const sameLineOutput = "Branch name: nemoclaw/example-2 PR URL: https://github.com/example/repo/pull/new/nemoclaw/example-2 HEARTBEAT_OK";

    assert.equal(_internal.extractBranchName(output), "nemoclaw/example-1");
    assert.equal(_internal.extractReportedPrUrl(output), "https://github.com/example/repo/pull/42");
    assert.equal(_internal.extractBranchName(sameLineOutput), "nemoclaw/example-2");
    assert.equal(
      _internal.extractReportedPrUrl(sameLineOutput),
      "https://github.com/example/repo/pull/new/nemoclaw/example-2",
    );
    assert.equal(_internal.isConcretePullRequestUrl("https://github.com/example/repo/pull/42"), true);
    assert.equal(_internal.isConcretePullRequestUrl("https://github.com/example/repo/pull/new/nemoclaw/example-1"), false);
  });

  it("matches exact files and directory globs in the allowlist", () => {
    assert.equal(_internal.isAllowedPathMatch("Website/README.md", "Website/README.md"), true);
    assert.equal(_internal.isAllowedPathMatch("src/components/button.tsx", "src/**"), true);
    assert.equal(_internal.isAllowedPathMatch("docs/runbook.md", "src/**"), false);
  });

  it("derives pull request content from the last commit message when needed", () => {
    const compare = {
      commits: [
        {
          commit: {
            message: "Refresh Website README\n\nDocument the local development flow.",
          },
        },
      ],
      files: [{ filename: "Website/README.md" }],
    };

    const content = _internal.derivePullRequestContent(compare, "nemoclaw/example-1", "", "");
    assert.equal(content.title, "Refresh Website README");
    assert.match(content.body, /Document the local development flow/);
  });
});
