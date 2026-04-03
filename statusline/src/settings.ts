/**
 * Settings management — stores config in ~/.config/pi-statusline/
 * Safe for read-only filesystems (Nix store).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { StatuslineSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

function getConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg || path.join(homedir(), ".config");
	return path.join(base, "pi-statusline");
}

function getSettingsPath(): string {
	return path.join(getConfigDir(), "settings.json");
}

let cached: StatuslineSettings | undefined;

export function loadSettings(): StatuslineSettings {
	if (cached) return cached;
	try {
		const p = getSettingsPath();
		if (!fs.existsSync(p)) {
			cached = { ...DEFAULT_SETTINGS };
			return cached;
		}
		const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
		cached = { ...DEFAULT_SETTINGS, ...raw };
		return cached!;
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
