import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { applyActiveTools } from "../../omomp-shared/active-tools.ts";
import { tr } from "../../omomp-shared/i18n.ts";
import { omompTool } from "../../omomp-shared/tool-entry.ts";
import { readOptional, sessionArtifactsDir } from "../_shared/session-files.ts";

export const SPLIT_TOOL = "flow_split";

const CHANNEL = "omp-subagent-ng/flow-split";
const HEARD_TIMEOUT_MS = 5000;

export type SplitAsk = {
	readonly id: string;
	readonly session: string;
	readonly parts: readonly string[];
	readonly details: string;
};

export type SplitAnswer =
	| { readonly kind: "waiting" }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "agreed" }
	| { readonly kind: "disagreed"; readonly reason: string };

const answerSchema = z.union([
	z.object({ kind: z.literal("waiting") }),
	z.object({ kind: z.literal("refused"), reason: z.string() }),
	z.object({ kind: z.literal("agreed") }),
	z.object({ kind: z.literal("disagreed"), reason: z.string() }),
]);

const messageSchema = z.union([
	z.object({ kind: z.literal("ask"), id: z.string(), session: z.string(), parts: z.array(z.string()), details: z.string() }),
	z.object({ kind: z.literal("answer"), id: z.string(), answer: answerSchema }),
]);

export type SplitServer = { readonly close: () => void };

export function serveSplits(claim: (ask: SplitAsk, reply: (answer: SplitAnswer) => void) => boolean): SplitServer {
	const channel = new BroadcastChannel(CHANNEL);
	channel.unref();
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "ask") return;
		const { kind: _, ...ask } = message.data;
		claim(ask, (answer) => channel.postMessage({ kind: "answer", id: ask.id, answer }));
	};
	return { close: () => channel.close() };
}

export type Decision = Exclude<SplitAnswer, { kind: "waiting" }>;

export async function askSplit(ask: Omit<SplitAsk, "id">, signal: AbortSignal | undefined): Promise<Decision> {
	const id = randomUUID();
	const channel = new BroadcastChannel(CHANNEL);
	const { promise, resolve, reject } = Promise.withResolvers<Decision>();
	const unheard = setTimeout(
		() =>
			resolve({
				kind: "refused",
				reason: "no running flow claims this session, so nobody can approve a split; finish the assignment another way",
			}),
		HEARD_TIMEOUT_MS,
	);
	const cancelled = (): void => reject(signal?.reason ?? new Error("the split request was cancelled"));
	signal?.addEventListener("abort", cancelled, { once: true });
	channel.onmessage = (event) => {
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.kind !== "answer" || message.data.id !== id) return;
		clearTimeout(unheard);
		if (message.data.answer.kind !== "waiting") resolve(message.data.answer);
	};
	try {
		if (signal?.aborted) cancelled();
		else channel.postMessage({ kind: "ask", id, ...ask });
		return await promise;
	} finally {
		clearTimeout(unheard);
		signal?.removeEventListener("abort", cancelled);
		channel.close();
	}
}

const markerPath = (sessionFile: string): string => path.join(sessionArtifactsDir(sessionFile), "flow.splittable");

export async function markSplittable(childFile: string): Promise<void> {
	const file = markerPath(childFile);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "");
}

const paramsSchema = z.object({
	parts: z
		.array(z.string())
		.min(2)
		.describe(
			'The pieces, at least two. Each is the JSON text of one value that takes the place of the assignment\'s fanned input, in the same form as that input (a string piece is written with its quotes, as `"src/a.ts"`).',
		),
	details: z
		.string()
		.min(1)
		.describe(
			"What the author of the flow needs to judge the split: why the assignment is too large for one session, what each piece covers, and how the pieces together cover everything left undone.",
		),
});

const DESCRIPTION = [
	"Ask the author of the flow that started this session to split its assignment into pieces, each done by a fork of this session in an isolated workspace.",
	"The call blocks until the author agrees or disagrees. On agree, yield the split status your assignment describes at once. On disagree, the result gives the author's reason and you continue this session.",
].join(" ");

function text(value: string, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

export function registerSplitTool(pi: ExtensionAPI): void {
	const tool: ToolDefinition<typeof paramsSchema> = {
		name: SPLIT_TOOL,
		label: tr("Flow Split", "流程拆分"),
		description: DESCRIPTION,
		loadMode: "essential",
		defaultInactive: true,
		parameters: paramsSchema,
		execute: async (_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionContext) => {
			const params = paramsSchema.parse(rawParams);
			const decision = await askSplit({ session: ctx.agent.id, parts: params.parts, details: params.details }, signal);
			switch (decision.kind) {
				case "agreed":
					return text(
						'The author agreed to the split. Yield `{"status": "split", "handoff": {…}}` now, as your only remaining step: do not work on the pieces, each goes to a fork of this session.',
					);
				case "disagreed":
					return text(`The author disagreed with the split, so continue this session yourself. The author's reason: ${decision.reason}`);
				case "refused":
					return text(`The split request was refused: ${decision.reason}`, true);
				default: {
					const unreachable: never = decision;
					return unreachable;
				}
			}
		},
	};
	pi.registerTool(omompTool(tool));
	pi.on("session_start", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (ctx.agent.kind !== "sub" || !file || (await readOptional(markerPath(file))) === undefined) return;
		await applyActiveTools(pi, [...pi.getActiveTools(), SPLIT_TOOL]);
	});
}
