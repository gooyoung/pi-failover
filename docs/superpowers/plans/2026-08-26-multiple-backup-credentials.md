# Multiple Backup Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing string-valued `key-backup` configuration while adding strict, ordered rotation through an array of backup credentials before provider fallback.

**Architecture:** Normalize valid `key-backup` input to `backupKeys: string[]` at the auth-catalog boundary. Represent each credential in the failover engine with a redacted ordered slot (`primary`, `backup`, `backup-2`, …), then map the selected slot back to the corresponding catalog value only inside the extension's runtime-application path. Extend the runtime adapter with a boolean ownership comparison so retry turns skip only the backup already applied, while later backups replace the owned override.

**Tech Stack:** TypeScript 6, Node.js 22 built-in test runner, `tsx`, Pi coding-agent extension APIs.

## Global Constraints

- Keep package identity as `pi-failover`.
- Read Pi's existing `auth.json`; do not add another configuration path.
- Accept both `"key-backup": "..."` and `"key-backup": ["...", "..."]`.
- Treat an empty array or any invalid array element as an invalid entire `key-backup` field.
- Rotate credential failures in configuration order: `primary -> backup -> backup-2 -> ... -> next provider`.
- Provider-level failures continue to skip all remaining backups and move directly to provider fallback.
- Keep credentials out of engine state, snapshots, diagnostics, notifications, tests, and documentation except obvious fake placeholders.
- Keep `README.md` and `README.zh-CN.md` behavior descriptions aligned.
- Preserve and do not stage the user's unrelated `package.json` changes.

## File Map

- `src/auth-catalog.ts`: validate both configuration shapes and normalize them to `backupKeys`.
- `src/failover-engine.ts`: create and rotate through ordered redacted credential slots.
- `src/pi-runtime.ts`: tell the extension whether a specific backup is already the extension-owned override.
- `src/index.ts`: pass backup counts into the engine and resolve selected slots to backup array values.
- `tests/auth-catalog.test.ts`: catalog normalization, strict validation, and redaction coverage.
- `tests/failover-engine.test.ts`: ordered slot rotation, independent state, and provider-failure coverage.
- `tests/pi-runtime.test.ts`: exact owned-backup comparison coverage.
- `tests/extension.test.ts`: end-to-end ordered writes, retry deduplication, failed writes, provider fallback, and redaction.
- `README.md`, `README.zh-CN.md`: user-facing configuration and behavior documentation.
- `DEPLOY.md`: review only; no edit is expected because it contains no runtime configuration wording.

---

### Task 1: Normalize String and Array Backup Configuration

**Files:**
- Modify: `tests/auth-catalog.test.ts`
- Modify: `src/auth-catalog.ts`

**Interfaces:**
- Produces: `AuthProviderEntry.backupKeys?: string[]`.
- Produces: catalog entries whose backup values are ordered, literal strings or are absent after one redacted diagnostic.

- [ ] **Step 1: Write failing catalog tests**

Update existing single-backup expectations from `backupKey` to `backupKeys`, then add these focused cases:

```ts
test("normalizes string and array backups while preserving array order", () => {
	writeAuthFile({
		legacy: { type: "api_key", key: "primary-legacy", "key-backup": "legacy-backup" },
		ordered: {
			type: "api_key",
			key: "primary-ordered",
			"key-backup": ["ordered-backup-1", "ordered-backup-2", "ordered-backup-3"],
		},
	});

	const catalog = loadAuthCatalog({ authPath });

	assert.deepEqual(catalog.providers, [
		{ provider: "legacy", type: "api_key", backupKeys: ["legacy-backup"] },
		{
			provider: "ordered",
			type: "api_key",
			backupKeys: ["ordered-backup-1", "ordered-backup-2", "ordered-backup-3"],
		},
	]);
});

test("rejects an empty or partially invalid backup array as a whole without exposing values", () => {
	const hidden = "valid-looking-secret-must-not-escape";
	writeAuthFile({
		empty: { type: "api_key", key: "primary-empty", "key-backup": [] },
		partlyEmpty: { type: "api_key", key: "primary-empty-item", "key-backup": [hidden, ""] },
		partlySymbolic: { type: "api_key", key: "primary-symbolic", "key-backup": [hidden, "$BACKUP_KEY"] },
		partlyCommand: { type: "api_key", key: "primary-command", "key-backup": [hidden, "!secret-command"] },
		partlyTyped: { type: "api_key", key: "primary-typed", "key-backup": [hidden, 42] },
	});

	const catalog = loadAuthCatalog({ authPath });

	assert.deepEqual(catalog.providers, [
		{ provider: "empty", type: "api_key" },
		{ provider: "partlyEmpty", type: "api_key" },
		{ provider: "partlySymbolic", type: "api_key" },
		{ provider: "partlyCommand", type: "api_key" },
		{ provider: "partlyTyped", type: "api_key" },
	]);
	assert.equal(catalog.diagnostics.length, 5);
	assert.doesNotMatch(JSON.stringify(catalog.diagnostics), new RegExp(hidden));
});
```

