import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPiRuntimeAdapter } from "../src/pi-runtime.ts";

type PiRuntimeModule = typeof import("../src/pi-runtime.ts");

interface RuntimeHarness {
	registry: {
		runtime: {
			setRuntimeApiKey(providerId: string, key: string): Promise<void>;
			removeRuntimeApiKey(providerId: string): Promise<void>;
		};
		getApiKeyForProvider(providerId: string): Promise<string | undefined>;
		getProviderAuthStatus(providerId: string): { configured: boolean; source?: "runtime" | "stored" | "environment" };
	};
	resolvedKeys: Map<string, string>;
	removedProviders: string[];
	setKeys: string[];
}

function createRuntimeHarness(source: "runtime" | "stored" | "environment", originalKey: string): RuntimeHarness {
	const resolvedKeys = new Map([["alpha", originalKey]]);
	const removedProviders: string[] = [];
	const setKeys: string[] = [];
	const runtimeProviders = new Set(source === "runtime" ? ["alpha"] : []);
	const registry = {
		runtime: {
			async setRuntimeApiKey(providerId: string, key: string): Promise<void> {
				setKeys.push(key);
				resolvedKeys.set(providerId, key);
				runtimeProviders.add(providerId);
			},
			async removeRuntimeApiKey(providerId: string): Promise<void> {
				removedProviders.push(providerId);
				runtimeProviders.delete(providerId);
				resolvedKeys.set(providerId, originalKey);
			},
		},
		async getApiKeyForProvider(providerId: string): Promise<string | undefined> {
			return resolvedKeys.get(providerId);
		},
		getProviderAuthStatus(providerId: string) {
			return runtimeProviders.has(providerId)
				? ({ configured: true, source: "runtime" } as const)
				: ({ configured: true, source } as const);
		},
	};
	return { registry, resolvedKeys, removedProviders, setKeys };
}

