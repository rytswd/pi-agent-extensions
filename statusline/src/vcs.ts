/**
 * VCS status detection — supports both git and jj.
 *
 * jj is preferred when a .jj directory exists because it is the
 * higher-level VCS; jj repos always colocate a .git directory but
 * the reverse is not true.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VcsKind, VcsStatus } from "./types.js";

// ── Cache ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 1000;

let cachedStatus: (VcsStatus & { ts: number }) | null = null;
let pending: Promise<VcsStatus | null> | null = null;
let invalidationSeq = 0;

export function invalidateVcs(): void {
	cachedStatus = null;
	invalidationSeq++;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 300): Promise<string | null> {
	return new Promise((resolve) => {
		let stdout = "";
		let resolved = false;
		const finish = (r: string | null) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			resolve(r);
		};
		const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
		proc.on("error", () => finish(null));
		const timer = setTimeout(() => {
			proc.kill();
			finish(null);
		}, timeoutMs);
	});
}

// ── jj ───────────────────────────────────────────────────────────────────

async function fetchJj(): Promise<VcsStatus | null> {
	// Get the current change-id (short) + description + bookmarks
	const logLine = await run("jj", [
		"log",
		"--no-graph",
		"--limit",
		"1",
		"-T",
		'change_id.shortest() ++ "\\x00" ++ bookmarks.join(",") ++ "\\x00" ++ description.first_line()',
	]);
	if (logLine === null) return null;

	const [changeId, bookmarksStr, _desc] = logLine.split("\0");
	// Use first bookmark if available, otherwise the short change-id
	const bookmarks = (bookmarksStr ?? "").split(",").filter(Boolean);
	const head = bookmarks[0] ?? changeId ?? null;

	// Get file change counts from jj status
	const status = await run("jj", ["diff", "--summary"], 500);
	let modified = 0;
	let added = 0;
	let removed = 0;
	if (status) {
		for (const line of status.split("\n")) {
			if (!line) continue;
			const code = line[0];
			if (code === "M") modified++;
			else if (code === "A" || code === "C") added++;
			else if (code === "D") removed++;
		}
	}

	return { kind: "jj", head, modified, added, removed };
}

// ── git ──────────────────────────────────────────────────────────────────

async function fetchGit(): Promise<VcsStatus | null> {
	const branch = await run("git", ["branch", "--show-current"]);
	if (branch === null) return null;

	let head = branch;
	if (!head) {
		const sha = await run("git", ["rev-parse", "--short", "HEAD"]);
		head = sha ? `${sha} (detached)` : "detached";
	}

	const porcelain = await run("git", ["status", "--porcelain"], 500);
	let modified = 0;
	let added = 0;
	let removed = 0;
	if (porcelain) {
		for (const line of porcelain.split("\n")) {
			if (!line) continue;
			const x = line[0];
			const y = line[1];
			if (x === "?" && y === "?") {
				added++;
				continue;
			}
			if (x === "D" || y === "D") removed++;
			else if (x === "A") added++;
			else if (x !== " " || y !== " ") modified++;
		}
	}

	return { kind: "git", head, modified, added, removed };
}

// ── Detect & dispatch ────────────────────────────────────────────────────

function detectKind(cwd: string): VcsKind | null {
	// jj repos colocate .git so check .jj first
	if (existsSync(join(cwd, ".jj"))) return "jj";
	if (existsSync(join(cwd, ".git"))) return "git";
	return null;
}

async function fetchVcsStatus(cwd: string): Promise<VcsStatus | null> {
	const kind = detectKind(cwd);
	if (!kind) return null;
	return kind === "jj" ? fetchJj() : fetchGit();
}

/**
 * Get VCS status. Returns cached value immediately, refreshes in background
 * when stale. Designed for synchronous render() calls.
 */
export function getVcsStatus(cwd: string): VcsStatus | null {
	const now = Date.now();
	if (cachedStatus && now - cachedStatus.ts < CACHE_TTL_MS) {
		return cachedStatus;
	}

	if (!pending) {
		const seq = invalidationSeq;
		pending = fetchVcsStatus(cwd).then((result) => {
			if (seq === invalidationSeq) {
				cachedStatus = result ? { ...result, ts: Date.now() } : null;
			}
			pending = null;
			return result;
		});
	}

	return cachedStatus;
}
