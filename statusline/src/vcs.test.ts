import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let spawnCalls = 0;
const spawnCwds: string[] = [];

mock.module("node:child_process", () => ({
	spawnSync: () => ({}),
	spawn: (_cmd: string, _args: string[], options: { cwd?: string }) => {
		spawnCalls++;
		if (options.cwd) spawnCwds.push(options.cwd);
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			pid: number;
			exitCode: number | null;
			signalCode: NodeJS.Signals | null;
			kill: () => boolean;
		};
		proc.stdout = new EventEmitter();
		proc.pid = 10_000 + spawnCalls;
		proc.exitCode = null;
		proc.signalCode = null;
		proc.kill = () => true;
		queueMicrotask(() => {
			proc.exitCode = 1;
			proc.emit("close", 1);
		});
		return proc;
	},
}));

const { getVcsStatus, invalidateVcs, invalidateVcsForRepoCreation, setVcsUpdateCallback } = await import("./vcs.ts");
const tempDir = mkdtempSync(join(tmpdir(), "statusline-vcs-"));
const repoDir = join(tempDir, "repo");
const secondRepoDir = join(tempDir, "repo-two");
const initializedLaterDir = join(tempDir, "initialized-later");
mkdirSync(join(repoDir, ".git"), { recursive: true });
mkdirSync(join(secondRepoDir, ".git"), { recursive: true });

afterAll(() => {
	setVcsUpdateCallback(null);
	rmSync(tempDir, { recursive: true, force: true });
});

test("caches a failed VCS lookup until invalidated", async () => {
	let updates = 0;
	let resolveFirst!: () => void;
	const firstUpdate = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	setVcsUpdateCallback(() => {
		updates++;
		// Simulate one render requested by the real statusline callback.
		if (updates === 1) getVcsStatus(repoDir);
		resolveFirst();
	});

	expect(getVcsStatus(repoDir)).toBeNull();
	await firstUpdate;

	expect(updates).toBe(1);
	expect(spawnCalls).toBe(1);

	invalidateVcs();
	const secondUpdate = new Promise<void>((resolve) => {
		setVcsUpdateCallback(() => resolve());
	});
	expect(getVcsStatus(repoDir)).toBeNull();
	await secondUpdate;

	expect(spawnCalls).toBe(2);
	expect(spawnCwds).toEqual([repoDir, repoDir]);
});

test("retries a missing repository while a user init command may be running", async () => {
	mkdirSync(initializedLaterDir, { recursive: true });
	invalidateVcsForRepoCreation();

	// A render during command execution observes no repository.
	expect(getVcsStatus(initializedLaterDir)).toBeNull();
	const before = spawnCalls;

	// The completion render must not reuse that negative lookup.
	mkdirSync(join(initializedLaterDir, ".git"));
	const updated = new Promise<void>((resolve) => setVcsUpdateCallback(resolve));
	expect(getVcsStatus(initializedLaterDir)).toBeNull();
	await updated;

	expect(spawnCalls - before).toBe(1);
	expect(spawnCwds.at(-1)).toBe(initializedLaterDir);
});

test("runs VCS commands in the detected root and does not reuse another repo's cache", async () => {
	invalidateVcs();
	const before = spawnCalls;

	async function lookup(cwd: string): Promise<void> {
		await new Promise<void>((resolve) => {
			setVcsUpdateCallback(resolve);
			expect(getVcsStatus(cwd)).toBeNull();
		});
	}

	await lookup(repoDir);
	await lookup(secondRepoDir);

	expect(spawnCalls - before).toBe(2);
	expect(spawnCwds.slice(-2)).toEqual([repoDir, secondRepoDir]);
});
