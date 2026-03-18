# Template Setup Guide

Use this checklist after cloning the skeleton into your own repository.

## 1. Rename Repository Metadata

Review and replace any values that should point at your new project:

- `README.md`
- `package.json`
- `docs/conf.py`
- `docs/index.md`
- `docs/about/release-notes.md`

At minimum, replace:

- repository URL
- docs base URL
- project title or branding
- release-notes links

## 2. Configure Secrets Locally

Do not commit real secrets into the repository.
Use the built-in hidden prompts instead:

```console
$ nemoclaw auth-nvidia
$ nemoclaw auth-github-worker
```

Use `.env.example` only as a placeholder reference.

## 3. Keep Public Exposure Off By Default

Start with the hardened local-only posture:

```console
$ export NEMOCLAW_SECURITY_PROFILE=prod-secure
$ nemoclaw start
$ nemoclaw security-check
```

Do not enable raw public tunnels.
If you need remote browser access later, put an authenticated access proxy in front of the host.

## 4. Configure Your First Repo Task

Edit `HEARTBEAT.md` only after:

- your NVIDIA key is stored locally
- your GitHub worker token is stored locally
- your target repository has branch protection or rulesets

Keep the first task narrow:

- one repository
- one base branch
- one small allowlist of file paths
- one short runtime limit

## 5. Enable Unattended Work Carefully

Install the heartbeat scheduler only after a manual one-off task succeeds:

```console
$ nemoclaw heartbeat-check
$ nemoclaw heartbeat-install
```

Leave `"enabled": false` in `HEARTBEAT.md` until the task definition is correct and `nemoclaw security-check` passes.

## 6. Publish Your Own Version

Before making the repo public:

- read `PUBLISHING.md`
- apply the hosted repository settings in `GITHUB_REPO_SETUP.md`
- confirm there are no secrets or local paths
- confirm docs and metadata point at your own repository, not this skeleton or upstream defaults
