import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAuthCatalog, type AuthCatalog } from "./auth-catalog.ts";
import { FailoverEngine, type FailoverDecision, type FailureObservation } from "./failover-engine.ts";
import { applyNextModel } from "./model-planner.ts";
import {
	formatStatus,
	notify,
	notifyExhausted,
	notifyKeySwitch,
	notifyProviderSwitch,
} from "./notification.ts";
import { createPiRuntimeAdapter, type PiRuntimeAdapter } from "./pi-runtime.ts";

export interface FailoverExtensionOptions {
	loadCatalog?: () => AuthCatalog;
	now?: () => number;
}

interface AttemptResponse {
	providerId: string;
	keySlot: "primary" | "backup";
	status?: number;
	retryAfterMs?: number;
}

const OVERLOADED_TEXT = /\boverload(?:ed)?(?:[_ -]?error)?\b/i;

function classifyAttemptFailure(attempt: AttemptResponse, errorMessage: string): FailureObservation {
	const retryAfter = attempt.retryAfterMs === undefined ? {} : { retryAfterMs: attempt.retryAfterMs };
	if (attempt.status !== undefined) {
		if (attempt.status === 429 && OVERLOADED_TEXT.test(errorMessage)) {
			return { kind: "overloaded", ...retryAfter };
		}
		return { status: attempt.status, ...retryAfter };
	}
	if (OVERLOADED_TEXT.test(errorMessage) || /\b529\b/i.test(errorMessage)) return { kind: "overloaded", ...retryAfter };
	if (/\btimeout|timed out|deadline exceeded/i.test(errorMessage)) return { kind: "network", ...retryAfter };
	if (/\bnetwork|connection (?:reset|refused|closed)|fetch failed|socket hang up/i.test(errorMessage)) {
		return { kind: "network", ...retryAfter };
	}
	if (/\b40[13]\b|unauthorized|forbidden/i.test(errorMessage)) return { kind: "unauthorized", ...retryAfter };
	if (/\b429\b|rate.?limit|too many requests/i.test(errorMessage)) return { kind: "rate-limited", ...retryAfter };
	if (/\b50[0234]\b|temporar(?:y|ily) unavailable/i.test(errorMessage)) return { kind: "provider-error", ...retryAfter };
	return retryAfter;
}

