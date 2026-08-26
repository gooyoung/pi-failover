# Multiple Backup Credentials Design

## Goal

Extend `pi-failover` so an API-key provider may configure either the existing
single literal backup credential or an ordered list of literal backup
credentials in Pi's existing `auth.json`.

## Configuration and validation

The existing form remains valid and keeps its behavior:

```json
"key-backup": "backup-api-key"
```

The new form accepts a non-empty array:

```json
"key-backup": ["backup-api-key-1", "backup-api-key-2"]
```

Every array element must pass the same literal-key validation as the existing
string form: it must be a non-empty string and must not be an environment
variable or command expression. An empty array or any invalid element makes the
entire field invalid. The provider remains available through its primary
credential, while all configured backups are ignored and one redacted
diagnostic is recorded for `key-backup`.

OAuth providers continue to ignore `key-backup`.

## Internal representation

`AuthProviderEntry` exposes `backupKeys?: string[]`. The catalog normalizes the
legacy string form to a one-element array, so downstream code has one shape to
handle.

The failover engine receives `backupKeyCount` for each provider and builds an
ordered list of credential slots. Slot labels are:

- `primary` for the stored Pi credential
- `backup` for the first configured backup, preserving existing status and
  notification wording
- `backup-2`, `backup-3`, and so on for later backups

Credential values never enter engine state, snapshots, status output, or
notifications. A helper converts a backup slot to its zero-based array index
only when the extension applies the selected runtime credential.

## Failover behavior

For credential-level failures (`401`, `403`, and `429`), selection proceeds in
configuration order:

```text
primary -> backup -> backup-2 -> backup-3 -> next provider
```

Each slot retains its own disabled or cooldown state. Provider-level failures
(`500`, `502`, `503`, `504`, `529`, overload, and network failures) continue to
skip the remaining credentials for that provider and move directly to provider
fallback.

If applying one runtime backup override fails, the extension marks that slot as
unavailable through the existing failure path and immediately tries the next
backup before considering another provider.

The existing retry-settling behavior remains unchanged: after all choices are
exhausted, the last successfully applied credential stays active until Pi's
built-in retry settles, then extension-owned overrides are restored when
required.

## Testing

Tests cover:

- normalization of the legacy string and ordered array forms
- strict rejection of empty or partially invalid arrays without credential
  exposure
- ordered engine rotation across three or more credential slots
- independent cooldown/disable state per backup slot
- extension-level application of backup values in array order
- continuation to provider fallback after all backups are exhausted or runtime
  override application fails
- redacted snapshots, status, diagnostics, and notifications
- unchanged behavior for provider-level failures and legacy single backups

## Documentation

`README.md` and `README.zh-CN.md` document both accepted forms, strict array
validation, ordered credential rotation, slot labels, and the distinction
between backup-key failover and provider failover. `DEPLOY.md` is reviewed but
does not require a change because it describes publishing rather than runtime
configuration or behavior.

## Compatibility and scope

- Package identity remains `pi-failover`.
- The extension continues to read Pi's `auth.json`; no new configuration path
  is introduced.
- Existing string configurations and first-backup user-facing wording remain
  compatible.
- No credential values may appear in examples beyond obvious placeholders, in
  diagnostics, or in runtime status output.
- Existing unrelated `package.json` changes are preserved and excluded from
  this feature's commits.
