---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description: "Full CLI reference for plugin and standalone NemoClaw commands."
keywords: ["nemoclaw cli commands", "nemoclaw command reference"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Commands

NemoClaw provides two command interfaces.
The plugin commands run under the `openclaw nemoclaw` namespace inside the OpenClaw CLI.
The standalone `nemoclaw` binary handles host-side setup, deployment, and service management.
Both interfaces are installed when you install NemoClaw from a reviewed local source tree or another pinned release source.

## Plugin Commands

### `openclaw nemoclaw launch`

Bootstrap OpenClaw inside an OpenShell sandbox.
If NemoClaw detects an existing host installation, `launch` stops unless you pass `--force`.

```console
$ openclaw nemoclaw launch [--force] [--profile <profile>]
```

`--force`
: Skip the ergonomics warning and force plugin-driven bootstrap. Without this flag,
  NemoClaw recommends using `openshell sandbox create` directly for new installs.

`--profile <profile>`
: Blueprint profile to use. Default: `default`.

### `nemoclaw <name> connect`

Open an interactive shell inside the OpenClaw sandbox.
Use this after launch to connect and chat with the agent through the TUI or CLI.

```console
$ nemoclaw my-assistant connect
```

### `openclaw nemoclaw status`

Display sandbox health, blueprint run state, and inference configuration.

```console
$ openclaw nemoclaw status [--json]
```

`--json`
: Output as JSON for programmatic consumption.

### `openclaw nemoclaw logs`

Stream blueprint execution and sandbox logs.

```console
$ openclaw nemoclaw logs [-f] [-n <count>] [--run-id <id>]
```

`-f, --follow`
: Follow log output, similar to `tail -f`.

`-n, --lines <count>`
: Number of lines to show. Default: `50`.

`--run-id <id>`
: Show logs for a specific blueprint run instead of the latest.

### `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw status` | Show sandbox and inference state |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw onboard`

Run the interactive setup wizard.
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard
```

The first run prompts for your NVIDIA API key and stores it in the OS credential backend when one is available.
On macOS that is the Keychain. On Linux desktops it is the libsecret keyring. Plaintext file fallback now requires explicit opt-in.

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy script installs Docker, NVIDIA Container Toolkit if a GPU is present, and OpenShell on the VM, then runs the nemoclaw setup and connects to the sandbox.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw security-check`

Verify the local hardening state before exposing remote access or reconnecting to a remote host.
This command checks for insecure UI flags, plaintext secret storage, raw public tunnel exposure, Telegram gating, and optionally SSH host-key pinning for a remote target.

```console
$ nemoclaw security-check [remote-host]
```

### `nemoclaw auth-nvidia`

Store the NVIDIA API key in the OS credential backend without exposing it in shell history or chat.
The prompt is local and hidden.

```console
$ nemoclaw auth-nvidia
```

### `nemoclaw auth-github-worker`

Store a dedicated GitHub worker token in the OS credential backend without exposing it in shell history or chat.
The prompt is local and hidden.

```console
$ nemoclaw auth-github-worker
```

Use a fine-grained PAT or short-lived GitHub App token only.
Do not use a broad classic personal access token unless you have explicitly dropped the hardening bar.

### `nemoclaw heartbeat-check`

Validate the active `HEARTBEAT.md` file and show which tasks are currently due.
Before installation this defaults to the checked-in repo template.
After `heartbeat-install`, it defaults to the private installed copy at `~/.nemoclaw/heartbeat/HEARTBEAT.md`.

```console
$ nemoclaw heartbeat-check
$ nemoclaw heartbeat-check --file /path/to/HEARTBEAT.md
```

### `nemoclaw heartbeat-run`

Run due `HEARTBEAT.md` tasks once.
This command is intended for unattended launchd execution and fails closed if the runtime is not in a clean hardened state.
In the installed scheduler path it runs against `~/.nemoclaw/heartbeat/HEARTBEAT.md`.

```console
$ nemoclaw heartbeat-run
```

### `nemoclaw heartbeat-status`

Show the installed heartbeat scheduler state, the configured schedule, and the due task ids.

```console
$ nemoclaw heartbeat-status
```

### `nemoclaw heartbeat-install`

Install the heartbeat scheduler as a user-local launchd job.
The generated wrapper script does not contain secrets.
This command copies the current `HEARTBEAT.md` into `~/.nemoclaw/heartbeat/HEARTBEAT.md` and the launchd job uses that private copy so it does not depend on repo access under protected directories.

```console
$ nemoclaw heartbeat-install
```

### `nemoclaw heartbeat-uninstall`

Remove the heartbeat launchd job and wrapper script.

```console
$ nemoclaw heartbeat-uninstall
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> destroy`

Stop the NIM container and delete the sandbox.
This removes the sandbox from the registry.

```console
$ nemoclaw my-assistant destroy
```

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.

```console
$ nemoclaw my-assistant policy-add
```

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `nemoclaw <name> lockdown`

Replace the live sandbox egress policy with an exact hardened profile instead of incrementally adding more hosts over time.
Use this to reset the sandbox back to the strict baseline before leaving it unattended, or to grant the minimum GitHub access needed for PR work.

```console
$ nemoclaw my-assistant lockdown <profile>
```

Available built-in profiles:

- `local-only`: baseline NVIDIA inference egress only
- `github-pr`: baseline plus GitHub HTTPS/API access for `git` and `curl`

Examples:

```console
$ nemoclaw my-assistant lockdown local-only
$ nemoclaw my-assistant lockdown github-pr
$ nemoclaw security-check
```

### `nemoclaw <name> github-agent`

Run one GitHub-capable OpenClaw task with a temporary GitHub worker token injection.
This command is designed for hardened PR work:

- it prompts for a dedicated fine-grained or short-lived GitHub worker token if one is not already stored in the OS credential backend
- it switches the sandbox to the exact `github-pr` egress profile
- it injects the worker token only into the remote agent process
- it restores the sandbox to `local-only` when the task exits, unless you explicitly keep the GitHub profile active

```console
$ nemoclaw my-assistant github-agent --message "<task>"
```

Optional flags:

- `--session-id <id>`: set the OpenClaw session identifier
- `--keep-github-profile`: leave the sandbox in `github-pr` after the task exits

Example:

```console
$ nemoclaw my-assistant github-agent \
    --message "Review the current repo, implement the fix, push a branch, and open a PR."
```

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw start`

Start explicitly enabled auxiliary services.
Remote browser access is no longer exposed through a raw public tunnel by default.
Use an authenticated access proxy for remote UI access, and enable Telegram only with a fixed allowlist in `prod-secure` mode.

```console
$ nemoclaw start
```

Examples:

```console
$ export NEMOCLAW_ENABLE_TELEGRAM=1
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
$ export ALLOWED_CHAT_IDS=123456789
$ nemoclaw start
```

Run `nemoclaw security-check` after changing any ingress, UI, or credential settings.

### `nemoclaw stop`

Stop all auxiliary services.

```console
$ nemoclaw stop
```

### `nemoclaw status`

Show the sandbox list and the status of auxiliary services.

```console
$ nemoclaw status
```

See [Run a Hardened NemoClaw Instance](../deployment/hardened-instance-runbook.md) for the exact operator sequence and environment settings used by a hardened deployment.

### `nemoclaw setup-spark`

Set up NemoClaw on DGX Spark.
This command applies cgroup v2 and Docker fixes required for Ubuntu 24.04.
Run with `sudo` on the Spark host.