function retryAfterMilliseconds(headers: Record<string, string>, now: number): number | undefined {
	const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1]?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function createFailoverExtension(options: FailoverExtensionOptions = {}) {
	const readCatalog = options.loadCatalog ?? loadAuthCatalog;
	const now = options.now ?? Date.now;

	return function registerFailover(pi: ExtensionAPI): void {
		let catalog: AuthCatalog = { enabled: false, providers: [], diagnostics: [] };
		let engine: FailoverEngine | undefined;
		let runtime: PiRuntimeAdapter | undefined;
		let attempt: AttemptResponse | undefined;
		let activeContext: ExtensionContext | undefined;
		const possiblyOwnedProviderIds = new Set<string>();
		let compatibilityErrorReported = false;

		function nextProvider(current: { providerId: string; model: string }, unavailableProviderIds: readonly string[]) {
			if (!activeContext) return undefined;
			const order = catalog.providers.map((provider) => provider.provider);
			const currentIndex = order.indexOf(current.providerId);
			const candidates = currentIndex < 0
				? order
				: [...order.slice(currentIndex + 1), ...order.slice(0, currentIndex)];
			const unavailable = new Set(unavailableProviderIds);
			const models = activeContext.modelRegistry.getAvailable();
			for (const providerId of candidates) {
				if (providerId === current.providerId || unavailable.has(providerId)) continue;
				if (!activeContext.modelRegistry.getProviderAuthStatus(providerId).configured) continue;
				const providerModels = models.filter((model) => model.provider === providerId);
				const model = providerModels.find((candidate) => candidate.id === current.model) ?? providerModels[0];
				if (model) return { providerId, model: model.id };
			}
			return undefined;
		}

		function rebuild(ctx: ExtensionContext): void {
			activeContext = ctx;
			catalog = readCatalog();
			runtime = createPiRuntimeAdapter(ctx.modelRegistry);
			if (!runtime.supported) {
				engine = undefined;
				if (!compatibilityErrorReported) {
					notify(ctx, "pi-failover: disabled because this Pi runtime lacks credential override support", "error");
					compatibilityErrorReported = true;
				}
				attempt = undefined;
				return;
			}
			engine = catalog.enabled
				? new FailoverEngine({
					providers: catalog.providers.map((provider) => ({
						id: provider.provider,
						hasBackupKey: provider.backupKey !== undefined,
					})),
					now,
					nextProvider: ({ current, unavailableProviderIds }) => nextProvider(current, unavailableProviderIds),
				})
				: undefined;
			attempt = undefined;
		}

		async function restoreOwnedOverrides(): Promise<void> {
			if (!runtime) return;
			for (const providerId of [...possiblyOwnedProviderIds]) {
				const result = await runtime.restoreOriginalKey(providerId);
				if (result.ok) possiblyOwnedProviderIds.delete(providerId);
			}
		}

		async function execute(initialDecision: FailoverDecision, ctx: ExtensionContext): Promise<void> {
			let decision = initialDecision;
			while (decision.kind === "switch-key" || decision.kind === "switch-model") {
				const activeDecision = decision;
				if (activeDecision.kind === "switch-model") {
					const applied = await applyNextModel(
						{ modelRegistry: ctx.modelRegistry, setModel: (model) => pi.setModel(model) },
						{
							authOrder: [activeDecision.providerId],
							current: { providerId: "", model: activeDecision.model },
							unavailableProviderIds: [],
							cooldownProviderIds: [],
						},
					);
					if (!applied) {
						decision = engine?.observeFailure({ kind: "provider-error" }) ?? { kind: "exhausted" };
						continue;
					}
					notifyProviderSwitch(ctx, applied.providerId, applied.model);
				}
				if (activeDecision.keySlot === "primary") {
					if (!runtime?.hasOwnedOverride(activeDecision.providerId)) {
						if (possiblyOwnedProviderIds.has(activeDecision.providerId)) {
							const result = await runtime?.restoreOriginalKey(activeDecision.providerId);
							if (result?.ok) possiblyOwnedProviderIds.delete(activeDecision.providerId);
						}
						return;
					}
					const result = await runtime?.restoreOriginalKey(activeDecision.providerId);
					if (result?.ok) {
						possiblyOwnedProviderIds.delete(activeDecision.providerId);
						return;
					}
					decision = engine?.observeFailure({ kind: "provider-error" }) ?? { kind: "exhausted" };
					continue;
				}
				const backupKey = catalog.providers.find((provider) => provider.provider === activeDecision.providerId)?.backupKey;
				possiblyOwnedProviderIds.add(activeDecision.providerId);
				const result = backupKey === undefined
					? { ok: false as const }
					: await runtime?.setBackupKey(activeDecision.providerId, backupKey);
				if (result?.ok) {
					notifyKeySwitch(ctx, activeDecision.providerId, activeDecision.keySlot);
					return;
				}
				if (!runtime?.hasOwnedOverride(activeDecision.providerId)) {
					possiblyOwnedProviderIds.delete(activeDecision.providerId);
				}
				decision = engine?.observeFailure({ kind: "unauthorized" }) ?? { kind: "exhausted" };
			}
			if (decision.kind === "exhausted") {
				await restoreOwnedOverrides();
				notifyExhausted(ctx);
			}
		}

		pi.on("session_start", (_event, ctx) => {
			rebuild(ctx);
		});

		pi.on("turn_start", async (_event, ctx) => {
			activeContext = ctx;
			if (!engine || !ctx.model) return;
			await execute(engine.startTurn({ providerId: ctx.model.provider, model: ctx.model.id }), ctx);
		});

		pi.on("before_provider_request", (_event, ctx) => {
			attempt = undefined;
			const decision = engine?.currentDecision();
			if (
				ctx.model &&
				decision &&
				(decision.kind === "switch-key" || decision.kind === "switch-model") &&
				decision.providerId === ctx.model.provider
			) {
				attempt = { providerId: decision.providerId, keySlot: decision.keySlot };
			}
		});

		pi.on("after_provider_response", (event) => {
			if (!attempt) return;
			attempt.status = event.status;
			attempt.retryAfterMs = retryAfterMilliseconds(event.headers, now());
			if (event.status >= 200 && event.status < 300) engine?.observeSuccess();
		});

		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant" || event.message.stopReason !== "error" || !attempt || !engine) return;
			const errorMessage = event.message.errorMessage ?? "";
			await execute(
				engine.observeFailure(classifyAttemptFailure(attempt, errorMessage)),
				ctx,
			);
		});

		pi.on("session_shutdown", async () => {
			await restoreOwnedOverrides();
			engine = undefined;
			attempt = undefined;
			activeContext = undefined;
		});

		pi.registerCommand("failover", {
			description: "show failover status or reload auth.json",
			handler: async (args, ctx) => {
				const subcommand = args.trim() || "status";
				if (subcommand === "status") {
					notify(ctx, formatStatus(catalog, engine?.snapshot()), "info");
					return;
				}
				if (subcommand === "reload") {
					await restoreOwnedOverrides();
					rebuild(ctx);
					notify(ctx, catalog.enabled ? "pi-failover: reloaded auth.json" : "pi-failover: auth.json reload disabled failover", catalog.enabled ? "info" : "warning");
					return;
				}
				notify(ctx, "pi-failover: usage: /failover status|reload", "warning");
			},
		});
	};
}

export default createFailoverExtension();
