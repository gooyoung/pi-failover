import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFailoverExtension } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

interface TestModel {
	provider: string;
	id: string;
}

type ExtensionMode = "tui" | "rpc" | "json" | "print";

interface NotificationCall {
	message: string;
	level?: string;
}

interface SentMessageCall {
	message: unknown;
	options?: {
		triggerTurn?: boolean;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	};
}

function createHarness(options: {
	models?: TestModel[];
	setModel?: (model: TestModel) => boolean | Promise<boolean>;
	setRuntimeKey?: (providerId: string, key: string) => void | Promise<void>;
	removeRuntimeKey?: (providerId: string, attempt: number) => void | Promise<void>;
	runtimeSupported?: boolean;
	hasUI?: boolean;
	mode?: ExtensionMode;
} = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const models = options.models ?? [{ provider: "alpha", id: "shared" }];
	const originalKeys = new Map(models.map((model) => [model.provider, `${model.provider}-primary-secret`]));
	const resolvedKeys = new Map(originalKeys);
	const runtimeProviders = new Set<string>();
	const setKeys: string[] = [];
	const setKeyCalls: Array<{ providerId: string; key: string }> = [];
	const removedProviders: string[] = [];
	const removeAttempts = new Map<string, number>();
	const notifications: string[] = [];
	const notificationCalls: NotificationCall[] = [];
	const sentMessageCalls: SentMessageCall[] = [];
	const appliedModels: TestModel[] = [];
	const runtime = options.runtimeSupported === false
		? {}
		: {
			async setRuntimeApiKey(providerId: string, key: string) {
				setKeys.push(key);
				setKeyCalls.push({ providerId, key });
				await options.setRuntimeKey?.(providerId, key);
				resolvedKeys.set(providerId, key);
				runtimeProviders.add(providerId);
			},
			async removeRuntimeApiKey(providerId: string) {
				removedProviders.push(providerId);
				const attempt = (removeAttempts.get(providerId) ?? 0) + 1;
				removeAttempts.set(providerId, attempt);
				await options.removeRuntimeKey?.(providerId, attempt);
				const originalKey = originalKeys.get(providerId);
				if (originalKey === undefined) resolvedKeys.delete(providerId);
				else resolvedKeys.set(providerId, originalKey);
				runtimeProviders.delete(providerId);
			},
		};
	const modelRegistry = {
		runtime,
		async getApiKeyForProvider(providerId: string) {
			return resolvedKeys.get(providerId);
		},
		getProviderAuthStatus(providerId: string) {
			return {
				configured: resolvedKeys.has(providerId),
				source: runtimeProviders.has(providerId) ? "runtime" : "stored",
			};
		},
		getAvailable() {
			return models;
		},
	};
	const mode = options.mode ?? "tui";
	const ctx = {
		mode,
		hasUI: options.hasUI ?? (mode === "tui" || mode === "rpc"),
		cwd: "/tmp/project",
		model: models[0],
		modelRegistry,
		ui: {
			notify(message: string, level?: string) {
				notifications.push(message);
				notificationCalls.push({ message, level });
			},
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		async setModel(model: TestModel) {
			appliedModels.push(model);
			const applied = (await options.setModel?.(model)) ?? true;
			if (applied) ctx.model = model;
			return applied;
		},
		sendMessage(message: unknown, options?: SentMessageCall["options"]) {
			sentMessageCalls.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	async function emit(event: string, value: Record<string, unknown>) {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...value }, ctx);
		return result;
	}

	async function runCommand(name: string, args: string) {
		const command = commands.get(name);
		assert.ok(command, `command ${name} was not registered`);
		return command.handler(args, ctx);
	}

	return {
		pi,
		ctx,
		emit,
		runCommand,
		commands,
		setKeys,
		setKeyCalls,
		removedProviders,
		notifications,
		notificationCalls,
		sentMessageCalls,
		appliedModels,
		resolvedKeys,
	};
}

type ExtensionHarness = ReturnType<typeof createHarness>;

function installExtension(
	harness: ExtensionHarness,
	providers: Array<
		| { provider: string; type: "api_key"; backupKeys?: string[] }
		| { provider: string; type: "oauth" }
	>,
	options: { now?: () => number } = {},
): void {
	createFailoverExtension({
		loadCatalog: () => ({ enabled: true, providers, diagnostics: [] }),
		...options,
	})(harness.pi);
}

function assistantError(errorMessage: string) {
	return { role: "assistant", stopReason: "error", errorMessage, content: [] };
}

const retryMessageCall: SentMessageCall = {
	message: {
		customType: "pi-failover-retry",
		content: "Retry the current user request now using the failover credential or provider. Do not mention this internal retry.",
		display: false,
	},
	options: { triggerTurn: true, deliverAs: "followUp" },
};

function assertHiddenRetry(result: unknown, message: ReturnType<typeof assistantError>): void {
	assert.deepEqual(result, {
		message: {
			...message,
			content: [],
			stopReason: "stop",
			errorMessage: undefined,
		},
	});
}

async function startSessionTurn(harness: ExtensionHarness, turnIndex = 0): Promise<void> {
	if (turnIndex === 0) await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex, timestamp: 1_000 + turnIndex });
}