describe("createPiRuntimeAdapter", () => {
	test("removes its backup override to reveal stored auth", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const adapter = createPiRuntimeAdapter(harness.registry);

		assert.deepEqual(await adapter.setBackupKey("alpha", "backup-key"), { ok: true, action: "set" });
		assert.equal(harness.resolvedKeys.get("alpha"), "backup-key");

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
		assert.deepEqual(harness.removedProviders, ["alpha"]);
		assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
	});

	test("restores the resolved key when the original auth source was runtime", async () => {
		const harness = createRuntimeHarness("runtime", "preexisting-runtime-key");
		const adapter = createPiRuntimeAdapter(harness.registry);

		await adapter.setBackupKey("alpha", "backup-key");

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "restored" });
		assert.deepEqual(harness.setKeys, ["backup-key", "preexisting-runtime-key"]);
		assert.deepEqual(harness.removedProviders, []);
		assert.equal(harness.resolvedKeys.get("alpha"), "preexisting-runtime-key");
	});

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

	test("retains the previous owned backup when a replacement rejects before activation", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const adapter = createPiRuntimeAdapter(harness.registry);
		await adapter.setBackupKey("alpha", "backup-one");
		const originalSetter = harness.registry.runtime.setRuntimeApiKey;
		harness.registry.runtime.setRuntimeApiKey = async (providerId, key) => {
			if (key === "backup-two") throw new Error("replacement rejected");
			await originalSetter(providerId, key);
		};

		assert.deepEqual(await adapter.setBackupKey("alpha", "backup-two"), {
			ok: false,
			reason: "operation_failed",
		});
		assert.equal(adapter.ownsBackupKey("alpha", "backup-one"), true);
		assert.equal(harness.resolvedKeys.get("alpha"), "backup-one");

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
		assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
	});

	test("preserves ownership across separately evaluated extension modules", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const firstModule = await import(
			new URL("../src/pi-runtime.ts?extension-instance=first", import.meta.url).href
		) as PiRuntimeModule;
		const reloadedModule = await import(
			new URL("../src/pi-runtime.ts?extension-instance=second", import.meta.url).href
		) as PiRuntimeModule;
		assert.notEqual(firstModule.createPiRuntimeAdapter, reloadedModule.createPiRuntimeAdapter);

		const firstAdapter = firstModule.createPiRuntimeAdapter(harness.registry);
		await firstAdapter.setBackupKey("alpha", "first-backup");

		const reloadedAdapter = reloadedModule.createPiRuntimeAdapter(harness.registry);
		await reloadedAdapter.setBackupKey("alpha", "second-backup");

		assert.deepEqual(await reloadedAdapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
		assert.deepEqual(harness.removedProviders, ["alpha"]);
		assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
	});

	test("stores reload-safe override ownership under the pi-failover namespace", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const adapter = createPiRuntimeAdapter(harness.registry);

		await adapter.setBackupKey("alpha", "backup-key");

		const root = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
		assert.ok(root[Symbol.for("pi-failover.runtime-override-ownership")] instanceof WeakMap);
	});

	test("does not clear a runtime override that replaced its owned backup", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const adapter = createPiRuntimeAdapter(harness.registry);
		await adapter.setBackupKey("alpha", "owned-backup");
		await harness.registry.runtime.setRuntimeApiKey("alpha", "external-runtime-key");

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "unchanged" });
		assert.deepEqual(harness.removedProviders, []);
		assert.equal(harness.resolvedKeys.get("alpha"), "external-runtime-key");
	});

	test("preserves ownership when runtime cleanup cannot resolve the active key", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const adapter = createPiRuntimeAdapter(harness.registry);
		await adapter.setBackupKey("alpha", "owned-backup");
		const resolveKey = harness.registry.getApiKeyForProvider;
		harness.registry.getApiKeyForProvider = async () => undefined;

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), {
			ok: false,
			reason: "operation_failed",
		});
		assert.deepEqual(harness.removedProviders, []);

		harness.registry.getApiKeyForProvider = resolveKey;
		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
		assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
	});

	test("returns unsupported without throwing when either runtime method is missing", async () => {
		for (const runtime of [
			{ setRuntimeApiKey: async () => {} },
			{ removeRuntimeApiKey: async () => {} },
		]) {
			const registry = {
				runtime,
				getApiKeyForProvider: async () => "primary-key",
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			};
			const adapter = createPiRuntimeAdapter(registry);
			assert.equal(adapter.supported, false);

			assert.deepEqual(await adapter.setBackupKey("alpha", "backup-key"), {
				ok: false,
				reason: "unsupported",
			});
			assert.deepEqual(await adapter.restoreOriginalKey("alpha"), {
				ok: false,
				reason: "unsupported",
			});
		}
	});

	test("does not replace runtime auth when its original key cannot be resolved", async () => {
		let setCalls = 0;
		const registry = {
			runtime: {
				setRuntimeApiKey: async () => {
					setCalls += 1;
				},
				removeRuntimeApiKey: async () => {},
			},
			getApiKeyForProvider: async () => undefined,
			getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
		};
		const adapter = createPiRuntimeAdapter(registry);

		assert.deepEqual(await adapter.setBackupKey("alpha", "backup-key"), {
			ok: false,
			reason: "operation_failed",
		});
		assert.equal(setCalls, 0);
	});

	test("compensates when Pi activates a backup before its setter rejects", async () => {
		for (const source of ["stored", "runtime"] as const) {
			const originalKey = `${source}-primary`;
			const harness = createRuntimeHarness(source, originalKey);
			const commitRuntimeKey = harness.registry.runtime.setRuntimeApiKey;
			harness.registry.runtime.setRuntimeApiKey = async (providerId, key) => {
				await commitRuntimeKey(providerId, key);
				if (key === "backup-key") throw new Error("synchronization failed");
			};
			const adapter = createPiRuntimeAdapter(harness.registry);

			assert.deepEqual(await adapter.setBackupKey("alpha", "backup-key"), {
				ok: false,
				reason: "operation_failed",
			});
			assert.equal(harness.resolvedKeys.get("alpha"), originalKey);
			assert.deepEqual(
				source === "runtime" ? harness.setKeys : harness.removedProviders,
				source === "runtime" ? ["backup-key", originalKey] : ["alpha"],
			);
			assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "unchanged" });
		}
	});

	test("retains ownership when rejected-set compensation cannot restore state", async () => {
		const harness = createRuntimeHarness("stored", "stored-primary");
		const commitRuntimeKey = harness.registry.runtime.setRuntimeApiKey;
		harness.registry.runtime.setRuntimeApiKey = async (providerId, key) => {
			await commitRuntimeKey(providerId, key);
			throw new Error("synchronization failed");
		};
		const removeRuntimeKey = harness.registry.runtime.removeRuntimeApiKey;
		let compensationAttempts = 0;
		harness.registry.runtime.removeRuntimeApiKey = async (providerId) => {
			compensationAttempts += 1;
			if (compensationAttempts === 1) throw new Error("compensation failed");
			await removeRuntimeKey(providerId);
		};
		const adapter = createPiRuntimeAdapter(harness.registry);

		assert.deepEqual(await adapter.setBackupKey("alpha", "backup-key"), {
			ok: false,
			reason: "operation_failed",
		});
		assert.equal(harness.resolvedKeys.get("alpha"), "backup-key");

		assert.deepEqual(await adapter.restoreOriginalKey("alpha"), { ok: true, action: "removed" });
		assert.equal(harness.resolvedKeys.get("alpha"), "stored-primary");
	});
});
