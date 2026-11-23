import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import { completeRoles, MEDIUM_EFFORT } from "./role-chain.ts";

const ROLE = "omp-subagent-more";

export const VERDICTS_LOG = "omp-subagent-more report-limit verdicts";

export const DEADLINE_MS = 25_000;

const itemSchema = z.object({ task: z.string(), name: z.string().optional(), agent: z.string().optional() }).passthrough();
const callSchema = z.object({ context: z.string().optional(), tasks: z.array(itemSchema) }).passthrough();
type Item = z.infer<typeof itemSchema>;

export type Verdict = { readonly kind: "flagged" } | { readonly kind: "clear" } | { readonly kind: "unknown"; readonly why: string };

export type Answer = { readonly kind: "text"; readonly text: string } | { readonly kind: "failed"; readonly why: string };

export const SYSTEM_PROMPT = [
	"You check one dispatch that an orchestrating agent is about to send to a single worker agent: a shared context describing the whole batch, plus one assignment for this worker.",
	"## Question `report-limit`",
	[
		"Does the dispatch limit the length of the report the worker returns: a cap on words, characters, lines, tokens, sentences, bullets or paragraphs, or an instruction to keep the report or answer short, brief or within some size?",
		"For this question both the shared context and the assignment count: a length limit in either one applies to this worker.",
		"Not a report limit: size requirements on a deliverable the worker writes into the repository or a file (a 200-word README section, a function under 50 lines); instructions to write a long report to a file and return its path.",
		"`true` if the dispatch limits the report length, `false` otherwise.",
	].join("\n"),
	"Answer with exactly one line, in the form `report-limit: true` or `report-limit: false`, and nothing else.",
].join("\n\n");

export const renderPrompt = (context: string | undefined, task: string): string =>
	["<shared-context>", context?.trim() || "(none)", "</shared-context>", "<assignment>", task.trim(), "</assignment>"].join("\n");

export function digest(context: string | undefined, task: string): string {
	const contextText = context?.trim() || "(none)";
	const taskText = task.trim();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${contextText.length}:${taskText.length}\0`);
	hasher.update(contextText);
	hasher.update("\0");
	hasher.update(taskText);
	return hasher.digest("hex");
}

export function parseAnswer(text: string): Verdict {
	const line = /^[\s`*-]*report-limit[`*]*\s*:\s*[`*]*(true|false)\b/im.exec(text);
	if (line === null) return { kind: "unknown", why: `unparseable answer: ${text.slice(0, 80)}` };
	return line[1]?.toLowerCase() === "true" ? { kind: "flagged" } : { kind: "clear" };
}

export const blockReason = (labels: string): string =>
	`禁止限制 task 系列 subagent 的报告字数：${labels} 的共享 context 或 task 限制了报告长度。删掉字数/长度限制后重新派发；报告长时让 worker 写入文件（如 \`local://<name>.md\`）并在回复里给出路径，而不是直接汇报全文。`;

export type Log = (message: string, data: Record<string, unknown>) => void;

export type Ask = (systemPrompt: string, prompt: string, signal: AbortSignal, deadlineAt: number) => Promise<Answer>;

export function createReportLimit(log: { info: Log; warn: Log }) {
	const cleared = new Set<string>();

	const judge = async (
		ask: Ask,
		context: string | undefined,
		item: Item,
		label: string,
		signal: AbortSignal,
		deadlineAt: number,
	): Promise<Verdict> => {
		const key = digest(context, item.task);
		if (cleared.has(key)) return { kind: "clear" };
		const answer = await ask(SYSTEM_PROMPT, renderPrompt(context, item.task), signal, deadlineAt);
		const verdict: Verdict = answer.kind === "text" ? parseAnswer(answer.text) : { kind: "unknown", why: answer.why };
		if (verdict.kind === "clear") cleared.add(key);
		if (verdict.kind === "unknown") log.warn("omp-subagent-more report-limit check failed", { item: label, error: verdict.why });
		return verdict;
	};

	return {
		async inspect(toolName: string, input: unknown, ask: Ask): Promise<string | null> {
			if (toolName !== "fork_task") return null;
			const call = callSchema.safeParse(input);
			if (!call.success) return null;
			const { context, tasks } = call.data;
			const judged = tasks.flatMap((item, index) =>
				item.agent === undefined || item.agent.startsWith("task:") ? [{ item, label: `\`${item.name ?? `item ${index + 1}`}\`` }] : [],
			);
			if (judged.length === 0) return null;
			const deadlineAt = Date.now() + DEADLINE_MS;
			const signal = AbortSignal.timeout(DEADLINE_MS);
			const verdicts = await Promise.all(judged.map(({ item, label }) => judge(ask, context, item, label, signal, deadlineAt)));
			log.info(VERDICTS_LOG, { verdicts: judged.map(({ label }, i) => ({ label, "report-limit": verdicts[i] })) });
			const flagged = judged.filter((_entry, i) => verdicts[i]?.kind === "flagged").map(({ label }) => label);
			return flagged.length === 0 ? null : blockReason(flagged.join("、"));
		},
	};
}

export function registerReportLimit(pi: ExtensionAPI): void {
	const reportLimit = createReportLimit({
		info: (message, data) => pi.logger.info(message, data),
		warn: (message, data) => pi.logger.warn(message, data),
	});
	// A throwing tool_call handler blocks the tool, so every failure lets the call run.
	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = await reportLimit.inspect(event.toolName, event.input, async (systemPrompt, prompt, signal, deadlineAt) => {
				const reply = await completeRoles(ctx, [ROLE, "default"], systemPrompt, prompt, MEDIUM_EFFORT, deadlineAt, signal);
				switch (reply.kind) {
					case "text":
						pi.logger.info("omp-subagent-more report-limit answered", { model: reply.model, failures: reply.failures });
						return { kind: "text", text: reply.text };
					case "no-model":
						return { kind: "failed", why: `no model: assign @${ROLE} or the default role in /model` };
					case "deadline":
						return { kind: "failed", why: "deadline" };
					case "all-failed":
						return { kind: "failed", why: `every model failed: ${reply.failures.join("; ")}` };
					case "error":
						return { kind: "failed", why: reply.error };
					default: {
						const unreachable: never = reply;
						return unreachable;
					}
				}
			});
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("omp-subagent-more report-limit skipped a fork_task call", { error: errorText(error) });
			return undefined;
		}
	});
}
