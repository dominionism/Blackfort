# SECURITY.md

This document is the NemoClaw security architecture, hardening blueprint, repository policy, remediation plan, and verification baseline. It is derived from `SECURITY_RECON.md` and is intentionally opinionated. It assumes strong attackers, treats convenience features as real attack surfaces, and does not rely on undocumented safeguards.

The document has two purposes:

1. Define the hardened target state NemoClaw should move toward.
2. Provide a repository-usable security policy section that maintainers and contributors can follow now.

## 1. Executive Security Verdict

NemoClaw's current security posture is high risk for any environment that is multi-user, internet-reachable, or treated as production-like. The most serious problems are not subtle. They are structural and operational:

- the control UI can be made publicly reachable while the sandbox startup path explicitly weakens authentication and auto-approves device pairing;
- the main host CLI executes interpolated shell strings through `bash -c`;
- the remote deployment path disables SSH host key verification;
- secrets are stored and replicated in plaintext local JSON files, remote `.env` files, and temporary artifacts;
- the install and build paths trust dynamic external artifacts with limited integrity enforcement;
- the sandbox egress baseline is broader than a high-assurance agent runtime should allow.

The most dangerous attack chains from `SECURITY_RECON.md` remain:

- public tunnel -> weakened UI auth -> unauthorized agent/control-surface access;
- unrestricted Telegram bridge -> remote prompt/tool abuse and cost abuse;
- malicious operator input or automation input -> host command execution through shell-string orchestration;
- MITM or spoofed remote host during Brev deploy -> secret theft and remote bootstrap compromise;
- poisoned install/build dependency or release asset -> pre-runtime compromise;
- poisoned existing OpenClaw state -> malicious persistence carried into the migrated sandbox.

The most dangerous trust boundaries are:

- internet/browser to the forwarded control UI;
- Telegram user to the bridge and then to the sandboxed agent;
- operator input to the host shell execution layer;
- operator workstation to remote VM bootstrap over SSH with relaxed authenticity checks;
- local `.openclaw` state to the migration import pipeline.

What should concern an experienced security engineer most is that several of the highest-risk paths are intentional convenience features, not accidental edge cases: insecure UI auth flags, auto-pairing, raw public tunneling, permissive Telegram ingress, shell-string orchestration, and transport trust bypass. Those choices make the project easy to demo, but hard to defend.

Current maturity assessment:

- runtime isolation story: potentially moderate, but externally dependent on OpenShell and not validated in this repo;
- host/admin/control-plane security: immature;
- supply-chain posture: immature;
- secret lifecycle hygiene: immature;
- public-edge posture: immature;
- operational security policy: previously minimal, now must become explicit and enforceable.

Before NemoClaw can credibly claim serious hardening, it must do five things first:

1. Eliminate insecure control-surface defaults: no raw public tunnel, no `allowInsecureAuth`, no `dangerouslyDisableDeviceAuth`, no auto-pair in any production path.
2. Remove `bash -c` orchestration for user-influenced values and enforce argv-safe process execution.
3. Enforce transport authenticity for remote deployment and stop copying high-value secrets around in loose `.env` files.
4. Make release, build, and install paths reproducible, pinned, verifiable, and auditable.
5. Rebuild the default egress and remote ingress model around least privilege, not convenience.

## 2. Recon-to-Architecture Traceability

This section is the bridge from `SECURITY_RECON.md` to the hardened design. Recommendations below are responses to these inputs, not generic best-practice lists.

### Top recon findings inherited from `SECURITY_RECON.md`

- `scripts/nemoclaw-start.sh` enables `allowInsecureAuth`, `dangerouslyDisableDeviceAuth`, and a device auto-pair watcher. This is the central reason the control UI cannot be treated as safely internet-exposable.
- `scripts/start-services.sh` exposes the local UI through `cloudflared tunnel --url http://localhost:18789` and treats that path as a normal operations feature.
- `scripts/telegram-bridge.js` accepts all Telegram chats unless `ALLOWED_CHAT_IDS` is configured and forwards prompt text directly into `openclaw agent`.
- `bin/lib/runner.js` wraps commands in `spawnSync("bash", ["-c", cmd])`, and multiple call sites interpolate prompt- or argument-derived values into those strings.
- `bin/nemoclaw.js` uses `StrictHostKeyChecking=no` for SSH/rsync/scp during Brev deployment and writes a remote `.env` file carrying deploy-time secrets.
- `install.sh`, `scripts/install.sh`, `scripts/brev-setup.sh`, `scripts/setup-spark.sh`, and the production `Dockerfile` create a weakly pinned supply chain with live downloads, curl-to-shell installers, and incomplete lockfile use.
- secrets live in plaintext local JSON files and remote env files, while logs and temp files can expose sensitive operational details.
- the default sandbox network policy already allows outbound destinations that materially help exfiltration and external command-and-control.

### Risk classification from recon

#### Architecture problems

- Public control-surface exposure is available without a mandatory private access layer.
- Management plane and user interaction plane are not cleanly separated.
- Runtime security depends heavily on OpenShell, but NemoClaw currently assumes rather than verifies the strength of that boundary.
- Migration treats existing local OpenClaw state as broadly trusted enough to preserve and import.
- Default sandbox egress is too permissive for a high-assurance agent runtime.

#### Implementation problems

- shell-string execution in the host CLI;
- insecure UI auth flags in startup logic;
- automatic device approval;
- optional Telegram allowlisting instead of mandatory enrollment;
- `StrictHostKeyChecking=no` in deploy path;
- use of `--no-verify` in inference routing operations;
- production Docker build not using the checked-in npm lockfile for runtime dependency installation.

#### Operational problems

- plaintext local secret storage;
- plaintext remote `.env` staging;
- public tunnel treated as routine;
- no visible attestation/signing/provenance controls in the repo;
- release and CI/CD security posture not inspectable from the repository;
- temporary files and logs may reveal tokens, URLs, and operational state.

#### Unknowns that materially affect confidence

- actual OpenClaw/OpenShell auth semantics under the configured insecure flags;
- exact strength of the OpenShell sandbox boundary;
- how OpenShell stores provider credentials;
- production deployment topology and whether public tunnel/Telegram are intended for real deployments or only demos;
- remote host hardening and `.env` protections on deployed VMs;
- CI/CD, provenance, and release signing posture;
- exact OpenClaw tool inventory and what the agent can reach inside the sandbox.

### Top assumptions from recon that still matter

- OpenShell is the primary runtime containment boundary and is stronger than NemoClaw itself.
- The UI on port `18789` is a privileged control surface, not an innocuous informational dashboard.
- Operators run the host CLI with meaningful local privileges.
- Public tunnel and Telegram bridge are live features, not dead demo code.
- `--no-verify` weakens safety in a meaningful way.
- Hidden external protections may exist, but they cannot be assumed in the final design.

### Top risks this design must address

1. Remote takeover of the control UI.
2. Remote prompt/tool abuse through Telegram.
3. Host compromise through shell-string orchestration.
4. Supply-chain compromise during install/build/release.
5. Deploy-time MITM or remote host spoofing.
6. Secret theft from local state, temp files, or remote env staging.
7. Exfiltration from a compromised or manipulated agent runtime.
8. Malicious endpoint routing for inference providers.
9. Persistence transfer through migration of poisoned local state.
10. Unknown release provenance and CI/CD trust.

### Top attack chains shaping the architecture

- public tunnel -> weakened UI auth -> unauthorized control;
- permissive Telegram bridge -> arbitrary remote prompt ingress;
- operator/social-engineering input -> shell injection on the host;
- remote deploy with disabled SSH host verification -> secret theft and bootstrap tampering;
- compromised dependency or release asset -> code execution before runtime;
- poisoned local `.openclaw` state -> imported malicious behavior in the sandbox;
- malicious custom inference endpoint -> prompt and credential capture.

Everything below is designed to break those chains, not to optimize for demo convenience.

## 3. Target-State Security Architecture

### Identity and Authentication Architecture

Required controls:

- Remove `allowInsecureAuth` and `dangerouslyDisableDeviceAuth` from all production and release-default startup paths.
- Remove automatic device approval from production paths. Device approval must require an authenticated human operator action in a local-only management channel or a separately authenticated access system.
- Place all browser access behind a private access broker that enforces enterprise identity plus MFA. Acceptable patterns include Cloudflare Access, Tailscale with ACLs, Teleport, or an equivalent IdP-backed access proxy. Raw direct exposure of the OpenClaw/OpenShell UI is forbidden.
- Bind every operator action to an identity. "Possession of the machine" is not enough once remote control or shared operations exist.

Why it matters:

- This is the direct response to the highest-ranked recon issue: public tunnel plus weakened UI auth plus auto-pairing.

Defends against:

- unauthorized browser session establishment;
- remote drive-by access to the control surface;
- replay of tokenized URLs;
- weak device pairing abuse.

Implementation notes:

- Split `nemoclaw-start` into explicit profiles: `dev-insecure`, `local-secure`, and `prod-secure`.
- Refuse to start a public tunnel unless the secure profile is active and an external authenticated access layer is present.
- Eliminate token-in-URL output from standard operation.

Priority:

- P0.

Tradeoffs:

- Less convenient demos and local sharing.
- Requires integration with a real access broker and an identity provider.

### Authorization and Privilege Model

Required controls:

