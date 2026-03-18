#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Keep a loopback-only SSH port forward open from the host to the sandbox UI.

set -euo pipefail

PATH="${HOME:-/tmp}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SANDBOX_NAME="${NEMOCLAW_SANDBOX:-nemoclaw}"
UI_PORT="${NEMOCLAW_UI_PORT:-18789}"
SSH_CONFIG="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-ssh-config.XXXXXX")"

cleanup() {
  rm -f "$SSH_CONFIG"
}
trap cleanup EXIT INT TERM

command -v openshell >/dev/null 2>&1 || {
  echo "openshell is required" >&2
  exit 1
}

if ! openshell sandbox list 2>/dev/null | perl -pe 's/\e\[[0-9;]*m//g' | awk -v sb="$SANDBOX_NAME" '$1 == sb && $NF == "Ready" { found = 1 } END { exit(found ? 0 : 1) }'; then
  echo "sandbox '$SANDBOX_NAME' is not Ready" >&2
  exit 1
fi

openshell sandbox ssh-config "$SANDBOX_NAME" > "$SSH_CONFIG"

exec ssh \
  -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -F "$SSH_CONFIG" \
  -L "127.0.0.1:${UI_PORT}:127.0.0.1:${UI_PORT}" \
  "openshell-${SANDBOX_NAME}"
