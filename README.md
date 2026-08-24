# pi-failover

Automatic credential and provider failover for [Pi coding agent](https://github.com/nicobailon/pi-coding-agent) `>=0.84.2`.

- [中文说明](./README.zh-CN.md)

```bash
pi install npm:pi-failover
```

`pi-failover` helps a Pi session keep going when the current credential or provider becomes unavailable. It works with Pi's existing `auth.json` and adds one extension field, `"key-backup"`, for API-key providers.

## Quick Start

### 1. Install the extension

```bash
pi install npm:pi-failover
```

### 2. Edit `auth.json`

`pi-failover` reads only Pi's `auth.json` from `getAgentDir()`, which is usually:

```text
~/.pi/agent/auth.json
```

If `PI_CODING_AGENT_DIR` is set, Pi's own agent-directory resolution still applies.

Keep Pi's primary credential as-is and add a literal, non-empty `"key-backup"` string to any API-key provider that should have a same-provider backup:

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

### 3. Verify that failover is active

Start Pi and run:

```text
/failover status
```

The command shows redacted runtime status only. It never prints raw credential values.

If the active key receives a handled failure during a user request, `pi-failover` can:

- switch to the backup key for the same provider
- switch to the next configured provider
- retry the same user request automatically after a successful switch
- show only the final provider error when every configured option is exhausted

Intermediate provider errors are replaced by a hidden continuation, so no second user message is required. TUI and RPC modes still show one redacted warning for each applied credential or provider switch.

## Configuration Notes

- `pi-failover` never reads or writes `keyrouter.json`.
- `"key-backup"` is a second key for the same provider, not a provider fallback.
- Provider fallback order follows the top-level insertion order in `auth.json`.
- OAuth entries can participate in provider fallback, but they do not support `"key-backup"`.
- `"key-backup"` is treated as a literal string. It is not expanded from environment variables or commands.
- Pi's `/login` flow can rewrite `auth.json` and remove unknown extension fields, so `"key-backup"` may need to be re-added after logging in again.

## How Failover Works

Within one user request, failed credentials and providers are disabled or cooled before the hidden continuation runs. A successful `2xx` response marks the active credential or provider healthy.

| Failure | What pi-failover does |
| --- | --- |
| `401` / `403` | Disables the current credential for the session, switches to its backup key or the next provider, then retries the same request. |
| `429` | Cools down the current credential by `Retry-After`, or by 60 seconds when the header is absent, switches to its backup key, then retries. |
| `529` or overloaded responses | Cools down the provider by `Retry-After`, or by 30 seconds when the header is absent, changes provider, then retries. |
| `500`, `502`, `503`, `504`, network, timeout | Cools down the provider for 30 seconds, changes provider, then retries. |
| Other failures | Leaves Pi's normal error handling unchanged. |

When switching providers, `pi-failover` prefers the current model ID. If that model is unavailable on the next provider, it uses that provider's first available model. The extension calls Pi's `setModel()`, so the new default model persists. There is no automatic failback to the original provider later.

## Commands

- `/failover status`: shows redacted failover state
- `/failover reload`: restores extension-owned overrides, then rereads `auth.json`

## Output Modes

| Mode | Notifications |
| --- | --- |
| TUI | Yes |
| RPC | Yes |
| JSON | No UI notifications; transparent retries still run |
| print | No UI notifications; transparent retries still run |

## Migration Notes

If migrating from `~/.pi/keyrouter.json`, move each provider's primary credential into Pi's `auth.json`, then place the second key for that provider in `"key-backup"`. Reorder the top-level entries in `auth.json` to control provider fallback order.

There is no dual-read migration path. `pi-failover` uses only `auth.json`.

## Security Notes

- Treat `auth.json` as a secret file.
- Do not commit credentials.
- Restrict file permissions appropriately.
- `pi-failover` keeps status and error messages redacted.

## Development

```bash
npm test
npm run typecheck
npm pack --dry-run
```
