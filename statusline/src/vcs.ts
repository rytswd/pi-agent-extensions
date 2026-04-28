/**
 * VCS status detection for git and jj.
 *
 * jj is preferred over git: jj repos colocate a .git directory but
 * not vice versa.
 *
 * Repo kind and binary availability are cached. Status fetched lazily
 * on first request and refetched only after invalidateVcs().
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VcsKind, VcsStatus } from "./types.js";

const binAvailable: Partial<Record<VcsKind, boolean>> = {};

function hasBinary(name: VcsKind): boolean {
	const cached = binAvailable[name];
	if (cached !== undefined) return cached;
	const r = spawnSync(name, ["--version"], { stdio: "ignore" });
	const ok = !r.error || (r.error as NodeJS.ErrnoException).code !== "ENOENT";
	binAvailable[name] = ok;
	return ok;
}

const kindByCwd = new Map<string, VcsKind | null>();

function detectKind(cwd: string): VcsKind | null {
	if (kindByCwd.has(cwd)) return kindByCwd.get(cwd)!;
	let kind: VcsKind | null = null;
	// Walk up to find a repo root. jj repos colocate .git so check .jj first.
	let dir = cwd;
	while (true) {
		if (existsSync(join(dir, ".jj")) && hasBinary("jj")) {
			kind = "jj";
			break;
		}
		if (existsSync(join(dir, ".git")) && hasBinary("git")) {
			kind = "git";
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	kindByCwd.set(cwd, kind);
	return kind;
}

let cachedStatus: VcsStatus | null = null;
let inflight = false;
let seq = 0;
let onUpdate: (() => void) | null = null;

export function setVcsUpdateCallback(cb: (() => void) | null): void {
	onUpdate = cb;
}

export function invalidateVcs(): void {
	cachedStatus = null;
	seq++;
}

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
	const bookmarks = (bookmarksStr ?? "").split(",").filter(Boolean);
	const head = bookmarks[0] ?? changeId ?? null;

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

async function fetchVcsStatus(cwd: string): Promise<VcsStatus | null> {
	const kind = detectKind(cwd);
	if (!kind) return null;
	return kind === "jj" ? fetchJj() : fetchGit();
}

/**
 * Get cached VCS status. Triggers a fetch only on first call or after
 * invalidateVcs(). Renders never block — they read whatever is cached.
 */
export function getVcsStatus(cwd: string): VcsStatus | null {
	if (detectKind(cwd) === null) return null;
	if (cachedStatus === null && !inflight) {
		inflight = true;
		const mySeq = seq;
		void fetchVcsStatus(cwd).then((result) => {
			inflight = false;
			if (mySeq !== seq) return;
			cachedStatus = result;
			onUpdate?.();
		});
	}
	return cachedStatus;
}
