import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAuthCatalog } from "../src/auth-catalog.ts";

let tmp: string;
let authPath: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-failover-auth-"));
	authPath = path.join(tmp, "auth.json");
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAuthFile(value: unknown): void {
	fs.writeFileSync(authPath, JSON.stringify(value));
}

describe("loadAuthCatalog", () => {
	test("preserves auth.json insertion order without exposing primary keys", () => {
		writeAuthFile({
			anthropic: { type: "api_key", key: "primary-anthropic", "key-backup": "backup-anthropic" },
			"openai-codex": { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: 42 },
			google: { type: "api_key", key: "primary-google" },
		});

		const catalog = loadAuthCatalog({ authPath });

		assert.equal(catalog.enabled, true);
		assert.deepEqual(catalog.providers, [
			{ provider: "anthropic", type: "api_key", backupKeys: ["backup-anthropic"] },
			{ provider: "openai-codex", type: "oauth" },
			{ provider: "google", type: "api_key" },
		]);
		assert.doesNotMatch(
			JSON.stringify(catalog),
			/primary-anthropic|primary-google|oauth-access|oauth-refresh/,
		);
	});

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

	test("includes api-key credentials that use a string-valued env map", () => {
		writeAuthFile({
			envOnly: { type: "api_key", env: { PROVIDER_API_KEY: "env-primary-secret" } },
			arrayEnv: { type: "api_key", env: ["not-a-map"] },
			nonStringEnv: { type: "api_key", env: { PROVIDER_API_KEY: 42 } },
		});

		const catalog = loadAuthCatalog({ authPath });

		assert.deepEqual(catalog.providers, [{ provider: "envOnly", type: "api_key" }]);
		assert.doesNotMatch(JSON.stringify(catalog), /env-primary-secret/);
	});

	test("does not expose a backup key on oauth credentials", () => {
		writeAuthFile({
			"openai-codex": {
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: 42,
				"key-backup": "must-not-be-exposed",
			},
		});

		const catalog = loadAuthCatalog({ authPath });

		assert.deepEqual(catalog.providers, [{ provider: "openai-codex", type: "oauth" }]);
	});

	test("diagnoses empty, symbolic, and non-string api-key backups without exposing credentials", () => {
		writeAuthFile({
			empty: { type: "api_key", key: "primary-empty", "key-backup": "" },
			whitespace: { type: "api_key", key: "primary-space", "key-backup": "   " },
			env: { type: "api_key", key: "primary-env", "key-backup": "$BACKUP_KEY" },
			command: { type: "api_key", key: "primary-command", "key-backup": "!secret-command" },
			numbered: { type: "api_key", key: "primary-numbered", "key-backup": 42 },
		});

		const catalog = loadAuthCatalog({ authPath });

		assert.deepEqual(catalog.providers, [
			{ provider: "empty", type: "api_key" },
			{ provider: "whitespace", type: "api_key" },
			{ provider: "env", type: "api_key" },
			{ provider: "command", type: "api_key" },
			{ provider: "numbered", type: "api_key" },
		]);
		assert.equal(catalog.diagnostics.length, 5);
		assert.ok(catalog.diagnostics.every((diagnostic) => diagnostic.field === "key-backup"));
		assert.doesNotMatch(JSON.stringify(catalog.diagnostics), /primary-empty|primary-numbered/);
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

	test("returns a disabled catalog for malformed JSON without exposing its contents", () => {
		fs.writeFileSync(authPath, '{ "anthropic": "primary-secret"');

		const catalog = loadAuthCatalog({ authPath });

		assert.deepEqual(catalog.providers, []);
		assert.equal(catalog.enabled, false);
		assert.deepEqual(catalog.diagnostics, [{ message: "Could not parse auth.json" }]);
		assert.doesNotMatch(JSON.stringify(catalog), /primary-secret/);
	});

	test("returns a disabled catalog for a non-object auth file", () => {
		fs.writeFileSync(authPath, "[]");

		const catalog = loadAuthCatalog({ authPath });

		assert.deepEqual(catalog.providers, []);
		assert.equal(catalog.enabled, false);
		assert.deepEqual(catalog.diagnostics, [{ message: "Expected auth.json to contain an object" }]);
	});
});
