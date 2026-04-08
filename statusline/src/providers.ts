/**
 * Usage data fetching for Anthropic and Codex.
 * Self-contained — no pi-sub-core dependency.
 * Uses shared file-based cache so multiple pi instances don't all hit the API.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";
import type { UsageSnapshot, RateWindow, ProviderName } from "./types.js";
import { fetchWithCache, getCached, isRateLimited, setRateLimited, writeCachedUsage } from "./cache.js";

/**
 * Resolver for live API keys from pi's model registry.
 * Set by the extension on session_start so providers use
 * the auto-refreshed OAuth token instead of the stale auth.json.
 */
let apiKeyResolver: ((provider: string) => Promise<string | undefined>) | undefined;

// ── Config ───────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_S = 60;
const CACHE_TTL_MS = REFRESH_INTERVAL_S * 1000;

export function resetRateLimit(): void {
	// Clear the shared file-based backoff so next fetch goes through
	setRateLimited(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): any | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

function piAuthPath(): string {
	return path.join(homedir(), ".pi", "agent", "auth.json");
}

function timeoutFetch(url: string, init: RequestInit, ms = API_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchHttpWithRetry(url: string, init: RequestInit): Promise<Response> {
	// Skip if ANY pi instance is in a backoff window (shared via cache file)
	if (isRateLimited()) {
		return new Response('{"error":{"type":"rate_limit","message":"Backing off"}}', { status: 429 });
	}

	const res = await timeoutFetch(url, init);
	if (res.status === 429) {
		// Back off for 15 minutes — written to cache file so all instances respect it
		setRateLimited(15 * 60 * 1000);
	}
	return res;
}

function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";
	const mins = Math.floor(diffMs / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function emptySnapshot(provider: ProviderName, displayName: string, error?: string): UsageSnapshot {
	return {
		provider,
		displayName,
		windows: [],
		error: error ? { code: "FETCH_FAILED", message: error } : undefined,
	};
}

// ── Provider detection ───────────────────────────────────────────────────

const DETECTION: Array<{ provider: ProviderName; providerTokens: string[]; modelTokens: string[] }> = [
	{ provider: "anthropic", providerTokens: ["anthropic"], modelTokens: ["claude"] },
	{ provider: "codex", providerTokens: ["openai", "codex"], modelTokens: ["gpt", "o1", "o3", "codex"] },
];

export function setApiKeyResolver(resolver: (provider: string) => Promise<string | undefined>): void {
	apiKeyResolver = resolver;
}

export function detectProvider(model: { provider?: string; id?: string } | undefined): ProviderName | undefined {
	if (!model) return undefined;
	const p = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();

	for (const d of DETECTION) {
		if (d.providerTokens.some((t) => p.includes(t))) return d.provider;
	}
	for (const d of DETECTION) {
		if (d.modelTokens.some((t) => id.includes(t))) return d.provider;
	}
	return undefined;
}

// ── Anthropic ────────────────────────────────────────────────────────────

async function loadAnthropicToken(): Promise<string | undefined> {
	// Prefer live token from pi's model registry (auto-refreshed OAuth)
	if (apiKeyResolver) {
		const key = await apiKeyResolver("anthropic");
		if (key) return key;
	}
	// Fallback to auth.json (may be stale)
	const auth = readJsonFile(piAuthPath());
	if (auth?.anthropic?.access) return auth.anthropic.access;
	return undefined;
}

async function fetchAnthropicDirect(): Promise<UsageSnapshot> {
	const token = await loadAnthropicToken();
	if (!token) return emptySnapshot("anthropic", "Claude Plan", "No credentials");

	try {
		const res = await fetchHttpWithRetry("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
		});

		if (!res.ok) {
			return emptySnapshot("anthropic", "Claude Plan", `HTTP ${res.status}`);
		}

		const data = (await res.json()) as {
			five_hour?: { utilization?: number; resets_at?: string };
			seven_day?: { utilization?: number; resets_at?: string };
			extra_usage?: { is_enabled?: boolean; used_credits?: number; monthly_limit?: number; utilization?: number };
		};

		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			const resetAt = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization,
				resetDescription: resetAt ? formatReset(resetAt) : undefined,
				resetAt: resetAt?.toISOString(),
			});
		}

		if (data.seven_day?.utilization !== undefined) {
			const resetAt = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
			windows.push({
				label: "Week",
				usedPercent: data.seven_day.utilization,
				resetDescription: resetAt ? formatReset(resetAt) : undefined,
				resetAt: resetAt?.toISOString(),
			});
		}

		if (data.extra_usage?.is_enabled) {
			const extra = data.extra_usage;
			const fiveHour = data.five_hour?.utilization ?? 0;
			const status = fiveHour >= 99 ? "active" : "on";
			const used = ((extra.used_credits ?? 0) / 100).toFixed(2);
			const limit = extra.monthly_limit ? `/${(extra.monthly_limit / 100).toFixed(2)}` : "";
			windows.push({
				label: `Extra [${status}] $${used}${limit}`,
				usedPercent: extra.utilization ?? 0,
			});
		}

		return { provider: "anthropic", displayName: "Claude Plan", windows };
	} catch {
		return emptySnapshot("anthropic", "Claude Plan", "Fetch failed");
	}
}

// ── Codex ────────────────────────────────────────────────────────────────

