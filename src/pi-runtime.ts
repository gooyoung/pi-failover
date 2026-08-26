export interface PiAuthStatus {
	configured: boolean;
	source?: string;
}

export interface PiRuntimeRegistry {
	getApiKeyForProvider(providerId: string): Promise<string | undefined>;
	getProviderAuthStatus(providerId: string): PiAuthStatus;
}

export type RuntimeOverrideResult =
	| { ok: true; action: "set" | "removed" | "restored" | "unchanged" }
	| { ok: false; reason: "unsupported" | "operation_failed" };

export interface PiRuntimeAdapter {
	readonly supported: boolean;
	hasOwnedOverride(providerId: string): boolean;
	ownsBackupKey(providerId: string, backupKey: string): boolean;
	setBackupKey(providerId: string, backupKey: string): Promise<RuntimeOverrideResult>;
	restoreOriginalKey(providerId: string): Promise<RuntimeOverrideResult>;
}

type RuntimeApi = {
	setRuntimeApiKey(providerId: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(providerId: string): void | Promise<void>;
};

type OwnedOverride =
	| { ownedKey: string; originalSourceWasRuntime: true; originalRuntimeKey: string }
	| { ownedKey: string; originalSourceWasRuntime: false };

const OWNERSHIP_SYMBOL = Symbol.for("pi-failover.runtime-override-ownership");

function ownershipStore(): WeakMap<object, Map<string, OwnedOverride>> {
	const root = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
	const existing = root[OWNERSHIP_SYMBOL];
	if (existing instanceof WeakMap) return existing as WeakMap<object, Map<string, OwnedOverride>>;

	const created = new WeakMap<object, Map<string, OwnedOverride>>();
	root[OWNERSHIP_SYMBOL] = created;
	return created;
}

function runtimeApi(registry: PiRuntimeRegistry): RuntimeApi | undefined {
	// ModelRegistry.runtime is private in Pi's declarations. Keep the compatibility
	// escape hatch contained here; all reads use the public registry facade.
	const runtime = (registry as PiRuntimeRegistry & { runtime?: Partial<RuntimeApi> }).runtime;
	if (
		!runtime ||
		typeof runtime.setRuntimeApiKey !== "function" ||
		typeof runtime.removeRuntimeApiKey !== "function"
	) {
		return undefined;
	}
	return runtime as RuntimeApi;
}

export function createPiRuntimeAdapter(registry: PiRuntimeRegistry): PiRuntimeAdapter {
	const runtime = runtimeApi(registry);

	async function readRuntimeState(providerId: string): Promise<{ key: string | undefined; status: PiAuthStatus }> {
		const key = await registry.getApiKeyForProvider(providerId);
		return { key, status: registry.getProviderAuthStatus(providerId) };
	}

	function originalStateConfirmed(state: { key: string | undefined; status: PiAuthStatus }, owned: OwnedOverride): boolean {
		return owned.originalSourceWasRuntime
			? state.status.source === "runtime" && state.key === owned.originalRuntimeKey
			: state.status.source !== "runtime" && state.key !== owned.ownedKey;
	}

	async function reconcileRejectedSet(
		api: RuntimeApi,
		providerId: string,
		owned: OwnedOverride,
		previousOwned: OwnedOverride | undefined,
		byProvider: Map<string, OwnedOverride>,
	): Promise<void> {
		let state: { key: string | undefined; status: PiAuthStatus };
		try {
			state = await readRuntimeState(providerId);
		} catch {
			return;
		}

		if (previousOwned && state.status.source === "runtime" && state.key === previousOwned.ownedKey) {
			byProvider.set(providerId, previousOwned);
			return;
		}
		if (originalStateConfirmed(state, owned)) {
			byProvider.delete(providerId);
			return;
		}
		if (state.status.source !== "runtime" || state.key !== owned.ownedKey) return;

		try {
			if (owned.originalSourceWasRuntime) {
				await api.setRuntimeApiKey(providerId, owned.originalRuntimeKey);
			} else {
				await api.removeRuntimeApiKey(providerId);
			}
		} catch {
			// Pi can commit compensation before synchronization rejects. Confirm
			// effective state below before deciding whether ownership can be cleared.
		}

		try {
			state = await readRuntimeState(providerId);
			if (originalStateConfirmed(state, owned)) byProvider.delete(providerId);
		} catch {
			// Indeterminate compensation keeps ownership for a later cleanup.
		}
	}

	return {
		supported: runtime !== undefined,
		hasOwnedOverride(providerId) {
			return runtime !== undefined && (ownershipStore().get(runtime)?.has(providerId) ?? false);
		},
		ownsBackupKey(providerId, backupKey) {
			if (!runtime) return false;
			return ownershipStore().get(runtime)?.get(providerId)?.ownedKey === backupKey;
		},

		async setBackupKey(providerId, backupKey) {
			if (!runtime) return { ok: false, reason: "unsupported" };

			try {
				const status = registry.getProviderAuthStatus(providerId);
				const currentKey = await registry.getApiKeyForProvider(providerId);
				const store = ownershipStore();
				const byProvider = store.get(runtime) ?? new Map<string, OwnedOverride>();
				store.set(runtime, byProvider);
				const existing = byProvider.get(providerId);
				let owned: OwnedOverride;
				if (existing && currentKey === existing.ownedKey) {
					owned = existing.originalSourceWasRuntime
						? { ownedKey: backupKey, originalSourceWasRuntime: true, originalRuntimeKey: existing.originalRuntimeKey }
						: { ownedKey: backupKey, originalSourceWasRuntime: false };
				} else if (status.source === "runtime") {
					if (currentKey === undefined) return { ok: false, reason: "operation_failed" };
					owned = { ownedKey: backupKey, originalSourceWasRuntime: true, originalRuntimeKey: currentKey };
				} else {
					owned = { ownedKey: backupKey, originalSourceWasRuntime: false };
				}
				byProvider.set(providerId, owned);
				try {
					await runtime.setRuntimeApiKey(providerId, backupKey);
				} catch {
					await reconcileRejectedSet(runtime, providerId, owned, existing, byProvider);
					return { ok: false, reason: "operation_failed" };
				}
				return { ok: true, action: "set" };
			} catch {
				return { ok: false, reason: "operation_failed" };
			}
		},

		async restoreOriginalKey(providerId) {
			if (!runtime) return { ok: false, reason: "unsupported" };
			const byProvider = ownershipStore().get(runtime);
			const owned = byProvider?.get(providerId);
			if (!owned) return { ok: true, action: "unchanged" };

			try {
				const currentKey = await registry.getApiKeyForProvider(providerId);
				if (
					currentKey === undefined &&
					registry.getProviderAuthStatus(providerId).source === "runtime"
				) {
					return { ok: false, reason: "operation_failed" };
				}
				if (currentKey !== owned.ownedKey) {
					byProvider?.delete(providerId);
					return { ok: true, action: "unchanged" };
				}

				if (owned.originalSourceWasRuntime) {
					await runtime.setRuntimeApiKey(providerId, owned.originalRuntimeKey);
					byProvider?.delete(providerId);
					return { ok: true, action: "restored" };
				}

				await runtime.removeRuntimeApiKey(providerId);
				byProvider?.delete(providerId);
				return { ok: true, action: "removed" };
			} catch {
				return { ok: false, reason: "operation_failed" };
			}
		},
	};
}