- Define distinct privilege tiers: contributor, operator, release maintainer, incident responder.
- Restrict host-side sandbox creation, provider changes, policy changes, tunnel startup, remote deploy, and destroy actions to the operator tier.
- Restrict release signing, dependency pin updates, and deployment script changes to release maintainers under code review and branch protection.
- Make the Telegram bridge prompt-only if it exists at all. It must not be able to trigger infrastructure-management actions.
- Treat policy changes and provider endpoint changes as privileged configuration changes requiring audit trails and, for production, dual approval.

Why it matters:

- Recon showed that the host CLI and remote exposure features collapse multiple power levels into one operator shell.

Defends against:

- abuse of highly privileged management commands;
- lateral movement after partial compromise;
- quiet weakening of egress or provider routing.

Implementation notes:

- Enforce privilege separation through deployment roles, code ownership, and CI policy, not just social convention.
- If NemoClaw evolves into a multi-operator service, the operator tier must become a formal RBAC model backed by IdP groups.

Priority:

- P1.

Tradeoffs:

- More process overhead for maintainers and operators.

### Session Management Model

Required controls:

- Short-lived browser sessions terminated at the access proxy, not by ad hoc token-in-URL flows.
- Reauthentication for sensitive actions such as provider endpoint change, policy expansion, public exposure enablement, remote deploy, and snapshot restore.
- Session establishment logs must record who initiated the session, from where, and through which access layer.
- Session tokens must never be printed to logs or shell output in default operation.

Why it matters:

- Recon identified tokenized URLs and uncertain pairing semantics.

Defends against:

- session hijack;
- replay;
- token leakage in logs or copy/paste workflows.

Implementation notes:

- If OpenClaw/OpenShell cannot meet these requirements natively, the access proxy becomes the authoritative session boundary.

Priority:

- P0.

Tradeoffs:

- Adds authentication friction for operators.

### Secret Management Model

Required controls:

- Replace plaintext `~/.nemoclaw/credentials.json` storage with OS keychain-backed storage on macOS and Linux keyring/libsecret on Linux desktops. For headless environments, use a dedicated secret manager or an encrypted secret file with explicit bootstrap tooling.
- Stop passing secrets on the command line where alternatives exist. Process argv leakage is not acceptable for steady-state operation.
- Stop copying all secrets into a general-purpose remote `.env` file during deployment. Use one of:
  - secret-manager injection on the remote VM,
  - root-owned `0600` systemd environment files with minimal process exposure,
  - one-shot bootstrap tokens that exchange for service-local secrets.
- Use separate secrets for separate functions: inference provider, GitHub release access, Telegram bridge, access proxy.
- Rotate secrets after public exposure incidents, remote deploy incidents, and release compromise scenarios.

Why it matters:

- Recon found secret sprawl across local JSON, remote `.env`, process env, temp files, and URLs.

Defends against:

- workstation compromise fallout;
- remote VM secret theft;
- accidental leakage through logs, shells, and process inspection.

Implementation notes:

- The host CLI should expose a pluggable secret backend interface rather than hardcoding JSON file storage.
- Provider creation should accept credentials through stdin, fd-passing, or secret-store references where OpenShell allows it.

Priority:

- P0.

Tradeoffs:

- Harder bootstrap and local development.
- More platform-specific code.

### Service-to-Service Trust Model

Required controls:

- No implicit trust of arbitrary inference endpoint URLs in production. Endpoint URLs must be allowlisted by scheme, hostname, and expected CA roots. "Custom" endpoints should be lab-only unless explicitly approved.
- Pin SSH host keys or use an SSH CA for Brev and any remote host path.
- Verify OpenShell and cloudflared release assets by signature or digest before use.
- Pin container base images and runtime images by digest, not floating tags.

Why it matters:

- Recon found arbitrary endpoint routing, disabled SSH host verification, and dynamic release downloads.

Defends against:

- MITM;
- malicious endpoint routing;
- release asset substitution;
- image tag hijack.

Implementation notes:

- Introduce an artifact manifest checked into the repo containing approved digests for release assets, container bases, and installer dependencies.

Priority:

- P0.

Tradeoffs:

- More maintenance overhead when dependencies are updated.

### Network Segmentation

Required controls:

- Treat the management plane as private by default. The control UI must bind to localhost or a private interface and only be reachable through a separate authenticated access layer.
- Separate sandbox egress policy by use case. The baseline production profile should allow only the active inference provider and strictly necessary system endpoints. GitHub, npm, Telegram, and other broad destinations must move out of the base profile and into explicit, operator-approved presets.
- Separate remote VM management traffic, public ingress, and sandbox-internal networking. Do not expose OpenShell management interfaces directly to the public internet.

Why it matters:

- Recon found that the default policy is broad enough to help exfiltration and that public-edge controls are optional.

Defends against:

- exfiltration from a compromised agent;
- pivoting from public reachability into the management plane.

Implementation notes:

- Introduce profile tiers such as `prod-minimal`, `dev-networked`, and `research-broad`.
- Fail closed if the requested policy profile is missing or malformed.

Priority:

- P1.

Tradeoffs:

- Agents will need more explicit network approvals.

### Public Edge Protection

Required controls:

- Raw `trycloudflare.com` tunnels are not allowed in production or on shared environments.
- If remote browser access is required, front the UI with an identity-aware access proxy enforcing MFA, IP/geo policy where feasible, request logging, and rate limiting.
- Publish only a stable, controlled hostname under an access-controlled edge, never ad hoc public URLs from logs.
- Explicitly detect and alert on tunnel startup, public hostname creation, or exposure policy changes.

Why it matters:

- This directly addresses Attack Chain 1 from recon.

Defends against:

- opportunistic internet access;
- brute-force and replay attempts;
- quiet exposure by an operator or compromised host.

Implementation notes:

- `nemoclaw start` should fail unless it detects a supported secure edge mode when run in production mode.

Priority:

- P0.

Tradeoffs:

- More operational setup and edge-service dependency.

### Reverse Proxy / API Gateway Posture

Required controls:

- Put a hardened access layer in front of the browser UI that terminates TLS, enforces identity, injects authenticated user context, and strips unsafe headers.
- Enforce rate limits, body-size limits, header sanitation, and origin restrictions at the proxy.
- If future NemoClaw-specific HTTP APIs are added, the same proxy must be the only public ingress point.

Why it matters:

- NemoClaw currently has no dedicated app gateway. That makes the access proxy the place where browser-facing controls must live.

Defends against:

- weak native auth;
- brute force;
- noisy internet abuse;
- header and origin confusion.

Implementation notes:

- Cloudflare Access, OAuth2 Proxy, or Teleport-style reverse proxy are realistic here; a raw NGINX reverse proxy without strong identity is not sufficient by itself.

Priority:

- P1.

Tradeoffs:

- More components to operate.

### Encryption in Transit and at Rest

Required controls:

- TLS for all browser access, provider access, and remote management channels.
- No plaintext secrets at rest on workstations or remote VMs beyond tightly controlled temporary bootstrap windows.
- Encrypt migration snapshots and backup artifacts at rest with a distinct key hierarchy from active runtime credentials.
- Prefer full-disk encryption on operator endpoints and remote VMs.

Why it matters:

- Recon identified local/remote plaintext secrets and highly sensitive snapshot bundles.

Defends against:

- disk theft;
- casual filesystem access after endpoint compromise;
- backup leakage.

Implementation notes:

- If local encrypted secret storage cannot be added immediately, enforce `0700`/`0600` permissions everywhere and shorten retention. That is not the target state, only a temporary containment measure.

Priority:

- P1.

Tradeoffs:

- More complex backup and restore processes.

### Database Security Model

Current state:

- No dedicated application database is visible in the repository.
- The effective data store today is local JSON state, OpenClaw state, OpenShell state, remote `.env`, and snapshot directories.

Required controls:

- Treat local state files as the de facto database and secure them accordingly.
- If NemoClaw later introduces a service database, it must be private-network only, access-controlled by workload identity, encrypted at rest, and excluded from public ingress.
- Do not grow from "local JSON files" to "shared network file state" without a formal data model and access control design.

Why it matters:

- There is no database to harden today, but there is sensitive state that behaves like one.

Defends against:

- unauthorized state tampering and secret disclosure.

Priority:

- P2.

Tradeoffs:

- Moving away from local JSON adds development and operational complexity.

### Admin Surface Isolation

Required controls:

- Host CLI, OpenShell admin commands, provider changes, policy changes, tunnel startup, and remote deploy operations must run only from dedicated admin workstations or bastions.
- Separate daily-use operator accounts from administrative accounts.
- No public admin surfaces. Remote management must traverse VPN, private mesh, or identity-aware proxy.

Why it matters:

- Recon made it clear that NemoClaw is primarily a privileged orchestration tool.

Defends against:

- compromise of the management plane from low-trust environments.

Implementation notes:

- Administrative actions should emit immutable audit events that include human identity, target host/sandbox, and diff of the change.

Priority:

- P1.

Tradeoffs:

- Less convenience for solo developers or demo operators.

### CI/CD Security Model

Required controls:

