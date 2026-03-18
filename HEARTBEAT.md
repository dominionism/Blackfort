# HEARTBEAT.md

This file is the only unattended task intake for the hardened NemoClaw heartbeat worker.

Rules:

- Keep the fenced `heartbeat` block valid JSON.
- Leave `"enabled": false` until you have stored a GitHub worker token locally with `nemoclaw auth-github-worker`.
- Increment each task's `revision` whenever you want the heartbeat worker to pick up a changed task.
- Keep `allowed_paths` narrow. The worker should not have open-ended repo-wide edit latitude.
- This hardened build supports only `engineering` tasks of type `github-pr`.

```heartbeat
{
  "version": 1,
  "enabled": false,
  "worker_type": "engineering",
  "sandbox": "nemoclaw",
  "schedule_minutes": 30,
  "max_tasks_per_run": 1,
  "tasks": [
    {
      "id": "example-pr-task",
      "enabled": false,
      "type": "github-pr",
      "repo": "owner/repo",
      "revision": "2026-03-17.1",
      "base_branch": "main",
      "branch_prefix": "nemoclaw/example-",
      "workdir": "/sandbox/workspaces/owner-repo",
      "allowed_paths": [
        "src/**",
        "docs/**"
      ],
      "max_runtime_minutes": 20,
      "prompt": "Describe the exact engineering task to perform, the expected change, and the acceptance criteria."
    }
  ]
}
```
