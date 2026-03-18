---
title:
  page: "Run a Hardened NemoClaw Instance"
  nav: "Hardened Instance Runbook"
description: "Operator runbook for running NemoClaw with the narrowest practical exposure."
keywords: ["nemoclaw hardening", "nemoclaw security runbook", "nemoclaw hardened deployment"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "security", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: advanced
  audience: ["developer", "engineer", "operator"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Run a Hardened NemoClaw Instance

This runbook targets the narrowest practical attack surface NemoClaw can provide from within this repository.
It does not make the system unhackable.
It removes the insecure defaults that create easy entry paths, forces identity at exposed boundaries, and gives you a repeatable verification step.

## Preferred Operating Mode: Local Only

Use local-only mode unless you have a concrete requirement for remote browser access or Telegram ingress.

Keep these settings unset or disabled:

```console
$ unset NEMOCLAW_ENABLE_PUBLIC_EDGE
$ unset NEMOCLAW_PUBLIC_EDGE_MODE
$ unset NEMOCLAW_ACCESS_PROXY_URL
$ unset NEMOCLAW_ALLOW_INSECURE_DEMO_TUNNEL
$ unset NEMOCLAW_ENABLE_TELEGRAM
$ unset TELEGRAM_BOT_TOKEN
$ unset ALLOWED_CHAT_IDS
$ unset NEMOCLAW_TELEGRAM_ENROLLMENT_CODE
$ unset NEMOCLAW_ALLOW_INSECURE_UI
$ unset NEMOCLAW_ENABLE_AUTO_PAIR
$ unset NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS
$ unset NEMOCLAW_ENABLE_EXPERIMENTAL_LOCAL_INFERENCE
$ export NEMOCLAW_SECURITY_PROFILE=prod-secure
```

Then start the local services:

```console
$ nemoclaw start
```

Verify the posture:

```console
$ nemoclaw security-check
```

If you have widened sandbox egress during interactive work, reset it before leaving the instance unattended:

```console
$ nemoclaw nemoclaw lockdown local-only
$ nemoclaw security-check
```

`security-check` now also verifies that the local loopback UI bridge is reachable and reports the effective sandbox egress profile.

## Background GitHub PR Work: Minimal Egress Only

Do not leave broad ad hoc egress approvals in place just because the agent occasionally needs to touch GitHub.
Switch into a narrow GitHub worker profile before that work, and switch back to `local-only` when the task is done.

```console
$ nemoclaw nemoclaw lockdown github-pr
$ nemoclaw security-check
```

This profile allows only:

- baseline NVIDIA inference egress
- `github.com`
- `api.github.com`
- the `git`, `curl`, and required Git HTTPS helper binaries inside the sandbox

Use a fine-grained GitHub token scoped only to the repositories and actions the worker actually needs.
Do not give the sandbox a broad personal token with full account access.
Do not paste the token into chat or store it in shell history.

Store it locally through the hidden prompt:

```console
$ nemoclaw auth-github-worker
```

Preferred execution path:

```console
$ nemoclaw nemoclaw github-agent \
    --message "Review the repo, implement the change, push a branch, and open a PR."
```

This command stores the GitHub worker token in the OS credential backend, injects it only into the sandboxed agent process for that task, and returns the sandbox to `local-only` when the task exits.

After the GitHub task completes:

```console
$ nemoclaw nemoclaw lockdown local-only
$ nemoclaw security-check
```

## Remote Browser Access: Access Proxy Only

Do not expose the control UI through a raw public tunnel in a hardened deployment.
If you need remote browser access, place a separate authenticated access proxy in front of the host and make the proxy enforce identity before it forwards traffic.

Set:

```console
$ export NEMOCLAW_ENABLE_PUBLIC_EDGE=1
$ export NEMOCLAW_PUBLIC_EDGE_MODE=access-proxy
$ export NEMOCLAW_ACCESS_PROXY_URL=https://nemoclaw.example.com
$ unset NEMOCLAW_ALLOW_INSECURE_DEMO_TUNNEL
$ export NEMOCLAW_SECURITY_PROFILE=prod-secure
```

Leave `NEMOCLAW_ALLOWED_ORIGINS` empty unless you have another specific trusted browser origin that must reach the control UI.

After updating the environment, restart services and verify:

```console
$ nemoclaw stop
$ nemoclaw start
$ nemoclaw security-check
```

## SSH Host-Key Pinning for Remote Deploy

`nemoclaw deploy` now fails closed unless the target host key is pinned.
Do not trust `ssh-keyscan` output blindly.
Obtain the expected fingerprint through a separate trusted path, compare it, then pin the key.

Example flow:

```console
$ ssh-keyscan <instance-name> > /tmp/<instance-name>.known_hosts
$ ssh-keygen -lf /tmp/<instance-name>.known_hosts
```

After you confirm the fingerprint through a trusted channel, append it to your pinned file:

```console
$ mkdir -p ~/.ssh
$ chmod 700 ~/.ssh
$ cat /tmp/<instance-name>.known_hosts >> ~/.ssh/known_hosts
$ chmod 600 ~/.ssh/known_hosts
```

Then verify locally before deployment or reconnect:

```console
$ nemoclaw security-check <instance-name>
```

If you maintain a separate pinned host-key file, export `NEMOCLAW_SSH_KNOWN_HOSTS=/path/to/known_hosts` before running the check or the deploy command.

## Telegram Bridge: Restricted Mode Only

Leave Telegram disabled unless you need it.
If you enable it, use a fixed allowlist only.

Preferred steady-state configuration:

```console
$ export NEMOCLAW_ENABLE_TELEGRAM=1
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
$ export ALLOWED_CHAT_IDS=123456789
$ unset NEMOCLAW_TELEGRAM_ENROLLMENT_CODE
$ nemoclaw stop
$ nemoclaw start
$ nemoclaw security-check
```

Do not enable Telegram enrollment codes in a hardened deployment.
If you ever drop out of `prod-secure` to onboard chats, that state is temporary and should be treated as a reduced-assurance maintenance window, not normal operation.

## Secrets Handling

Store the NVIDIA API key and any GitHub token through the OS credential backend when prompted by `nemoclaw onboard` or `nemoclaw deploy`.
For unattended engineering work, store the dedicated GitHub worker token through the hidden local prompt:

```console
$ nemoclaw auth-github-worker
```

Do not paste the worker token into chat or store it in shell history.

Do not enable plaintext secret storage:

```console
$ unset NEMOCLAW_ALLOW_PLAINTEXT_CREDENTIALS
```

If `~/.nemoclaw/credentials.json` still exists from an older setup, remove it only after you have confirmed the credentials were migrated into the OS-backed store and `nemoclaw security-check` passes.

## Unattended Heartbeat Mode: Constrained Only

If you want NemoClaw to work while you are away, do not turn it into a permanently broad always-on agent.
Use the checked-in `HEARTBEAT.md` file as the source template, then install the scheduler so it copies that file into `~/.nemoclaw/heartbeat/HEARTBEAT.md`.
Review and edit the installed copy, not an arbitrary duplicate.

The hardened heartbeat worker:

- accepts only structured tasks from `HEARTBEAT.md`
- runs one task at a time
- reruns a task only when its `revision` changes
- uses the `github-pr` egress profile only during the task
- returns the sandbox to `local-only` after the task
- writes a chained local audit log under `~/.nemoclaw/heartbeat`

Recommended setup:

```console
$ nemoclaw heartbeat-check
$ nemoclaw heartbeat-install
$ nemoclaw heartbeat-status
```

After `heartbeat-install`, the active unattended task file is `~/.nemoclaw/heartbeat/HEARTBEAT.md`.
Keep that file disabled until the task list is correct and the runtime passes `nemoclaw security-check`.
Do not use unattended heartbeat mode for broad business operations in this hardened build.
The supported unattended mode here is an engineering worker only.

## Local Verification Sequence

Run this sequence after installation, after deployment changes, and after changing ingress settings:

```console
$ nemoclaw security-check
$ npm test
$ nemoclaw status
$ openshell term
```

Use `nemoclaw security-check <instance-name>` when you also need to verify SSH host-key pinning for a remote target.

If your install path downloads OpenShell, set `NEMOCLAW_OPENSHELL_SHA256` to the expected release archive digest before running the installer or remote bootstrap.

For generic maintenance, use [UPDATE_RUNBOOK.md](../../../UPDATE_RUNBOOK.md).
That runbook is intentionally host-neutral and assumes only the standard installed private heartbeat file at `~/.nemoclaw/heartbeat/HEARTBEAT.md`.

## Controls This Repository Cannot Enforce for You

Some of the strongest controls are outside the NemoClaw codebase and still require operator action:

- The access proxy itself must enforce strong identity and session controls.
- The operator workstation must be hardened because it holds credentials and can approve egress.
- CI/CD provenance, signed release artifacts, and SBOM verification depend on your release pipeline.
- The container base image should be pinned to an approved digest during your release process.

Those controls still matter even after the repo-side hardening is in place.
