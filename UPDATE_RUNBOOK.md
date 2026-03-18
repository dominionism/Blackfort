# Generic Update Runbook

This runbook is safe to publish.
It assumes a generic NemoClaw checkout and does not depend on any machine-specific paths.

## Rules

- Update one layer at a time.
- Verify after every layer.
- Keep unattended heartbeat work disabled during maintenance.
- Prefer official upstream release artifacts and checksums.
- Do not paste secrets into chat, docs, or shell history.

## Before You Start

1. Pause unattended work.
2. Back up your active `~/.nemoclaw/heartbeat/HEARTBEAT.md` if you use heartbeat mode.
3. Record the current versions:
   - `nemoclaw --help`
   - `openshell --version`
   - `docker --version`
4. Run a pre-update posture check:

```console
$ nemoclaw security-check
```

## OpenShell Update

1. Download the exact release asset from the official `NVIDIA/OpenShell` release page.
2. Download the corresponding checksum file if one is provided.
3. Verify the checksum locally.
4. Replace the OpenShell binary only after the checksum matches.
5. Re-check:

```console
$ openshell --version
$ openshell sandbox list
$ nemoclaw security-check
```

## NemoClaw Update

1. Review the exact source changes you want to adopt.
2. Reinstall from a reviewed local checkout or a packed tarball, not a repo symlink path.
3. Re-run:

```console
$ npm test
$ nemoclaw security-check
$ nemoclaw heartbeat-check
```

## Heartbeat Validation

If you use the unattended engineering worker:

1. Keep `HEARTBEAT.md` disabled until validation is complete.
2. Confirm the installed scheduler still points at `~/.nemoclaw/heartbeat/HEARTBEAT.md`.
3. Confirm the sandbox still returns to `local-only` after a GitHub-capable run.
4. Confirm audit logs are still written under `~/.nemoclaw/heartbeat/`.

## Token Rotation

Rotate worker credentials through the hidden local prompts:

```console
$ nemoclaw auth-nvidia
$ nemoclaw auth-github-worker
```

Use short-lived or fine-grained credentials whenever possible.

## Post-Update Verification

Run this sequence before re-enabling unattended work:

```console
$ nemoclaw security-check
$ npm test
$ nemoclaw heartbeat-check
$ openshell sandbox list
```

If any of those fail, stop and fix the issue before re-enabling heartbeat mode or widening egress.
