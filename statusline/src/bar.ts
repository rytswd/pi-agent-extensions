/**
 * Status bar renderer — single condensed line below the editor.
 * Segments: model · usage · context · thinking · path · vcs · cost
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";
import { getVcsStatus, invalidateVcs } from "./vcs.js";
import type { ContextFormat, UsageSnapshot } from "./types.js";

// ── Extension statuses ───────────────────────────────────────────────────

let extensionStatuses: ReadonlyMap<string, string> = new Map();

export function setExtensionStatuses(statuses: ReadonlyMap<string, string>): void {
	extensionStatuses = statuses;
}

// ── Separator ────────────────────────────────────────────────────────────

const SEP = "❯";

function sep(theme: Theme): string {
	return theme.fg("dim", ` ${SEP} `);
}

// ── Token formatting ─────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Usage color ──────────────────────────────────────────────────────────

function usageColor(pct: number): ThemeColor {
	const remaining = 100 - pct;
	if (remaining <= 10) return "error";
	if (remaining <= 30) return "warning";
	return "dim";
}

// ── Segment renderers ────────────────────────────────────────────────────

function segStatuses(theme: Theme): string | null {
	if (!extensionStatuses || extensionStatuses.size === 0) return null;
	const parts: string[] = [];
	for (const value of extensionStatuses.values()) {
		if (value) parts.push(value);
	}
	if (parts.length === 0) return null;
	return parts.join(theme.fg("dim", " "));
}

export interface BarContext {
	model: { id: string; name?: string; provider?: string; reasoning?: boolean; contextWindow?: number } | undefined;
	thinkingLevel: string;
	cwd: string;
	sessionBranch: ReturnType<any>;
	usingSubscription: boolean;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	contextTokens: number;
	contextPercent: number;
	contextWindow: number;
	contextFormat: ContextFormat;
	/** Subscription usage snapshot (from providers) */
	subUsage: UsageSnapshot | undefined;
}

function fmtResetShort(desc: string | undefined): string {
	if (!desc) return "";
	return desc;
}

function segModel(theme: Theme, ctx: BarContext): string | null {
	if (!ctx.model) return null;
	let name = ctx.model.name || ctx.model.id;
	if (name.startsWith("Claude ")) name = name.slice(7);
	return theme.fg("text", name);
}

function segUsage(theme: Theme, ctx: BarContext): string | null {
	const sub = ctx.subUsage;
	if (!sub || sub.windows.length === 0) return null;

	const windowParts: string[] = [];
	for (const w of sub.windows) {
		const pct = Math.round(Math.max(0, Math.min(100, w.usedPercent)));
		const color = usageColor(pct);
		const showReset = pct > 50 && w.resetDescription;
		const reset = showReset ? ` ${fmtResetShort(w.resetDescription)}` : "";

		let label: string;
		if (w.label.startsWith("Extra")) {
			label = "Ex";
			const pctStr = pct >= 100 ? "100%+" : `${pct}%`;
			windowParts.push(theme.fg(color, `${label}:${pctStr}${reset}`));
		} else if (w.label === "Week" || w.label === "7d") {
			windowParts.push(theme.fg(color, `W:${pct}%${reset}`));
		} else if (w.label === "Day") {
			windowParts.push(theme.fg(color, `D:${pct}%${reset}`));
		} else {
			windowParts.push(theme.fg(color, `${w.label}:${pct}%${reset}`));
		}
	}

	return windowParts.join(theme.fg("dim", "│"));
}

function segThinking(theme: Theme, ctx: BarContext): string | null {
	if (!ctx.model?.reasoning) return null;
	const level = ctx.thinkingLevel || "off";
	if (level === "off") return null;
	const abbr: Record<string, string> = { minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi" };
	return theme.fg("muted", `think:${abbr[level] ?? level}`);
}

function segPath(theme: Theme, ctx: BarContext): string {
	const dir = basename(ctx.cwd) || ctx.cwd;
	return theme.fg("accent", dir);
}

function segVcs(theme: Theme, ctx: BarContext): string | null {
	const vcs = getVcsStatus(ctx.cwd);
	if (!vcs || !vcs.head) return null;

	const isDirty = vcs.modified > 0 || vcs.added > 0 || vcs.removed > 0;
	const icon = vcs.kind === "jj" ? "◆" : "";
	const label = icon ? `${icon} ${vcs.head}` : vcs.head;
	let s = theme.fg(isDirty ? "warning" : "success", label);

	const parts: string[] = [];
	if (vcs.modified > 0) parts.push(theme.fg("warning", `~${vcs.modified}`));
	if (vcs.added > 0) parts.push(theme.fg("success", `+${vcs.added}`));
	if (vcs.removed > 0) parts.push(theme.fg("error", `-${vcs.removed}`));
	if (parts.length > 0) s += ` ${parts.join(" ")}`;

	return s;
}

function segContext(theme: Theme, ctx: BarContext): string | null {
	if (!ctx.contextWindow) return null;
	const pct = ctx.contextPercent;
	const color = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";
	const used = ctx.contextFormat === "absolute" ? fmtTokens(ctx.contextTokens) : `${pct.toFixed(0)}%`;
	return theme.fg(color, `${used}/${fmtTokens(ctx.contextWindow)}`);
}

function segCost(theme: Theme, ctx: BarContext): string | null {
	if (ctx.usingSubscription) return null;
	if (ctx.usage.cost === 0) return null;
	return theme.fg("dim", `$${ctx.usage.cost.toFixed(2)}`);
}

// ── Build ────────────────────────────────────────────────────────────────

export function renderBar(theme: Theme, ctx: BarContext, width: number): string {
	const segments = [
		segModel(theme, ctx),
		segUsage(theme, ctx),
		segContext(theme, ctx),
		segThinking(theme, ctx),
		segPath(theme, ctx),
		segVcs(theme, ctx),
		segCost(theme, ctx),
		segStatuses(theme),
	].filter((s): s is string => s !== null);

	if (segments.length === 0) return "";
	const line = " " + segments.join(sep(theme)) + " ";
	if (visibleWidth(line) > width) {
		return truncateToWidth(line, width, theme.fg("dim", "…"));
	}
	return line;
}

/**
 * Compute BarContext from an ExtensionContext.
 */
export function buildBarContext(
	ctx: any,
	thinkingLevel: string,
	subUsage?: UsageSnapshot,
	contextFormat: ContextFormat = "percent",
): BarContext {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		cost = 0;
	let lastAssistant: AssistantMessage | undefined;

	const entries = ctx.sessionManager?.getBranch?.() ?? [];
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			input += m.usage.input;
			output += m.usage.output;
			cacheRead += m.usage.cacheRead;
			cacheWrite += m.usage.cacheWrite;
			cost += m.usage.cost.total;
			lastAssistant = m;
		}
	}

	const contextTokens = lastAssistant
		? lastAssistant.usage.input + lastAssistant.usage.output + lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite
		: 0;
	const contextWindow = ctx.model?.contextWindow || 0;
	const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
	const usingSubscription = ctx.model ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false : false;

	return {
		model: ctx.model,
		thinkingLevel,
		cwd: ctx.cwd ?? process.cwd(),
		sessionBranch: null,
		usingSubscription,
		usage: { input, output, cacheRead, cacheWrite, cost },
		contextTokens,
		contextPercent,
		contextWindow,
		contextFormat,
		subUsage: subUsage,
	};
}

export { invalidateVcs };
