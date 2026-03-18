---
title:
  page: "Set Up the NemoClaw Telegram Bridge for Remote Agent Chat"
  nav: "Set Up Telegram Bridge"
description: "Forward messages between Telegram and the sandboxed OpenClaw agent."
keywords: ["nemoclaw telegram bridge", "telegram bot openclaw agent"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "telegram", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the Telegram Bridge

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Telegram bot token from [BotFather](https://t.me/BotFather).
- A fixed allowlist configured through `ALLOWED_CHAT_IDS` or a pre-created Telegram allowlist file.

## Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Set the Environment Variable

Export the bot token and enable the bridge explicitly:

```console
$ export NEMOCLAW_ENABLE_TELEGRAM=1
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Start Auxiliary Services

Start the Telegram bridge:

```console
$ export ALLOWED_CHAT_IDS="123456789"
$ nemoclaw start
```

The Telegram bridge is disabled by default.
It starts only when `NEMOCLAW_ENABLE_TELEGRAM=1` is set and a fixed allowlist has been configured.

## Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
$ nemoclaw security-check
```

The output shows the status of all auxiliary services.

## Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Restrict Access by Chat ID

To restrict which Telegram chats can interact with the agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Enrollment Codes and Hardened Mode

One-time enrollment codes are not part of the hardened `prod-secure` posture.
If you temporarily enable enrollment outside `prod-secure`, treat that as a transitional onboarding state, convert the enrolled chats into a fixed allowlist, remove the enrollment settings, restart the bridge, and run `nemoclaw security-check` again.

## Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Run a Hardened NemoClaw Instance](hardened-instance-runbook.md) for the exact ingress settings used by a hardened deployment.
- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Telegram support.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