- Branch protection on all security-relevant paths: scripts, Dockerfile, `bin/`, `nemoclaw/`, `nemoclaw-blueprint/`, policy files.
- Mandatory code review and CODEOWNERS for deploy scripts, public exposure paths, startup/auth logic, and dependency updates.
- CI must run secret scanning, shell linting, static analysis, dependency checks, lockfile drift detection, container scanning, and artifact provenance generation.
- CI runners must use OIDC or equivalent short-lived credentials, not long-lived cloud or registry keys.

Why it matters:

- CI/CD posture is a recon unknown and a likely high-impact risk.

Defends against:

- malicious PRs;
- compromised release pipeline;
- artifact substitution.

Implementation notes:

- If GitHub Actions is used later, require `actionlint`, pinned action SHAs, least-privilege `permissions`, and OIDC-based federation.

Priority:

- P1.

Tradeoffs:

- Slower release process and more pipeline maintenance.

### Supply-Chain Security Model

Required controls:

- Eliminate release-time "latest" downloads for OpenShell, cloudflared, NodeSource, and other bootstrap dependencies unless backed by signature or pinned digest verification.
- Use `npm ci` and checked-in lockfiles in all release and image builds.
- Pin the container base image by digest.
- Generate SBOMs for the host CLI package, plugin package, and container image.
- Sign release artifacts and container images with verifiable provenance.

Why it matters:

- Recon ranked supply-chain compromise as a top-three risk.

Defends against:

- dependency poisoning;
- release-asset substitution;
- non-reproducible builds.

Implementation notes:

- For Python dependencies, use hash-pinned requirements or lock tooling.
- For shell-delivered installers, publish signed manifest files and verify before execution.

Priority:

- P0.

Tradeoffs:

- More release engineering work.
- More friction when rapidly updating dependencies.

### Runtime and Container Hardening

Required controls:

- Non-root execution inside the sandbox remains mandatory.
- Use a minimal base image pinned by digest and install only required runtime packages.
- Enforce read-only root filesystem where OpenClaw/OpenShell permit it, with explicit writable mounts for `/sandbox` and `/tmp` only.
- Drop Linux capabilities, enforce `no-new-privileges`, and validate seccomp/AppArmor/Landlock behavior on every supported platform.
- Fail closed on unsupported sandboxing features in production rather than silently accepting degraded isolation.

Why it matters:

- Recon shows that the project leans heavily on OpenShell for containment, while the current policy admits degraded Landlock behavior.

Defends against:

- sandbox escape;
- privilege escalation;
- persistence through unexpected writable paths.

Implementation notes:

- The final runtime profile should be validated empirically, not assumed from YAML alone.

Priority:

- P1.

Tradeoffs:

- Reduced portability and more platform-specific testing.

### File Upload and Content-Processing Isolation

Current state:

- NemoClaw does not expose a generic file-upload API.
- The equivalent ingestion surfaces are migration imports, workspace/hooks/skills content, and any future files exposed through OpenClaw tools.

Required controls:

- Treat all imported migration content as untrusted.
- Quarantine imported hooks, skills, and external roots until inventory, file-type, symlink, and path-scope checks pass.
- Preserve only safe symlinks that remain within the intended sandbox import root. Reject or rewrite absolute or escaping symlinks.
- If future file uploads are added, process them in a separate transient sandbox with MIME verification and size limits.

Why it matters:

- Recon showed that migration intentionally preserves symlinks and imports behavior-defining content.

Defends against:

- malicious persistence carried into the new sandbox;
- path confusion;
- stealthy file-based poisoning.

Implementation notes:

- Require explicit operator confirmation before enabling imported hooks or extensions.

Priority:

- P1.

Tradeoffs:

- Migration becomes slower and less seamless.

### Model and Tool Execution Isolation

Required controls:

- Separate inference connectivity from tool/network access. A model endpoint being reachable must not imply GitHub, npm, or Telegram are also reachable.
- Define sandbox capability profiles:
  - `chat-only`;
  - `read-only-research`;
  - `build`;
  - `deployment`.
- Default to the narrowest profile and require logged, time-bounded elevation for broader tool/network access.
- Prompt surfaces exposed to remote users must run only in the narrowest profile.

Why it matters:

- Recon highlighted prompt injection, tool misuse, and exfiltration through preapproved destinations as first-order risks.

Defends against:

- prompt-driven data exfiltration;
- unauthorized tool execution;
- abuse of permissive defaults.

Implementation notes:

- This likely requires OpenShell/OpenClaw support beyond what is visible in the repo. If upstream cannot support profile separation, NemoClaw must enforce it through policy templates and startup modes.

Priority:

- P1.

Tradeoffs:

- Reduced agent capability and more operator approvals.

### Observability, Logging, and Tamper-Resistant Audit Trails

Required controls:

- Emit structured security events for:
  - tunnel start/stop;
  - device pairing requests and approvals;
  - Telegram bridge start and chat enrollment changes;
  - provider create/update;
  - inference route changes;
  - policy changes;
  - remote deployment;
  - snapshot creation/restore;
  - sandbox create/destroy/connect.
- Ship logs off-host to a write-restricted destination.
- Redact secrets, session tokens, and public URLs from standard logs.
- Make audit events append-only and separate from application debug logs.

Why it matters:

- Recon found sensitive operational details in `/tmp` logs and shell output, and identified multiple high-risk admin actions with no visible audit model.

Defends against:

- stealthy configuration tampering;
- hard-to-investigate incidents;
- silent public exposure.

Implementation notes:

- Logging must be designed not to reintroduce secret leakage. Security events should reference secret identifiers, not secret values.

Priority:

- P1.

Tradeoffs:

- More infrastructure and retention cost.

### Backup, Restore, and Disaster Recovery Security

Required controls:

- Encrypt migration snapshots and backup copies.
- Apply retention policies to snapshots and temp artifacts; default to ephemeral staging for migrations unless the operator explicitly requests a retained rollback copy.
- Verify restore paths in a clean environment at a defined cadence.
- Protect backup keys separately from runtime credentials.

Why it matters:

- Recon found snapshots to be crown-jewel data stores and part of the migration trust boundary.

Defends against:

- backup theft;
- stale sensitive data accumulation;
- failed recovery during incident response.

Implementation notes:

- Snapshot manifests should be checksummed and signed to detect tampering between creation and restore.

Priority:

- P2.

Tradeoffs:

- More complicated restore operations and key management.

### Incident Response Readiness and Containment Architecture

Required controls:

- Provide immediate kill switches for:
  - public tunnel;
  - Telegram bridge;
  - provider endpoint overrides;
  - remote deploy secrets;
  - sandbox destroy/quarantine.
- Maintain rotation procedures for NVIDIA, GitHub, Telegram, and access-proxy credentials.
- Preserve forensic artifacts separately from active runtime state.
- Predefine a containment order: public ingress off first, secret rotation second, provider/policy freeze third, sandbox quarantine fourth.

Why it matters:

- The recon attack chains rely on rapid exploitation of exposed paths. Containment speed matters as much as prevention.

Defends against:

- ongoing exfiltration;
- attacker persistence after exposure;
- panic-driven destructive response.

Implementation notes:

- These procedures belong in ops runbooks and should be exercised.

Priority:

- P1.

Tradeoffs:

- More operational complexity and documentation burden.

### Endpoint Hardening Expectations for Operators and Admins

Required controls:

- Run NemoClaw management only from hardened operator endpoints or bastions with full-disk encryption, EDR, MFA-backed SSH, and current patching.
- Use hardware-backed SSH keys and, where possible, a separate admin account from daily-use accounts.
- Do not run production NemoClaw management from an unmanaged personal workstation.

Why it matters:

- The host CLI is a privileged orchestration surface. If the operator endpoint is compromised, many other controls collapse.

Defends against:

- local secret theft;
- command hijack;
- release key abuse.

Implementation notes:

- This is an operational dependency, not something the repo can enforce by itself.

Priority:

- P1.

Tradeoffs:

- Increased operator overhead and endpoint-management cost.

## 4. Attack-Surface-by-Attack-Surface Hardening Plan

### Attack Surface: Host CLI and Operator Shell

- Likely attacker goals:
  - gain host code execution;
  - steal local credentials;
  - manipulate deployment or policy actions.
- Likely attack methods:
  - shell metacharacter injection through interpolated values;
  - social engineering operators to paste crafted names or flags;
  - malicious automation inputs.
- Concrete mitigations:
  - replace `bash -c` execution with argv-safe `spawn`/`execFile` calls everywhere;
  - enforce strict regex validation for sandbox names, instance names, model names, profile names, and file paths before they reach execution;
  - ban new shell-string execution via CI static analysis;
  - require explicit `--confirm` on destructive actions.
- Detection mechanisms:
  - structured audit log for every admin command including arguments after validation;
  - EDR on admin workstations;
  - alert on suspicious argument values rejected by validation.
- Containment mechanisms:
  - dedicated admin workstation or bastion;
  - rapid token rotation if operator host is suspected compromised.
- Validation steps:
  - unit tests for argument validation;
  - Semgrep rule banning `bash -c` and unsafe `execSync` usage;
  - negative tests for shell metacharacters.
- Priority:
  - P0.

### Attack Surface: Browser-Facing Control UI

- Likely attacker goals:
  - obtain unauthorized UI/session access;
  - control or observe the agent;
  - steal tokenized URLs or session material.
- Likely attack methods:
  - direct access through public tunnel;
  - abuse of weak pairing semantics;
  - token replay from logs or copied URLs.