- [ ] **Step 2: Run the catalog tests and verify RED**

Run:

```bash
npx tsx --test tests/auth-catalog.test.ts
```

Expected: FAIL because `AuthProviderEntry` still exposes `backupKey` and arrays are rejected.

- [ ] **Step 3: Implement strict normalization**

Change the interface and parsing branch in `src/auth-catalog.ts`:

```ts
export interface AuthProviderEntry {
	provider: string;
	type: "api_key" | "oauth";
	backupKeys?: string[];
}

// Inside the API-key credential branch:
const entry: AuthProviderEntry = { provider, type: "api_key" };
const backup = credential["key-backup"];
const backupKeys = normalizeBackupKeys(backup);
if (backupKeys) {
	entry.backupKeys = backupKeys;
} else if (backup !== undefined) {
	diagnostics.push({ provider, field: "key-backup", message: "Ignored invalid key-backup" });
}
```

Replace the old validator with:

```ts
function normalizeBackupKeys(value: unknown): string[] | undefined {
	if (isLiteralBackupKey(value)) return [value];
	if (!Array.isArray(value) || value.length === 0) return undefined;
	return value.every(isLiteralBackupKey) ? value : undefined;
}

function isLiteralBackupKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.startsWith("!") && !/\$(?:\{|[A-Za-z_])/.test(value);
}
```

Keep OAuth handling unchanged so it never exposes `key-backup`.

- [ ] **Step 4: Run the catalog tests and verify GREEN**

Run:

```bash
npx tsx --test tests/auth-catalog.test.ts
```

Expected: all catalog tests PASS with zero warnings or credential-bearing output.

- [ ] **Step 5: Commit the catalog boundary change**

```bash
git add src/auth-catalog.ts tests/auth-catalog.test.ts
git commit -m "feat: parse ordered backup credentials"
```

---

### Task 2: Rotate Through Ordered Redacted Credential Slots

**Files:**
- Modify: `tests/failover-engine.test.ts`
- Modify: `src/failover-engine.ts`

**Interfaces:**
- Consumes: a non-negative `FailoverProvider.backupKeyCount`.
- Produces: the TypeScript union `KeySlot = "primary" | "backup" | \`backup-${number}\``.
- Produces: `backupSlot(index: number): KeySlot` and `backupIndexForSlot(slot: KeySlot): number | undefined`.

- [ ] **Step 1: Write failing ordered-rotation tests**

Change the test helper provider type to `{ id: string; backupKeyCount?: number }`, make its default `[{ id: "alpha", backupKeyCount: 1 }]`, widen `assertAttempt.expected.keySlot` to `KeySlot`, and convert existing `{ hasBackupKey: true }` fixtures to `{ backupKeyCount: 1 }`.

Add:

```ts
test("rotates through every backup in order before provider fallback", () => {
	const engine = createEngine({
		providers: [{ id: "alpha", backupKeyCount: 3 }, { id: "beta" }],
		plans: [{ providerId: "beta", model: "beta-model" }],
	});

	assertAttempt(engine.startTurn({ providerId: "alpha", model: "alpha-model" }), {
		providerId: "alpha",
		model: "alpha-model",
		keySlot: "primary",
	});
	for (const keySlot of ["backup", "backup-2", "backup-3"] as const) {
		assertAttempt(engine.observeFailure({ status: 401 }), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot,
		});
	}
	assertAttempt(engine.observeFailure({ status: 401 }), {
		kind: "switch-model",
		providerId: "beta",
		model: "beta-model",
		keySlot: "primary",
	});
	assert.deepEqual(engine.snapshot().providers[0]?.keys, [
		{ slot: "primary", status: "disabled" },
		{ slot: "backup", status: "disabled" },
		{ slot: "backup-2", status: "disabled" },
		{ slot: "backup-3", status: "disabled" },
	]);
});

test("tracks cooldown independently for each ordered backup", () => {
	const engine = createEngine({ providers: [{ id: "alpha", backupKeyCount: 2 }] });
	engine.startTurn({ providerId: "alpha", model: "alpha-model" });
	engine.observeFailure({ status: 429, retryAfterMs: 5_000 });
	assertAttempt(engine.observeFailure({ status: 429, retryAfterMs: 10_000 }), {
		providerId: "alpha",
		model: "alpha-model",
		keySlot: "backup-2",
	});
	assert.deepEqual(engine.snapshot().providers[0]?.keys, [
		{ slot: "primary", status: "cooling", cooldownUntil: 6_000 },
		{ slot: "backup", status: "cooling", cooldownUntil: 11_000 },
		{ slot: "backup-2", status: "healthy" },
	]);
});

test("maps backup slots to stable zero-based catalog indexes", () => {
	assert.equal(backupIndexForSlot("primary"), undefined);
	assert.equal(backupIndexForSlot("backup"), 0);
	assert.equal(backupIndexForSlot("backup-2"), 1);
	assert.equal(backupIndexForSlot("backup-3"), 2);
	assert.equal(backupSlot(0), "backup");
	assert.equal(backupSlot(1), "backup-2");
	assert.equal(backupSlot(2), "backup-3");
});
```

