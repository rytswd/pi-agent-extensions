/**
 * Shared file-based cache for usage data.
 * All pi instances read/write the same cache file so only one
 * instance needs to hit the API per refresh interval.
 *
 * Uses atomic write (write tmp + rename) and a simple lock file
 * to coordinate between processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { UsageSnapshot, ProviderName } from "./types.js";

// ── Paths ────────────────────────────────────────────────────────────────

function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return path.join(xdg || path.join(homedir(), ".config"), "pi-statusline");
}

function cachePath(): string {
	return path.join(configDir(), "cache.json");
}

function lockPath(): string {
	return path.join(configDir(), "cache.lock");
}

// ── Lock ─────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 10_000;

function tryAcquireLock(): boolean {
	try {
		const dir = configDir();
		fs.mkdirSync(dir, { recursive: true });
		const lp = lockPath();

		// Check for stale lock
		try {
			const stat = fs.statSync(lp);
			if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				fs.unlinkSync(lp);
			}
		} catch {
			// No lock file — good
		}

		fs.writeFileSync(lp, `${process.pid}`, { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

function releaseLock(): void {
	try {
		fs.unlinkSync(lockPath());
	} catch {
		// Ignore
	}
}

// ── Cache entries ────────────────────────────────────────────────────────

interface CacheEntry {
	fetchedAt: number;
	usage: UsageSnapshot;
}

interface CacheFile {
	_rateLimitedUntil?: number;
	[provider: string]: CacheEntry | number | undefined;
}

function readCacheFile(): CacheFile {
	try {
		const p = cachePath();
		if (!fs.existsSync(p)) return {};
		const content = fs.readFileSync(p, "utf-8");
		return JSON.parse(content) as CacheFile;
	} catch {
		return {};
	}
}

function writeCacheFile(cache: CacheFile): void {
	try {
		const dir = configDir();
		fs.mkdirSync(dir, { recursive: true });
		const tmp = cachePath() + `.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
		fs.renameSync(tmp, cachePath());
	} catch {
		// Best effort
	}
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Get cached usage if it's fresh enough (within ttlMs).
 * Returns undefined if stale or missing.
 */
export function getCached(provider: ProviderName, ttlMs: number): UsageSnapshot | undefined {
	const cache = readCacheFile();
	const entry = cache[provider] as CacheEntry | undefined;
	if (!entry || typeof entry !== "object") return undefined;
	if (Date.now() - entry.fetchedAt >= ttlMs) return undefined;
	return entry.usage;
}

/** Check if we're in a shared rate-limit backoff window. */
export function isRateLimited(): boolean {
	const cache = readCacheFile();
	const until = cache._rateLimitedUntil;
	if (typeof until !== "number") return false;
	return Date.now() < until;
}

/** Set shared rate-limit backoff (written to cache file so all instances respect it). */
export function setRateLimited(durationMs: number): void {
	const cache = readCacheFile();
	cache._rateLimitedUntil = Date.now() + durationMs;
	writeCacheFile(cache);
}

/**
 * Fetch usage, coordinating with other pi instances via file lock + cache.
 *
 * 1. Check cache — if fresh, return it (no API call)
 * 2. Try to acquire lock — if another process holds it, wait and re-check cache
 * 3. Fetch from API, write to cache, release lock
 */
export async function fetchWithCache(
	provider: ProviderName,
	ttlMs: number,
	fetchFn: () => Promise<UsageSnapshot>,
): Promise<UsageSnapshot> {
	// 1. Fresh cache?
	const cached = getCached(provider, ttlMs);
	if (cached) return cached;

	// 2. Try lock
	const gotLock = tryAcquireLock();
	if (!gotLock) {
		// Another process is fetching — wait a bit and check cache
		await new Promise((r) => setTimeout(r, 2000));
		const afterWait = getCached(provider, ttlMs);
		if (afterWait) return afterWait;
		// Still stale — fetch anyway (lock was probably stale)
	}

	try {
		const result = await fetchFn();

		// Write to shared cache if we got real data
		if (result.windows.length > 0) {
			const cache = readCacheFile();
			cache[provider] = { fetchedAt: Date.now(), usage: result };
			writeCacheFile(cache);
		}

		return result;
	} finally {
		if (gotLock) releaseLock();
	}
}
