/**
 * permission-gate — confirm or block dangerous bash commands before they run.
 *
 * Every bash command is parsed into the programs it actually runs (see
 * shell.ts) and checked against the rules. A matching rule does one of:
 *   - "prompt": show a Yes/No dialog; No accepts an optional reason that
 *     is sent back to the model. Toggle prompting with /gate.
 *   - "block":  reject outright and tell the model why. Stays active even
 *     when /gate turns prompting off.
 * PI_NO_GATE=1 turns the whole extension off.
 *
 * Configuration is read from four places, in order (each can add rules or
 * turn off earlier ones); see config.ts for the trust rules per place:
 *   1. the built-in rules
 *   2. ~/.config/pi-agent-extensions/permission-gate/rules.ts (or .mjs / .js)
 *   3. ~/.config/pi-agent-extensions/permission-gate/rules.json  (written by /gate)
 *   4. <cwd>/.pi/permission-gate.json                            (project, untrusted)
 *
 * Based on pi's built-in permission-gate example, PR #13, and the
 * block-commands extension by Mic92 (github.com/Mic92/dotfiles).
 */

import type { ExtensionAPI, ExtensionContext, BashToolCallEvent } from "@mariozechner/pi-coding-agent";
import { EVENTS, type ArgvPipeline, type CompiledRule, type GateHelpers, type WarnFn } from "./types.ts";
import { searchPaths } from "./builtin-rules.ts";
import { anyCmd, hasFlag } from "./helpers.ts";
import { collectPipelines, deferredScripts, nestedScripts, pipelines, SHELLS, simpleCommands, unwrap, unwrapSteps } from "./shell.ts";
import { matchEvidence, matchRules } from "./match.ts";
import { compileRules, type ConfigLayers, loadConfig, saveUserJson } from "./config.ts";
import { type MatchDetail, showReviewPrompt } from "./ui.ts";

const GATE_SUBCMDS = "list(ls)|off <group>|on <group>|add|remove(rm)|reload";
const HELPERS: GateHelpers = {
	simpleCommands, pipelines, searchPaths,
	unwrap, unwrapSteps, nestedScripts, deferredScripts,
	anyCmd, hasFlag, SHELLS,
};

/**
 * How a `bash` tool command is turned into pipelines for the argv rules.
 * The default is the POSIX parser (shell.ts); the nushell extension plugs
 * in nu's own parser. `unverified` names a reason the analysis is
 * incomplete (parse error, runtime-built command name) — that prompts on
 * its own, since an unparsed script is unverified rather than safe.
 */
export type Analyze = (command: string) => Promise<{ pipelines: ArgvPipeline[]; unverified?: string }>;

const analyzeSh: Analyze = async (command) => ({ pipelines: collectPipelines(command) });

// ── extension ────────────────────────────────────────────────────────────

export default function permissionGate(pi: ExtensionAPI) {
	createGate(pi, analyzeSh);
}

