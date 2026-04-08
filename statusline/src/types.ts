/**
 * Types for the statusline extension.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

// ── VCS ──────────────────────────────────────────────────────────────────

export type VcsKind = "git" | "jj";

export interface VcsStatus {
	kind: VcsKind;
	/** Branch name, bookmark, or change-id short */
	head: string | null;
	/** Number of modified files */
	modified: number;
	/** Number of added/untracked files */
	added: number;
	/** Number of removed files */
	removed: number;
}

// ── Subscription usage (from pi-sub-core) ────────────────────────────────

export type ProviderName = "anthropic" | "copilot" | "gemini" | "antigravity" | "codex" | "kiro" | "zai";

export interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}

export interface UsageSnapshot {
	provider: ProviderName;
	displayName: string;
	windows: RateWindow[];
	error?: { code: string; message: string };
	status?: { indicator: string; description?: string };
	lastSuccessAt?: number;
	requestsRemaining?: number;
	requestsEntitlement?: number;
}

// ── Settings ─────────────────────────────────────────────────────────────

export type ContextFormat = "percent" | "absolute";

export interface StatuslineSettings {
	/** Show usage widget below editor */
	showUsage: boolean;
	/** Show status bar below editor */
	showBar: boolean;
	/** How to render context-window usage: "42%/200k" vs "84k/200k" */
	contextFormat: ContextFormat;
}

export const DEFAULT_SETTINGS: StatuslineSettings = {
	showUsage: true,
	showBar: true,
	contextFormat: "absolute",
};
