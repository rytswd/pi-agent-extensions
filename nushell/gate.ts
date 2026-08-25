/**
 * nushell — permission-gate analyzer backed by nu's own parser.
 *
 * Scripts handed on to another interpreter are followed: `sh -c '…'` (and
 * eval, find -exec, pueue add, …) into permission-gate's POSIX parser,
 * `nu -c '…'` back into this one.
 */

import { execFile } from "node:child_process";
import type { Analyze } from "../permission-gate/index.ts";
import type { ArgvPipeline } from "../permission-gate/types.ts";
import { collectPipelines, deferredScripts, nestedScripts, unwrap } from "../permission-gate/shell.ts";
import { type FlatToken, hasOpaqueCommand, nuPipelines, OPAQUE_HEAD } from "./ast.ts";

const MAX_DEPTH = 4;

// `ast --flatten` tokenizes even input nu would refuse to run, so the parse
// error is asked for separately. -n keeps user config out of the parser.
const TOKENIZE =
	"let s = $in; { error: (ast $s | get error | to nuon), tokens: (ast --flatten $s | select content shape span) } | to json -r";

/** nu's tokens for `script`. Rejects when nu is missing, hangs or reports a parse error. */
export function tokenize(script: string, nu = "nu"): Promise<FlatToken[]> {
	return new Promise((resolve, reject) => {
		const child = execFile(nu, ["-n", "--stdin", "-c", TOKENIZE], { timeout: 5_000, maxBuffer: 16 << 20 }, (err, stdout) => {
			if (err) return reject(err);
			try {
				const { error, tokens } = JSON.parse(stdout) as { error: string; tokens: FlatToken[] };
				if (error === '"None"') resolve(tokens);
				else reject(new Error(error.replace(/\s+/g, " ")));
			} catch (e) {
				reject(e);
			}
		});
		child.stdin?.end(script);
	});
}

/** X in `nu -c X`, `-c=X`, `--commands X`, `--commands=X`. */
function nuInlineScript(argv: string[]): string | undefined {
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "-c" || argv[i] === "--commands") return argv[i + 1];
		const joined = /^(?:-c|--commands)=(["'`]?)([\s\S]*)\1$/.exec(argv[i]);
		if (joined) return joined[2];
	}
	return undefined;
}

async function collect(script: string, nu: string, depth: number): Promise<ArgvPipeline[]> {
	if (depth > MAX_DEPTH) return [[[OPAQUE_HEAD]]];
	const own = nuPipelines(script, await tokenize(script, nu));
	const forwarded: ArgvPipeline[] = [];
	for (const argv of own.flat()) {
		const cmd = unwrap(argv);
		const isNu = cmd[0].split("/").pop() === "nu";
		const nuScript = isNu ? nuInlineScript(cmd) : undefined;
		if (nuScript !== undefined) {
			forwarded.push(...(await collect(nuScript, nu, depth + 1)));
		} else {
			for (const sh of [...nestedScripts(cmd), ...deferredScripts(cmd)]) forwarded.push(...collectPipelines(sh));
		}
	}
	return [...own, ...forwarded];
}

export const analyzeNu = (nu: string): Analyze => async (command) => {
	try {
		const pipelines = await collect(command, nu, 0);
		return { pipelines, unverified: hasOpaqueCommand(pipelines) ? "command name built at runtime" : undefined };
	} catch (err) {
		return { pipelines: [], unverified: `nu parse failed: ${(err as Error).message}` };
	}
};
