export type FailureKind =
	| "unauthorized"
	| "rate-limited"
	| "overloaded"
	| "provider-error"
	| "network";

export interface FailureObservation {
	status?: number;
	kind?: FailureKind;
	retryAfterMs?: number;
}

export type KeySlot = "primary" | "backup";

export interface FailoverAttempt {
	providerId: string;
	model: string;
	keySlot: KeySlot;
}

export interface KeyStatusSnapshot {
	slot: KeySlot;
	status: "healthy" | "disabled" | "cooling";
	cooldownUntil?: number;
}

export interface ProviderStatusSnapshot {
	providerId: string;
	status: "healthy" | "cooling";
	cooldownUntil?: number;
	keys: KeyStatusSnapshot[];
}

export interface FailoverSnapshot {
	providers: ProviderStatusSnapshot[];
	active?: { providerId: string; model: string; keySlot: KeySlot };
	visitedProviders: string[];
	visitedKeys: Array<{ providerId: string; keySlot: KeySlot }>;
}

export interface ProviderPlan {
	providerId: string;
	model: string;
}

export interface ProviderFallbackRequest {
	current: ProviderPlan;
	unavailableProviderIds: readonly string[];
}

export interface FailoverProvider {
	id: string;
	hasBackupKey?: boolean;
}

export interface FailoverEngineOptions {
	providers: readonly FailoverProvider[];
	now: () => number;
	nextProvider: (request: ProviderFallbackRequest) => ProviderPlan | undefined;
}

export type FailoverDecision =
	| { kind: "switch-key" | "switch-model"; providerId: string; model: string; keySlot: KeySlot }
	| { kind: "none" | "exhausted" };

interface KeyState {
	slot: KeySlot;
	disabled: boolean;
	cooldownUntil: number;
}

interface ProviderState {
	id: string;
	keys: KeyState[];
	cooldownUntil: number;
}

interface ActiveAttempt {
	plan: ProviderPlan;
	keySlot: KeySlot;
}

const KEY_RATE_LIMIT_COOLDOWN_MS = 60_000;
const PROVIDER_COOLDOWN_MS = 30_000;

export class FailoverEngine {
	private readonly providers: ProviderState[];
	private readonly now: () => number;
	private readonly nextProvider: FailoverEngineOptions["nextProvider"];
	private visitedKeys = new Set<string>();
	private visitedProviders = new Set<string>();
	private active?: ActiveAttempt;
	private decision: FailoverDecision = { kind: "none" };

	constructor(options: FailoverEngineOptions) {
		this.providers = options.providers.map((provider) => ({
			id: provider.id,
			keys: [
				{ slot: "primary", disabled: false, cooldownUntil: 0 },
				...(provider.hasBackupKey ? [{ slot: "backup" as const, disabled: false, cooldownUntil: 0 }] : []),
			],
			cooldownUntil: 0,
		}));
		this.now = options.now;
		this.nextProvider = options.nextProvider;
	}

	startTurn(initial: ProviderPlan): FailoverDecision {
		this.visitedKeys = new Set();
		this.visitedProviders = new Set();
		this.active = undefined;

		return this.selectPlan(initial, "switch-key") ?? this.selectFallback(initial);
	}

	observeFailure(observation: FailureObservation): FailoverDecision {
		if (!this.active) return this.setDecision({ kind: "none" });

		switch (classifyFailure(observation)) {
			case "unauthorized":
				{
					const key = this.activeKey();
					if (key) key.disabled = true;
				}
				return this.rotateKeyOrFallback();
			case "rate-limited":
				this.activeKey()!.cooldownUntil = this.now() + cooldownFor(observation, KEY_RATE_LIMIT_COOLDOWN_MS);
				return this.rotateKeyOrFallback();
			case "overloaded":
			case "provider-error":
			case "network":
				this.activeProvider()!.cooldownUntil = this.now() + cooldownFor(observation, PROVIDER_COOLDOWN_MS);
				return this.selectFallback(this.active.plan);
			case "other":
				return this.setDecision({ kind: "none" });
		}
	}

	observeSuccess(): void {
		if (!this.active) return;
		const provider = this.activeProvider();
		const key = this.activeKey();
		if (!provider || !key) return;

		provider.cooldownUntil = 0;
		key.cooldownUntil = 0;
	}

	currentDecision(): FailoverDecision {
		return this.decision;
	}

	resumeAttempt(attempt: FailoverAttempt): boolean {
		const provider = this.provider(attempt.providerId);
		const key = provider?.keys.find((candidate) => candidate.slot === attempt.keySlot);
		if (!provider || !key) return false;
		this.active = {
			plan: { providerId: attempt.providerId, model: attempt.model },
			keySlot: attempt.keySlot,
		};
		return true;
	}

