/**
 * Settings management — stores config in ~/.config/pi-agent-extensions/statusline/
 * Configurable via ~/.pi/agent/pi-agent-extensions.json. See .ref/config-dir.org.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { StatuslineSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

/** Resolve config directory. See .ref/config-dir.org for convention. */
function getConfigDir(): string {
	const override = path.join(homedir(), ".pi", "agent", "pi-agent-extensions.json");
	try {
		const cfg = JSON.parse(fs.readFileSync(override, "utf-8"));
		if (cfg.configDir) return path.join(cfg.configDir, "statusline");
	} catch {}
	const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	return path.join(base, "pi-agent-extensions", "statusline");
}

function getSettingsPath(): string {
	return path.join(getConfigDir(), "settings.json");
}

let cached: StatuslineSettings | undefined;

/** Old config path for migration. */
function getOldSettingsPath(): string {
	const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	return path.join(base, "pi-statusline", "settings.json");
}

export function loadSettings(): StatuslineSettings {
	if (cached) return cached;
	try {
		// Try new location first
		const p = getSettingsPath();
		if (fs.existsSync(p)) {
			const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
			cached = { ...DEFAULT_SETTINGS, ...raw };
			return cached!;
		}
		// Fall back to old location
		const old = getOldSettingsPath();
		if (fs.existsSync(old)) {
			const raw = JSON.parse(fs.readFileSync(old, "utf-8"));
			cached = { ...DEFAULT_SETTINGS, ...raw };
			return cached!;
		}
		cached = { ...DEFAULT_SETTINGS };
		return cached;
	} catch {
		cached = { ...DEFAULT_SETTINGS };
		return cached;
	}
}

export function saveSettings(s: StatuslineSettings): void {
	try {
		const dir = getConfigDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2) + "\n");
		cached = s;
	} catch (e) {
		console.error("[statusline] Failed to save settings:", e);
	}
}

export function clearCache(): void {
	cached = undefined;
}
