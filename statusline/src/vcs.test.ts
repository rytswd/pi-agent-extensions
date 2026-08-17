import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let spawnCalls = 0;

mock.module("node:child_process", () => ({
	spawnSync: () => ({}),
	spawn: () => {
		spawnCalls++;
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

const { getVcsStatus, invalidateVcs, setVcsUpdateCallback } = await import("./vcs.ts");
const tempDir = mkdtempSync(join(tmpdir(), "statusline-vcs-"));
const repoDir = join(tempDir, "repo");
mkdirSync(join(repoDir, ".git"), { recursive: true });

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
});
