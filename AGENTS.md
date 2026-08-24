# AGENTS

## Repo Purpose

`pi-failover` is a Pi extension that adds credential-level and provider-level failover for Pi coding agent. The runtime entry point is `src/index.ts`.

## Key Files

- `src/index.ts`: extension lifecycle, command registration, retry flow wiring
- `src/auth-catalog.ts`: `auth.json` loading and validation
- `src/failover-engine.ts`: failover decisions and cooldown behavior
- `src/pi-runtime.ts`: runtime credential override ownership and restore logic
- `README.md`: English user-facing documentation
- `README.zh-CN.md`: Chinese user-facing documentation
- `DEPLOY.md`: release and publish process

## Working Rules

- Keep package identity as `pi-failover`.
- Keep user-facing docs aligned across `README.md` and `README.zh-CN.md`.
- Preserve Pi runtime assumptions: read Pi's `auth.json`; do not introduce a new config path.
- Do not place secrets, real tokens, or non-redacted credentials in examples, tests, or docs.
- When documenting fallback behavior, distinguish clearly between backup-key failover and provider failover.

## Verification

Run these commands after code or behavior changes:

```bash
npm test
npm run typecheck
npm pack --dry-run
```

For documentation-only changes, review both README files and `DEPLOY.md` when terminology or package behavior wording changes.