async function failAttempt(
	harness: ExtensionHarness,
	options: { status?: number; headers?: Record<string, string>; errorMessage: string },
) {
	await harness.emit("before_provider_request", { payload: { messages: [] } });
	if (options.status !== undefined) {
		await harness.emit("after_provider_response", { status: options.status, headers: options.headers ?? {} });
	}
	const message = assistantError(options.errorMessage);
	const result = await harness.emit("message_end", { message });
	return { message, result };
}

test("a 401 response rotates to the provider backup and hides the intermediate error", async () => {
	const harness = createHarness();
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	const message = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "request failed because the service claims it is overloaded",
		content: [],
	};
	const result = await harness.emit("message_end", { message });

	assert.deepEqual(harness.setKeys, ["backup-secret"]);
	assertHiddenRetry(result, message);
	assert.equal(message.errorMessage, "request failed because the service claims it is overloaded");
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall]);
});

test("a 403 backup switch hides the intermediate error and queues exactly one continuation", async () => {
	const harness = createHarness();
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] },
	]);

	await startSessionTurn(harness);
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 403, headers: {} });
	const failedMessage = assistantError(
		'403: {"message":"Access to model denied.","type":"AccessDenied.Unpurchased","code":"AccessDenied.Unpurchased"}',
	);
	const firstResult = await harness.emit("message_end", { message: failedMessage });
	const duplicateResult = await harness.emit("message_end", { message: failedMessage });

	assert.deepEqual(harness.setKeys, ["backup-secret"]);
	assertHiddenRetry(firstResult, failedMessage);
	assert.equal(duplicateResult, undefined);
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall]);
	assert.equal(
		harness.notifications.filter((message) => message === "pi-failover: alpha switched to backup credential").length,
		1,
	);
});

test("the follow-up retry turn does not re-announce an already-applied backup switch", async () => {
	const harness = createHarness();
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: assistantError("401 unauthorized"),
	});

	assert.deepEqual(harness.setKeys, ["backup-secret"]);
	assert.equal(
		harness.notifications.filter((message) => message === "pi-failover: alpha switched to backup credential").length,
		1,
	);

	// triggerTurn retries with a fresh turn while the primary is still disabled,
	// which previously re-applied the backup switch and announced it again.
	await harness.emit("turn_start", { turnIndex: 1, timestamp: 2_000 });

	assert.deepEqual(harness.setKeys, ["backup-secret"], "backup key must not be re-set on the retry turn");
	assert.equal(
		harness.notifications.filter((message) => message === "pi-failover: alpha switched to backup credential").length,
		1,
		"backup switch must not be announced again on the retry turn",
	);
});

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

