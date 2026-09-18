import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStashFile, saveStashFile } from "./storage.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "stash-storage-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("atomically stores valid JSON with private file and directory modes", () => {
	const parent = tempRoot();
	const root = join(parent, "stash");
	const file = join(root, "sessions", "one.json");

	saveStashFile(file, ["first", "second"], root);

	expect(loadStashFile(file)).toEqual(["first", "second"]);
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(join(root, "sessions")).mode & 0o777).toBe(0o700);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readFileSync(file, "utf-8")).toBe('[\n  "first",\n  "second"\n]\n');
});

test("repairs modes on existing stash paths when saving", () => {
	const parent = tempRoot();
	const root = join(parent, "stash");
	const file = join(root, "global.json");

	saveStashFile(file, ["old"], root);
	chmodSync(root, 0o775);
	chmodSync(file, 0o664);
	saveStashFile(file, ["new"], root);

	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(loadStashFile(file)).toEqual(["new"]);
});

test("repairs modes on existing stash paths when loading", () => {
	const parent = tempRoot();
	const root = join(parent, "stash");
	const sessions = join(root, "sessions");
	const file = join(sessions, "one.json");

	saveStashFile(file, ["existing"], root);
	chmodSync(root, 0o775);
	chmodSync(sessions, 0o775);
	chmodSync(file, 0o664);

	expect(loadStashFile(file, root)).toEqual(["existing"]);
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(sessions).mode & 0o777).toBe(0o700);
	expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("rejects malformed stash data instead of treating it as empty", () => {
	const parent = tempRoot();
	const root = join(parent, "stash");
	const file = join(root, "global.json");
	saveStashFile(file, ["keep"], root);
	writeFileSync(file, '{"broken":true}\n');

	expect(() => loadStashFile(file)).toThrow("array of strings");
});
