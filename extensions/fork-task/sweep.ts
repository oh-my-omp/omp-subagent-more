import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PID_NAME = /^[1-9]\d*$/;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export async function sweepDeadProcessDirs(roots: readonly string[], warn: (message: string, error: unknown) => void): Promise<void> {
	for (const parent of roots) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(parent, { withFileTypes: true });
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			warn(`fork_task: listing ${parent} failed`, error);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !PID_NAME.test(entry.name)) continue;
			if (processAlive(Number(entry.name))) continue;
			await fs
				.rm(path.join(parent, entry.name), { recursive: true, force: true })
				.catch((error: unknown) => warn(`fork_task: removing records of dead process ${entry.name} failed`, error));
		}
	}
}