Import `backupIndexForSlot`, `backupSlot`, and `type KeySlot` in the test.

- [ ] **Step 2: Run engine tests and verify RED**

Run:

```bash
npx tsx --test tests/failover-engine.test.ts
```

Expected: FAIL because backup counts, numbered slots, and mapping helpers do not exist.

- [ ] **Step 3: Implement ordered slots without storing credentials**

In `src/failover-engine.ts`, replace the slot and provider definitions and add the helpers:

```ts
export type KeySlot = "primary" | "backup" | `backup-${number}`;

export interface FailoverProvider {
	id: string;
	backupKeyCount?: number;
}

export function backupSlot(index: number): KeySlot {
	return index === 0 ? "backup" : `backup-${index + 1}`;
}

export function backupIndexForSlot(slot: KeySlot): number | undefined {
	if (slot === "primary") return undefined;
	if (slot === "backup") return 0;
	const ordinal = Number(slot.slice("backup-".length));
	return Number.isInteger(ordinal) && ordinal >= 2 ? ordinal - 1 : undefined;
}
```

Build provider keys using the count:

```ts
this.providers = options.providers.map((provider) => ({
	id: provider.id,
	keys: [
		{ slot: "primary" as const, disabled: false, cooldownUntil: 0 },
		...Array.from({ length: provider.backupKeyCount ?? 0 }, (_, index) => ({
			slot: backupSlot(index),
			disabled: false,
			cooldownUntil: 0,
		})),
	],
	cooldownUntil: 0,
}));
```

No other selection algorithm changes are needed: `nextAvailableKey()` already preserves the `keys` array order and state is keyed by the redacted slot.

- [ ] **Step 4: Run engine tests and verify GREEN**

Run:

```bash
npx tsx --test tests/failover-engine.test.ts
```

Expected: all engine tests PASS, including unchanged provider-level skip behavior.

- [ ] **Step 5: Commit the engine change**

```bash
git add src/failover-engine.ts tests/failover-engine.test.ts
git commit -m "feat: rotate ordered credential slots"
```

---

### Task 3: Apply Each Selected Backup Exactly Once

