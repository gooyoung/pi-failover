import type { ProviderPlan } from "./failover-engine.ts";

export interface PlannerModel {
	provider: string;
	id: string;
}

export interface ModelPlannerContext<TModel extends PlannerModel = PlannerModel> {
	modelRegistry: {
		getAvailable(): readonly TModel[];
		getProviderAuthStatus(providerId: string): { configured: boolean };
	};
	setModel(model: TModel): boolean | Promise<boolean>;
}

export interface ApplyNextModelRequest {
	authOrder: readonly (string | { provider: string })[];
	current: ProviderPlan;
	unavailableProviderIds: readonly string[];
	cooldownProviderIds: readonly string[];
}

export async function applyNextModel<TModel extends PlannerModel>(
	ctx: ModelPlannerContext<TModel>,
	request: ApplyNextModelRequest,
): Promise<ProviderPlan | undefined> {
	const providerIds = request.authOrder.map((entry) => typeof entry === "string" ? entry : entry.provider);
	const currentIndex = providerIds.indexOf(request.current.providerId);
	const ordered = currentIndex < 0
		? providerIds
		: [...providerIds.slice(currentIndex + 1), ...providerIds.slice(0, currentIndex)];
	const available = ctx.modelRegistry.getAvailable();
	const unavailable = new Set(request.unavailableProviderIds);
	const cooling = new Set(request.cooldownProviderIds);

	for (const providerId of ordered) {
		if (unavailable.has(providerId) || cooling.has(providerId)) continue;
		if (!ctx.modelRegistry.getProviderAuthStatus(providerId).configured) continue;
		const providerModels = available.filter((candidate) => candidate.provider === providerId);
		const model = providerModels.find((candidate) => candidate.id === request.current.model) ?? providerModels[0];
		if (!model) continue;
		try {
			if (await ctx.setModel(model)) return { providerId, model: model.id };
		} catch {
			// A model may become unavailable between the registry snapshot and
			// application. Continue the deterministic provider walk.
		}
	}

	return undefined;
}
