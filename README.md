# pi-failover

Credential and provider failover for [Pi coding agent](https://github.com/nicobailon/pi-coding-agent) `>=0.84.2`.

```bash
pi install npm:pi-failover
```

## Configuration

pi-failover reads **only** `auth.json` from Pi's `getAgentDir()`: by default
`~/.pi/agent/auth.json`. The `PI_CODING_AGENT_DIR` environment variable remains
compatible with Pi's agent-directory resolution. It never reads or writes
`keyrouter.json`.

Keep Pi's existing primary credential and add a literal, non-empty
`"key-backup"` string to an API-key provider:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "primary-api-key",
    "key-backup": "backup-api-key"
  },
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1767225600000
  }
}
```

An OAuth entry is a provider fallback candidate but has no backup credential.
`key-backup` means a secondary key for the same provider, distinct from
provider fallback across different providers.
Its finite numeric `expires` value is normally written and preserved by Pi's
`/login` flow.
`key-backup` is not expanded from environment variables or commands. Provider
fallback order is the top-level insertion order in `auth.json`.

To migrate manually from `~/.pi/keyrouter.json`, copy each provider's primary
credential into its Pi `auth.json` entry and put its second key in
`"key-backup"`; order the entries as you want providers tried. There is no
dual-read migration path. Pi's `/login` can rewrite `auth.json` and discard
unknown extension fields, so re-add `"key-backup"` after logging in.

## Failover behavior

For each turn, a credential or provider is tried at most once. A successful
2xx response marks the active credential/provider healthy.

| Failure | Action |
| --- | --- |
| 401 / 403 | Disable the current credential for the session; use its backup, then the next provider. |
| 429 | Cool down the current credential; use `Retry-After`, or 60 seconds when absent, then use its backup. |
| 529 / overloaded | Cool down the provider; use `Retry-After`, or 30 seconds when absent, then change provider. |
| 500, 502, 503, 504, network, timeout | Cool down the provider for 30 seconds, then change provider. |
| Other errors | Leave Pi's normal error handling unchanged. |

On provider fallback, pi-failover prefers the current model id and otherwise
uses that provider's first available model. It calls Pi's `setModel()`, so the
new default model persists. There is no automatic failback.

## Commands and output modes

- `/failover status` shows the redacted runtime status.
- `/failover reload` restores extension-owned overrides, then rereads `auth.json`.

| Mode | Notifications |
| --- | --- |
| TUI | Yes |
| RPC | Yes |
| JSON | No UI or injected messages |
| print | No UI or injected messages |

pi-failover never prints credential values or includes them in status and error
messages. Treat `auth.json` as a secret file: do not commit it and restrict its
permissions appropriately.

## Development

```bash
npm test
npm run typecheck
npm pack --dry-run
```
