#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Configures OpenClaw and starts the dashboard
# gateway inside the sandbox so the forwarded host port has a live upstream.
#
# Optional env:
#   NVIDIA_API_KEY   API key for NVIDIA-hosted inference
#   CHAT_UI_URL      Browser origin that will access the forwarded dashboard
#   NEMOCLAW_ACCESS_PROXY_URL  External authenticated access URL, if present
#   NEMOCLAW_ALLOWED_ORIGINS   Comma-separated extra browser origins
#   NEMOCLAW_ALLOW_INSECURE_UI Set to 1 only for isolated lab/demo use
#   NEMOCLAW_ENABLE_AUTO_PAIR  Set to 1 only with insecure demo mode

set -euo pipefail

NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
NEMOCLAW_ACCESS_PROXY_URL="${NEMOCLAW_ACCESS_PROXY_URL:-}"
NEMOCLAW_ALLOWED_ORIGINS="${NEMOCLAW_ALLOWED_ORIGINS:-}"
NEMOCLAW_SECURITY_PROFILE="${NEMOCLAW_SECURITY_PROFILE:-prod-secure}"
NEMOCLAW_ALLOW_INSECURE_UI="${NEMOCLAW_ALLOW_INSECURE_UI:-0}"
NEMOCLAW_ENABLE_AUTO_PAIR="${NEMOCLAW_ENABLE_AUTO_PAIR:-0}"
PUBLIC_PORT=18789

if [ "$NEMOCLAW_SECURITY_PROFILE" = "prod-secure" ]; then
  if [ "$NEMOCLAW_ALLOW_INSECURE_UI" = "1" ] || [ "$NEMOCLAW_ENABLE_AUTO_PAIR" = "1" ]; then
    echo "[gateway] Refusing insecure UI flags in prod-secure profile" >&2
    exit 1
  fi
fi

fix_openclaw_config() {
  python3 - <<'PYCFG'
import json
import os
from urllib.parse import urlparse

home = os.environ.get('HOME', '/sandbox')
config_path = os.path.join(home, '.openclaw', 'openclaw.json')
os.makedirs(os.path.dirname(config_path), exist_ok=True)

cfg = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'nvidia/nemotron-3-super-120b-a12b'

local_origin = f'http://127.0.0.1:{os.environ.get("PUBLIC_PORT", "18789")}'
origins = [local_origin]

def add_origin(raw_value):
    parsed = urlparse(raw_value)
    if not parsed.scheme or not parsed.netloc:
        return
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in origins:
        origins.append(origin)

add_origin(os.environ.get('CHAT_UI_URL', 'http://127.0.0.1:18789'))
add_origin(os.environ.get('NEMOCLAW_ACCESS_PROXY_URL', '').strip())
for value in os.environ.get('NEMOCLAW_ALLOWED_ORIGINS', '').split(','):
    candidate = value.strip()
    if candidate:
        add_origin(candidate)

gateway = cfg.setdefault('gateway', {})
gateway['mode'] = 'local'
control_ui = gateway.setdefault('controlUi', {})
control_ui['allowedOrigins'] = origins
if os.environ.get('NEMOCLAW_ALLOW_INSECURE_UI', '0') == '1':
    control_ui['allowInsecureAuth'] = True
    control_ui['dangerouslyDisableDeviceAuth'] = True
else:
    control_ui.pop('allowInsecureAuth', None)
    control_ui.pop('dangerouslyDisableDeviceAuth', None)
gateway['trustedProxies'] = ['127.0.0.1', '::1']

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)
os.chmod(config_path, 0o600)
PYCFG
}

configure_git_tls() {
  local ca_bundle=""
  for candidate in /etc/openshell-tls/ca-bundle.pem /etc/ssl/certs/ca-certificates.crt; do
    if [ -f "$candidate" ]; then
      ca_bundle="$candidate"
      break
    fi
  done

  if [ -z "$ca_bundle" ]; then
    echo "[gateway] WARNING: no CA bundle found for Git HTTPS verification" >&2
    return
  fi

  export GIT_SSL_CAINFO="$ca_bundle"
  git config --global http.sslCAInfo "$ca_bundle" > /dev/null 2>&1 || true
}

write_auth_profile() {
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    return
  fi

  python3 - <<'PYAUTH'
import json
import os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'nvidia:manual': {
        'type': 'api_key',
        'provider': 'nvidia',
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
        'profileId': 'nvidia:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}

print_dashboard_urls() {
  local local_url remote_url

  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  echo "[gateway] Security profile: ${NEMOCLAW_SECURITY_PROFILE}"
  echo "[gateway] Local UI: ${local_url}"
  if [ -n "${NEMOCLAW_ACCESS_PROXY_URL:-}" ]; then
    remote_url="${NEMOCLAW_ACCESS_PROXY_URL%/}/"
    echo "[gateway] Remote UI (behind access proxy): ${remote_url}"
  else
    echo "[gateway] Remote UI: disabled until an authenticated access proxy is configured"
  fi
}

start_auto_pair() {
  nohup python3 - <<'PYAUTOPAIR' >> /tmp/gateway.log 2>&1 &
import json
import subprocess
import time

DEADLINE = time.time() + 600
QUIET_POLLS = 0
APPROVED = 0

def run(*args):
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()

while time.time() < DEADLINE:
    rc, out, err = run('openclaw', 'devices', 'list', '--json')
    if rc != 0 or not out:
        time.sleep(1)
        continue
    try:
        data = json.loads(out)
    except Exception:
        time.sleep(1)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    if pending:
        QUIET_POLLS = 0
        for device in pending:
            request_id = (device or {}).get('requestId')
            if not request_id:
                continue
            arc, aout, aerr = run('openclaw', 'devices', 'approve', request_id, '--json')
            if arc == 0:
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id}')
            elif aout or aerr:
                print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
        time.sleep(1)
        continue

    if has_browser:
        QUIET_POLLS += 1
        if QUIET_POLLS >= 4:
            print(f'[auto-pair] browser pairing converged approvals={APPROVED}')
            break
    elif APPROVED > 0:
        QUIET_POLLS += 1
    else:
        QUIET_POLLS = 0

    time.sleep(1)
else:
    print(f'[auto-pair] watcher timed out approvals={APPROVED}')
PYAUTOPAIR
  echo "[gateway] auto-pair watcher launched (pid $!)"
}

echo 'Setting up NemoClaw...'
openclaw doctor --fix > /dev/null 2>&1 || true
openclaw models set nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true
configure_git_tls
write_auth_profile
export CHAT_UI_URL PUBLIC_PORT NEMOCLAW_ACCESS_PROXY_URL NEMOCLAW_ALLOWED_ORIGINS NEMOCLAW_ALLOW_INSECURE_UI
fix_openclaw_config
openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${NEMOCLAW_CMD[@]}"
fi

nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
echo "[gateway] openclaw gateway launched (pid $!)"
if [ "$NEMOCLAW_ALLOW_INSECURE_UI" = "1" ] && [ "$NEMOCLAW_ENABLE_AUTO_PAIR" = "1" ]; then
  echo "[gateway] WARNING: insecure UI mode enabled for lab/demo use only"
  start_auto_pair
fi
print_dashboard_urls