test("overloaded text on an ordinary 429 switches provider through Pi's model API", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
	});
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [
				{ provider: "alpha", type: "api_key", backupKeys: ["alpha-backup-secret"] },
				{ provider: "beta", type: "oauth" },
			],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 429, headers: {} });
	const message = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "upstream error type=overloaded_error",
		content: [],
	};
	await harness.emit("message_end", { message });

	assert.equal(harness.ctx.model?.provider, "beta");
	assert.deepEqual(harness.setKeys, []);
	assert.equal(message.errorMessage, "upstream error type=overloaded_error");
});

test("a new provider attempt clears stale status before classifying a response-less timeout", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
	});
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [
				{ provider: "alpha", type: "api_key", backupKeys: ["alpha-backup-secret"] },
				{ provider: "beta", type: "oauth" },
			],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Network request timed out before a response arrived",
			content: [],
		},
	});

	assert.equal(harness.ctx.model?.provider, "beta");
	assert.deepEqual(harness.setKeys, []);
});

test("a rejected backup override continues to provider fallback without surfacing an extension error", async () => {
	const backupSecret = "alpha-backup-must-not-be-displayed";
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
		setRuntimeKey(_providerId, key) {
			if (key === backupSecret) throw new Error(`setter rejected ${key}`);
		},
	});
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [
				{ provider: "alpha", type: "api_key", backupKeys: [backupSecret] },
				{ provider: "beta", type: "oauth" },
			],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "unauthorized",
			content: [],
		},
	});

	assert.equal(harness.ctx.model?.provider, "beta");
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall]);
	assert.doesNotMatch(harness.notifications.join("\n"), new RegExp(backupSecret));
});

test("total exhaustion waits for Pi retries to settle before restoring an owned override", async () => {
	const harness = createHarness();
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
			diagnostics: [],
		}),
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "primary rejected", content: [] },
	});

	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	const finalMessage = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "backup rejected by provider",
		content: [],
	};
	const result = await harness.emit("message_end", { message: finalMessage });

	assert.deepEqual(harness.removedProviders, []);
	assert.equal(harness.resolvedKeys.get("alpha"), "backup-secret");
	assert.equal(result, undefined);
	assert.equal(finalMessage.errorMessage, "backup rejected by provider");
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall]);

	await harness.emit("agent_settled", {});

	assert.deepEqual(harness.removedProviders, ["alpha"]);
	assert.equal(harness.resolvedKeys.get("alpha"), "alpha-primary-secret");
});

test("a Pi retry after backup exhaustion keeps using the backup until it succeeds", async () => {
	const harness = createHarness();
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 401, errorMessage: "primary unauthorized" });
	await harness.emit("turn_start", { turnIndex: 1, timestamp: 2_000 });

	const exhausted = await failAttempt(harness, {
		status: 429,
		errorMessage: "429 Throttling.ResourceExhausted",
	});

	assert.equal(exhausted.result, undefined);
	assert.deepEqual(harness.removedProviders, []);
	assert.equal(harness.resolvedKeys.get("alpha"), "backup-secret");

	// Pi starts its built-in retry only after the failed message_end handler returns.
	await harness.emit("turn_start", { turnIndex: 2, timestamp: 3_000 });
	await harness.emit("before_provider_request", { payload: {} });
	assert.equal(harness.resolvedKeys.get("alpha"), "backup-secret");
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [] },
	});
	await harness.emit("agent_settled", {});
	await harness.runCommand("failover-status", "");

	assert.deepEqual(harness.removedProviders, []);
	assert.equal(harness.resolvedKeys.get("alpha"), "backup-secret");
	assert.match(harness.notifications.at(-1) ?? "", /backup=healthy/);
	assert.equal(
		harness.notifications.filter((message) => message.includes("all configured providers exhausted")).length,
		0,
	);
});

