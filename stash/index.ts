/**
 * stash — save and restore editor text with Alt+S.
 *
 * Press Alt+S to stash the current editor content (up to 9 slots).
 * When editor is empty, Alt+S shows the stash list:
 *   - Enter: restore selected item
 *   - x/d: delete selected item
 *   - Esc: cancel
 *
 * Status shows "📋 N" with stash count in the extension statuses.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SelectList } from "@mariozechner/pi-tui";

const MAX_STASHES = 9;

export default function stash(pi: ExtensionAPI) {
	const stashes: string[] = [];
	let currentCtx: ExtensionContext | undefined;

	function hasText(text: string): boolean {
		return text.trim().length > 0;
	}

	function preview(text: string, i: number): string {
		const p = text.replace(/\s+/g, " ").trim();
		return `${i + 1}. ${p.length > 60 ? p.slice(0, 57) + "…" : p}`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("stash", stashes.length > 0 ? `📋 ${stashes.length}` : undefined);
	}

	// ── Stash shortcut ───────────────────────────────────────────────────

	pi.registerShortcut("alt+s", {
		description: "Stash/restore editor text",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			currentCtx = ctx;

			const editorText = ctx.ui.getEditorText();

			if (hasText(editorText)) {
				if (stashes.length >= MAX_STASHES) {
					ctx.ui.notify(`Stash full (${MAX_STASHES}) — restore or delete first`, "warning");
					return;
				}
				stashes.push(editorText);
				ctx.ui.setEditorText("");
				updateStatus(ctx);
				ctx.ui.notify(`Stashed (#${stashes.length})`, "info");
				return;
			}

			if (stashes.length === 0) {
				ctx.ui.notify("Nothing stashed", "info");
				return;
			}

			if (stashes.length === 1) {
				ctx.ui.setEditorText(stashes.pop()!);
				updateStatus(ctx);
				ctx.ui.notify("Restored", "info");
				return;
			}

			await showStashPicker(ctx);
		},
	});

	// ── Picker: Enter=restore, x/d=delete ────────────────────────────────

	async function showStashPicker(ctx: ExtensionContext): Promise<void> {
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
						const header = ` ${theme.fg("accent", "Stash")} ${theme.fg("dim", `(${stashes.length})`)}`;
						const hint = theme.fg("dim", "Enter restore · x delete · Esc cancel");
						return [header, "", ...list.render(width - 2).map((l: string) => ` ${l}`), "", ` ${hint}`];
					},
					invalidate() { list.invalidate(); },
					handleInput(data: string) {
						// x or d to delete selected item
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
				updateStatus(ctx);
				ctx.ui.notify(`Restored #${result.index + 1}`, "info");
			}
		} else if (result.action === "delete") {
			if (result.index >= 0 && result.index < stashes.length) {
				stashes.splice(result.index, 1);
				updateStatus(ctx);
				ctx.ui.notify(`Deleted #${result.index + 1}`, "info");
				// Re-open if items remain
				if (stashes.length > 1) {
					await showStashPicker(ctx);
				}
			}
		}
	}

	// ── Auto-restore after agent finishes ────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI || stashes.length === 0) return;

		if (!hasText(ctx.ui.getEditorText())) {
			ctx.ui.setEditorText(stashes.pop()!);
			updateStatus(ctx);
			ctx.ui.notify("Stash restored", "info");
		} else {
			ctx.ui.notify(`${stashes.length} stash(es) — Alt+S to restore`, "info");
		}
	});

	// ── Session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		stashes.length = 0;
		if (ctx.hasUI) ctx.ui.setStatus("stash", undefined);
	});

	pi.on("session_shutdown", async () => {
		stashes.length = 0;
		currentCtx = undefined;
	});
}
