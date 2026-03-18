# Blackfort

<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-See%20SECURITY.md-red)](SECURITY.md)
[![Project Status](https://img.shields.io/badge/status-template-orange)](docs/about/release-notes.md)
<!-- end-badges -->

Blackfort is a hardened NemoClaw skeleton for running OpenClaw workers inside OpenShell with a narrower default attack surface.
It is designed to be cloned into a new repository and configured with the operator's own credentials, repositories, access controls, and runtime choices.

This repository does not contain personal tokens, host-specific paths, private task files, or machine-bound runtime state.
The CLI and package names remain `nemoclaw`; `Blackfort` is the template identity.

> **Alpha software**
>
> The hardening model is real, but this is still early-stage software.
> Expect sharp edges, incomplete ergonomics, and ongoing changes in the plugin and automation layers.

---

## What Blackfort Includes

- hardened `nemoclaw` host CLI
- OpenClaw plugin and OpenShell blueprint wiring
- deny-by-default service startup posture
- local-only default runtime mode
- scoped GitHub worker flow for branch-and-PR work
- disabled-by-default unattended `HEARTBEAT.md` engineering worker
- public-safe templates for secrets, publishing, onboarding, and maintenance

## What Blackfort Intentionally Excludes

- real API keys, tokens, passwords, or certificates
- host keychain data
- `~/.nemoclaw/*` and `~/.openclaw/*` runtime state
- LaunchAgents or scheduler state from a specific machine
- pinned SSH host keys from a specific operator environment
- repo-specific heartbeat tasks
- private recon or host-specific maintenance notes

## Security Posture

| Area | Current behavior |
|---|---|
| Secrets | Stored through hidden local prompts and OS-backed credential storage; no checked-in `.env` secrets |
| Public exposure | Off by default; hardened mode disables raw demo tunnels |
| UI access | Loopback-only by default |
| Sandbox egress | `local-only` by default; broader egress is profile-driven and explicit |
| GitHub automation | Fine-grained worker token injected only for explicit tasks |
| Deploy trust | Remote deploy path requires SSH host-key pinning |
| Unattended work | Disabled by default; engineering-only; one task source; narrow allowed paths |
| PR workflow | Branch-based flow with host-side allowlist validation and PR creation fallback |
| Drift detection | `nemoclaw security-check` verifies hardened local posture |

## What This Hardening Actually Reduces

- accidental public exposure of the local control surface
- plaintext secret sprawl in the repository
- broad always-on network access for the worker
- direct-to-branch automation without PR boundaries
- unattended repo edits outside declared path allowlists
- transport trust downgrade during remote deploys
- lingering broad GitHub egress after a one-off repo task

## What It Does Not Guarantee

Blackfort is not unhackable.
It does not eliminate risk from:

- a compromised operator workstation
- zero-days in macOS, Linux, Docker, OpenShell, OpenClaw, Node, or dependencies
- supply-chain compromise in upstream artifacts you choose to trust
- mis-scoped GitHub or cloud credentials
- unsafe runtime changes made after installation
- exposed infrastructure placed in front of the worker without proper identity controls

## Quick Start

1. Read [TEMPLATE_SETUP.md](TEMPLATE_SETUP.md).
2. Read [PUBLISHING.md](PUBLISHING.md).
3. Review [.env.example](.env.example) and keep it placeholder-only.
4. Install from a reviewed local checkout.
5. Store secrets locally with the built-in hidden prompts.
6. Keep the runtime in `local-only` until `nemoclaw security-check` passes.

### Install

```console
$ git clone <your-repo-url>
$ cd <your-repo-directory>
$ export NEMOCLAW_OPENSHELL_SHA256=<expected-openshell-archive-sha256>
$ bash scripts/install.sh
```

### Store credentials locally

```console
$ nemoclaw auth-nvidia
$ nemoclaw auth-github-worker
```

### Verify the hardened baseline

```console
$ nemoclaw start
$ nemoclaw security-check
$ npm test
```

## Included Workflows

- local-only sandboxed interactive work
- one-off GitHub branch-and-PR tasks
- scheduled `HEARTBEAT.md` engineering tasks
- controlled egress switching between `local-only` and `github-pr`

## Current Implementation

| Component | Location | Purpose |
|---|---|---|
| Host CLI | `bin/nemoclaw.js` | Install, security checks, sandbox management, heartbeat control |
| GitHub worker path | `bin/lib/github-worker.js` | Scoped repo automation, branch/PR flow, postflight validation |
| Heartbeat controller | `bin/lib/heartbeat.js` | Scheduled engineering worker with fail-closed preflight |
| Sandbox startup | `scripts/nemoclaw-start.sh` | Secure-by-default OpenClaw startup inside the sandbox |
| Service launcher | `scripts/start-services.sh` | Deny-by-default ingress and auxiliary service control |
| Policies | `nemoclaw-blueprint/policies/` | Network and capability boundaries |

## Unattended Worker Model

- `HEARTBEAT.md` is the only unattended task intake in this hardened build.
- It is disabled by default.
- Tasks are engineering-only and currently modeled as GitHub PR work.
- Each task must declare:
  - repository
  - base branch
  - branch prefix
  - workspace path
  - allowed edit paths
  - runtime limit
- The worker returns the sandbox to `local-only` after GitHub-capable tasks.

## Learn More

- [TEMPLATE_SETUP.md](TEMPLATE_SETUP.md)
- [PUBLISHING.md](PUBLISHING.md)
- [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md)
- [HEARTBEAT.md](HEARTBEAT.md)
- [docs/reference/commands.md](docs/reference/commands.md)
- [docs/deployment/hardened-instance-runbook.md](docs/deployment/hardened-instance-runbook.md)

## License

This project is licensed under the [Apache License 2.0](LICENSE).