test("a Pi retry tracks the primary request when applying the backup failed", async () => {
	const harness = createHarness({
		setRuntimeKey(_providerId, key) {
			if (key === "rejected-backup") throw new Error("backup override rejected");
		},
	});
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: ["rejected-backup"] },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, {
		status: 429,
		errorMessage: "429 Throttling.ResourceExhausted",
	});

	assert.equal(harness.resolvedKeys.get("alpha"), "alpha-primary-secret");
	await harness.emit("turn_start", { turnIndex: 1, timestamp: 2_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [] },
	});
	await harness.emit("agent_settled", {});
	await harness.runCommand("failover-status", "");

	assert.equal(harness.resolvedKeys.get("alpha"), "alpha-primary-secret");
	assert.match(harness.notifications.at(-1) ?? "", /primary=healthy/);
	assert.doesNotMatch(harness.notifications.join("\n"), /rejected-backup/);
});

test("registers discoverable status and reload commands and status responds without arguments", async () => {
	const harness = createHarness();
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] },
	]);

	await harness.emit("session_start", { reason: "startup" });
	await harness.runCommand("failover-status", "");

	assert.deepEqual([...harness.commands.keys()], ["failover-status", "failover-reload"]);
	assert.match(harness.notifications.at(-1) ?? "", /pi-failover: active/);
});

test("reload and shutdown restore owned overrides while the failover commands stay redacted", async () => {
	const backupSecret = "backup-secret-must-stay-out-of-status";
	const harness = createHarness();
	let catalogLoads = 0;
	createFailoverExtension({
		loadCatalog: () => {
			catalogLoads += 1;
			if (catalogLoads === 2) assert.deepEqual(harness.removedProviders, ["alpha"]);
			return {
				enabled: true,
				providers: [{ provider: "alpha", type: "api_key", backupKeys: [backupSecret] }],
				diagnostics: [],
			};
		},
		now: () => 1_000,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "unauthorized", content: [] },
	});

	await harness.runCommand("failover-reload", "");
	await harness.runCommand("failover-status", "");
	assert.equal(catalogLoads, 2);
	assert.deepEqual([...harness.commands.keys()], ["failover-status", "failover-reload"]);
	assert.match(harness.notifications.join("\n"), /alpha|failover/i);
	assert.doesNotMatch(harness.notifications.join("\n"), new RegExp(backupSecret));

	await harness.emit("turn_start", { turnIndex: 1, timestamp: 2_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "unauthorized again", content: [] },
	});
	await harness.emit("session_shutdown", { reason: "quit" });

	assert.deepEqual(harness.removedProviders, ["alpha", "alpha"]);
});

test("Retry-After metadata expires the primary cooldown and restores the owned backup before reuse", async () => {
	let time = 1_000;
	const harness = createHarness();
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
			diagnostics: [],
		}),
		now: () => time,
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: time });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 429, headers: { "Retry-After": "5" } });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "rate limited", content: [] },
	});
	assert.deepEqual(harness.setKeys, ["backup-secret"]);

	time += 5_000;
	await harness.emit("turn_start", { turnIndex: 1, timestamp: time });

	assert.deepEqual(harness.removedProviders, ["alpha"]);
	assert.deepEqual(harness.setKeys, ["backup-secret"]);
});

test("an exact successful response takes precedence over conflicting assistant error text", async () => {
	const harness = createHarness();
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
			diagnostics: [],
		}),
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "body text says 401 unauthorized and overloaded",
			content: [],
		},
	});

	assert.deepEqual(harness.setKeys, []);
	assert.deepEqual(harness.removedProviders, []);
});

test("json and print modes make no UI calls while still queuing a hidden continuation", async () => {
	for (const mode of ["json", "print"] as const) {
		const harness = createHarness({ mode, hasUI: false });
		createFailoverExtension({
			loadCatalog: () => ({
				enabled: true,
				providers: [{ provider: "alpha", type: "api_key", backupKeys: ["backup-secret"] }],
				diagnostics: [],
			}),
		})(harness.pi);

		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("failover-status", "");
		await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
		await harness.emit("before_provider_request", { payload: {} });
		await harness.emit("after_provider_response", { status: 401, headers: {} });
		await harness.emit("message_end", {
			message: { role: "assistant", stopReason: "error", errorMessage: "unauthorized", content: [] },
		});

		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.sentMessageCalls, [retryMessageCall]);
	}
});

