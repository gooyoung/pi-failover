import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthCatalog } from "./auth-catalog.ts";
import type { FailoverSnapshot, KeySlot } from "./failover-engine.ts";

export type NotificationLevel = "info" | "warning" | "error";
export type NotificationContext = Pick<ExtensionContext, "hasUI" | "ui">;

export function notify(ctx: NotificationContext, message: string, level: NotificationLevel): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// A disappearing UI must not interrupt provider failover.
	}
}

export function notifyKeySwitch(ctx: NotificationContext, providerId: string, slot: KeySlot): void {
	notify(ctx, `pi-failover: ${providerId} switched to ${slot} credential`, "warning");
}

export function notifyProviderSwitch(ctx: NotificationContext, providerId: string, model: string): void {
	notify(ctx, `pi-failover: switched to ${providerId}/${model}`, "warning");
}

export function notifyExhausted(ctx: NotificationContext): void {
	notify(ctx, "pi-failover: all configured providers exhausted; preserving the original provider error", "error");
}

export function formatStatus(catalog: AuthCatalog, snapshot: FailoverSnapshot | undefined): string {
	if (!catalog.enabled || !snapshot) return "pi-failover: disabled";
	const lines = ["pi-failover: active"];
	if (snapshot.active) {
		lines.push(`current: ${snapshot.active.providerId}/${snapshot.active.model}; key=${snapshot.active.keySlot}`);
	}
	for (const provider of snapshot.providers) {
		const providerCooldown = provider.cooldownUntil === undefined ? "" : ` until=${provider.cooldownUntil}`;
		const keys = provider.keys.map((key) => `${key.slot}=${key.status}${key.cooldownUntil === undefined ? "" : ` until=${key.cooldownUntil}`}`).join(", ");
		lines.push(`${provider.providerId}: ${provider.status}${providerCooldown}; ${keys}`);
	}
	lines.push(`visited providers: ${snapshot.visitedProviders.join(", ") || "none"}`);
	lines.push(`visited keys: ${snapshot.visitedKeys.map((key) => `${key.providerId}:${key.keySlot}`).join(", ") || "none"}`);
	return lines.join("\n");
}
