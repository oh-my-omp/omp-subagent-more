import { randomUUID } from "node:crypto";
import { z } from "@oh-my-pi/omptype/zod";
import { type SharedSource, shareSource } from "./replica.ts";
import { parsePortableSource } from "./replica-file.ts";

const CHANNEL = "omp-fork-task/source";

const ANSWER_TIMEOUT_MS = 5000;

const messageSchema = z.union([
	z.object({ kind: z.literal("ask"), id: z.string(), file: z.string() }),
	z.object({ kind: z.literal("answer"), id: z.string(), answer: z.string() }),
]);

const answerSchema = z.union([
	z.object({ kind: z.literal("ready"), source: z.unknown() }),
	z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

let server: BroadcastChannel | undefined;

export function serveSources(warn: (message: string, error: unknown) => void): void {
	if (server) return;
	const channel = new BroadcastChannel(CHANNEL);
	channel.unref();
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "ask") return;
		const { id, file } = message.data;
		shareSource(file).then(
			(answer) => {
				if (answer) channel.postMessage({ kind: "answer", id, answer: JSON.stringify(answer) });
			},
			(error: unknown) => {
				warn("fork_task: answering another thread for a fork source failed", error);
				channel.postMessage({
					kind: "answer",
					id,
					answer: JSON.stringify({ kind: "unavailable", reason: `its thread failed to share it: ${String(error)}` }),
				});
			},
		);
	};
	server = channel;
}

export async function askSource(file: string): Promise<SharedSource | undefined> {
	const id = randomUUID();
	const channel = new BroadcastChannel(CHANNEL);
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS);
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "answer" || message.data.id !== id) return;
		resolve(message.data.answer);
	};
	try {
		channel.postMessage({ kind: "ask", id, file });
		const text = await promise;
		if (text === undefined) return undefined;
		const answer = answerSchema.parse(JSON.parse(text));
		return answer.kind === "ready" ? { kind: "ready", source: parsePortableSource(answer.source) } : answer;
	} finally {
		clearTimeout(timer);
		channel.close();
	}
}
