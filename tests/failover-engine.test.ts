import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	backupIndexForSlot,
	backupSlot,
	FailoverEngine,
	type FailoverDecision,
	type FailureObservation,
	type KeySlot,
} from "../src/failover-engine.ts";

const primarySecret = "primary-secret-must-never-escape";
const backupSecret = "backup-secret-must-never-escape";

function createClock(initial = 1_000): { now: () => number; advance: (milliseconds: number) => void } {
	let time = initial;
	return {
		now: () => time,
		advance: (milliseconds) => {
			time += milliseconds;
		},
	};
}

function createEngine(options: {
	providers?: Array<{ id: string; backupKeyCount?: number }>;
	plans?: Array<{ providerId: string; model: string }>;
	clock?: ReturnType<typeof createClock>;
} = {}): FailoverEngine {
	const plans = [...(options.plans ?? [])];
	return new FailoverEngine({
		providers: options.providers ?? [{ id: "alpha", backupKeyCount: 1 }],
		now: options.clock?.now ?? (() => 1_000),
		nextProvider: () => plans.shift(),
	});
}

function assertAttempt(
	decision: FailoverDecision,
	expected: { providerId: string; model: string; keySlot: KeySlot; kind?: "switch-key" | "switch-model" },
): void {
	assert.deepEqual(decision, {
		kind: expected.kind ?? "switch-key",
		providerId: expected.providerId,
		model: expected.model,
		keySlot: expected.keySlot,
	});
}