test("a failed model application continues the deterministic provider walk", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
			{ provider: "gamma", id: "shared" },
		],
		setModel: (model) => model.provider !== "beta",
	});
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [
				{ provider: "alpha", type: "oauth" },
				{ provider: "beta", type: "oauth" },
				{ provider: "gamma", type: "oauth" },
			],
			diagnostics: [],
		}),
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 503, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "unavailable", content: [] },
	});

	assert.deepEqual(harness.appliedModels.map((model) => model.provider), ["beta", "gamma"]);
	assert.equal(harness.ctx.model?.provider, "gamma");
});

test("missing runtime override APIs disable failover and report compatibility once", async () => {
	const harness = createHarness({
		runtimeSupported: false,
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
			{ provider: "gamma", id: "shared" },
		],
	});
	createFailoverExtension({
		loadCatalog: () => ({
			enabled: true,
			providers: [
				{ provider: "alpha", type: "oauth" },
				{ provider: "beta", type: "oauth" },
				{ provider: "gamma", type: "oauth" },
			],
			diagnostics: [],
		}),
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("session_start", { reason: "reload" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	assert.equal(harness.ctx.model?.provider, "alpha");
	assert.equal(harness.appliedModels.length, 0);

	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 503, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "unavailable", content: [] },
	});

	assert.equal(harness.ctx.model?.provider, "alpha");
	assert.deepEqual(harness.appliedModels, []);
	assert.equal(harness.notifications.filter((message) => message.includes("lacks credential override support")).length, 1);
});

test("shutdown retries failed reload cleanup after the new catalog removes the owned provider", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
		removeRuntimeKey(providerId, attempt) {
			if (providerId === "alpha" && attempt === 1) throw new Error("temporary cleanup failure");
		},
	});
	let catalogLoads = 0;
	createFailoverExtension({
		loadCatalog: () => {
			catalogLoads += 1;
			return catalogLoads === 1
				? {
					enabled: true,
					providers: [{ provider: "alpha", type: "api_key", backupKeys: ["alpha-backup-secret"] }],
					diagnostics: [],
				}
				: {
					enabled: true,
					providers: [{ provider: "beta", type: "oauth" }],
					diagnostics: [],
				};
		},
	})(harness.pi);

	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("turn_start", { turnIndex: 0, timestamp: 1_000 });
	await harness.emit("before_provider_request", { payload: {} });
	await harness.emit("after_provider_response", { status: 401, headers: {} });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "unauthorized", content: [] },
	});

	await harness.runCommand("failover-reload", "");
	assert.equal(catalogLoads, 2);
	assert.deepEqual(harness.removedProviders, ["alpha"]);

	await harness.emit("session_shutdown", { reason: "quit" });

	assert.deepEqual(harness.removedProviders, ["alpha", "alpha"]);
});

