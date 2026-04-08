/**
 * stash — save and restore editor text with Alt+S.
 *
 * Two stash scopes:
 *   - Session stash (Alt+S): per-session, persisted to XDG data dir
 *   - Global stash (Alt+Shift+S): shared across all sessions
 *
 * Stashes survive /reload and pi restarts.
 *
 * When editor is empty, Alt+S shows the session stash picker:
 *   - Enter: restore selected item
 *   - x/d: delete selected item
 *   - Esc: cancel
 *
 * Status shows "stash 📋N" (session) or "stash 📋N+M" (session+global).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SelectList } from "@mariozechner/pi-tui";

const MAX_STASHES = 9;

// ── Data directory (XDG_DATA_HOME) ───────────────────────────────────────

function dataDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	return path.join(xdg || path.join(homedir(), ".local", "share"), "pi-agent-extensions", "stash");
}

function globalStashPath(): string {
	return path.join(dataDir(), "global.json");
}

function sessionStashPath(sessionId: string): string {
	return path.join(dataDir(), "sessions", `${sessionId}.json`);
}

// ── Persistence ──────────────────────────────────────────────────────────

function loadStashFile(filePath: string): string[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (Array.isArray(data)) return data.filter((s: unknown) => typeof s === "string");
	} catch {}
	return [];
}

function saveStashFile(filePath: string, stashes: string[]): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(stashes, null, 2) + "\n");
	} catch {}
}

// ── Extension ────────────────────────────────────────────────────────────

export default function stash(pi: ExtensionAPI) {
	let sessionStashes: string[] = [];
	let globalStashes: string[] = [];
	let sessionId = "";
	let currentCtx: ExtensionContext | undefined;

	function hasText(text: string): boolean {
		return text.trim().length > 0;
	}

	function preview(text: string, i: number, prefix?: string): string {
		const p = text.replace(/\s+/g, " ").trim();
		const tag = prefix ? `${prefix} ` : "";
		return `${tag}${i + 1}. ${p.length > 55 ? p.slice(0, 52) + "…" : p}`;
	}

	function saveSession(): void {
		if (sessionId) saveStashFile(sessionStashPath(sessionId), sessionStashes);
	}

	function saveGlobal(): void {
		saveStashFile(globalStashPath(), globalStashes);
	}

	/** Reload global stash from disk (picks up changes from other sessions). */
	function syncGlobal(): void {
		globalStashes = loadStashFile(globalStashPath());
	}

	// Track whether global stash has been used in this session
	let globalUsed = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const s = sessionStashes.length;
		if (s === 0 && !globalUsed) {
			ctx.ui.setStatus("stash", undefined);
			return;
		}
		const gMark = globalUsed ? "+" : "";
		const count = s > 0 ? `${s}${gMark}` : gMark;
		ctx.ui.setStatus("stash", ctx.ui.theme.fg("success", `\uf187 stash ${count}`));
	}

	// ── Session stash (Alt+S) ────────────────────────────────────────────

	pi.registerShortcut("alt+s", {
		description: "Stash/restore editor text (session-scoped)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			currentCtx = ctx;

			const editorText = ctx.ui.getEditorText();

			if (hasText(editorText)) {
				if (sessionStashes.length >= MAX_STASHES) {
					ctx.ui.notify(`Session stash full (${MAX_STASHES}) — restore or delete first`, "warning");
					return;
				}
				sessionStashes.push(editorText);
				saveSession();
				ctx.ui.setEditorText("");
				updateStatus(ctx);
				ctx.ui.notify(`Stashed (#${sessionStashes.length})`, "info");
				return;
			}

			if (sessionStashes.length === 0) {
				const hint = globalUsed ? " (global stash has items — Alt+Shift+S)" : "";
				ctx.ui.notify(`Nothing stashed in this session${hint}`, "info");
				return;
			}

			if (sessionStashes.length === 1) {
				ctx.ui.setEditorText(sessionStashes.pop()!);
				saveSession();
				updateStatus(ctx);
				ctx.ui.notify("Restored", "info");
				return;
			}

			await showPicker(ctx, sessionStashes, "Session", saveSession);
		},
	});

	// ── Global stash (Alt+Shift+S) ───────────────────────────────────────

	pi.registerShortcut("alt+shift+s", {
		description: "Global stash — push, apply, pop, or delete (shared across sessions)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			currentCtx = ctx;

			syncGlobal();

			const editorText = ctx.ui.getEditorText();

			// If editor has text, push directly
			if (hasText(editorText)) {
				if (globalStashes.length >= MAX_STASHES) {
					ctx.ui.notify(`Global stash full (${MAX_STASHES})`, "warning");
					return;
				}
				globalStashes.push(editorText);
				saveGlobal();
				globalUsed = true;
				ctx.ui.setEditorText("");
				updateStatus(ctx);
				ctx.ui.notify(`Pushed to global (#${globalStashes.length})`, "info");
				return;
			}

			// Editor empty — always show global picker
			await showGlobalPicker(ctx);
		},
	});

	// ── Global stash picker: Enter=pop, a=apply, x/d=delete ─────────────

	async function showGlobalPicker(ctx: ExtensionContext): Promise<void> {
		if (globalStashes.length === 0) {
			ctx.ui.notify("Global stash is empty", "info");
			return;
		}

		const result = await ctx.ui.custom<{ action: "pop" | "apply" | "delete"; index: number } | null>(
			(tui, theme, _kb, done) => {
				function buildList() {
					const items = globalStashes.map((text, i) => ({
						value: String(i),
						label: preview(text, i),
					}));
					const list = new SelectList(items, Math.min(items.length, 9), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					list.onSelect = (item: any) => done({ action: "pop", index: parseInt(item.value, 10) });
					list.onCancel = () => done(null);
					return list;
				}

				let list = buildList();

				return {
					render(width: number) {
						const header = ` ${theme.fg("accent", "Global Stash")} ${theme.fg("dim", `(${globalStashes.length})`)}`;
						const hint = theme.fg("dim", "Enter pop · a apply · x delete · Esc cancel");
						return [header, "", ...list.render(width - 2).map((l: string) => ` ${l}`), "", ` ${hint}`];
					},
					invalidate() { list.invalidate(); },
					handleInput(data: string) {
						if (data === "a") {
							const selected = (list as any).getSelectedItem?.();
							if (selected) {
								done({ action: "apply", index: parseInt(selected.value, 10) });
							}
							return;
						}
						if (data === "x" || data === "d") {
							const selected = (list as any).getSelectedItem?.();
							if (selected) {
								done({ action: "delete", index: parseInt(selected.value, 10) });
							}
							return;
						}
						list.handleInput(data);
					},
				};
			},
		);

		if (!result) return;

		if (result.action === "pop") {
			ctx.ui.setEditorText(globalStashes.splice(result.index, 1)[0]);
			saveGlobal();
			globalUsed = globalStashes.length > 0;
			updateStatus(ctx);
			ctx.ui.notify(`Popped #${result.index + 1} from global`, "info");
		} else if (result.action === "apply") {
			ctx.ui.setEditorText(globalStashes[result.index]);
			globalUsed = true;
			ctx.ui.notify(`Applied #${result.index + 1} from global (kept in stash)`, "info");
		} else if (result.action === "delete") {
			globalStashes.splice(result.index, 1);
			saveGlobal();
			globalUsed = globalStashes.length > 0;
			updateStatus(ctx);
			ctx.ui.notify(`Deleted #${result.index + 1} from global`, "info");
			if (globalStashes.length > 0) {
				await showGlobalPicker(ctx);
			}
		}
	}


	// ── Session stash picker: Enter=restore, x/d=delete ─────────────────

	async function showPicker(
		ctx: ExtensionContext,
		stashes: string[],
		scope: string,
		save: () => void,
	): Promise<void> {
		const result = await ctx.ui.custom<{ action: "restore" | "delete"; index: number } | null>(
			(tui, theme, _kb, done) => {
				function buildList() {
					const items = stashes.map((text, i) => ({
						value: String(i),
						label: preview(text, i),
					}));
					const list = new SelectList(items, Math.min(items.length, 9), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					list.onSelect = (item: any) => done({ action: "restore", index: parseInt(item.value, 10) });
					list.onCancel = () => done(null);
					return list;
				}

				let list = buildList();

				return {
					render(width: number) {
						const globalNote = scope === "Session" && globalUsed
							? ` ${theme.fg("dim", "· global stash has items (Alt+Shift+S)")}`
							: "";
						const header = ` ${theme.fg("accent", `${scope} Stash`)} ${theme.fg("dim", `(${stashes.length})`)}${globalNote}`;
						const hint = theme.fg("dim", "Enter restore · x delete · Esc cancel");
						return [header, "", ...list.render(width - 2).map((l: string) => ` ${l}`), "", ` ${hint}`];
					},
					invalidate() { list.invalidate(); },
					handleInput(data: string) {
						if (data === "x" || data === "d") {
							const selected = (list as any).getSelectedItem?.();
							if (selected) {
								const idx = parseInt(selected.value, 10);
								if (idx >= 0 && idx < stashes.length) {
									done({ action: "delete", index: idx });
								}
							}
							return;
						}
						list.handleInput(data);
					},
				};
			},
		);

		if (!result) return;

		if (result.action === "restore") {
			if (result.index >= 0 && result.index < stashes.length) {
				ctx.ui.setEditorText(stashes.splice(result.index, 1)[0]);
				save();
				updateStatus(ctx);
				ctx.ui.notify(`Restored #${result.index + 1} (${scope.toLowerCase()})`, "info");
			}
		} else if (result.action === "delete") {
			if (result.index >= 0 && result.index < stashes.length) {
				stashes.splice(result.index, 1);
				save();
				updateStatus(ctx);
				ctx.ui.notify(`Deleted #${result.index + 1} (${scope.toLowerCase()})`, "info");
				if (stashes.length > 1) {
					await showPicker(ctx, stashes, scope, save);
				}
			}
		}
	}

	// ── Auto-restore after agent finishes ────────────────────────────────

	// ── Session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		// Derive session ID from session file or fallback
		const sf = ctx.sessionManager?.getSessionFile?.();
		sessionId = sf ? path.basename(sf, ".jsonl") : `${process.pid}`;

		// Load from disk (survives /reload and restarts)
		sessionStashes = loadStashFile(sessionStashPath(sessionId));
		globalStashes = loadStashFile(globalStashPath());
		globalUsed = globalStashes.length > 0;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		saveSession();
		currentCtx = undefined;
	});
}