**Files:**
- Modify: `tests/pi-runtime.test.ts`
- Modify: `src/pi-runtime.ts`
- Modify: `tests/extension.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `AuthProviderEntry.backupKeys` and `backupIndexForSlot(KeySlot)`.
- Consumes: `FailoverProvider.backupKeyCount`.
- Produces: `PiRuntimeAdapter.ownsBackupKey(providerId: string, backupKey: string): boolean`.
- Preserves: extension-owned original credential restoration after replacing one backup with another.

- [ ] **Step 1: Write a failing runtime ownership test**

Add to `tests/pi-runtime.test.ts`:

```ts
test("recognizes only the currently owned backup while preserving the original across replacements", async () => {
	const harness = createRuntimeHarness("stored", "stored-primary");
	const adapter = createPiRuntimeAdapter(harness.registry);

	assert.equal(adapter.ownsBackupKey("alpha", "backup-one"), false);
	await adapter.setBackupKey("alpha", "backup-one");
	assert.equal(adapter.ownsBackupKey("alpha", "backup-one"), true);
	assert.equal(adapter.ownsBackupKey("alpha", "backup-two"), false);

	await adapter.setBackupKey("alpha", "backup-two");
	assert.equal(adapter.ownsBackupKey("alpha", "backup-one"), false);
	assert.equal(adapter.ownsBackupKey("alpha", "backup-two"), true);

	assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
	assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```bash
npx tsx --test tests/pi-runtime.test.ts
```

Expected: FAIL because `ownsBackupKey` is missing.

- [ ] **Step 3: Add exact owned-backup comparison**

Extend `PiRuntimeAdapter` and the returned adapter in `src/pi-runtime.ts`:

```ts
export interface PiRuntimeAdapter {
	readonly supported: boolean;
	hasOwnedOverride(providerId: string): boolean;
	ownsBackupKey(providerId: string, backupKey: string): boolean;
	setBackupKey(providerId: string, backupKey: string): Promise<RuntimeOverrideResult>;
	restoreOriginalKey(providerId: string): Promise<RuntimeOverrideResult>;
}

ownsBackupKey(providerId, backupKey) {
	if (!runtime) return false;
	return ownershipStore().get(runtime)?.get(providerId)?.ownedKey === backupKey;
},
```

Do not expose the stored key from this method; return only the comparison result.

- [ ] **Step 4: Run the runtime tests and verify GREEN**

Run:

```bash
npx tsx --test tests/pi-runtime.test.ts
```

Expected: all runtime adapter tests PASS, including restoration and rejected-write compensation tests.

- [ ] **Step 5: Write failing extension tests for ordered application**

First change the extension test catalog helper and all existing API-key fixtures from `backupKey?: string` / `backupKey: value` to `backupKeys?: string[]` / `backupKeys: [value]`.

Add:

```ts
test("credential failures apply ordered backups once before provider fallback", async () => {
	const backups = ["ordered-secret-one", "ordered-secret-two", "ordered-secret-three"];
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
	});
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: backups },
		{ provider: "beta", type: "oauth" },
	]);

	await startSessionTurn(harness);
	for (const errorMessage of ["primary unauthorized", "backup one unauthorized", "backup two unauthorized"]) {
		await failAttempt(harness, { status: 401, errorMessage });
	}
	assert.deepEqual(harness.setKeyCalls, backups.map((key) => ({ providerId: "alpha", key })));

	await failAttempt(harness, { status: 401, errorMessage: "backup three unauthorized" });
	assert.equal(harness.ctx.model?.provider, "beta");
	assert.deepEqual(harness.appliedModels, [{ provider: "beta", id: "shared" }]);
	assert.doesNotMatch(JSON.stringify(harness.notificationCalls), new RegExp(backups.join("|")));
});

test("a retry turn does not rewrite the currently selected numbered backup", async () => {
	const harness = createHarness();
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: ["backup-one", "backup-two"] },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 401, errorMessage: "primary unauthorized" });
	await failAttempt(harness, { status: 401, errorMessage: "first backup unauthorized" });
	assert.deepEqual(harness.setKeys, ["backup-one", "backup-two"]);

	await harness.emit("turn_start", { turnIndex: 1, timestamp: 1_001 });
	assert.deepEqual(harness.setKeys, ["backup-one", "backup-two"]);
	assert.equal(
		harness.notifications.filter((message) => message === "pi-failover: alpha switched to backup-2 credential").length,
		1,
	);
});

test("a rejected backup write advances to the next configured backup", async () => {
	const rejected = "rejected-backup-secret";
	const accepted = "accepted-backup-secret";
	const harness = createHarness({
		setRuntimeKey(_providerId, key) {
			if (key === rejected) throw new Error(`setter rejected ${key}`);
		},
	});
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: [rejected, accepted] },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 401, errorMessage: "primary unauthorized" });

	assert.deepEqual(harness.setKeys, [rejected, accepted]);
	assert.equal(harness.resolvedKeys.get("alpha"), accepted);
	assert.doesNotMatch(JSON.stringify(harness.notificationCalls), new RegExp(`${rejected}|${accepted}`));
});
```

- [ ] **Step 6: Run extension tests and verify RED**

Run:

```bash
npx tsx --test tests/extension.test.ts
```

Expected: FAIL because `src/index.ts` still expects one `backupKey` and treats every backup slot as the same override.

- [ ] **Step 7: Wire counts and selected backup values through the extension**

Import the mapping helper:

```ts
import {
	backupIndexForSlot,
	FailoverEngine,
	type FailoverAttempt,
	type FailoverDecision,
	type FailureObservation,
} from "./failover-engine.ts";
```

Build the engine with counts:

```ts
providers: catalog.providers.map((provider) => ({
	id: provider.provider,
	backupKeyCount: provider.backupKeys?.length ?? 0,
})),
```

Replace the single-backup lookup and broad owned-override skip inside `execute()` with:

```ts
const provider = catalog.providers.find((candidate) => candidate.provider === activeDecision.providerId);
const backupIndex = backupIndexForSlot(activeDecision.keySlot);
const backupKey = backupIndex === undefined ? undefined : provider?.backupKeys?.[backupIndex];
if (backupKey !== undefined && runtime?.ownsBackupKey(activeDecision.providerId, backupKey)) {
	clearPendingExhaustion();
	return "applied";
}
possiblyOwnedProviderIds.add(activeDecision.providerId);
const result = backupKey === undefined
	? { ok: false as const }
	: await runtime?.setBackupKey(activeDecision.providerId, backupKey);
```

Keep the existing success notification, ownership cleanup, and `observeFailure({ kind: "unauthorized" })` loop below this block. Calling `setBackupKey` for a different owned backup intentionally replaces only the owned key while `pi-runtime.ts` retains the original pre-extension credential for later restoration.

- [ ] **Step 8: Run extension tests and verify GREEN**

Run:

```bash
npx tsx --test tests/extension.test.ts
```

Expected: all extension tests PASS; ordered writes occur exactly once and notifications remain redacted.

- [ ] **Step 9: Run all behavior tests affected by the shared types**

Run:

```bash
npm test
```

Expected: all tests PASS. Fix any remaining `backupKey` / `hasBackupKey` fixtures by converting them to `backupKeys: [value]` / `backupKeyCount: 1`; do not alter their existing assertions except for the normalized catalog shape.

- [ ] **Step 10: Commit runtime and extension integration**

```bash
git add src/index.ts src/pi-runtime.ts tests/extension.test.ts tests/pi-runtime.test.ts
git commit -m "feat: apply multiple backup credentials in order"
```

---

### Task 4: Document Both Configuration Forms and Verify the Package

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Review: `DEPLOY.md`

**Interfaces:**
- Documents: the legacy string form, ordered array form, strict validation, redacted slot labels, and provider-failover distinction.

- [ ] **Step 1: Update the English README**

In the setup section, show both forms with obvious placeholders:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "primary-api-key",
    "key-backup": ["backup-api-key-1", "backup-api-key-2"]
  }
}
```

State explicitly:

```markdown
`"key-backup"` accepts either one literal, non-empty string or a non-empty array of literal, non-empty strings. The string form remains equivalent to a one-item array. Array entries are tried in order. If the array is empty or any item is invalid, the entire backup field is ignored and the provider remains available only through its primary credential.
```

Update behavior wording from “the backup key” to “the next backup key,” document the sequence `primary`, `backup`, `backup-2`, and so on, and retain the statement that these are credentials for the same provider rather than provider fallbacks. Update migration wording from “the second key” to “one backup string or an ordered backup array.”

- [ ] **Step 2: Update the Chinese README with equivalent semantics**

Use the same JSON shape and add:

```markdown
`"key-backup"` 既可以是一个字面量、非空字符串，也可以是由字面量、非空字符串组成的非空数组。字符串形式等价于只含一项的数组，数组中的凭证按书写顺序尝试。如果数组为空或任一元素无效，整个备用字段都会被忽略，该 provider 仍只能使用主凭证。
```

Use “下一把备用 key” for credential-level rotation and document the redacted order `primary`、`backup`、`backup-2`…… Keep backup-key failover distinct from provider failover and align the migration wording with the English README.

- [ ] **Step 3: Review documentation consistency and formatting**

Run:

```bash
rg -n 'key-backup|backup key|备用 key|second key|第二把' README.md README.zh-CN.md DEPLOY.md
git diff --check -- README.md README.zh-CN.md
```

Expected: both READMEs describe the same accepted shapes and order; `DEPLOY.md` contains no behavior wording requiring edits; `git diff --check` exits 0.

- [ ] **Step 4: Run the repository-required verification suite**

Run each command separately and inspect its full output:

```bash
npm test
npm run typecheck
npm pack --dry-run
```

Expected: tests report zero failures, TypeScript exits 0, and the dry-run package includes `src`, `README.md`, and `tsconfig.json` without secret files. The existing unstaged `package.json` keyword edits may affect the generated package metadata but must not be staged by this feature.

- [ ] **Step 5: Inspect the final scoped diff**

Run:

```bash
git status --short
git diff --check
git diff -- src tests README.md README.zh-CN.md
git diff -- package.json
```

Expected: feature changes are limited to the files in this plan, no credentials appear, and `package.json` still shows only the user's pre-existing unstaged keyword changes.

- [ ] **Step 6: Commit the aligned documentation**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: explain multiple backup credentials"
```

- [ ] **Step 7: Re-run final verification after the commit**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run
git status --short
```

Expected: all three verification commands exit 0, and `git status --short` shows only the user's pre-existing `package.json` modification.
