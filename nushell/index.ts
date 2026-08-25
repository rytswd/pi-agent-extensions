/**
 * Replaces the `bash` tool's interpreter with Nushell and gates it with
 * permission-gate's rules, parsed by nu itself (gate.ts). Supersedes the
 * permission-gate extension (same /gate command, config and rules); load
 * one or the other. Without `nu` in PATH it degrades to plain
 * permission-gate over the built-in bash tool.
 *
 * `$XDG_CONFIG_HOME/nushell/pi.nu` is sourced before every script if it exists.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import permissionGate, { createGate } from "../permission-gate/index.ts";
import { analyzeNu } from "./gate.ts";

export default function (pi: ExtensionAPI) {
	let nu: string;
	try {
		nu = execFileSync("which", ["nu"], { encoding: "utf8" }).trim();
	} catch {
		return permissionGate(pi);
	}
	createGate(pi, analyzeNu(nu));

	// There is no tty: nu would draw box tables clipped to 80 columns with
	// "..." cells. Light borders, no index column and a wide render keep
	// output complete and cheap in tokens. pi.nu may override.
	const prefix = [
		'$env.config.table.mode = "light"',
		'$env.config.table.index_mode = "never"',
		"$env.config.footer_mode = \"never\"",
		"$env.config.hooks.display_output = { table --expand --width 200 }",
	];
	const rc = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nushell", "pi.nu");
	if (existsSync(rc)) prefix.push(`source ${JSON.stringify(rc)}`);
	const bash = createBashTool(process.cwd(), { shellPath: nu, commandPrefix: prefix.join("; ") });
	pi.registerTool({
		...bash,
		label: "nushell",
		description:
			"Execute a Nushell (nu) script in the current working directory — this tool runs nu, NOT bash/POSIX sh. " +
			"Returns stdout and stderr, truncated to the last 2000 lines or 50KB. Optional timeout in seconds.",
		promptSnippet: "Run Nushell scripts (nu syntax, not POSIX sh)",
		promptGuidelines: [
			"bash tool runs Nushell: no `&&`, `$(...)`, `>`, `export` or heredocs; use `;`, `(...)`, `| save file`, `$env.FOO = bar`. External commands work as usual; prefix with `^` when a nu built-in shadows them (`^ls`, `^rm`).",
			"bash tool runs Nushell: only the *last* expression's value is shown; use `print` (or `| print`) for intermediate results — `ls; open x.json` shows just the json.",
			"bash tool runs Nushell: prefer structured pipelines over text munging (`open x.json | get a.b`, `ls | where size > 1mb`, `| to json`), nuon for data files.",
			"bash tool runs Nushell: when rewriting a file you read from, `collect` first: `open f.nuon | where x > 1 | collect | save -f f.nuon`.",
		],
	});
}
