## Summary

- What changed?
- Why was it needed?

## Validation

- [ ] `npm test`
- [ ] Docs updated if user-visible behavior changed
- [ ] No secrets, tokens, machine-specific paths, or local runtime state were committed

## Security Review

- [ ] This change does not widen public exposure by default
- [ ] This change does not relax sandbox egress without explicit documentation
- [ ] This change does not introduce new plaintext secret handling
- [ ] This change does not add raw shell-string execution for user-influenced input
- [ ] New network endpoints, credentials, or privileged behaviors are documented in `SECURITY.md` if applicable

## Notes

- Any trust-boundary change, deployment assumption, or migration impact belongs here.
