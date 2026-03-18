# GitHub Repository Setup

Use this file to configure the hosted repository after pushing the template.
These settings are the recommended public baseline for Blackfort as a security-first engineering worker template.

## About Section

Recommended repository description:

`Hardened OpenShell and OpenClaw worker template with local-only defaults, scoped GitHub PR automation, and fail-closed heartbeat tasks.`

Recommended short tagline:

`Security-first agent worker template for OpenShell and OpenClaw.`

Recommended topics:

- `agent-security`
- `automation`
- `github-automation`
- `openclaw`
- `openshell`
- `sandbox`
- `security-hardening`
- `template`

Keep the website field empty unless you intentionally publish maintained docs or a project site.

## Repository Features

Recommended defaults:

- `Issues`: on
- `Projects`: off until you actually use them
- `Wiki`: off
- `Discussions`: off until you are ready to moderate them
- `Sponsorships`: off unless you intentionally support funding through GitHub
- `Preserve this repository`: off

Reasoning:

- `Issues` is the lowest-friction public intake path.
- `Wiki` and `Discussions` expand the public surface area and moderation burden without improving the security posture of the template.
- `Projects` can stay off until you need public planning artifacts.

## Default Branch and Rulesets

Recommended baseline for `main`:

- require pull requests before merge
- require at least 1 approval
- dismiss stale approvals on new commits
- require approval of the most recent reviewable push
- require conversation resolution before merge
- block force pushes
- block deletions
- keep bypass lists empty
- disable auto-merge

Only require status checks after you have stable CI configured.
Do not create a fake gate by requiring checks that do not exist yet.

## Security Settings

Enable these if your GitHub plan supports them:

- dependency graph
- Dependabot alerts
- Dependabot security updates
- private vulnerability reporting
- secret scanning
- push protection

If code scanning is added later, keep it advisory until the signal quality is good enough to enforce.

## GitHub Actions

Recommended baseline:

- keep GitHub Actions disabled until workflows are reviewed and intentional
- if Actions are enabled later:
  - set default `GITHUB_TOKEN` permissions to read-only
  - do not allow Actions to create or approve pull requests
  - only allow reviewed actions from trusted publishers or pinned SHAs

## Pages and Releases

- keep GitHub Pages off unless the published docs are intentionally curated and scrubbed
- do not publish release artifacts that contain local runtime state, caches, or machine-specific config
- if you publish binaries later, attach checksums and a verification workflow

## After Every Material Repository Change

1. Run the checks in [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md).
2. Re-read [SECURITY.md](SECURITY.md) if the change affects trust boundaries, network policy, secrets, sandboxing, or unattended execution.
3. Update [README.md](README.md) if user-visible behavior changed.