- Concrete mitigations:
  - no public exposure without an access proxy;
  - remove insecure auth flags and auto-pair from production;
  - remove token-in-URL output from normal workflows;
  - require MFA-backed identity before reaching the UI.
- Detection mechanisms:
  - alerts on tunnel start, pairing events, failed access attempts, new public hostname exposure.
- Containment mechanisms:
  - immediate tunnel shutdown;
  - invalidate sessions and rotate any exposed UI token material;
  - freeze provider/policy changes until incident review.
- Validation steps:
  - adversarial test of UI exposure path with and without secure profile;
  - verify the UI is unreachable from the public internet in production deployment tests.
- Priority:
  - P0.

### Attack Surface: Authentication Flows and Device Pairing

- Likely attacker goals:
  - create or hijack sessions;
  - bypass intended operator approval.
- Likely attack methods:
  - remote device pairing abuse;
  - replay of tokenized URLs;
  - exploitation of weak native auth semantics.
- Concrete mitigations:
  - remove `dangerouslyDisableDeviceAuth`;
  - require human approval tied to an authenticated operator identity;
  - put all browser access behind an access proxy that becomes the real auth boundary.
- Detection mechanisms:
  - pair request/approval audit events;
  - alert on pairing from unexpected IPs or geographies.
- Containment mechanisms:
  - revoke session tokens and disable browser access;
  - quarantine exposed sandbox if unauthorized approval is suspected.
- Validation steps:
  - run an explicit auth red-team against pairing and session flow before release.
- Priority:
  - P0.

### Attack Surface: Authorization-Sensitive Routes and Admin Capabilities

- Likely attacker goals:
  - change providers, policies, tunnels, or sandboxes;
  - destroy or exfiltrate data.
- Likely attack methods:
  - abusing overbroad operator power;
  - chaining partial access into full admin actions.
- Concrete mitigations:
  - separate prompt submission from infrastructure administration;
  - dual-control approval for production policy expansion and provider endpoint changes;
  - code ownership on all admin-plane code.
- Detection mechanisms:
  - immutable audit log for every admin action with before/after diff.
- Containment mechanisms:
  - emergency "admin-freeze" mode that blocks policy/provider/tunnel changes during incident response.
- Validation steps:
  - review all current admin actions and classify by privilege tier.
- Priority:
  - P1.

### Attack Surface: Telegram Bridge

- Likely attacker goals:
  - remote prompt injection;
  - unauthorized use;
  - cost exhaustion;
  - exfiltration through the agent.
- Likely attack methods:
  - messaging the bot from an unapproved chat;
  - high-volume spam;
  - prompt sequences that invoke tools or external access.
- Concrete mitigations:
  - disable the bridge by default;
  - require explicit allowlisting and enrollment for every chat;
  - add per-chat and per-bot rate limits;
  - make remote prompt sessions run in the narrowest capability profile;
  - remove direct export of secrets into SSH command strings if a safer transport exists.
- Detection mechanisms:
  - alerts on new chat IDs, rate-limit hits, unusual message volume, and unexpected geographies/time windows.
- Containment mechanisms:
  - instant bot token rotation;
  - bridge shutdown;
  - sandbox quarantine if abusive prompt activity is detected.
- Validation steps:
  - test that unapproved chats are denied;
  - test rate limiting;
  - test that allowed chats cannot escalate infrastructure actions.
- Priority:
  - P0.

### Attack Surface: Secrets Handling

- Likely attacker goals:
  - steal NVIDIA, GitHub, Telegram, and UI tokens;
  - persist access after partial compromise.
- Likely attack methods:
  - reading plaintext JSON, `.env`, temp files, process args, logs, or shell history.
- Concrete mitigations:
  - use keychain or secret manager storage;
  - eliminate plaintext remote `.env` staging where possible;
  - redact logs and remove tokenized URLs;
  - avoid CLI-argument secret passing.
- Detection mechanisms:
  - file-permission audits;
  - secret-scanning of the repo and build artifacts;
  - alerts on unexpected secret file access if host telemetry exists.
- Containment mechanisms:
  - rotation playbooks and least-scoped tokens.
- Validation steps:
  - filesystem scan of active runtime state;
  - process inspection tests to ensure secrets are not exposed in argv.
- Priority:
  - P0.

### Attack Surface: Data Storage and Migration Snapshots

- Likely attacker goals:
  - read sensitive local OpenClaw state;
  - inject malicious hooks or symlink behavior that survives migration.
- Likely attack methods:
  - tampering with `.openclaw`;
  - snapshot theft;
  - malicious symlink chains.
- Concrete mitigations:
  - encrypt snapshots;
  - retain them only when necessary;
  - quarantine imported content;
  - reject symlinks that escape approved import roots;
  - require explicit operator approval before enabling imported hooks/extensions.
- Detection mechanisms:
  - signed snapshot manifests;
  - audit events for snapshot creation, import, and restore.
- Containment mechanisms:
  - discard poisoned snapshot bundle;
  - rebuild sandbox from clean state.
- Validation steps:
  - symlink and path-escape tests;
  - restore testing from encrypted backup.
- Priority:
  - P1.

### Attack Surface: File Upload / Ingestion Equivalent Surfaces

- Likely attacker goals:
  - introduce executable or behavior-defining content;
  - cause path confusion or sandbox import abuse.
- Likely attack methods:
  - malicious hooks, skills, workspace files, or future file uploads.
- Concrete mitigations:
  - treat migration imports as untrusted ingestion;
  - add content inventory and file-type checks;
  - block absolute symlinks and escaping relative symlinks;
  - future generic uploads must be processed in a separate transient sandbox.
- Detection mechanisms:
  - ingestion logs and policy violations.
- Containment mechanisms:
  - quarantine imported content until validated.
- Validation steps:
  - malicious sample corpus for symlink, path, and behavior files.
- Priority:
  - P1.

### Attack Surface: Internal Services and Third-Party Integrations

- Likely attacker goals:
  - abuse inference providers;
  - capture prompts and credentials;
  - pivot through release download paths.
- Likely attack methods:
  - malicious custom endpoint configuration;
  - dependency/release asset substitution;
  - weakly verified installers.
- Concrete mitigations:
  - allowlist provider endpoints;
  - pin and verify all release assets;
  - separate lab-only from production-approved integrations;
  - maintain an approved external dependency manifest.
- Detection mechanisms:
  - alert on provider endpoint changes and dependency digest drift.
- Containment mechanisms:
  - freeze provider updates during incident response;
  - rotate exposed credentials;
  - invalidate compromised release channels.
- Validation steps:
  - negative tests for unapproved endpoint URLs;
  - digest/signature verification in CI and installers.
- Priority:
  - P0.

### Attack Surface: Infrastructure and Cloud Boundaries

- Likely attacker goals:
  - compromise remote VMs;
  - intercept deploy traffic;
  - pivot from control plane to runtime.
- Likely attack methods:
  - MITM during SSH/rsync/scp;
  - weakly hardened remote VM;
  - broad security group exposure.
- Concrete mitigations:
  - enforce SSH host key verification or SSH CA;
  - use hardened base images for remote VMs;
  - store secrets in a secret manager or root-owned service env file only;
  - close all unnecessary inbound ports.
- Detection mechanisms:
  - SSH connection auditing;
  - config drift detection;
  - alerts on instance exposure changes.
- Containment mechanisms:
  - quarantine or destroy remote VM;
  - revoke deploy credentials;
  - redeploy from attested artifact.
- Validation steps:
  - remote deploy test with host key pinning enabled;
  - remote VM benchmark against a hardening baseline.
- Priority:
  - P0.

### Attack Surface: CI/CD and Release Paths

- Likely attacker goals:
  - ship malicious code through trusted releases;
  - steal signing or publish credentials.
- Likely attack methods:
  - compromised runner;
  - malicious dependency update;
  - unsigned or unverifiable release process.
- Concrete mitigations:
  - branch protection, CODEOWNERS, signed releases, SBOM, provenance, and pinned build dependencies;
  - OIDC-based ephemeral credentials;
  - artifact verification in downstream installers.
- Detection mechanisms:
  - CI artifact attestation checks;
  - anomaly detection for publishing actions.
- Containment mechanisms:
  - revoke publish keys;
  - yank compromised releases;
  - publish incident advisory and verified replacement.
- Validation steps:
  - reproducible build test;
  - provenance verification as a release gate.
- Priority:
  - P1.

### Attack Surface: Dependency Chain

- Likely attacker goals:
  - obtain execution on build hosts, operator workstations, or inside the sandbox image.
- Likely attack methods:
  - npm/pip/installer poisoning;
  - malicious release asset.
- Concrete mitigations:
  - lockfiles in all builds;
  - digest or signature checks for downloaded binaries;
  - SBOM and vulnerability scanning;
  - internal mirror for high-trust deployments.
- Detection mechanisms:
  - lockfile drift alerts;
  - vulnerability and integrity scans.
- Containment mechanisms:
  - block release if attestation or scanning fails;
  - rapid rollback to last attested build.
- Validation steps:
  - dependency review gate on every update.
- Priority:
  - P0.

### Attack Surface: Background Workers

- Likely attacker goals:
  - exploit long-lived processes such as the bridge, tunnel, gateway, or auto-pair watcher.
- Likely attack methods:
  - abusing weak configs;
  - credential theft from worker env;
  - stealthy persistence.
