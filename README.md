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

Keep Pi's primary credential as-is and add `"key-backup"` to any API-key provider that should have same-provider backups. The field accepts either one literal, non-empty string or a non-empty array of literal, non-empty strings:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "primary-api-key",
    "key-backup": ["backup-api-key-1", "backup-api-key-2"]
  },
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1767225600000
  }
}
```

The existing string form remains equivalent to a one-item array. Array entries are tried in order. If the array is empty or any item is invalid, the entire backup field is ignored and the provider remains available only through its primary credential.

### 3. Verify that failover is active

Start Pi and run:

```text
/failover status
```

The command shows redacted runtime status only. It never prints raw credential values.

If the active key receives a handled failure during a user request, `pi-failover` can:

- switch to the next backup key for the same provider
- switch to the next configured provider
- retry the same user request automatically after a successful switch
- show only the final provider error when every configured option is exhausted

Intermediate provider errors are replaced by a hidden continuation, so no second user message is required. TUI and RPC modes still show one redacted warning for each applied credential or provider switch.

Example warnings emitted after a backup-credential switch and provider switches:

![Backup credential switch warning](https://raw.githubusercontent.com/gooyoung/pi-failover/main/docs/images/failover-backup-credential-switch.png)

![Provider switch warnings](https://raw.githubusercontent.com/gooyoung/pi-failover/main/docs/images/failover-provider-switches.png)

If all failover options are exhausted while Pi still has a built-in automatic retry pending, the extension keeps the last active credential in place until that retry finishes. A successful retry keeps that credential active; after a final failure, the extension restores its runtime overrides and reports exhaustion once. This prevents Pi's retry from unexpectedly falling back to a primary credential that already failed.

## Configuration Notes

- `pi-failover` never reads or writes `keyrouter.json`.
- `"key-backup"` contains one or more keys for the same provider, not provider fallbacks.
- Provider fallback order follows the top-level insertion order in `auth.json`, followed by custom providers discovered from Pi in model-registry order.
- OAuth entries can participate in provider fallback, but they do not support `"key-backup"`.
- Every `"key-backup"` value is treated as a literal string. Values are not expanded from environment variables or commands.
- Pi's `/login` flow can rewrite `auth.json` and remove unknown extension fields, so `"key-backup"` may need to be re-added after logging in again.

## How Failover Works

Within one user request, failed credentials and providers are disabled or cooled before the hidden continuation runs. A successful `2xx` response marks the active credential or provider healthy.

| Failure | What pi-failover does |
| --- | --- |
| `401` / `403` | Disables the current credential for the session, switches to the next backup key or the next provider, then retries the same request. |
| `429` | Cools down the current credential by `Retry-After`, or by 60 seconds when the header is absent, switches to the next backup key, then retries. |
| `529` or overloaded responses | Cools down the provider by `Retry-After`, or by 30 seconds when the header is absent, changes provider, then retries. |
| `500`, `502`, `503`, `504`, network, timeout | Cools down the provider for 30 seconds, changes provider, then retries. |
| Other failures | Leaves Pi's normal error handling unchanged. |

When switching providers, `pi-failover` prefers the current model ID. If that model is unavailable on the next provider, it uses that provider's first available model. The extension calls Pi's `setModel()`, so the new default model persists. There is no automatic failback to the original provider later.

Status and warning messages identify credential slots without exposing values: the primary credential is `primary`, the first backup is `backup`, and later backups are `backup-2`, `backup-3`, and so on.

## Custom Providers

Custom providers defined in Pi's `models.json` or registered by provider extensions can participate in provider failover even when they are absent from `auth.json`. The extension discovers available physical chat models with configured credentials at session startup and on `/failover reload`. Providers listed in `auth.json` come first; discovered custom providers are appended once, in model-registry order. To control their order explicitly, store their credentials in `auth.json` in the desired order.

For example, define an OpenAI-compatible endpoint in Pi's existing `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "my-endpoint": {
      "baseUrl": "https://example.invalid/v1",
      "api": "openai-completions",
      "apiKey": "$CUSTOM_API_KEY",
      "models": [{ "id": "my-chat-model" }]
    }
  }
}
```

Replace the example URL/model and set `CUSTOM_API_KEY`. Pi loads and authenticates the provider; `pi-failover` uses Pi's registry and does not read another configuration file itself. After changing or registering providers, refresh them in Pi and run `/failover reload`.

For **backup-key failover**, place the primary credential and ordered backups under the exact same provider ID in `auth.json`:

```json
{
  "my-endpoint": {
    "type": "api_key",
    "key": "$CUSTOM_API_KEY",
    "key-backup": ["backup-api-key-1", "backup-api-key-2"]
  }
}
```

Without backups, a handled failure moves directly to another configured provider. Providers need an available physical chat model and usable authentication; an endpoint URL alone is insufficient. A missing `auth.json` is allowed for runtime-configured custom providers; malformed or unreadable files still disable failover. The extension never creates or rewrites the file.

## Pi 1.0 Virtual Models

For virtual selections such as `router/auto`, failover uses the physical provider and model recorded on the assistant response. A backup-key switch keeps the virtual selection and its routing logic. If routing chooses a different provider on the retry, the failure is attributed to that provider's active credential.

Provider failover selects a physical model through `setModel()`, replacing the virtual selection. Virtual models are excluded from fallback candidates, so the router cannot immediately route that continuation back to the failed provider. The physical selection persists until you change it manually.

Pi's request hooks do not expose the dispatched model before the request. For virtual selections, credential rotation therefore happens after a failed physical response; the extension does not prevent the router from initially choosing a cooling provider or automatically restore the primary key after its cooldown. Selecting a physical model resumes credential selection before each turn; `/failover reload` restores extension-owned overrides.

This extension handles main chat assistant failures. Codemode classifier/image requests and compaction requests do not have independent failover support. Router errors that do not dispatch a physical model keep Pi's normal error handling.

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

If migrating from `~/.pi/keyrouter.json`, move each provider's primary credential into Pi's `auth.json`, then place either one backup string or an ordered backup array in `"key-backup"`. Reorder the top-level entries in `auth.json` to control provider fallback order.

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
npm run audit
npm pack --dry-run
```

The development dependency and runtime integration tests use Pi 1.1.0. The peer dependency remains `>=0.84.2`; source type checking and the core regression suite also pass against Pi 0.84.2.

`npm run audit` checks the dev-only dependency tree against the official npm registry. The published package ships no runtime dependencies.
