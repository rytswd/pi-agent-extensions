/**
 * permission-gate with the nu analyzer applies the built-in rules to nu scripts,
 * headless (prompt rules hard-block). Run with: bun test nushell (needs nu)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGate } from "../permission-gate/index.ts";
import { analyzeNu } from "./gate.ts";

const hasNu = (() => {
	try { execFileSync("nu", ["--version"]); return true; } catch { return false; }
})();

describe.skipIf(!hasNu)("nushell gate (headless)", () => {
	const env = { ...process.env };
	let xdg: string;
	let run: (command: string, toolName?: string) => Promise<unknown>;

	beforeAll(async () => {
		delete process.env.PI_NO_GATE;
		process.env.XDG_CONFIG_HOME = xdg = fs.mkdtempSync(path.join(os.tmpdir(), "nugate-"));
		const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createGate({ on: (n: string, fn: any) => { handlers[n] = fn; }, events: { on: () => () => {}, emit() {} }, registerCommand() {} } as any, analyzeNu("nu"));
		const ctx = { hasUI: false, cwd: xdg };
		await handlers.session_start({}, ctx);
		run = (command, toolName = "bash") => handlers.tool_call({ toolName, input: { command } }, ctx);
	});
	afterAll(() => {
		process.env = env;
		fs.rmSync(xdg, { recursive: true, force: true });
	});

	const blocked = (s: string | RegExp) => ({ block: true, reason: typeof s === "string" ? expect.stringContaining(s) : expect.stringMatching(s) });

	test("harmless script passes", async () => {
		expect(await run("ls | where size > 1kb | get name | to nuon")).toBeUndefined();
	});
	test("ignores other tools", async () => {
		expect(await run("sudo id", "nushell")).toBeUndefined();
	});
	test("built-in rm -r fires the recursive delete rule", async () => {
		expect(await run("rm -r build")).toEqual(blocked("recursive"));
	});
	test("external inside closure is seen", async () => {
		expect(await run("ls | each {|f| ^sudo rm $f.name }")).toEqual(blocked("sudo"));
	});
	test("sh -c strings recurse into the POSIX parser", async () => {
		expect(await run(`bash -c "git push --force origin main"`)).toEqual(blocked(/force/i));
	});
	test("nu -c strings recurse into the nu parser", async () => {
		expect(await run(`nu -c 'ls | each { ^sudo id }'`)).toEqual(blocked("sudo"));
	});
	test("nu -c=/--commands= forms recurse too", async () => {
		expect(await run(`^nu -c='^sudo id'`)).toEqual(blocked("sudo"));
		expect(await run(`^nu --commands "^sudo id"`)).toEqual(blocked("sudo"));
	});
	test("string piped into a bare shell", async () => {
		expect(await run("'sudo id' | ^sh")).toEqual(blocked("stdin"));
		expect(await run("[1 2] | each { $in + 1 } | to json | ^jq .")).toBeUndefined();
	});
	test("runtime-built command name is unverified", async () => {
		expect(await run("let c = 'rm'; ^$c -rf /")).toEqual(blocked("unverified"));
	});
	test("interpolated sh -c script is a non-literal command", async () => {
		expect(await run('^bash -c $"sudo (id)"')).toEqual(blocked("non-literal"));
	});
	test("save to a raw device maps onto the device-write rule", async () => {
		expect(await run("open --raw img | save -f /dev/sda")).toEqual(blocked(/device/i));
	});
	test("parse errors are unverified", async () => {
		expect(await run("ls | each {|| ")).toEqual(blocked("nu parse failed"));
	});
});
