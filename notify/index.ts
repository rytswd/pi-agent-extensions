/**
 * notify — desktop notification when agent finishes.
 *
 * Sends a native terminal notification via OSC escape sequences when the
 * agent is done and waiting for input. Works with Ghostty, iTerm2, WezTerm,
 * Kitty, rxvt-unicode, and Windows Terminal (WSL).
 *
 * Toggle: /notify
 * Status: "notify:off" shown when disabled (enabled by default)
 *
 * Inspired by https://github.com/aldoborrero/pi-agent-kit/tree/main/extensions/notify
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

// ── Notification protocols ───────────────────────────────────────────────

function sanitize(s: string): string {
	return s.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

/**
 * tmux only forwards unknown OSC sequences to the outer terminal when they
 * are wrapped in its DCS passthrough (\ePtmux;...\e\\) — even with
 * `allow-passthrough on`. Detect tmux via $TMUX and double-escape ESC bytes.
 */
function writeEscape(seq: string): void {
	if (process.env.TMUX) {
		process.stdout.write(`\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
	} else {
		process.stdout.write(seq);
	}
}

function notifyOSC777(title: string, body: string): void {
	writeEscape(`\x1b]777;notify;${sanitize(title)};${sanitize(body)}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	writeEscape(`\x1b]99;i=1:d=0;${sanitize(title)}\x1b\\`);
	writeEscape(`\x1b]99;i=1:p=body;${sanitize(body)}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("node:child_process");
	const t = sanitize(title);
	const b = sanitize(body);
	const type = "Windows.UI.Notifications";
	const script = [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${b}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${t}').Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script]);
}

function sendNotification(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// ── Extension ────────────────────────────────────────────────────────────

export default function notify(pi: ExtensionAPI) {
	let enabled = true;
	let agentStartTime: number | null = null;
	let turnCount = 0;
	let filesChanged = 0;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Only show when off — on is the expected default
		ctx.ui.setStatus("notify", enabled ? undefined : ctx.ui.theme.fg("warning", "notify:off"));
	}

	pi.on("session_start", async (_event, ctx) => {
		// PI_NO_NOTIFY=1 disables notifications at startup
		if (process.env.PI_NO_NOTIFY === "1") {
			enabled = false;
		}
		updateStatus(ctx);
	});

	pi.registerCommand("notify", {
		description: "Toggle desktop notifications on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			updateStatus(ctx);
			ctx.ui.notify(enabled ? "Notifications enabled" : "Notifications disabled", "info");
		},
	});

	pi.on("agent_start", async () => {
		agentStartTime = Date.now();
		turnCount = 0;
		filesChanged = 0;
	});

	pi.on("turn_start", async (event) => {
		turnCount = event.turnIndex + 1;
	});

	pi.on("tool_result", async (event) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			filesChanged++;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) return;

		const project = basename(ctx.cwd) || ctx.cwd;
		const elapsed = agentStartTime !== null ? Math.round((Date.now() - agentStartTime) / 1000) : null;

		// Extract first sentence from last assistant message
		let snippet = "";
		for (const msg of [...event.messages].reverse()) {
			const m = msg as any;
			if (m.role !== "assistant") continue;
			const text = ((m.content ?? []) as any[])
				.filter((c: any) => c.type === "text")
				.map((c: any) => (c.text ?? "") as string)
				.join(" ")
				.trim();
			if (text) {
				snippet = text.split(/[.!?\n]/)[0].trim().slice(0, 80);
				break;
			}
		}

		// Build stats
		const stats: string[] = [];
		if (elapsed !== null) stats.push(`${elapsed}s`);
		if (turnCount > 0) stats.push(`${turnCount} turn${turnCount !== 1 ? "s" : ""}`);
		if (filesChanged > 0) stats.push(`${filesChanged} file${filesChanged !== 1 ? "s" : ""}`);

		const title = `Pi · ${project}`;
		const body = snippet
			? stats.length > 0 ? `${snippet} (${stats.join(" · ")})` : snippet
			: stats.join(" · ") || "Ready for input";

		sendNotification(title, body);
	});
}