- Concrete mitigations:
  - run background workers under dedicated service accounts;
  - minimize inherited environment;
  - remove auto-pair watcher in production;
  - supervise workers through hardened service management, not loose nohup shells.
- Detection mechanisms:
  - service state monitoring and integrity checks.
- Containment mechanisms:
  - immediate service disable and credential rotation.
- Validation steps:
  - verify worker environments contain only required secrets and no broad inherited shell environment.
- Priority:
  - P1.

### Attack Surface: Monitoring and Logging Systems

- Likely attacker goals:
  - hide activity;
  - obtain leaked secrets or public URLs from logs.
- Likely attack methods:
  - log scraping;
  - tampering with local temp logs.
- Concrete mitigations:
  - off-host write-restricted audit logging;
  - token/secret redaction;
  - split debug logs from security logs;
  - remove `/tmp` as the only log sink for important security events.
- Detection mechanisms:
  - missing-log and tamper alerts;
  - alerting on unexpected redaction failures.
- Containment mechanisms:
  - log sink isolation and retention of incident snapshots.
- Validation steps:
  - replay test of tunnel start, provider change, and unauthorized pairing to confirm alerts fire.
- Priority:
  - P1.

### Attack Surface: Agent, Tool, and Plugin Execution Surfaces

- Likely attacker goals:
  - use the agent as an exfiltration or automation broker;
  - escape intended capability limits.
- Likely attack methods:
  - prompt injection through UI or Telegram;
  - abuse of broad outbound policy;
  - malicious local state imported through migration.
- Concrete mitigations:
  - capability-tiered sandbox profiles;
  - no broad outbound destinations in the base policy;
  - approval and audit for policy expansion;
  - quarantine imported hooks/skills.
- Detection mechanisms:
  - unusual egress alerts;
  - tool invocation telemetry;
  - anomaly detection on prompt-driven network activity.
- Containment mechanisms:
  - revoke broad policy presets;
  - snapshot and quarantine sandbox.
- Validation steps:
  - red-team prompt sequences attempting exfiltration through all allowed destinations.
- Priority:
  - P1.

## 5. Countermeasures for Realistic Attack Chains

### Attack Chain: Public tunnel -> weakened UI auth -> unauthorized control

Why it is plausible:

- `SECURITY_RECON.md` identified both the public tunnel path and the weakened auth/auto-pair behavior in the sandbox startup path.

What enables it today:

- raw cloudflared exposure;
- `allowInsecureAuth`;
- `dangerouslyDisableDeviceAuth`;
- automatic device approval;
- tokenized URL printing.

Preventive controls:

- remove insecure auth flags from production;
- no raw public tunnel in production;
- force IdP/MFA-backed access proxy in front of the UI;
- no auto-pairing;
- short-lived proxy sessions instead of tokenized URLs.

Detective controls:

- alerts on tunnel start, new public hostname, pairing requests, pairing approvals, repeated failed access attempts.

Containment controls:

- immediate tunnel disable;
- session invalidation at the proxy;
- sandbox quarantine if unauthorized access is suspected.

Recovery controls:

- rotate UI/session material and any secrets exposed via logs or URLs;
- redeploy the secure startup profile and review audit trail.

Remaining residual risk:

- If OpenClaw/OpenShell itself has an auth or session flaw, the access proxy reduces but does not erase the risk.

### Attack Chain: Unrestricted Telegram bridge -> remote prompt/tool abuse

Why it is plausible:

- The bridge is coded to accept chats unless an optional allowlist is configured.

What enables it today:

- permissive default;
- direct forwarding of prompt text to the agent;
- no visible rate limits or per-chat trust elevation;
- inherited access to powerful runtime capabilities.

Preventive controls:

- disable bridge by default;
- mandatory chat enrollment and allowlist;
- per-chat rate limits and quotas;
- remote prompt sessions bound to `chat-only` or `read-only-research` capability profile;
- separate bot token and service account with tight secret scope.

Detective controls:

- alert on new chat IDs, spike in prompt volume, repeated denials, unusual working hours/geography.

Containment controls:

- bridge shutdown;
- bot token rotation;
- sandbox policy rollback to minimal profile.

Recovery controls:

- revoke leaked data paths where possible;
- review prompt and tool telemetry to assess exfiltration.

Remaining residual risk:

- Allowed users can still intentionally or accidentally submit harmful prompts; the bridge remains a high-risk remote ingress even when restricted.

### Attack Chain: Malicious operator input -> host command execution

Why it is plausible:

- The host CLI presently routes multiple commands through `bash -c`.

What enables it today:

- shell-string execution;
- mixed trust between operator-provided values and command syntax;
- lack of a hard ban on unsafe exec patterns.

Preventive controls:

- replace all shell-string execution with argv-safe process calls;
- strict input schemas;
- Semgrep/CodeQL checks that fail CI on new unsafe patterns.

Detective controls:

- audit rejected input values;
- workstation EDR;
- shell execution telemetry for high-risk commands.

Containment controls:

- isolate admin workstations;
- immediate secret rotation if operator compromise suspected.

Recovery controls:

- rebuild workstation from known-good image;
- revoke and reissue deploy, GitHub, NVIDIA, and Telegram credentials.

Remaining residual risk:

- An already-compromised operator machine can still abuse the CLI legitimately.

### Attack Chain: MITM or spoofed host during Brev deploy

Why it is plausible:

- The deploy path explicitly disables SSH host key verification.

What enables it today:

- `StrictHostKeyChecking=no`;
- rsync/scp/ssh to remote host;
- copy of secrets into remote `.env`.

Preventive controls:

- pin SSH host keys or use SSH CA;
- remove raw `.env` secret staging where possible;
- deploy only from hardened bastion or admin workstation.

Detective controls:

- log host key fingerprints used for each deployment;
- alert on changed host keys or unexpected target IPs.

Containment controls:

- revoke deploy-time secrets;
- destroy and rebuild suspect remote host from attested artifacts.

Recovery controls:

- rotate all secrets copied during deploy;
- audit remote host for unauthorized modifications.

Remaining residual risk:

- A compromised but legitimate remote VM will still see deployed secrets unless the design moves fully to runtime secret injection.

### Attack Chain: Compromised dependency or release asset -> pre-runtime compromise

Why it is plausible:

- Installers and builds currently rely on live downloads and partially unpinned dependency resolution.

What enables it today:

- curl-to-shell installers;
- live GitHub release downloads;
- missing lockfile use in the production Docker build;
- unsigned or unverified release chain visible in the repo.

Preventive controls:

- lockfiles in all builds;
- signature/digest verification of release assets;
- SBOM generation;
- artifact signing and provenance.

Detective controls:

- dependency integrity checks;
- vulnerability and drift scanning;
- attestation verification during deploy.

Containment controls:

- revoke compromised release;
- block install path until verified artifacts are restored.

Recovery controls:

- republish from verified source state with new signatures;
- notify operators to rotate secrets if compromised installer/build path had access.

Remaining residual risk:

- Upstream zero-day or sophisticated compromise of a signed trusted source can still propagate malicious code.

### Attack Chain: Poisoned host state imported during migration

Why it is plausible:

- Migration explicitly preserves external roots and symlinks and imports behavior-defining content.

What enables it today:

- trust in existing `.openclaw` state;
- lack of quarantine for imported hooks/skills;
- symlink preservation.

Preventive controls:

- quarantine imported artifacts;
- sign snapshot manifests;
- reject or rewrite unsafe symlinks;
- require operator review before enabling imported hooks/extensions.

Detective controls:

- detailed import inventory and diff logs;
- alert on executable or unexpected file types.

Containment controls:

- block activation of imported content;
- revert to clean sandbox image and known-good state.

Recovery controls:

- restore from verified clean snapshot or rebuild from scratch;
- investigate upstream workstation compromise.

Remaining residual risk:

- If the operator intentionally approves poisoned content, technical controls only reduce, not eliminate, risk.

### Attack Chain: Malicious custom inference endpoint -> prompt/credential capture

Why it is plausible:

- The onboarding flow supports arbitrary endpoint URLs and validates them by sending requests to the target.

What enables it today:

- permissive endpoint configuration;
- direct credential use in provider setup;
- no production allowlist for endpoints.

Preventive controls:

- production endpoint allowlist;
- separate lab-only mode for custom endpoints;
- endpoint CA and hostname validation;
- warnings are not enough; enforce policy in code.

Detective controls:

- alert on provider endpoint changes, non-approved hostnames, and custom endpoint usage.

Containment controls:

- freeze provider changes during incident response;
- roll back to approved provider profile.

Recovery controls:

- rotate exposed API keys;
- review model traffic and prompts for leakage impact.

Remaining residual risk:

- Approved third-party providers can still be compromised or legally compelled; model traffic always inherits provider trust risk.

## 6. Security Control Matrix

