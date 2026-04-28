/**
 * statusline — single condensed status line below the editor.
 *
 * Format: model usage · thinking · path · vcs(git/jj) · context · cost
 *
 * Config: ~/.config/pi-agent-extensions/statusline/ (see .ref/config-dir.org).
 * Usage cache shared across pi instances.
 * VCS: auto-detects jj (when .jj exists) or git.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { loadSettings, saveSettings, clearCache } from "./src/settings.js";
import { renderBar, buildBarContext, invalidateVcs, setExtensionStatuses } from "./src/bar.js";
import { setVcsUpdateCallback } from "./src/vcs.js";
import { detectProvider, createUsageController, setApiKeyResolver, resetRateLimit } from "./src/providers.js";
import { getCached } from "./src/cache.js";

const STATUSLINE_SUBCMDS = "usage|bar|context|refresh";

// ── Extension ────────────────────────────────────────────────────────────

export default function statusline(pi: ExtensionAPI) {
	let settings = loadSettings();
	let enabled = true;
	let currentCtx: ExtensionContext | undefined;
	let tuiRef: any = null;
	let getThinkingLevelFn: (() => string) | null = null;

	// ── Usage controller ─────────────────────────────────────────────────

	const usage = createUsageController(() => {
		renderWidget();
	});

	/** Get usage: in-memory first, then file cache fallback. */
	function getUsage() {
		const mem = usage.current();
		if (mem) return mem;
		const provider = currentProvider();
		if (!provider) return undefined;
		return getCached(provider, 5 * 60 * 1000);
	}

	function currentProvider() {
		return detectProvider(currentCtx?.model);
	}

	// ── Widget (single line below editor) ────────────────────────────────

	function renderWidget(): void {
		if (!currentCtx || !enabled || !settings.showBar) {
			currentCtx?.ui.setWidget("statusline-bar", undefined);
			return;
		}

		const ctx = currentCtx;
		(ctx.ui as any).setWidget(
			"statusline-bar",
			(_tui: any, theme: Theme) => ({
				render(width: number) {
					if (!currentCtx) return [];
					const thinkingLevel = getThinkingLevelFn?.() ?? "off";
					const subUsage = settings.showUsage ? getUsage() : undefined;
					const barCtx = buildBarContext(currentCtx, thinkingLevel, subUsage, settings.contextFormat);
					const line = renderBar(theme, barCtx, width);
					if (!line) return [];
					return [line];
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	}

	// ── Footer for TUI ref + git branch re-renders ───────────────────────

	function setupFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(): string[] {
					// Feed extension statuses into the bar widget
					const statuses = footerData.getExtensionStatuses();
					setExtensionStatuses(statuses);
					return [];
				},
			};
		});
	}

	// ── Init usage fetch ─────────────────────────────────────────────────

	async function initUsage(ctx: ExtensionContext): Promise<void> {
		if (ctx.modelRegistry?.getApiKeyForProvider) {
			setApiKeyResolver((provider) => ctx.modelRegistry.getApiKeyForProvider(provider));
		}

		const provider = currentProvider();
		if (provider) {
			await usage.refresh(provider);
		}
		usage.start(currentProvider);
	}

	// ── VCS invalidation on file changes ─────────────────────────────────

	const VCS_CHANGE_PATTERNS = [
		/\b(git|jj)\s+(checkout|switch|branch|merge|rebase|pull|reset|new|edit|abandon|squash|split|move|bookmark)\b/,
		/\bjj\s+(describe|commit|undo|restore)\b/,
		/\bgit\s+stash\s+(pop|apply)\b/,
	];

	function mightChangeVcs(cmd: string): boolean {
		return VCS_CHANGE_PATTERNS.some((p) => p.test(cmd));
	}

	// ── Events ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		settings = loadSettings();
		clearCache();
		getThinkingLevelFn =
			typeof (ctx as any).getThinkingLevel === "function" ? () => (ctx as any).getThinkingLevel() : null;

		// PI_STATUSLINE=minimal disables usage fetching
		if (process.env.PI_STATUSLINE === "minimal") {
			settings.showUsage = false;
		}

		if (enabled && ctx.hasUI) {
			setupFooter(ctx);
			renderWidget();
			setVcsUpdateCallback(() => tuiRef?.requestRender());
		}

		if (settings.showUsage) {
			await initUsage(ctx);
		}
	});

	pi.on("turn_end", async () => {
		const provider = currentProvider();
		if (provider) {
			void usage.refresh(provider);
		}
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			invalidateVcs();
		}
		if (event.toolName === "bash" && (event.input as any)?.command) {
			const cmd = String((event.input as any).command);
			if (mightChangeVcs(cmd)) {
				invalidateVcs();
				setTimeout(() => tuiRef?.requestRender(), 100);
			}
		}
	});

	pi.on("user_bash", async (event) => {
		if (mightChangeVcs(event.command)) {
			invalidateVcs();
			setTimeout(() => tuiRef?.requestRender(), 150);
			setTimeout(() => tuiRef?.requestRender(), 500);
		}
	});

	pi.on("model_select" as any, async (_event: any, ctx: ExtensionContext) => {
		currentCtx = ctx;
		const provider = currentProvider();
		if (provider) {
			void usage.refresh(provider);
		}
		renderWidget();
		tuiRef?.requestRender();
	});

	pi.on("session_shutdown", async () => {
		usage.stop();
		currentCtx = undefined;
		tuiRef = null;
		setVcsUpdateCallback(null);
	});

	// ── Command ──────────────────────────────────────────────────────────

	pi.registerCommand("statusline", {
		description: `Toggle statusline on/off, or configure: /statusline [${STATUSLINE_SUBCMDS}]`,
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const arg = args?.trim().toLowerCase();

			if (!arg) {
				enabled = !enabled;
				if (enabled) {
					setupFooter(ctx);
					const provider = currentProvider();
					if (provider) void usage.refresh(provider);
					usage.start(currentProvider);
					renderWidget();
					ctx.ui.notify("Statusline enabled", "info");
				} else {
					usage.stop();
					ctx.ui.setWidget("statusline-bar", undefined);
					ctx.ui.setFooter(undefined);
					tuiRef = null;
					ctx.ui.notify("Statusline disabled", "info");
				}
				return;
			}

			if (arg === "usage") {
				settings.showUsage = !settings.showUsage;
				saveSettings(settings);
				renderWidget();
				ctx.ui.notify(`Usage: ${settings.showUsage ? "on" : "off"}`, "info");
				return;
			}

			if (arg === "context") {
				settings.contextFormat = settings.contextFormat === "percent" ? "absolute" : "percent";
				saveSettings(settings);
				renderWidget();
				ctx.ui.notify(`Context: ${settings.contextFormat}`, "info");
				return;
			}

			if (arg === "bar") {
				settings.showBar = !settings.showBar;
				saveSettings(settings);
				renderWidget();
				ctx.ui.notify(`Status bar: ${settings.showBar ? "on" : "off"}`, "info");
				return;
			}

			if (arg === "refresh") {
				if (ctx.modelRegistry?.getApiKeyForProvider) {
					setApiKeyResolver((provider) => ctx.modelRegistry.getApiKeyForProvider(provider));
				}
				resetRateLimit();
				const provider = currentProvider();
				if (provider) {
					const result = await usage.forceRefresh(provider);
					renderWidget();
					if (result && result.windows.length > 0) {
						ctx.ui.notify("Usage refreshed", "info");
					} else {
						const err = result?.error?.message ?? "no data";
						const hint = err.includes("429") ? " — try /login to get a fresh token" : "";
						ctx.ui.notify(`Usage refresh failed (${err})${hint}`, "warning");
					}
				} else {
					ctx.ui.notify("No provider detected", "warning");
				}
				return;
			}

			ctx.ui.notify(`Usage: /statusline [${STATUSLINE_SUBCMDS}]`, "info");
		},
	});
}