describe("FailoverEngine", () => {
	test("rotates a permanently disabled 401 or 403 primary key to its backup without exposing credentials", () => {
		for (const status of [401, 403]) {
			const engine = createEngine();

			assertAttempt(engine.startTurn({ providerId: "alpha", model: "alpha-model" }), {
				providerId: "alpha",
				model: "alpha-model",
				keySlot: "primary",
			});
			assertAttempt(engine.observeFailure({ status }), {
				providerId: "alpha",
				model: "alpha-model",
				keySlot: "backup",
			});

			const snapshot = engine.snapshot();
			assert.deepEqual(snapshot.providers, [
				{
					providerId: "alpha",
					status: "healthy",
					keys: [
						{ slot: "primary", status: "disabled" },
						{ slot: "backup", status: "healthy" },
					],
				},
			]);
			assert.doesNotMatch(
				JSON.stringify({ snapshot, decision: engine.currentDecision() }),
				/primary-secret-must-never-escape|backup-secret-must-never-escape/,
			);
		}
	});

	test("uses Retry-After to cool down a rate-limited key before attempting its backup", () => {
		const clock = createClock();
		const engine = createEngine({ clock });

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.observeFailure({ status: 429, retryAfterMs: 5_000 }), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot: "backup",
		});
		assert.deepEqual(engine.snapshot().providers[0], {
			providerId: "alpha",
			status: "healthy",
			keys: [
				{ slot: "primary", status: "cooling", cooldownUntil: 6_000 },
				{ slot: "backup", status: "healthy" },
			],
		});

		clock.advance(5_000);
		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.currentDecision(), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot: "primary",
		});
	});

	test("uses a sixty-second key cooldown when rate limiting omits Retry-After", () => {
		const clock = createClock();
		const engine = createEngine({ clock });

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		engine.observeFailure({ status: 429 });

		assert.deepEqual(engine.snapshot().providers[0]?.keys[0], {
			slot: "primary",
			status: "cooling",
			cooldownUntil: 61_000,
		});
	});

	test("cools down an overloaded provider and skips key rotation", () => {
		const clock = createClock();
		const engine = createEngine({
			clock,
			providers: [{ id: "alpha", backupKeyCount: 1 }, { id: "beta", backupKeyCount: 1 }],
			plans: [{ providerId: "beta", model: "beta-model" }],
		});

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.observeFailure({ status: 529, retryAfterMs: 7_000 }), {
			kind: "switch-model",
			providerId: "beta",
			model: "beta-model",
			keySlot: "primary",
		});
		assert.deepEqual(engine.snapshot().providers, [
			{
				providerId: "alpha",
				status: "cooling",
				cooldownUntil: 8_000,
				keys: [
					{ slot: "primary", status: "healthy" },
					{ slot: "backup", status: "healthy" },
				],
			},
			{
				providerId: "beta",
				status: "healthy",
				keys: [
					{ slot: "primary", status: "healthy" },
					{ slot: "backup", status: "healthy" },
				],
			},
		]);
	});

	test("uses the thirty-second provider cooldown for overloaded and provider/network failures", () => {
		for (const observation of [{ status: 529 }, { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }, { kind: "network" }, { kind: "provider-error" }] satisfies FailureObservation[]) {
			const clock = createClock();
			const engine = createEngine({ clock });

			engine.startTurn({ providerId: "alpha", model: "alpha-model" });
			assert.deepEqual(engine.observeFailure(observation), { kind: "exhausted" });
			assert.deepEqual(engine.snapshot().providers[0], {
				providerId: "alpha",
				status: "cooling",
				cooldownUntil: 31_000,
				keys: [
					{ slot: "primary", status: "healthy" },
					{ slot: "backup", status: "healthy" },
				],
			});
		}
	});

	test("does nothing for other failures", () => {
		const engine = createEngine();

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assert.deepEqual(engine.observeFailure({ status: 418 }), { kind: "none" });
		assert.deepEqual(engine.snapshot().providers[0]?.keys[0], { slot: "primary", status: "healthy" });
	});

	test("marks only the active key and provider healthy after a successful response", () => {
		const clock = createClock();
		const engine = createEngine({ clock });

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		engine.observeFailure({ status: 429 });
		engine.observeSuccess();

		assert.deepEqual(engine.snapshot().providers[0], {
			providerId: "alpha",
			status: "healthy",
			keys: [
				{ slot: "primary", status: "cooling", cooldownUntil: 61_000 },
				{ slot: "backup", status: "healthy" },
			],
		});
	});

	test("does not retry a key or provider more than once during a turn", () => {
		const engine = createEngine({
			providers: [{ id: "alpha", backupKeyCount: 1 }, { id: "beta", backupKeyCount: 1 }],
			plans: [
				{ providerId: "alpha", model: "alpha-again" },
				{ providerId: "beta", model: "beta-model" },
			],
		});

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.observeFailure({ status: 401 }), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot: "backup",
		});
		assertAttempt(engine.observeFailure({ status: 401 }), {
			kind: "switch-model",
			providerId: "beta",
			model: "beta-model",
			keySlot: "primary",
		});
		assertAttempt(engine.observeFailure({ status: 401 }), {
			providerId: "beta",
			model: "beta-model",
			keySlot: "backup",
		});
		assert.deepEqual(engine.observeFailure({ status: 401 }), { kind: "exhausted" });
	});

	test("does not cycle into providers or keys that are cooling down", () => {
		const clock = createClock();
		const engine = createEngine({
			clock,
			providers: [{ id: "alpha", backupKeyCount: 1 }, { id: "beta", backupKeyCount: 1 }],
			plans: [
				{ providerId: "alpha", model: "alpha-again" },
				{ providerId: "beta", model: "beta-model" },
			],
		});

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.observeFailure({ status: 529 }), {
			kind: "switch-model",
			providerId: "beta",
			model: "beta-model",
			keySlot: "primary",
		});
		engine.observeFailure({ status: 429 });
		assert.deepEqual(engine.observeFailure({ status: 401 }), { kind: "exhausted" });
	});

	test("resets turn visits while retaining cooldown state", () => {
		const clock = createClock();
		const engine = createEngine({
			clock,
			providers: [{ id: "alpha", backupKeyCount: 1 }, { id: "beta" }],
			plans: [
				{ providerId: "beta", model: "beta-model" },
				{ providerId: "beta", model: "beta-model" },
			],
		});

		engine.startTurn({ providerId: "alpha", model: "alpha-model" });
		assertAttempt(engine.observeFailure({ status: 429 }), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot: "backup",
		});
		engine.observeFailure({ status: 401 });

		assertAttempt(engine.startTurn({ providerId: "alpha", model: "alpha-model" }), {
			kind: "switch-model",
			providerId: "beta",
			model: "beta-model",
			keySlot: "primary",
		});
		clock.advance(60_000);
		assertAttempt(engine.startTurn({ providerId: "alpha", model: "alpha-model" }), {
			providerId: "alpha",
			model: "alpha-model",
			keySlot: "primary",
		});
	});

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
});