async function loadCodexCredentials(): Promise<{ accessToken?: string; accountId?: string }> {
	// Prefer live token from pi's model registry
	if (apiKeyResolver) {
		const key = await apiKeyResolver("openai-codex");
		if (key) return { accessToken: key };
	}

	const auth = readJsonFile(piAuthPath());
	if (auth?.["openai-codex"]?.access) {
		return { accessToken: auth["openai-codex"].access, accountId: auth["openai-codex"].accountId };
	}

	const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
	const codexAuth = readJsonFile(path.join(codexHome, "auth.json"));
	if (codexAuth?.OPENAI_API_KEY) return { accessToken: codexAuth.OPENAI_API_KEY };
	if (codexAuth?.tokens?.access_token) {
		return { accessToken: codexAuth.tokens.access_token, accountId: codexAuth.tokens.account_id };
	}
	return {};
}

async function fetchCodexDirect(): Promise<UsageSnapshot> {
	const { accessToken, accountId } = await loadCodexCredentials();
	if (!accessToken) return emptySnapshot("codex", "Codex Plan", "No credentials");

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		const res = await fetchHttpWithRetry("https://chatgpt.com/backend-api/wham/usage", { headers });
		if (!res.ok) return emptySnapshot("codex", "Codex Plan", `HTTP ${res.status}`);

		const data = (await res.json()) as {
			rate_limit?: {
				primary_window?: { reset_at?: number; limit_window_seconds?: number; used_percent?: number };
				secondary_window?: { reset_at?: number; limit_window_seconds?: number; used_percent?: number };
			};
		};

		const windows: RateWindow[] = [];

		if (data.rate_limit?.primary_window) {
			const pw = data.rate_limit.primary_window;
			const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
			const hours = Math.round((pw.limit_window_seconds ?? 10800) / 3600);
			windows.push({
				label: `${hours}h`,
				usedPercent: pw.used_percent ?? 0,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetAt: resetDate?.toISOString(),
			});
		}

		if (data.rate_limit?.secondary_window) {
			const sw = data.rate_limit.secondary_window;
			const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
			const hours = Math.round((sw.limit_window_seconds ?? 86400) / 3600);
			const label = hours >= 144 ? "Week" : hours >= 24 ? "Day" : `${hours}h`;
			windows.push({
				label,
				usedPercent: sw.used_percent ?? 0,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetAt: resetDate?.toISOString(),
			});
		}

		return { provider: "codex", displayName: "Codex Plan", windows };
	} catch {
		return emptySnapshot("codex", "Codex Plan", "Fetch failed");
	}
}

// ── Dispatch (cache-aware) ───────────────────────────────────────────────

const DIRECT_FETCHERS: Partial<Record<ProviderName, () => Promise<UsageSnapshot>>> = {
	anthropic: fetchAnthropicDirect,
	codex: fetchCodexDirect,
};

/**
 * Fetch usage through the shared file cache.
 * Only one pi instance will actually call the API per refresh interval.
 */
export function fetchUsage(provider: ProviderName): Promise<UsageSnapshot> | undefined {
	const fetcher = DIRECT_FETCHERS[provider];
	if (!fetcher) return undefined;
	return fetchWithCache(provider, CACHE_TTL_MS, fetcher);
}

/** Fetch directly, bypassing cache and rate limit. For manual /statusline refresh. */
export function fetchUsageDirect(provider: ProviderName): Promise<UsageSnapshot> | undefined {
	return DIRECT_FETCHERS[provider]?.();
}

// ── Refresh controller ───────────────────────────────────────────────────

export interface UsageController {
	current(): UsageSnapshot | undefined;
	refresh(provider: ProviderName): Promise<UsageSnapshot | undefined>;
	/** Force fetch bypassing cache and rate limit. For manual /statusline refresh. */
	forceRefresh(provider: ProviderName): Promise<UsageSnapshot | undefined>;
	start(getProvider: () => ProviderName | undefined): void;
	stop(): void;
}

export function createUsageController(onUpdate: (usage: UsageSnapshot | undefined) => void): UsageController {
	let cached: UsageSnapshot | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastFetchAt = 0;

	async function doRefresh(provider: ProviderName): Promise<UsageSnapshot | undefined> {
		const promise = fetchUsage(provider);
		if (!promise) {
			cached = undefined;
			onUpdate(undefined);
			return undefined;
		}
		const result = await promise;
		lastFetchAt = Date.now();
		if (result.windows.length > 0) {
			cached = result;
		} else if (cached?.provider !== provider) {
			cached = undefined;
		}
		onUpdate(cached);
		return cached;
	}

	return {
		current() {
			return cached;
		},

		async refresh(provider) {
			const fileCached = getCached(provider, CACHE_TTL_MS);
			if (fileCached && fileCached.windows.length > 0) {
				cached = fileCached;
				onUpdate(cached);
				return cached;
			}
			return doRefresh(provider);
		},

		async forceRefresh(provider) {
			const promise = fetchUsageDirect(provider);
			if (!promise) return undefined;
			const result = await promise;
			lastFetchAt = Date.now();
			if (result.windows.length > 0) {
				cached = result;
				writeCachedUsage(provider, result);
			}
			onUpdate(cached);
			return result;
		},

		start(getProvider) {
			if (timer) clearInterval(timer);
			const tickMs = Math.min(REFRESH_INTERVAL_S * 1000, 10_000);
			timer = setInterval(() => {
				const p = getProvider();
				if (!p) return;
				const elapsed = Date.now() - lastFetchAt;
				if (elapsed >= REFRESH_INTERVAL_S * 1000) {
					void doRefresh(p);
				}
			}, tickMs);
		},

		stop() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			cached = undefined;
			lastFetchAt = 0;
		},
	};
}
