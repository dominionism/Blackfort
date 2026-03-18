// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateGithubWorkerToken } = require("../bin/lib/credentials");

describe("GitHub worker token validation", () => {
  it("accepts fine-grained and short-lived GitHub token formats", () => {
    assert.equal(validateGithubWorkerToken("github_pat_example"), null);
    assert.equal(validateGithubWorkerToken("ghs_example"), null);
    assert.equal(validateGithubWorkerToken("ghu_example"), null);
  });

  it("rejects classic personal access tokens by default", () => {
    assert.match(
      validateGithubWorkerToken("ghp_example"),
      /Classic GitHub personal access tokens are too broad/,
    );
  });

  it("allows classic tokens only behind an explicit override", () => {
    process.env.NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN = "1";
    try {
      assert.equal(validateGithubWorkerToken("ghp_example"), null);
    } finally {
      delete process.env.NEMOCLAW_ALLOW_CLASSIC_GITHUB_TOKEN;
    }
  });

  it("rejects empty and malformed values", () => {
    assert.match(validateGithubWorkerToken(""), /Token required/);
    assert.match(validateGithubWorkerToken("not-a-token"), /Unrecognized GitHub token format/);
  });
});