for (const { mode, expectsNotifications } of [
	{ mode: "tui", expectsNotifications: true },
	{ mode: "rpc", expectsNotifications: true },
	{ mode: "json", expectsNotifications: false },
	{ mode: "print", expectsNotifications: false },
] as const) {
	test(`${mode}: primary 429 uses backup, second 429 uses the next provider's same-id model`, async () => {
		const alphaBackup = `${mode}-alpha-backup-secret`;
		const harness = createHarness({
			mode,
			models: [
				{ provider: "alpha", id: "shared" },
				{ provider: "beta", id: "beta-first" },
				{ provider: "beta", id: "shared" },
			],
		});
		installExtension(harness, [
			{ provider: "alpha", type: "api_key", backupKeys: [alphaBackup] },
			{ provider: "beta", type: "oauth" },
		]);

		await startSessionTurn(harness);
		const primaryError = await failAttempt(harness, { status: 429, errorMessage: "primary rate limited" });
		assert.deepEqual(harness.setKeyCalls, [{ providerId: "alpha", key: alphaBackup }]);
		assert.equal(harness.ctx.model?.provider, "alpha");

		const backupError = await failAttempt(harness, { status: 429, errorMessage: "backup rate limited" });

		assert.deepEqual(harness.appliedModels, [{ provider: "beta", id: "shared" }]);
		assert.deepEqual(harness.ctx.model, { provider: "beta", id: "shared" });
		assert.equal(primaryError.message.errorMessage, "primary rate limited");
		assert.equal(backupError.message.errorMessage, "backup rate limited");
		assertHiddenRetry(primaryError.result, primaryError.message);
		assertHiddenRetry(backupError.result, backupError.message);
		assert.deepEqual(harness.sentMessageCalls, [retryMessageCall, retryMessageCall]);
		assert.equal(harness.notificationCalls.length, expectsNotifications ? 2 : 0);
		assert.doesNotMatch(JSON.stringify(harness.notificationCalls), new RegExp(alphaBackup));
	});
}

test("provider fallback uses the target provider's first model when the current id is absent", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "alpha-only" },
			{ provider: "beta", id: "beta-first" },
			{ provider: "beta", id: "beta-second" },
		],
	});
	installExtension(harness, [
		{ provider: "alpha", type: "oauth" },
		{ provider: "beta", type: "oauth" },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 503, errorMessage: "service unavailable" });

	assert.deepEqual(harness.appliedModels, [{ provider: "beta", id: "beta-first" }]);
	assert.deepEqual(harness.ctx.model, { provider: "beta", id: "beta-first" });
});

for (const scenario of [
	{ name: "529", status: 529, errorMessage: "provider overloaded" },
	{ name: "503", status: 503, errorMessage: "service unavailable" },
	{ name: "network", status: undefined, errorMessage: "network connection reset" },
] as const) {
	test(`${scenario.name} falls back directly to the next provider without consuming the backup`, async () => {
		const backupKey = `${scenario.name}-backup-secret`;
		const harness = createHarness({
			models: [
				{ provider: "alpha", id: "shared" },
				{ provider: "beta", id: "shared" },
			],
		});
		installExtension(harness, [
			{ provider: "alpha", type: "api_key", backupKeys: [backupKey] },
			{ provider: "beta", type: "oauth" },
		]);

		await startSessionTurn(harness);
		await failAttempt(harness, scenario);

		assert.deepEqual(harness.setKeyCalls, []);
		assert.deepEqual(harness.appliedModels, [{ provider: "beta", id: "shared" }]);
		assert.equal(harness.ctx.model?.provider, "beta");
		assert.doesNotMatch(JSON.stringify(harness.notificationCalls), new RegExp(backupKey));
	});
}