	snapshot(): FailoverSnapshot {
		const now = this.now();
		return {
			providers: this.providers.map((provider) => ({
				providerId: provider.id,
				...(provider.cooldownUntil > now
					? { status: "cooling" as const, cooldownUntil: provider.cooldownUntil }
					: { status: "healthy" as const }),
				keys: provider.keys.map((key) => ({
					slot: key.slot,
					...(key.disabled
						? { status: "disabled" as const }
						: key.cooldownUntil > now
							? { status: "cooling" as const, cooldownUntil: key.cooldownUntil }
							: { status: "healthy" as const }),
				})),
			})),
			...(this.active ? { active: { providerId: this.active.plan.providerId, model: this.active.plan.model, keySlot: this.active.keySlot } } : {}),
			visitedProviders: [...this.visitedProviders],
			visitedKeys: [...this.visitedKeys].map((value) => {
				const separator = value.lastIndexOf(":");
				return { providerId: value.slice(0, separator), keySlot: value.slice(separator + 1) as KeySlot };
			}),
		};
	}

	private rotateKeyOrFallback(): FailoverDecision {
		const active = this.active;
		if (!active) return this.setDecision({ kind: "none" });
		const provider = this.activeProvider();
		const key = provider && this.nextAvailableKey(provider);
		if (!provider || !key) return this.selectFallback(active.plan);

		return this.activate(active.plan, key, "switch-key");
	}

	private selectFallback(current: ProviderPlan): FailoverDecision {
		const considered = new Set<string>();
		for (let remaining = this.providers.length; remaining > 0; remaining -= 1) {
			const plan = this.nextProvider({
				current,
				unavailableProviderIds: [...new Set([...this.visitedProviders, ...considered])],
			});
			if (!plan) break;
			considered.add(plan.providerId);
			const decision = this.selectPlan(plan, "switch-model");
			if (decision) return decision;
		}

		return this.setDecision({ kind: "exhausted" });
	}

	private selectPlan(plan: ProviderPlan, kind: "switch-key" | "switch-model"): FailoverDecision | undefined {
		const provider = this.provider(plan.providerId);
		if (!provider || this.visitedProviders.has(provider.id) || provider.cooldownUntil > this.now()) return undefined;

		const key = this.nextAvailableKey(provider);
		if (!key) return undefined;

		this.visitedProviders.add(provider.id);
		return this.activate(plan, key, kind);
	}

	private activate(plan: ProviderPlan, key: KeyState, kind: "switch-key" | "switch-model"): FailoverDecision {
		this.visitedKeys.add(this.keyId(plan.providerId, key.slot));
		this.active = { plan, keySlot: key.slot };
		return this.setDecision({ kind, providerId: plan.providerId, model: plan.model, keySlot: key.slot });
	}

	private nextAvailableKey(provider: ProviderState): KeyState | undefined {
		const now = this.now();
		return provider.keys.find(
			(key) => !this.visitedKeys.has(this.keyId(provider.id, key.slot)) && !key.disabled && key.cooldownUntil <= now,
		);
	}

	private activeProvider(): ProviderState | undefined {
		return this.active && this.provider(this.active.plan.providerId);
	}

	private activeKey(): KeyState | undefined {
		const provider = this.activeProvider();
		return provider?.keys.find((key) => key.slot === this.active?.keySlot);
	}

	private provider(id: string): ProviderState | undefined {
		return this.providers.find((provider) => provider.id === id);
	}

	private keyId(providerId: string, keySlot: KeySlot): string {
		return `${providerId}:${keySlot}`;
	}

	private setDecision(decision: FailoverDecision): FailoverDecision {
		this.decision = decision;
		return decision;
	}
}

function classifyFailure(observation: FailureObservation): FailureKind | "other" {
	switch (observation.status) {
		case 401:
		case 403:
			return "unauthorized";
		case 429:
			return "rate-limited";
		case 529:
			return "overloaded";
		case 500:
		case 502:
		case 503:
		case 504:
			return "provider-error";
	}

	switch (observation.kind) {
		case "overloaded":
			return "overloaded";
		case "provider-error":
		case "network":
			return observation.kind;
		case "unauthorized":
			return "unauthorized";
		case "rate-limited":
			return "rate-limited";
		default:
			return "other";
	}
}

function cooldownFor(observation: FailureObservation, fallback: number): number {
	return typeof observation.retryAfterMs === "number" && Number.isFinite(observation.retryAfterMs)
		? Math.max(0, observation.retryAfterMs)
		: fallback;
}
