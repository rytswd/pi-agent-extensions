import { expect, test } from "bun:test";
import stash, { type StashStorage } from "./index.ts";

function harness(sessionItems: string[] = []) {
	const eventHandlers = new Map<string, (...args: any[]) => any>();
	const shortcutHandlers = new Map<string, (ctx: any) => Promise<void>>();
	const notifications: Array<{ message: string; type?: string }> = [];
	let editorText = "";

	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			eventHandlers.set(event, handler);
		},
		registerShortcut(key: string, options: { handler: (ctx: any) => Promise<void> }) {
			shortcutHandlers.set(key, options.handler);
		},
	} as any;
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/session-one.jsonl" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; },
			setStatus() {},
			notify(message: string, type?: string) { notifications.push({ message, type }); },
		},
	} as any;
	let failSave = true;
	const saved: string[][] = [];
	const storage: StashStorage = {
		load(filePath) {
			return filePath.includes("/sessions/") ? [...sessionItems] : [];
		},
		save(_filePath, items) {
			if (failSave) throw new Error("injected save failure");
			saved.push([...items]);
		},
	};

	stash(pi, storage);

	return {
		ctx,
		notifications,
		saved,
		setEditorText(text: string) { editorText = text; },
		getEditorText() { return editorText; },
		allowSaves() { failSave = false; },
		async start() { await eventHandlers.get("session_start")?.({ type: "session_start" }, ctx); },
		async toggle() { await shortcutHandlers.get("alt+s")?.(ctx); },
	};
}

test("failed stash push preserves editor text and rolls back in-memory state", async () => {
	const h = harness();
	h.setEditorText("draft");
	await h.start();

	await h.toggle();
	expect(h.getEditorText()).toBe("draft");
	expect(h.notifications.at(-1)).toEqual({
		message: "Session stash was not saved: injected save failure",
		type: "error",
	});

	h.allowSaves();
	await h.toggle();
	expect(h.saved).toEqual([["draft"]]);
	expect(h.getEditorText()).toBe("");
});

test("failed restore preserves editor text and restores the in-memory stash", async () => {
	const h = harness(["saved text"]);
	await h.start();

	await h.toggle();
	expect(h.getEditorText()).toBe("");
	expect(h.notifications.at(-1)?.type).toBe("error");

	h.allowSaves();
	await h.toggle();
	expect(h.saved).toEqual([[]]);
	expect(h.getEditorText()).toBe("saved text");
});