export function createGate(pi: ExtensionAPI, analyze: Analyze): void {
	// PI_NO_GATE=1 disables the extension entirely (prompts and block
	// rules). Exact match on "1": treating any non-empty value as a
	// disable made PI_NO_GATE=0 turn the gate off — the standard env-var
	// footgun, and this one is a kill switch.
	if (process.env.PI_NO_GATE === "1") return;

	let promptsEnabled = true;
	let layers: ConfigLayers = { userCode: {}, userJson: {}, project: {} };
	let rules: CompiledRule[] = compileRules(layers);

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("gate", ctx.ui.theme.fg("dim", promptsEnabled ? "\uf132 gate" : "\uf132 block"));
	}

	async function reloadRules(cwd: string, warn: WarnFn | undefined, headless: boolean): Promise<void> {
		layers = await loadConfig(cwd, HELPERS, warn);
		rules = compileRules(layers, warn, { headless });
	}

	// ── events ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Headless the warn channel is stderr — a no-op here let a repo-shipped
		// config neuter every prompt rule with zero record. compileRules also
		// refuses project prompt-disables entirely when headless (prompts
		// hard-block without a UI, so disabling one escalates, not softens).
		const warn: WarnFn = (msg) =>
			ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.error(msg);
		await reloadRules(ctx.cwd, warn, !ctx.hasUI);
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = (event as BashToolCallEvent).input.command;
		if (!command) return undefined;

		// A throwing rule must fail *closed* — without this guard a malformed
		// project config errored every bash call through pi's tool plumbing
		// instead of blocking cleanly, and the handler contract is "never
		// throw" (loadConfig sanitizes; this is defense in depth).
		let matched: CompiledRule[];
		let unverified: string | undefined;
		try {
			const analysis = await analyze(command);
			unverified = analysis.unverified;
			matched = matchRules(command, rules, analysis.pipelines);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`permission-gate: rule evaluation failed: ${(err as Error).message}`, "warning");
			}
			return { block: true, reason: "Blocked: permission-gate rule evaluation failed — fix the gate config (see /gate list) and retry" };
		}
		// Block wins over prompt and ignores the /gate toggle.
		const block = matched.find((r) => r.action === "block");
		if (block) {
			return { block: true, reason: block.reason ?? `Blocked (${block.label})` };
		}

		const matches: MatchDetail[] = matched
			.filter((r) => r.action === "prompt")
			.map((r) => ({ label: r.label, evidence: matchEvidence(command, r) }));
		if (unverified) matches.push({ label: `unverified (${unverified})` });
		if (!promptsEnabled || matches.length === 0) return undefined;

		const labels = matches.map((m) => m.label).join(", ");
		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (${labels}) — no UI` };
		}

		// showReviewPrompt emits EVENTS.waiting itself, *after* arming its
		// EVENTS.respond listener — emitting it here lost the answer of any
		// responder that reacted synchronously.
		const result = await showReviewPrompt(ctx, command, labels, pi.events, matches);
		pi.events.emit(EVENTS.resolved);

		return result.allow ? undefined : { block: true, reason: result.reason };
	});

	// ── /gate ────────────────────────────────────────────────────────────

	pi.registerCommand("gate", {
		description: `Permission gate — toggle prompts or manage rules: /gate [${GATE_SUBCMDS}]`,
		handler: async (args, ctx) => {
			// Every branch below talks to the UI; headless/RPC callers get a no-op.
			if (!ctx.hasUI) return;
			const sub = args?.trim().toLowerCase() ?? "";
			const warn: WarnFn = (msg) => ctx.ui.notify(msg, "warning");

			// Toggle prompting (block rules unaffected).
			if (!sub) {
				promptsEnabled = !promptsEnabled;
				updateStatus(ctx);
				ctx.ui.notify(
					promptsEnabled
						? "Permission gate: prompts enabled"
						: "Permission gate: prompts disabled (block rules still active)",
					"info",
				);
				return;
			}

			if (sub === "list" || sub === "ls") {
				// Grouped by the coarse dial users actually turn (`/gate off vcs`),
				// not by config source; non-built-in rules note their source inline.
				const byGroup: Record<string, string[]> = {};
				for (const r of rules) {
					const tags = [
						r.action === "block" ? "[block]" : "",
						r.source !== "built-in" ? `[${r.source}]` : "",
					].filter(Boolean).join(" ");
					(byGroup[r.group ?? "custom"] ??= []).push(tags ? `${r.label} ${tags}` : r.label);
				}
				const off = [
					...(layers.userJson.disabledGroups ?? []),
					...(layers.userCode.disabledGroups ?? []),
				];
				const sections = Object.entries(byGroup).map(([group, labels]) =>
					`${group} (${labels.length}):\n${labels.map((l) => `  • ${l}`).join("\n")}`,
				);
				if (off.length) sections.push(`off: ${[...new Set(off)].join(", ")}`);
				ctx.ui.notify(sections.join("\n\n") || "No active rules", "info");
				return;
			}

			// `/gate off vcs` / `/gate on vcs` — the coarse dial. Writes
			// disabledGroups in the user rules.json so it persists.
			const [verb, groupArg] = sub.split(/\s+/, 2);
			if ((verb === "off" || verb === "on") && groupArg) {
				const cfg = layers.userJson;
				const current = new Set(cfg.disabledGroups ?? []);
				if (verb === "off") current.add(groupArg);
				else current.delete(groupArg);
				cfg.disabledGroups = [...current];
				saveUserJson(cfg, warn);
				await reloadRules(ctx.cwd, warn, false);
				ctx.ui.notify(
					verb === "off"
						? `Group "${groupArg}" disabled (${rules.length} rule(s) active)`
						: `Group "${groupArg}" enabled (${rules.length} rule(s) active)`,
					"info",
				);
				return;
			}

			if (sub === "reload") {
				await reloadRules(ctx.cwd, warn, false);
				const src = layers.userCodePath ? ` from ${layers.userCodePath}` : "";
				ctx.ui.notify(`Reloaded ${rules.length} rule(s)${src}`, "info");
				return;
			}

			// Add regex rule → user JSON.
			if (sub === "add") {
				const pattern = await ctx.ui.input("Pattern", "Regex (e.g. \\\\bdocker\\\\s+rm\\\\b)");
				if (!pattern) return;
				const label = await ctx.ui.input("Label", "Short name (e.g. docker remove)");
				if (!label) return;
				try { new RegExp(pattern, "i"); } catch {
					ctx.ui.notify("Invalid regex", "error");
					return;
				}
				const action = (await ctx.ui.select("Action", ["prompt", "block"])) as "prompt" | "block" | undefined;
				if (!action) return;
				const reason = action === "block"
					? await ctx.ui.input("Reason (sent to model)", "")
					: undefined;
				const cfg = layers.userJson;
				cfg.extraRules = [...(cfg.extraRules ?? []), { pattern, label, action, ...(reason ? { reason } : {}) }];
				const saved = saveUserJson(cfg, warn);
				await reloadRules(ctx.cwd, warn, false);
				if (saved) ctx.ui.notify(`Rule added: ${label}`, "info");
				return;
			}

			// Remove: user-json rules are spliced; anything else is disabled by label.
			if (sub === "remove" || sub === "rm") {
				if (rules.length === 0) { ctx.ui.notify("No rules to remove", "info"); return; }
				const choice = await ctx.ui.select("Remove rule", rules.map((r) => r.label));
				if (!choice) return;

				const cfg = layers.userJson;
				// Prefer the user-json rule when labels collide — /gate rm must
				// splice the user's own rule, not disable a built-in that happens
				// to share its label.
				const target = rules.find((r) => r.label === choice && r.source === "user-json")
					?? rules.find((r) => r.label === choice);
				const idx = (cfg.extraRules ?? []).findIndex((r) => r.label === choice);
				if (target?.source === "user-json" && idx >= 0) {
					cfg.extraRules!.splice(idx, 1);
				} else {
					cfg.disabledRules = [...new Set([...(cfg.disabledRules ?? []), choice])];
				}
				const saved = saveUserJson(cfg, warn);
				await reloadRules(ctx.cwd, warn, false);
				if (saved) ctx.ui.notify(`Rule removed: ${choice}`, "info");
				return;
			}

			ctx.ui.notify(`Usage: /gate [${GATE_SUBCMDS}]`, "info");
		},
	});
}
