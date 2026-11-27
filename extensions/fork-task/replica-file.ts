import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { readOptional, sessionArtifactsDir } from "../_shared/session-files.ts";
import type { PortableSource, Replica } from "./replica.ts";

const requestSchema = z.object({
	model: z.object({ provider: z.string(), id: z.string() }).passthrough(),
	context: z.object({ systemPrompt: z.unknown(), messages: z.array(z.unknown()), tools: z.array(z.unknown()).optional() }),
	options: z.record(z.string(), z.unknown()),
});

const replaySchema = z.union([
	z.object({
		kind: z.literal("prefix"),
		response: z.number().optional(),
		notice: z.object({ entryId: z.string(), timestamp: z.number() }),
	}),
	z.object({ kind: z.literal("own") }),
]);

const contextFilesSchema = z.array(z.object({ path: z.string(), text: z.string() }));

const portableSchema = z.object({
	request: requestSchema,
	systemPrompt: z.array(z.string()),
	contextFiles: contextFilesSchema,
	cwd: z.string(),
	sourceModel: z.string(),
	replay: replaySchema,
	inheritReasoning: z.boolean(),
});

const thinkingLevels: readonly string[] = Object.values(ThinkingLevel);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return thinkingLevels.includes(value);
}

const portableSourceSchema = z.object({
	request: requestSchema,
	response: z.number().optional(),
	systemPrompt: z.array(z.string()),
	contextFiles: contextFilesSchema,
	thinkingLevel: z.string().optional(),
	cwd: z.string(),
});

export function replicaFilePath(childFile: string): string {
	return path.join(sessionArtifactsDir(childFile), "fork-task.replica.json");
}

export async function writeReplicaFile(file: string, replica: Replica): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(replica));
}

export async function readReplicaFile(file: string): Promise<Replica | undefined> {
	const text = await readOptional(file);
	if (text === undefined) return undefined;
	const { request, replay, ...rest } = portableSchema.parse(JSON.parse(text));
	return {
		...rest,
		// SAFETY: writeReplicaFile wrote this from a Replica["request"], whose keys requestSchema matches one for one; model keeps its extra fields via passthrough, and the message, tool and option values are the extension's own output, read back unchecked.
		request: request as unknown as Replica["request"],
		replay: replay.kind === "prefix" ? { kind: "prefix", response: replay.response, notice: replay.notice } : replay,
	};
}

export function parkedFilePath(sessionFile: string): string {
	return path.join(sessionArtifactsDir(sessionFile), "fork-task.request.json");
}

export function parsePortableSource(value: unknown): PortableSource {
	const { request, response, thinkingLevel, ...rest } = portableSourceSchema.parse(value);
	if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`unknown thinking level \`${thinkingLevel}\``);
	return {
		...rest,
		// SAFETY: the source channel and the parked file carry a PortableSource["request"] this extension serialized, whose keys requestSchema matches one for one; model keeps its extra fields via passthrough, and the message, tool and option values are read back unchecked.
		request: request as unknown as PortableSource["request"],
		response,
		thinkingLevel,
	};
}
