# Publishing This Skeleton Safely

This directory is intended to become a new public repository.
Do not publish your private working repository or reuse its git history if you want a clean separation from your personal environment.

## Safe Publishing Model

1. Create a brand new empty repository on GitHub.
2. Copy the contents of this `public-skeleton/` directory into a clean local working directory.
3. Initialize a fresh git repository there:

```console
$ git init
$ git add .
$ git commit -m "Initial sanitized NemoClaw skeleton"
```

4. Review the staged content before pushing:

```console
$ rg -n "<your-local-username>|<your-private-org-or-user>|<your-private-project-name>" .
$ rg -n "(file:///|/home/|C:\\\\Users\\\\)" .
$ git grep -n "github_pat_"
$ git grep -n "nvapi-"
```

All of those should return no sensitive hits before the first push.

## What This Skeleton Intentionally Excludes

- local keychain data
- `~/.nemoclaw/*` runtime state
- `~/.openclaw/*` state
- `~/.ssh/known_hosts`
- LaunchAgent plist files from a specific machine
- host-specific update notes
- private recon documents
- private repository task examples

## What New Users Should Configure Themselves

- NVIDIA API key through `nemoclaw auth-nvidia`
- GitHub worker token through `nemoclaw auth-github-worker`
- their own `HEARTBEAT.md` tasks
- their own repository names, branch names, and allowed paths
- their own access proxy configuration if they need remote UI access
- their own SSH host-key pinning for remote deploys

## Before You Push

- Replace upstream-facing branding or repository URLs if you want your own project identity.
- Review `package.json`, docs metadata, and README links if you want them to point at your new repository.
- Apply the hosted repository settings in `GITHUB_REPO_SETUP.md`.
- Keep `.env.example` as placeholders only.
- Do not commit real `.env` files, secrets, audit logs, or local state.
