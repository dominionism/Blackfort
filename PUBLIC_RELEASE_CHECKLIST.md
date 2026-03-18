# Public Release Checklist

Use this before the first public push.

## Repository Identity

- Replace placeholder repository URLs with your actual public repository URL.
- Replace placeholder docs base URLs if you publish docs.
- Confirm the project name and branding are the ones you want to keep.

## Secrets and Local State

- No `.env` files are tracked.
- No API keys, tokens, certificates, or private keys are tracked.
- No `~/.nemoclaw/*` or `~/.openclaw/*` state is present.
- No host-specific LaunchAgent, SSH, or keychain artifacts are present.

## Quick Scans

Run these from the repository root:

```console
$ rg -n "(file:///|example.invalid)" .
$ rg -n "(github_pat_|ghp_|nvapi-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})" .
$ rg -n "<your-user-or-org>|<your-repo>|example.invalid" .
```

Review any hit before pushing.

## Validation

```console
$ npm test
$ python3 -m py_compile docs/conf.py
```

## Publish Model

- Prefer a brand new repository with fresh git history.
- Do not publish a private operational repository and then try to scrub it afterward.
- Keep this repository template-only. Configure secrets locally after clone.
