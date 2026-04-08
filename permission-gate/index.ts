/**
 * permission-gate — confirm dangerous bash commands before they run.
 *
 * Matches bash commands against a configurable regex blocklist and shows
 * a Yes/No prompt. Selecting "No" opens an inline editor so you can tell
 * the assistant *why* the command was rejected — the reason is returned
 * as the block message.
 *
 * Config: ~/.config/pi-agent-extensions/permission-gate/rules.json
 *         (see .ref/config-dir.org for the directory convention)
 * Project: <cwd>/.pi/permission-gate.json (extra/disabled rules)
 *
 * Toggle: /gate
 * Env: PI_NO_GATE=1 to disable at startup
 *
 * Based on pi's built-in permission-gate example and
 * https://github.com/rytswd/pi-agent-extensions/pull/13 by Mic92.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────

interface RuleEntry {
	pattern: string;
	label: string;
	flags?: string;
}

/** On-disk format for rules.json and .pi/permission-gate.json */
interface RulesFile {
	/** Replace default rules entirely (default: append) */
	rules?: RuleEntry[];
	/** Extra rules appended to defaults */
	extraRules?: RuleEntry[];
	/** Disable specific rules by label */
	disabledRules?: string[];
}

interface CompiledRule {
	pattern: RegExp;
	label: string;
	source: "built-in" | "user" | "project";
}

type GateResult = { allow: true } | { allow: false; reason: string };

type WarnFn = (msg: string) => void;

const GATE_SUBCMDS = "list(ls)|add|remove(rm)";

// ── Default rules ────────────────────────────────────────────────────────

const DEFAULT_RULES: RuleEntry[] = [
	{ pattern: "\\brm\\s+(-[^\\s]*r|--recursive)", label: "recursive delete" },
	{ pattern: "\\bsudo\\b", label: "sudo" },
	{ pattern: "\\bchmod\\b.*777", label: "world-writable permissions" },
	{ pattern: ">\\s*/dev/[sh]d[a-z]", label: "raw device redirect" },
	{ pattern: "\\bgit\\s+push\\s+.*(-f\\b|--force\\b)", label: "force push" },
	{ pattern: "\\bgit\\s+reset\\s+--hard\\b", label: "hard reset" },
	{ pattern: "\\bgit\\s+clean\\s+-[^\\s]*f", label: "git clean" },
	{ pattern: "\\bgit\\s+checkout\\s+\\.\\s*($|[;&|])", label: "git checkout (discard all)" },
	{ pattern: "\\bgit\\s+restore\\b", label: "git restore" },
	{ pattern: "\\b(curl|wget)\\b.*\\|\\s*(ba)?sh\\b", label: "pipe to shell" },
	{ pattern: "\\bgh\\s+repo\\s+(create|delete|rename|archive)\\b", label: "modify GitHub repo" },
	{ pattern: "\\bgh\\s+release\\s+(create|delete|edit)\\b", label: "modify GitHub release" },
];

// ── Config ───────────────────────────────────────────────────────────────

/** Resolve config directory. See .ref/config-dir.org for convention. */
function configDir(): string {
	const override = path.join(homedir(), ".pi", "agent", "pi-agent-extensions.json");
	try {
		const cfg = JSON.parse(fs.readFileSync(override, "utf-8"));
		if (cfg.configDir) return path.join(cfg.configDir, "permission-gate");
	} catch {}
	const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	return path.join(base, "pi-agent-extensions", "permission-gate");
}

function rulesFilePath(): string {
	return path.join(configDir(), "rules.json");
}

