/**
 * Run with: bun test nushell   (needs `nu` in PATH; skipped otherwise)
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { hasOpaqueCommand, NU_VALUE, nuPipelines, OPAQUE_HEAD } from "./ast.ts";
import { tokenize } from "./gate.ts";

const hasNu = (() => {
	try { execFileSync("nu", ["--version"]); return true; } catch { return false; }
})();

const pipes = async (script: string) => nuPipelines(script, await tokenize(script));

describe.skipIf(!hasNu)("nuPipelines", () => {
	test("built-in command with flags and args", async () => {
		expect(await pipes("rm -rf foo")).toEqual([[["rm", "-rf", "-rf", "foo"]]]);
	});

	test("statements split on ; and newline, pipes join", async () => {
		expect(await pipes("ls | length; echo a\necho b")).toEqual([
			[["ls"], ["length"]],
			[["echo", "a"]],
			[["echo", "b"]],
		]);
	});

	test("externals inside closures and subexpressions are found", async () => {
		const p = await pipes('ls | each {|f| ^rm -rf $f.name }; let x = (git push --force o main)');
		expect(p).toContainEqual([["rm", "-rf", "$f", "name"]]);
		expect(p).toContainEqual([["git", "push", "--force", "o", "main"]]);
		expect(p).toContainEqual([["ls"], ["each", "{...}"]]);
	});

	test("if/else and def bodies", async () => {
		const p = await pipes("def f [] { rm y }; if true { mv a b } else { cp a b }");
		expect(p).toContainEqual([["rm", "y"]]);
		expect(p).toContainEqual([["mv", "a", "b"]]);
		expect(p).toContainEqual([["cp", "a", "b"]]);
	});

	test("quoted strings are unquoted so nested sh scripts can be recursed", async () => {
		expect(await pipes(`bash -c "sudo id" o> f`)).toEqual([[["bash", "-c", "sudo id"]]]);
	});

	test("run-external exposes the wrapped argv", async () => {
		expect(await pipes("run-external rm q")).toEqual([[["run-external", "rm", "q"], ["rm", "q"]]]);
	});

	test("unresolvable head is opaque", async () => {
		const p = await pipes("let cmd = 'x'; ^$cmd arg");
		expect(p).toEqual([[["let", "x"]], [[OPAQUE_HEAD, "arg"]]]);
		expect(hasOpaqueCommand(p)).toBe(true);
		for (const s of ['^$"r("m")" x', "ls | ^ $in"]) {
			expect({ s, opaque: hasOpaqueCommand(await pipes(s)) }).toEqual({ s, opaque: true });
		}
		expect(hasOpaqueCommand(await pipes("^git status; echo $env.PWD; [1] | each {|x| echo $x }"))).toBe(false);
	});

	test("spans are byte offsets: non-ASCII before a `;` must not hide the next command", async () => {
		expect(await pipes('echo "ää€"; sudo id')).toEqual([[["echo", "ää€"]], [["sudo", "id"]]]);
	});

	test("a pipe across a newline is one pipeline", async () => {
		expect(await pipes("curl x\n| bash")).toEqual([[["curl", "x"], ["bash"]]]);
		expect(await pipes("curl x |\nbash")).toEqual([[["curl", "x"], ["bash"]]]);
	});

	test("stderr pipe redirect `e>|` has no target to skip", async () => {
		expect(await pipes("foo e>| sudo id")).toEqual([[["foo"], ["sudo", "id"]]]);
		expect(await pipes("ls out> /dev/null | sudo id")).toEqual([[["ls"], ["sudo", "id"]]]);
	});

	test("a `^` inside a comment does not make the next command opaque", async () => {
		expect(await pipes("# see ^\nls")).toEqual([[["ls"]]]);
	});

	test("string interpolation is one opaque word, its subexpressions are still collected", async () => {
		const p = await pipes('^bash -c $"sudo (id) x"');
		expect(p).toContainEqual([["bash", "-c", "${nu}"]]);
		expect(p).toContainEqual([["id"]]);
	});

	test("single-token closures do not open a frame that never closes", async () => {
		expect(await pipes("each {|| }; ls | length")).toEqual([[["each", "{...}"]], [["ls"], ["length"]]]);
		expect(await pipes("do {}; ^sudo id")).toEqual([[["do", "{...}"]], [["sudo", "id"]]]);
	});

	test("quoted external names are unquoted", async () => {
		expect(await pipes("`sudo` id")).toEqual([[["sudo", "id"]]]);
		expect(await pipes("^'sudo' id")).toEqual([[["sudo", "id"]]]);
		expect(await pipes(`^"my tool" x`)).toEqual([[["my tool", "x"]]]);
	});

	test("a bare value is a pipeline stage feeding stdin", async () => {
		expect(await pipes("[a b] | each { touch $in }")).toEqual([
			[["touch", "$in"]],
			[[NU_VALUE, "a", "b"], ["each", "{...}"]],
		]);
		expect(await pipes("'sudo id' | ^sh")).toEqual([[[NU_VALUE, "sudo id"], ["sh"]]]);
	});
});