test("401 walks primary to backup to provider without cycling and restores after retries settle", async () => {
	const alphaBackup = "alpha-backup-secret-for-exhaustion";
	const betaBackup = "beta-backup-secret-for-exhaustion";
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
			{ provider: "gamma", id: "shared" },
		],
	});
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: [alphaBackup] },
		{ provider: "beta", type: "api_key", backupKeys: [betaBackup] },
		{ provider: "gamma", type: "oauth" },
	]);

	await startSessionTurn(harness);
	const errors = [];
	for (const errorMessage of [
		"alpha primary unauthorized",
		"alpha backup unauthorized",
		"beta primary unauthorized",
		"beta backup unauthorized",
	]) {
		errors.push(await failAttempt(harness, { status: 401, errorMessage }));
	}
	const finalError = await failAttempt(harness, { status: 401, errorMessage: "gamma unauthorized" });

	assert.deepEqual(harness.setKeyCalls, [
		{ providerId: "alpha", key: alphaBackup },
		{ providerId: "beta", key: betaBackup },
	]);
	assert.deepEqual(harness.appliedModels.map((model) => model.provider), ["beta", "gamma"]);
	assert.deepEqual(harness.removedProviders, []);

	await harness.emit("agent_settled", {});

	assert.deepEqual(harness.removedProviders, ["alpha", "beta"]);
	assert.equal(harness.resolvedKeys.get("alpha"), "alpha-primary-secret");
	assert.equal(harness.resolvedKeys.get("beta"), "beta-primary-secret");
	assert.equal(finalError.message.errorMessage, "gamma unauthorized");
	assert.equal(finalError.result, undefined);
	assert.deepEqual(errors.map(({ message }) => message.errorMessage), [
		"alpha primary unauthorized",
		"alpha backup unauthorized",
		"beta primary unauthorized",
		"beta backup unauthorized",
	]);
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall, retryMessageCall, retryMessageCall, retryMessageCall]);
	assert.ok(harness.notificationCalls.some(({ level }) => level === "warning"));
	assert.ok(harness.notificationCalls.some(({ level }) => level === "error"));
	assert.equal(
		harness.notifications.filter((message) => message.includes("all configured providers exhausted")).length,
		1,
	);
	assert.doesNotMatch(
		JSON.stringify(harness.notificationCalls),
		new RegExp(`${alphaBackup}|${betaBackup}|alpha-primary-secret|beta-primary-secret`),
	);
});

test("failed model application skips to the next provider and reports only the applied target", async () => {
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
			{ provider: "gamma", id: "shared" },
		],
		setModel(model) {
			if (model.provider === "beta") throw new Error("beta model application failed with internal-secret");
			return true;
		},
	});
	installExtension(harness, [
		{ provider: "alpha", type: "oauth" },
		{ provider: "beta", type: "oauth" },
		{ provider: "gamma", type: "oauth" },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 503, errorMessage: "alpha unavailable" });

	assert.deepEqual(harness.appliedModels.map((model) => model.provider), ["beta", "gamma"]);
	assert.equal(harness.ctx.model?.provider, "gamma");
	assert.deepEqual(harness.notificationCalls, [
		{ message: "pi-failover: switched to gamma/shared", level: "warning" },
	]);
	assert.doesNotMatch(JSON.stringify(harness.notificationCalls), /internal-secret/);
});

test("reload and shutdown restore the owned backup and keep status and warning notices redacted", async () => {
	const alphaBackup = "alpha-backup-never-display";
	const betaBackup = "beta-backup-never-display";
	const harness = createHarness({
		models: [
			{ provider: "alpha", id: "shared" },
			{ provider: "beta", id: "shared" },
		],
	});
	installExtension(harness, [
		{ provider: "alpha", type: "api_key", backupKeys: [alphaBackup] },
		{ provider: "beta", type: "api_key", backupKeys: [betaBackup] },
	]);

	await startSessionTurn(harness);
	await failAttempt(harness, { status: 401, errorMessage: "alpha unauthorized" });
	await harness.runCommand("failover-status", "");
	await harness.runCommand("failover-reload", "");
	assert.deepEqual(harness.removedProviders, ["alpha"]);

	await startSessionTurn(harness, 1);
	await failAttempt(harness, { status: 401, errorMessage: "alpha unauthorized after reload" });
	await harness.emit("session_shutdown", { reason: "quit" });

	assert.deepEqual(harness.removedProviders, ["alpha", "alpha"]);
	assert.deepEqual(harness.sentMessageCalls, [retryMessageCall, retryMessageCall]);
	assert.ok(harness.notificationCalls.some(({ level }) => level === "info"));
	assert.ok(harness.notificationCalls.some(({ level }) => level === "warning"));
	assert.doesNotMatch(
		JSON.stringify(harness.notificationCalls),
		new RegExp(`${alphaBackup}|${betaBackup}|alpha-primary-secret|beta-primary-secret`),
	);
});