| Risk / attack path | Affected asset | Required control | Implementation layer | Priority | Owner | Verification method |
| --- | --- | --- | --- | --- | --- | --- |
| Public tunnel -> UI takeover | Control UI, agent runtime | No raw public tunnel in production; access proxy + MFA; remove insecure auth flags; disable auto-pair | `scripts/start-services.sh`, `scripts/nemoclaw-start.sh`, deployment architecture | P0 | Maintainers + Platform | External access test, auth red-team, config review |
| Telegram bridge abuse | Agent runtime, inference budget | Bridge disabled by default, mandatory allowlist/enrollment, rate limits, low-privilege runtime profile | `scripts/telegram-bridge.js`, service management | P0 | Maintainers + Operations | Unauthorized chat tests, rate-limit tests, abuse simulation |
| Host CLI command injection | Operator workstation, local secrets | Remove `bash -c`, argv-safe execution, strict input validation, CI ban on unsafe exec | `bin/lib/runner.js`, host CLI code | P0 | Maintainers | Unit tests, Semgrep, code review |
| Deploy MITM / spoofed host | Remote VM, deploy secrets | SSH host key pinning or SSH CA, remove `StrictHostKeyChecking=no`, no loose `.env` staging | `bin/nemoclaw.js`, deploy architecture | P0 | Maintainers + Platform | Deployment test with host-key validation, SSH policy review |
| Supply-chain compromise | Installer hosts, CI, sandbox image | Lockfiles, digest/signature verification, SBOM, provenance, signed releases | installers, Dockerfile, release pipeline | P0 | Release engineering | Reproducible build test, attestation verification |
| Secret sprawl and leakage | API keys, bot token, UI tokens | Keychain/secret manager backend, redaction, no CLI secret args, encrypted snapshots | host CLI, service scripts, ops | P0 | Maintainers + Operations | Secret scan, file-permission audit, process inspection test |
| Overbroad sandbox egress | Sandbox data, prompts, outputs | Minimal base policy; move GitHub/npm/Telegram out of baseline; approval and audit for expansion | `nemoclaw-blueprint/policies/*` | P1 | Maintainers + Security owner | Policy review, exfiltration simulation |
| Malicious custom endpoint | Prompts, credentials | Endpoint allowlist, lab-only custom mode, change alerts | plugin onboarding, provider config | P1 | Maintainers | Negative tests for disallowed endpoints, alert validation |
| Poisoned migration state | Sandbox integrity | Quarantine imports, symlink restrictions, manual enablement of imported hooks | migration code | P1 | Maintainers | Symlink/path abuse tests, import inventory review |
| Unverified OpenShell / runtime assumptions | Overall containment model | Formal validation of auth semantics, provider secret storage, sandbox isolation | architecture and validation program | P1 | Security owner + Platform | Architecture review, upstream source review, runtime pen test |
| Missing CI/release confidence | Distributed artifacts | Branch protection, CODEOWNERS, pinned CI actions, OIDC, release review gates | VCS/CI | P1 | Release engineering | CI audit, dry-run release verification |
| Weak auditability | Incident response capability | Structured security events off-host with tamper resistance | host CLI, plugin, service management | P1 | Operations + Security owner | Alert and log replay tests |

## 7. Repository-Ready SECURITY.md

The section below is the concise repository-facing policy text maintainers should preserve even if this larger architecture document is later split into `SECURITY.md` and a separate architecture or operations guide.

### Security Policy

#### Supported Versions

NemoClaw is alpha software. During alpha, security support applies only to:

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Most recent published tag in the active release line | Yes |
| Older tags and unsupported forks | No |

Security fixes may land only on `main` and the most recent supported release unless maintainers explicitly announce backports.

#### Reporting Security Issues

- Do not report vulnerabilities in public GitHub issues or pull requests.
- Report potential security vulnerabilities through NVIDIA PSIRT:
  - Web: <https://www.nvidia.com/object/submit-security-vulnerability.html>
  - Email: `psirt@nvidia.com`
  - PGP: use NVIDIA's published PGP key for sensitive email communication
- Include, at minimum:
  - affected NemoClaw version, branch, or commit;
  - deployment mode used;
  - exact reproduction steps;
  - impact;
  - proof of concept if available;
  - whether the issue requires public tunnel, Telegram bridge, migration, or remote deploy features.

#### Disclosure Policy

- Coordinated disclosure is required.
- Maintainers may move discussion away from public channels immediately.
- Public disclosure before a fix is available is strongly discouraged because NemoClaw includes privileged orchestration, sandbox management, and remote exposure features.

#### Response Expectations

- Reporters should expect acknowledgment through NVIDIA PSIRT processes.
- Repo-level target for initial maintainer triage is within 5 business days.
- Critical issues affecting remote control, secret theft, supply-chain compromise, or host command execution should trigger immediate containment guidance once confirmed.
- Timing of fixes depends on severity, exploitability, and dependency on upstream OpenShell/OpenClaw changes.

#### Scope

In scope:

- host CLI code under `bin/`;
- plugin code under `nemoclaw/`;
- blueprint and policy code under `nemoclaw-blueprint/`;
- container build files and shell scripts;
- deployment, onboarding, migration, provider, policy, tunnel, and Telegram bridge behavior;
- release and installer integrity concerns for official NemoClaw artifacts.

Out of scope unless explicitly tied to NemoClaw:

- unsupported forks and downstream modifications;
- generic feature requests;
- issues that require undocumented debug-only changes to reproduce;
- vulnerabilities solely in third-party software with no NemoClaw-specific impact path.

#### Secret Handling Rules

- Never commit secrets, tokens, `.env` files, SSH private keys, or provider credentials to the repository.
- Never post secrets in issues, pull requests, screenshots, or logs.
- Production deployments must not rely on loose plaintext secret files when a keychain or secret manager is available.
- Secret scope must be minimal and separated by function: inference, release, Telegram, remote access, and CI must not share credentials.

#### Environment Variable Handling Rules

- Environment variables are acceptable for local development only when no safer local secret backend exists.
- Production or shared-host deployments must source secrets from a secret manager, OS keychain integration, or tightly controlled service environment files with restrictive permissions.
- Do not pass secrets as CLI arguments when an alternative exists.
- Do not print tokens or tokenized URLs to normal logs or shell output.

#### Dependency and Update Rules

- All release and image builds must use checked-in lockfiles.
- New external download paths require integrity verification by digest or signature.
- Floating `latest` downloads are not acceptable in production or release builds.
- Dependency updates affecting startup scripts, remote deploy, public exposure, auth, provider routing, or container contents require explicit review by code owners.

#### Release Hardening Requirements

- No release may ship with production defaults that enable:
  - raw public tunnel exposure;
  - `allowInsecureAuth`;
  - `dangerouslyDisableDeviceAuth`;
  - automatic device approval.
- Release builds must produce:
  - SBOMs;
  - signed artifacts and container images;
  - verifiable provenance;
  - vulnerability scan results;
  - secret-scan results.
- Release artifacts must be built from reviewed source with pinned dependencies.

#### Deployment Security Requirements

- `StrictHostKeyChecking=no` is not acceptable for production deployment.
- Public internet exposure of the control UI requires an authenticated private access layer with MFA.
- Telegram bridge must be disabled by default and explicitly allowlisted when used.
- Remote VMs must be hardened, patched, and configured with least-privilege inbound access.
- Migration imports must be treated as untrusted until validated.

#### Access Control Expectations

- Administrative NemoClaw operations must be restricted to authorized operators.
- Provider changes, policy expansion, public exposure enablement, and release changes require explicit review and auditability.
- Production operations should use dedicated admin endpoints or bastions, not unmanaged personal workstations.

#### Logging and Monitoring Expectations

- Security-relevant actions must be logged with identity, target, and change details.
- Secrets, session tokens, and public URLs must be redacted from logs.
- Tunnel startup, Telegram bridge startup, provider endpoint changes, policy changes, and device pairing events must be alertable.

#### Incident Response Expectations

- Maintainers must be able to:
  - disable public tunnel access;
  - disable Telegram ingress;
  - rotate inference, GitHub, and Telegram credentials;
  - freeze provider and policy changes;
  - quarantine or destroy a sandboxed deployment.
- Incident handling must preserve enough evidence for root-cause analysis without keeping sensitive data indefinitely.

#### Secure Contribution Expectations

- Do not introduce new shell-string execution with untrusted input.
- Do not introduce new remote exposure features without an explicit trust-boundary review.
- Do not widen the base network policy without explaining why the agent needs that egress by default.
- Do not introduce new download/install paths without integrity verification.
- Security-sensitive code paths require tests, threat-model notes, and code-owner review.

#### Security Testing Required Before Release

- secret scanning;
- lockfile and dependency integrity verification;
- static analysis of shell, Node.js, and Python code;
- container/image scanning;
- tests that confirm insecure UI auth and auto-pair are not enabled in production defaults;
- tests that confirm Telegram bridge deny-by-default behavior;
- validation of SSH host key checking in remote deploy paths;
- review of sandbox policy deltas.

## 8. Prioritized Remediation Roadmap

### Phase 0 - Immediate Critical Risk Reduction