function readJsonSafe(filePath: string, warn?: WarnFn): RulesFile {
	try {
		if (!fs.existsSync(filePath)) return {};
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (err) {
		warn?.(`permission-gate: failed to load ${filePath}: ${(err as Error).message}`);
		return {};
	}
}

function loadRules(cwd: string, warn?: WarnFn): { global: RulesFile; project: RulesFile } {
	return {
		global: readJsonSafe(rulesFilePath(), warn),
		project: readJsonSafe(path.join(cwd, ".pi", "permission-gate.json"), warn),
	};
}

function saveGlobalRules(cfg: RulesFile): void {
	try {
		const dir = configDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(rulesFilePath(), JSON.stringify(cfg, null, 2) + "\n");
	} catch {}
}

function compileRules(global: RulesFile, project: RulesFile, warn?: WarnFn): CompiledRule[] {
	const disabled = new Set([...(global.disabledRules ?? []), ...(project.disabledRules ?? [])]);
	const compiled: CompiledRule[] = [];
	let hadError = false;

	function add(entries: RuleEntry[], source: CompiledRule["source"]) {
		for (const r of entries) {
			if (disabled.has(r.label)) continue;
			try {
				compiled.push({ pattern: new RegExp(r.pattern, r.flags ?? "i"), label: r.label, source });
			} catch (err) {
				warn?.(`permission-gate: invalid regex for "${r.label}": ${(err as Error).message}`);
				hadError = true;
			}
		}
	}

	// Base rules: user override or built-in defaults
	add(global.rules ?? DEFAULT_RULES, global.rules ? "user" : "built-in");
	add(global.extraRules ?? [], "user");
	add(project.extraRules ?? [], "project");

	// Fallback: if everything failed, use defaults
	if (compiled.length === 0 && hadError) {
		warn?.("permission-gate: all rules failed, falling back to defaults");
		add(DEFAULT_RULES, "built-in");
	}

	return compiled;
}

// ── Review UI ────────────────────────────────────────────────────────────

async function showReviewPrompt(
	ctx: ExtensionContext,
	command: string,
	labels: string,
): Promise<GateResult> {
	return ctx.ui.custom<GateResult>((tui, theme, _kb, done) => {
		let optionIndex = 0;
		let inputMode = false;
		let cachedLines: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		editor.onSubmit = (value) => {
			const reason = value.trim()
				? `Blocked by user (${labels}): ${value.trim()}`
				: `Blocked by user (${labels})`;
			done({ allow: false, reason });
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) { optionIndex = 0; refresh(); return; }
			if (matchesKey(data, Key.down)) { optionIndex = 1; refresh(); return; }
			if (matchesKey(data, Key.enter)) {
				if (optionIndex === 0) {
					done({ allow: true });
				} else {
					inputMode = true;
					editor.setText("");
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ allow: false, reason: `Blocked by user (${labels})` });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			lines.push("");
			add(theme.fg("warning", " ⚠️ Dangerous command ") + theme.fg("muted", `(${labels})`));
			add(` ${theme.fg("text", command)}`);
			lines.push("");

			const opts = ["Yes", inputMode ? "No ✎" : "No"];
			for (let i = 0; i < opts.length; i++) {
				const sel = i === optionIndex;
				add(`${sel ? theme.fg("accent", " > ") : "   "}${theme.fg(sel ? "accent" : "text", opts[i])}`);
			}
			lines.push("");

			if (inputMode) {
				add(theme.fg("muted", " Reason:"));
				for (const line of editor.render(width - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter submit • Esc back"));
			} else {
				add(theme.fg("dim", " ↑↓ • Enter • Esc block"));
			}
			lines.push("");

			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
	});
}

// ── Extension ────────────────────────────────────────────────────────────

export default function permissionGate(pi: ExtensionAPI) {
	let enabled = true;
	let globalRules: RulesFile = {};
	let projectRules: RulesFile = {};
	let rules: CompiledRule[] = compileRules(globalRules, projectRules);

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("gate", enabled ? ctx.ui.theme.fg("dim", "\uf132 gate") : undefined);
	}

	function reloadRules(cwd: string, warn?: WarnFn): void {
		const loaded = loadRules(cwd, warn);
		globalRules = loaded.global;
		projectRules = loaded.project;
		rules = compileRules(globalRules, projectRules, warn);
	}

	// ── Events ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_NO_GATE === "1") enabled = false;
		const warn: WarnFn = (msg) => ctx.hasUI ? ctx.ui.notify(msg, "warning") : undefined;
		reloadRules(ctx.cwd, warn);
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "bash") return undefined;

		const command = (event.input as any).command as string;
		if (!command) return undefined;

		const matched = rules.filter((r) => r.pattern.test(command));
		if (matched.length === 0) return undefined;

		const labels = matched.map((m) => m.label).join(", ");

		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (${labels}) — no UI` };
		}

		pi.events.emit("permission-gate:waiting");
		const result = await showReviewPrompt(ctx, command, labels);
		pi.events.emit("permission-gate:resolved");

		return result.allow ? undefined : { block: true, reason: result.reason };
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("gate", {
		description: `Permission gate — toggle or manage rules: /gate [${GATE_SUBCMDS}]`,
		handler: async (args, ctx) => {
			const sub = args?.trim().toLowerCase() ?? "";

			// Toggle
			if (!sub) {
				enabled = !enabled;
				updateStatus(ctx);
				ctx.ui.notify(enabled ? "Permission gate enabled" : "Permission gate disabled", "info");
				return;
			}

			// List rules grouped by source
			if (sub === "list" || sub === "ls") {
				const groups: Record<string, string[]> = {};
				for (const r of rules) (groups[r.source] ??= []).push(r.label);

				const sections: string[] = [];
				for (const [source, labels] of Object.entries(groups)) {
					const heading = source.charAt(0).toUpperCase() + source.slice(1);
					sections.push(`${heading} (${labels.length}):\n${labels.map((l) => `  • ${l}`).join("\n")}`);
				}
				ctx.ui.notify(sections.join("\n\n") || "No active rules", "info");
				return;
			}

			// Add rule (saved to global config)
			if (sub === "add") {
				const pattern = await ctx.ui.input("Pattern", "Regex (e.g. \\\\bdocker\\\\s+rm\\\\b)");
				if (!pattern) return;
				const label = await ctx.ui.input("Label", "Short name (e.g. docker remove)");
				if (!label) return;
				try { new RegExp(pattern, "i"); } catch {
					ctx.ui.notify("Invalid regex", "error");
					return;
				}
				globalRules.extraRules = [...(globalRules.extraRules ?? []), { pattern, label }];
				saveGlobalRules(globalRules);
				rules = compileRules(globalRules, projectRules);
				ctx.ui.notify(`Rule added: ${label}`, "info");
				return;
			}

			// Remove rule (extra rules deleted, built-ins added to disabledRules)
			if (sub === "remove" || sub === "rm") {
				if (rules.length === 0) { ctx.ui.notify("No rules to remove", "info"); return; }
				const choice = await ctx.ui.select("Remove rule", rules.map((r) => r.label));
				if (!choice) return;

				const extraIdx = (globalRules.extraRules ?? []).findIndex((r) => r.label === choice);
				if (extraIdx >= 0) {
					globalRules.extraRules!.splice(extraIdx, 1);
				} else {
					globalRules.disabledRules = [...(globalRules.disabledRules ?? []), choice];
				}
				saveGlobalRules(globalRules);
				rules = compileRules(globalRules, projectRules);
				ctx.ui.notify(`Rule removed: ${choice}`, "info");
				return;
			}

			ctx.ui.notify(`Usage: /gate [${GATE_SUBCMDS}]`, "info");
		},
	});
}
