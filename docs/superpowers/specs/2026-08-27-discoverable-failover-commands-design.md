# Discoverable Failover Commands Design

## Problem

The extension currently registers only `/failover`. Its `status` and `reload`
operations are handler arguments, so Pi's slash-command picker shows neither
operation. Selecting the generic command also gives weak feedback because the
result is shown only after the hidden default argument is resolved.

## Goals

- Make the status operation directly discoverable as `/failover-status`.
- Make the reload operation equally discoverable as `/failover-reload`.
- Ensure invoking either command produces clear, redacted UI feedback.
- Keep the English and Chinese documentation aligned.

## Non-goals

- Change failover decisions, cooldowns, retry behavior, or credential handling.
- Add a new configuration file or expose credential values.
- Preserve the ambiguous `/failover [status|reload]` command as a compatibility
  alias. The package is pre-1.0, and retaining it would leave the reported
  picker problem in place.

## Command Design

The extension will register two argument-free commands:

- `/failover-status`: format the current catalog and engine snapshot with the
  existing redacted status formatter, then show it as an informational notice.
- `/failover-reload`: restore extension-owned runtime overrides, rebuild state
  from Pi's existing `auth.json`, and show a success or disabled warning.

Both commands will have action-specific descriptions. The old `/failover`
registration will be removed so the picker contains only explicit operations.
Unexpected arguments will not alter behavior because the commands have no
argument contract.

## Error Handling and Security

The existing catalog loader and notification boundary remain responsible for
safe failure behavior. Status and reload messages must remain redacted: tests
will assert that primary and backup credentials never appear in notices.
Reload must continue restoring extension-owned overrides before rereading
`auth.json`.

## Tests

Regression coverage will verify that:

1. Exactly `/failover-status` and `/failover-reload` are registered.
2. Running `/failover-status` without arguments produces a redacted status
   notice.
3. Running `/failover-reload` restores owned overrides, reloads the catalog,
   and produces explicit feedback.
4. Existing non-interactive behavior and credential redaction remain intact.

The implementation will be verified with `npm test`, `npm run typecheck`, and
`npm pack --dry-run` as required by the repository instructions.

## Documentation

`README.md` and `README.zh-CN.md` will replace `/failover status` and
`/failover reload` with their new independent command names. `DEPLOY.md` will be
reviewed for affected terminology; no edit is expected because it does not
document runtime slash commands.