| Action | Why it matters | Risk reduced | Owner | Dependency | Difficulty | Urgency | Expected risk reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Remove `allowInsecureAuth`, `dangerouslyDisableDeviceAuth`, and auto-pair from production defaults | Directly breaks the top remote takeover path | Public control-surface compromise | Maintainers | Runtime validation of OpenClaw/OpenShell auth behavior | Medium | Immediate | Very high |
| Disable raw public tunnel in production paths and fail closed if secure access layer is absent | Stops the easiest internet entry point | Public UI exposure | Maintainers + Platform | Access-proxy design | Medium | Immediate | Very high |
| Replace `bash -c` orchestration with argv-safe execution for all user-influenced commands | Eliminates a host-RCE primitive | Host compromise via CLI injection | Maintainers | Command inventory | High | Immediate | Very high |
| Enforce SSH host key verification or SSH CA for Brev deploy | Removes a direct transport authenticity failure | Deploy MITM and remote bootstrap compromise | Maintainers + Platform | Host key or SSH CA distribution | Medium | Immediate | High |
| Disable Telegram bridge by default and require explicit chat allowlist/enrollment | Removes a permissive remote prompt ingress | Unauthorized Telegram prompt abuse | Maintainers | Minimal bridge redesign | Low-Medium | Immediate | High |
| Stop copying broad plaintext remote `.env` bundles where possible; tighten permissions as an immediate fallback | Shrinks secret sprawl quickly | Secret theft on remote VM | Maintainers + Operations | Secret backend decision | Medium | Immediate | High |
| Update the production Docker build to use checked-in lockfiles and pinned base image digests | Closes an avoidable supply-chain gap | Build/image compromise | Release engineering | Lockfile discipline | Medium | Immediate | High |

### Phase 1 - High-Priority Hardening

| Action | Why it matters | Risk reduced | Owner | Dependency | Difficulty | Urgency | Expected risk reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Introduce secure startup profiles (`dev-insecure`, `local-secure`, `prod-secure`) | Prevents convenience flags from leaking into production | Insecure default configuration | Maintainers | Phase 0 auth changes | Medium | High | High |
| Narrow the base sandbox network policy to inference-only plus core runtime needs | Reduces exfiltration and C2 options | Agent exfiltration | Maintainers + Security owner | Review of actual minimum required egress | Medium | High | High |
| Implement structured security event logging and off-host shipping | Enables detection and response | Silent exposure and admin tampering | Operations + Maintainers | Logging sink | Medium | High | Medium-High |
| Add static analysis and lint gates for shell, JS/TS, Python, secrets, and container content | Converts recurring classes into release blockers | Shell injection, secret leaks, supply-chain drift | Release engineering | CI setup | Medium | High | Medium-High |
| Enforce provider endpoint allowlist for production and lab-only mode for custom endpoints | Stops credential/prompt routing to arbitrary hosts | Malicious custom endpoint use | Maintainers | Config model update | Medium | High | Medium-High |
| Quarantine migration imports and validate symlink scope before activation | Reduces persistence transfer during migration | Poisoned local state import | Maintainers | Migration redesign | Medium | High | Medium |

### Phase 2 - Structural Security Upgrades

| Action | Why it matters | Risk reduced | Owner | Dependency | Difficulty | Urgency | Expected risk reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Put the control UI behind an IdP-backed private access layer with MFA | Creates a real identity boundary for browser access | Remote UI compromise | Platform | Phase 0 exposure changes | Medium-High | Medium | Very high |
| Replace plaintext local secret storage with OS keychain or secret manager integration | Reduces persistent secret theft from endpoints | Local credential compromise | Maintainers | Secret backend design | Medium-High | Medium | High |
| Move long-lived remote secrets to managed secret injection or tightly scoped service env files | Prevents broad remote `.env` sprawl | Remote host secret theft | Platform + Operations | Secret manager or service manager integration | Medium-High | Medium | High |
| Generate SBOMs, sign releases/images, and attach provenance to all official artifacts | Makes release trust auditable | Supply-chain compromise | Release engineering | CI/CD hardening | High | Medium | High |
| Formalize RBAC and change approval for provider/policy changes in production | Stops unilateral weakening of boundaries | Admin abuse and configuration drift | Security owner + Maintainers | Identity model | High | Medium | Medium-High |

### Phase 3 - Advanced Defensive Maturity

| Action | Why it matters | Risk reduced | Owner | Dependency | Difficulty | Urgency | Expected risk reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Introduce capability-tiered sandbox profiles for prompt-only, research, build, and deployment use cases | Limits blast radius from prompt injection and remote prompt surfaces | Tool abuse and exfiltration | Maintainers + OpenShell integrators | Upstream/runtime support | High | Medium | High |
| Add just-in-time elevation for broad network presets and privileged admin actions | Reduces standing privilege | Insider misuse and lateral movement | Platform + Security owner | RBAC and audit layer | High | Medium | Medium-High |
| Run management only from dedicated admin endpoints or bastions with hardware-backed authentication | Hardens the most privileged trust boundary | Operator endpoint compromise | Operations | Endpoint management program | Medium-High | Medium | Medium-High |
| Add immutable or append-only security audit storage with alert replay testing | Improves forensic confidence | Tampering and blind spots | Operations | Logging platform | Medium | Medium | Medium |
| Add policy diff approval workflow and signed policy manifests | Prevents quiet egress broadening | Policy tampering | Maintainers + Security owner | Policy tooling | Medium | Medium | Medium |

### Phase 4 - Continuous Security Operations

| Action | Why it matters | Risk reduced | Owner | Dependency | Difficulty | Urgency | Expected risk reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Quarterly threat-model and architecture review against actual deployments | Keeps controls aligned with reality | Drift and stale assumptions | Security owner | Deployment inventory | Medium | Ongoing | Medium |
| Regular credential rotation and access review | Limits value of stolen credentials | Secret replay | Operations | Secret backend | Low-Medium | Ongoing | Medium |
| Annual or release-triggered external penetration test focused on public edge, CLI, deploy path, and prompt surfaces | Finds issues internal review misses | Unknown exploitable flaws | Security owner | Stable test environment | Medium-High | Ongoing | Medium-High |
| Red-team exercises for prompt abuse, supply-chain compromise, and operator compromise scenarios | Validates containment and IR | High-end adversary chains | Security owner + Operations | Runbooks and logging | High | Ongoing | Medium-High |
| Restore drills for encrypted snapshots and clean-room rebuilds | Ensures recovery is real, not theoretical | Disaster recovery failure | Operations | Backup redesign | Medium | Ongoing | Medium |

## 9. Verification, Audit, and Testing Plan

### Architecture Review Checklist

- Verify the control UI is never directly exposed to the public internet in production.
- Verify any remote browser access traverses a private access layer with MFA.
- Verify insecure UI auth flags and auto-pair do not exist in production profiles.
- Verify management plane and prompt ingress plane are separated.
- Verify default sandbox egress is minimal and that GitHub/npm/Telegram are not in the production baseline.
- Verify secret storage backend choice and remote injection path.
- Verify deploy path authenticates remote hosts.
- Verify capability profiles exist for remote prompt sources.

### Code Review Checklist

- No `bash -c`, `sh -c`, or equivalent shell-string execution for user-influenced data.
- No new public exposure features without explicit trust-boundary notes.
- No new secrets in logs, shell output, URLs, or test fixtures.
- No new floating or unverifiable external downloads in release paths.
- No widening of the base network policy without justification.
- No new migration import behavior without path, symlink, and activation review.
- Security-sensitive files require code-owner approval: `scripts/*`, `bin/*`, `Dockerfile`, `nemoclaw-blueprint/policies/*`, `nemoclaw/src/commands/*`.

### Secrets Audit

- Run repository secret scanning with `gitleaks` or equivalent.
- Audit runtime files on a test deployment:
  - `~/.nemoclaw/*`
  - `~/.openclaw/*`
  - remote service env files
  - `/tmp` artifacts
- Verify file modes and ownership.
- Verify secrets do not appear in:
  - process arguments;
  - logs;
  - shell histories;
  - public URLs.

### Dependency Audit

- Use `npm audit` and `osv-scanner` as a minimum, not as the whole program.
- Generate SBOMs with `syft`.
- Scan images and packages with `grype` or `trivy`.
- Diff lockfiles on every dependency change.
- Verify release asset digests/signatures in CI and installer paths.

### Infrastructure Audit

- Confirm no direct public ingress to OpenShell or the control UI.
- Confirm SSH host key pinning or SSH CA for deploy targets.
- Confirm remote VM patching, disk encryption, and restrictive security groups.
- Confirm no broad inbound ports are exposed.
- Confirm cloudflared is absent from production or wrapped by strong access controls.

### IAM and Privilege Audit

- Review operator accounts and whether separate admin endpoints are used.
- Review GitHub token scopes and publishing credentials.
- Review NVIDIA API key exposure paths and rotation process.
- Review Telegram bot ownership, secret scope, and allowed chat enrollment.
- Review who can change provider endpoints and policy manifests.

### Auth and Authz Test Plan

- Verify that the UI is unreachable without the private access layer in production mode.
- Verify that pairing requires authenticated human approval.
- Verify that a copied old tokenized URL does not create a valid session.
- Verify that unapproved Telegram chats are denied.
- Verify that prompt-only channels cannot trigger infrastructure actions.
- Verify that only authorized operators can modify policy/provider state.

### Abuse-Case Testing

- Prompt injection attempts to exfiltrate via any default-allowed destination.
- Cost-exhaustion attempts through Telegram or browser session.
- Malicious operator-input tests for CLI argument injection.
- Custom endpoint abuse tests using hostile endpoints.
- Migration tests with poisoned hooks, skills, and symlink chains.

### Attack-Surface Verification

- Confirm cloudflared is disabled by default and blocked in production mode.
- Confirm Telegram bridge is disabled by default and requires explicit allowlisting.
- Confirm `--no-verify` is removed or tightly controlled in production paths.
- Confirm provider endpoint allowlist enforcement.

