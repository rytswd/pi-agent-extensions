import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function repairExistingModes(filePath: string, rootDir: string): void {
	if (fs.existsSync(rootDir)) fs.chmodSync(rootDir, DIRECTORY_MODE);

	const dir = path.dirname(filePath);
	if (dir !== rootDir && fs.existsSync(dir)) fs.chmodSync(dir, DIRECTORY_MODE);
	if (fs.existsSync(filePath)) fs.chmodSync(filePath, FILE_MODE);
}

export function loadStashFile(filePath: string, rootDir = path.dirname(filePath)): string[] {
	repairExistingModes(filePath, rootDir);
	if (!fs.existsSync(filePath)) return [];
	const data: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	if (!Array.isArray(data) || !data.every((value) => typeof value === "string")) {
		throw new Error("stash file must contain an array of strings");
	}
	return data;
}

export function saveStashFile(filePath: string, stashes: string[], rootDir: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(rootDir, { recursive: true, mode: DIRECTORY_MODE });
	fs.chmodSync(rootDir, DIRECTORY_MODE);
	fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
	fs.chmodSync(dir, DIRECTORY_MODE);

	const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", FILE_MODE);
		fs.writeFileSync(fd, JSON.stringify(stashes, null, 2) + "\n", "utf-8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch {}
		}
		try { fs.unlinkSync(tempPath); } catch {}
		throw error;
	}
}
