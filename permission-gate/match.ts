/**
 * permission-gate — rule matching against a bash command string.
 *
 * Pure rule matching: all command-structure analysis (tokenizing, pipeline
 * collection, script recursion) lives in shell.ts. Kept free of pi imports
 * so tests can exercise the exact code paths the extension uses (index.ts
 * only wires these into the tool_call event).
 */

import type { ArgvPipeline, CompiledRule } from "./types.ts";
import { collectPipelines, tokenize } from "./shell.ts";

/**
 * Project regexes match against at most this many characters of the
 * command (raw and decoded). The compile-time caps in config.ts bound
 * pattern size, count and the classic exponential shape — not match
 * *time*: backtracking cost grows with the subject, so a heuristic-
 * evading pattern must still run against a bounded subject or a hostile
 * repo stalls the gate inside tool_call. 512 chars is far beyond what a
 * legitimate project rule targets; user and built-in rules are trusted
 * and keep seeing the full string.
 */
export const MAX_PROJECT_MATCH_LENGTH = 512;

/** Longest evidence snippet shown in the prompt (see matchEvidence). */
const MAX_EVIDENCE_LENGTH = 200;

/** All rules matching `command`. Pipelines and the decoded spelling are
 * computed lazily and at most once per call. */
export function matchRules(command: string, rules: CompiledRule[], argvPipes?: ArgvPipeline[]): CompiledRule[] {
	let decoded: string | undefined;
	// Regex rules run against the raw string *and* the tokenizer-decoded
	// words (quotes stripped, escapes decoded, redirect targets included —
	// they are word tokens at this level). Raw-only matching let a quote
	// splice hide any substring a regex rule looks for: the gate
	// self-protection rule missed
	// `~/.config/'pi-agent-extensions'/permission-gate/rules.json` while
	// the argv rules had long since decoded the same spelling.
	const decode = () =>
		(decoded ??= tokenize(command)
			.map((t) => (t.type === "word" || t.type === "op" ? t.value : ""))
			.filter(Boolean)
			.join(" "));
	const clip = (s: string, r: CompiledRule) =>
		r.source === "project" && s.length > MAX_PROJECT_MATCH_LENGTH
			? s.slice(0, MAX_PROJECT_MATCH_LENGTH)
			: s;
	return rules.filter((r) =>
		r.kind === "regex"
			? r.pattern.test(clip(command, r)) || r.pattern.test(clip(decode(), r))
			: (argvPipes ??= collectPipelines(command)).some((p) => r.test(p)),
	);
}

/**
 * The fragment of `command` that made `rule` fire, for display in the
 * prompt. A label alone ({@link CompiledRule.label}) answers "which rule"
 * but not "which part of my 40-line heredoc" — and the dangerous word is
 * routinely nowhere near the visible start of the command.
 *
 * Best effort by design: returns undefined when the rule cannot be
 * attributed to a fragment (or does not match on this pass), and the
 * prompt then falls back to the label. Only called when a prompt is about to be
 * shown, so the second matching pass costs nothing in the common path.
 */
export function matchEvidence(command: string, rule: CompiledRule): string | undefined {
	try {
		if (rule.kind === "regex") {
			// exec, not test: /g and /y carry lastIndex across calls, so the
			// shared compiled pattern would skip or miss on alternate runs.
			const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, ""));
			const subject =
				rule.source === "project" && command.length > MAX_PROJECT_MATCH_LENGTH
					? command.slice(0, MAX_PROJECT_MATCH_LENGTH)
					: command;
			return snippet(pattern.exec(subject)?.[0]);
		}
		const pipeline = collectPipelines(command).find((p) => rule.test(p));
		return snippet(pipeline?.map((argv) => argv.join(" ")).join(" | "));
	} catch {
		// Never let display logic break the prompt: no evidence, just the label.
		return undefined;
	}
}

/** One-line, bounded rendering of a matched fragment. */
function snippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > MAX_EVIDENCE_LENGTH ? `${flat.slice(0, MAX_EVIDENCE_LENGTH - 1)}…` : flat;
}
