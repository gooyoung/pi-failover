import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyNextModel } from "../src/model-planner.ts";

interface TestModel {
	provider: string;
	id: string;
}

function createContext(options: {
	models: TestModel[];
	authenticated?: string[];
	setModel?: (model: TestModel) => boolean | Promise<boolean>;
}) {
	const authenticated = new Set(options.authenticated ?? options.models.map((model) => model.provider));
	const applied: TestModel[] = [];
	let availableReads = 0;
	return {
		ctx: {
			modelRegistry: {
				getAvailable() {
					availableReads += 1;
					return options.models;
				},
				getProviderAuthStatus(providerId: string) {
					return { configured: authenticated.has(providerId) };
				},
			},
			async setModel(model: TestModel): Promise<boolean> {
				applied.push(model);
				return (await options.setModel?.(model)) ?? true;
			},
		},
		applied,
		availableReads: () => availableReads,
	};
}

describe("applyNextModel", () => {
	test("starts after the current provider and prefers the same model id", async () => {
		const harness = createContext({
			models: [
				{ provider: "alpha", id: "shared" },
				{ provider: "beta", id: "beta-first" },
				{ provider: "beta", id: "shared" },
				{ provider: "gamma", id: "gamma-first" },
			],
		});

		const plan = await applyNextModel(harness.ctx, {
			authOrder: ["alpha", "beta", "gamma"],
			current: { providerId: "alpha", model: "shared" },
			unavailableProviderIds: [],
			cooldownProviderIds: [],
		});

		assert.deepEqual(plan, { providerId: "beta", model: "shared" });
		assert.deepEqual(harness.applied, [{ provider: "beta", id: "shared" }]);
		assert.equal(harness.availableReads(), 1);
	});

	test("starts at the first provider when current is absent and uses its first model", async () => {
		const harness = createContext({
			models: [
				{ provider: "alpha", id: "alpha-first" },
				{ provider: "alpha", id: "alpha-second" },
				{ provider: "beta", id: "shared" },
			],
		});

		const plan = await applyNextModel(harness.ctx, {
			authOrder: [{ provider: "alpha" }, { provider: "beta" }],
			current: { providerId: "outside-order", model: "shared" },
			unavailableProviderIds: [],
			cooldownProviderIds: [],
		});

		assert.deepEqual(plan, { providerId: "alpha", model: "alpha-first" });
		assert.deepEqual(harness.applied, [{ provider: "alpha", id: "alpha-first" }]);
	});

	test("skips visited, cooldown, unauthenticated, and model-less providers", async () => {
		const harness = createContext({
			models: [
				{ provider: "visited", id: "model" },
				{ provider: "cooling", id: "model" },
				{ provider: "unauthenticated", id: "model" },
				{ provider: "eligible", id: "model" },
			],
			authenticated: ["visited", "cooling", "model-less", "eligible"],
		});

		const plan = await applyNextModel(harness.ctx, {
			authOrder: ["visited", "cooling", "unauthenticated", "model-less", "eligible"],
			current: { providerId: "outside-order", model: "model" },
			unavailableProviderIds: ["visited"],
			cooldownProviderIds: ["cooling"],
		});

		assert.deepEqual(plan, { providerId: "eligible", model: "model" });
		assert.deepEqual(harness.applied, [{ provider: "eligible", id: "model" }]);
	});

	test("continues after false and rejected model applications", async () => {
		const harness = createContext({
			models: [
				{ provider: "beta", id: "shared" },
				{ provider: "gamma", id: "shared" },
				{ provider: "delta", id: "shared" },
			],
			setModel(model) {
				if (model.provider === "beta") return false;
				if (model.provider === "gamma") throw new Error("application failed");
				return true;
			},
		});

		const plan = await applyNextModel(harness.ctx, {
			authOrder: ["alpha", "beta", "gamma", "delta"],
			current: { providerId: "alpha", model: "shared" },
			unavailableProviderIds: ["alpha"],
			cooldownProviderIds: [],
		});

		assert.deepEqual(plan, { providerId: "delta", model: "shared" });
		assert.deepEqual(harness.applied.map((model) => model.provider), ["beta", "gamma", "delta"]);
	});

	test("wraps once without reconsidering the current provider", async () => {
		const harness = createContext({
			models: [
				{ provider: "alpha", id: "shared" },
				{ provider: "beta", id: "shared" },
				{ provider: "gamma", id: "shared" },
			],
			setModel: (model) => model.provider === "beta",
		});

		const plan = await applyNextModel(harness.ctx, {
			authOrder: ["alpha", "beta", "gamma"],
			current: { providerId: "beta", model: "shared" },
			unavailableProviderIds: [],
			cooldownProviderIds: [],
		});

		assert.equal(plan, undefined);
		assert.deepEqual(harness.applied.map((model) => model.provider), ["gamma", "alpha"]);
	});
});