### File-Handling Security Testing

- Test symlink escaping, absolute symlinks, deep relative symlinks, oversized files, and unusual file types in migration imports.
- Verify imported hooks/extensions are quarantined and not auto-enabled.
- Test snapshot encryption and manifest integrity validation.

### Container and Runtime Validation

- Verify non-root execution.
- Verify base image digest pinning.
- Verify read-only root filesystem where supported.
- Verify dropped capabilities, `no-new-privileges`, and seccomp/AppArmor/Landlock behavior.
- Validate sandbox escape assumptions through focused runtime testing.

### Logging and Alert Validation

- Confirm alerts fire for:
  - tunnel start;
  - Telegram bridge start;
  - new chat enrollment;
  - provider endpoint changes;
  - policy changes;
  - pairing requests and approvals.
- Confirm logs redact tokens, secrets, and public URLs.
- Confirm audit logs cannot be silently truncated or overwritten by application code.

### Backup and Restore Security Testing

- Test encrypted snapshot creation, retention, and restore.
- Run clean-room restore from a known-good snapshot.
- Verify restores do not reactivate quarantined malicious content without approval.

### CI/CD Security Checks

- Secret scan on every push and PR.
- Static analysis for shell, JS/TS, and Python.
- Dependency and container scanning.
- Lockfile drift detection.
- Build provenance generation and verification.
- Signed artifact verification before publish.

### Release Gate Requirements

- No release if insecure UI auth or auto-pair is enabled in production defaults.
- No release if tunnel exposure is not gated behind the secure edge model.
- No release if lockfiles are missing or ignored in release builds.
- No release if artifact signatures, SBOMs, or provenance are missing.
- No release if critical vulnerabilities remain in the release artifact set without an explicit, documented exception approved by the security owner.

### Penetration-Testing Priorities

1. Browser access path to the control UI.
2. Telegram bridge abuse path.
3. Host CLI injection surface.
4. Brev deploy transport trust and remote bootstrap.
5. Custom provider endpoint routing.
6. Migration import poisoning and symlink behavior.
7. Runtime exfiltration through allowed egress.

### Red-Team Exercise Ideas

- Discover and seize a leaked or logged public tunnel URL.
- Spearphish an operator into using a crafted sandbox or instance name to test CLI hardening.
- Simulate a compromised dependency release in the installer path.
- Plant malicious `.openclaw` state and test migration quarantine.
- Attempt prompt-driven exfiltration through every allowed network preset.
- Simulate compromise of a remote deploy target and measure secret rotation/containment time.

### Recurring Security Review Cadence

- Per security-sensitive release: full gate review.
- Quarterly: threat-model and trust-boundary review.
- Semiannual: restore drill and credential-scope review.
- Annual or after major architecture changes: external penetration test or red-team engagement.

## 10. Assumptions That Still Require Closure

| Assumption | Why it still matters | What control design depends on it | What must be checked | What changes if false |
| --- | --- | --- | --- | --- |
| The UI on `18789` is a privileged control surface | This drives the access-proxy and no-public-exposure design | Public-edge architecture, session model | Runtime validation of actual UI capabilities | If it is less privileged than inferred, some controls can be relaxed, but exposure still needs review |
| `allowInsecureAuth` and `dangerouslyDisableDeviceAuth` materially weaken auth | The strongest P0 recommendations assume they do | Identity/auth architecture | Upstream docs and runtime testing | If semantics are narrower than inferred, the severity drops, but raw public exposure is still unsafe until proven otherwise |
| Auto-pair can approve arbitrary or attacker-controlled clients | This drives its outright removal from production | Pairing and session controls | Runtime auth tests and upstream source review | If it only approves a constrained local client, production policy might allow a narrower secure version |
| OpenShell provides meaningful sandbox isolation | Most runtime containment controls rely on it | Runtime hardening, capability profiles | OpenShell threat model and runtime validation | If false, NemoClaw needs much stronger out-of-band containment and some deployment modes may be indefensible |
| OpenShell can store provider secrets more safely than NemoClaw currently does | Secret architecture depends on avoiding ad hoc `.env` sprawl | Secret management model | OpenShell provider secret storage review | If false, a separate secret backend or sidecar injection model is required |
| Production uses of NemoClaw will want remote browser access | Drives the need for an access broker rather than "no remote access ever" | Public edge architecture | Product/ops intent review | If false, the simplest secure posture is to keep the UI local-only and delete remote exposure features |
| Production uses of NemoClaw will want Telegram-based prompt ingress | Drives whether to harden the bridge or deprecate it | Telegram bridge design | Product/ops intent review | If false, the bridge should remain a lab-only tool or be removed |
| `--no-verify` bypasses something materially important | Drives removal or restriction of the flag | Provider/inference hardening | OpenShell command semantics review | If false, this becomes a lower-priority cleanup item |
| CI/CD and release signing can be controlled by the repo maintainers | Needed for provenance and release-gate recommendations | Supply-chain model | Actual release pipeline ownership and tooling | If false, security architecture must include external release governance outside the repo |
| Operators can realistically use hardened admin endpoints or bastions | Several operational controls assume a managed admin environment | Admin surface isolation, endpoint hardening | Ops model review | If false, some controls must move closer to the product because operator discipline alone is insufficient |

## 11. Overkill vs High-Value Controls

### High-Value Controls That Should Almost Certainly Be Implemented

- Remove insecure UI auth flags and auto-pair from all production and release-default paths.
- Prohibit raw public tunnel exposure in production; require an authenticated access layer.
- Replace `bash -c` host orchestration with argv-safe process execution and strict input validation.
- Enforce SSH host authenticity for remote deploy.
- Move secrets out of plaintext local JSON and loose remote `.env` files.
- Tighten the base network policy to inference-only plus true minimum runtime dependencies.
- Disable Telegram bridge by default and require mandatory allowlisting plus rate limits when enabled.
- Use checked-in lockfiles, pinned base image digests, release-asset verification, SBOMs, and signed provenance.
- Add structured off-host audit logging for policy changes, provider changes, tunnel startup, deploys, and pairing.

These controls directly address the highest-ranked risks and materially reduce attacker opportunity.

### Advanced / Expensive / Diminishing-Return Controls

- Internal mirrored package and binary registries for all bootstrap dependencies.
- Hardware-backed mandatory admin authentication and separate managed bastion fleet for all operators.
- Full per-session ephemeral sandboxes and one-time workspaces for every remote prompt source.
- eBPF-based runtime anomaly detection on operator hosts and deployed VMs.
- Formal dual-control approval workflow for every production policy change and provider change.
- Memory-safe reimplementation of the host orchestration layer once the design stabilizes.
- Cryptographic signing of snapshot manifests and backup bundles with a separate trust hierarchy.

These controls are defensible for high-risk or regulated environments, but they have higher implementation and operational cost. They should not be allowed to delay the P0 and P1 fixes above.

## 12. Residual Risk Statement

Even after the hardening in this document is implemented, NemoClaw will not be "safe by document." It will remain a privileged orchestration system that manages an agent runtime with meaningful external connectivity and depends heavily on upstream software not fully controlled by this repository.

Residual risks that remain even after serious hardening:

- OpenShell or OpenClaw may contain auth, sandbox, provider, or session vulnerabilities that NemoClaw can only partially mitigate.
- A compromised operator endpoint can still abuse legitimate admin access.
- An approved inference provider can still see prompts and responses and may itself be compromised, malicious, or legally compelled.
- Strong prompt injection and tool abuse remain live risks whenever the agent is allowed broad file or network capabilities.
- Supply-chain compromise of a trusted, signed upstream dependency or release source is still possible.
- Insider misuse, careless operator actions, and rushed emergency changes can still weaken the environment faster than technical controls can compensate.
- Misconfiguration at deployment time can still reopen the very trust boundaries this document tries to close.
- Zero-days in the OS, container runtime, OpenShell, OpenClaw, cloud edge, or SSH client stack can still create high-impact chains.

What cannot be guaranteed:

- that a sophisticated attacker will never compromise a deployment;
- that sandbox isolation will withstand all host, kernel, or upstream runtime exploits;
- that remote prompt surfaces can be made low risk if they are granted high-capability tools and broad egress;
- that supply-chain verification can fully prevent compromise of a truly trusted upstream.

What still depends on operator discipline:

- not enabling public exposure casually;
- not relaxing policy presets without review;
- using managed admin endpoints;
- rotating secrets after suspected exposure;
- keeping deployments patched and monitored;
- not treating lab-only modes as production-ready.

What still depends on correct deployment and maintenance:

- access-proxy correctness;
- SSH trust configuration;
- secret-backend integration;
- CI/CD provenance enforcement;
- log shipping and alerting;
- actual OpenShell/OpenClaw runtime behavior matching assumptions.

What sophisticated attackers could still try:

- compromise an operator endpoint and use legitimate admin tooling;
- chain an upstream OpenShell/OpenClaw flaw with exposed runtime capabilities;
- target release engineering or dependency publishers;
- abuse an approved external provider or allowed egress destination;
- poison local state before migration;
- wait for an operator to enable demo or lab modes in a production-like environment.

Strong security for NemoClaw is not a one-time document. It is a maintained posture that has to be revalidated every time the trust boundaries change, every time a new ingress path is introduced, and every time upstream runtime behavior shifts.
