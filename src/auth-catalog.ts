import * as fs from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AuthProviderEntry {
	provider: string;
	type: "api_key" | "oauth";
	backupKeys?: string[];
}

export interface AuthCatalogDiagnostic {
	message: string;
	provider?: string;
	field?: "key-backup";
}

export interface AuthCatalog {
	enabled: boolean;
	providers: AuthProviderEntry[];
	diagnostics: AuthCatalogDiagnostic[];
}

interface LoadAuthCatalogOptions {
	authPath?: string;
}

type AuthCredential = Record<string, unknown>;

export function loadAuthCatalog(options: LoadAuthCatalogOptions = {}): AuthCatalog {
	const authPath = options.authPath ?? join(getAgentDir(), "auth.json");
	let parsed: unknown;

	try {
		parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// Pi can have configured custom providers without stored credentials.
			return { enabled: true, providers: [], diagnostics: [] };
		}
		return disabledCatalog(error instanceof SyntaxError ? "Could not parse auth.json" : "Could not read auth.json");
	}

	if (!isRecord(parsed)) {
		return disabledCatalog("Expected auth.json to contain an object");
	}

	const providers: AuthProviderEntry[] = [];
	const diagnostics: AuthCatalogDiagnostic[] = [];

	for (const [provider, credential] of Object.entries(parsed)) {
		if (!isRecord(credential)) continue;

		if (isApiKeyCredential(credential)) {
			const entry: AuthProviderEntry = { provider, type: "api_key" };
			const backup = credential["key-backup"];
			const backupKeys = normalizeBackupKeys(backup);
			if (backupKeys) {
				entry.backupKeys = backupKeys;
			} else if (backup !== undefined) {
				diagnostics.push({ provider, field: "key-backup", message: "Ignored invalid key-backup" });
			}
			providers.push(entry);
			continue;
		}

		if (isOAuthCredential(credential)) {
			providers.push({ provider, type: "oauth" });
		}
	}

	return { enabled: true, providers, diagnostics };
}

export interface RuntimeProviderCatalog {
	getAvailable(): readonly { provider: string; api?: string }[];
	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string };
	getRegisteredProviderIds?(): readonly string[];
}

/** Append Pi-configured custom providers without copying their credentials. */
export function withRuntimeProviders(catalog: AuthCatalog, registry: RuntimeProviderCatalog): AuthCatalog {
	if (!catalog.enabled) return catalog;
	const providers = [...catalog.providers];
	const seen = new Set(providers.map((entry) => entry.provider));
	const registered = new Set(registry.getRegisteredProviderIds?.() ?? []);
	for (const model of registry.getAvailable()) {
		if (model.api === "pi-virtual" || seen.has(model.provider)) continue;
		const status = registry.getProviderAuthStatus(model.provider);
		if (!status.configured) continue;
		const custom = registered.has(model.provider) ||
			status.source === "models_json_key" || status.source === "models_json_command" || status.source === "fallback";
		if (!custom) continue;
		providers.push({ provider: model.provider, type: "api_key" });
		seen.add(model.provider);
	}
	return { ...catalog, providers };
}

function normalizeBackupKeys(value: unknown): string[] | undefined {
	if (isLiteralBackupKey(value)) return [value];
	if (!Array.isArray(value) || value.length === 0) return undefined;
	return value.every(isLiteralBackupKey) ? value : undefined;
}

function isLiteralBackupKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.startsWith("!") && !/\$(?:\{|[A-Za-z_])/.test(value);
}

function disabledCatalog(message: string): AuthCatalog {
	return { enabled: false, providers: [], diagnostics: [{ message }] };
}

function isRecord(value: unknown): value is AuthCredential {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiKeyCredential(value: AuthCredential): boolean {
	const validKey = value.key === undefined || typeof value.key === "string";
	const validEnv =
		value.env === undefined ||
		(isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
	return value.type === "api_key" && validKey && validEnv;
}

function isOAuthCredential(value: AuthCredential): boolean {
	return (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}
