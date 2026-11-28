import * as fs from "node:fs/promises";
import { hasErrorCode } from "./errors.ts";

export function sessionArtifactsDir(sessionFile: string): string {
	if (!sessionFile.endsWith(".jsonl")) throw new Error(`fork_task: ${sessionFile} is not a session transcript`);
	return sessionFile.slice(0, -".jsonl".length);
}

export async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}
