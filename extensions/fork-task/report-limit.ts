/**
 * report-limit: a `tool_call` check on `fork_task`, in every session. Items whose
 * `agent` is `task:*` or omitted are judged; the question is whether the shared
 * `context` or the item's `task` caps the length of the report the worker
 * returns. Items are judged concurrently, one model request each, under one
 * 25 s deadline (below the harness's 30 s `tool_call` handler timeout). Any
 * flagged item blocks the whole call with one reason naming the flagged items.
 *
 * Only `clear` verdicts are remembered (per process, keyed by sha256 over the
 * trimmed context and task), so a flagged dispatch resent unchanged is judged
 * and blocked again. No model, a failed or timed-out request, or an answer that
 * does not parse is `unknown`: it is logged and lets the call run. Every call
 * that judged at least one item logs one `omp-subagent-more report-limit verdicts`
 * line with each item's verdict.
 */
import { z } from "@oh-my-pi/pi-coding-agent";

/** Log message of the per-call verdict line, named after this plugin so it is not mistaken for another check's verdicts. */
export const VERDICTS_LOG = "omp-subagent-more report-limit verdicts";

export const DEADLINE_MS = 25_000;

const itemSchema = z.object({ task: z.string(), name: z.string().optional(), agent: z.string().optional() }).passthrough();
const callSchema = z.object({ context: z.string().optional(), tasks: z.array(itemSchema) }).passthrough();
type Item = z.infer<typeof itemSchema>;

export type Verdict = { readonly kind: "flagged" } | { readonly kind: "clear" } | { readonly kind: "unknown"; readonly why: string };

/** A model answer to the question, or why none came back. */
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

/** Length-framed sha256 over the trimmed fragments `renderPrompt` joins, so fragment boundaries cannot collide. */
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

/** The model call, for one rendered prompt; `signal` aborts at the shared deadline `deadlineAt` (epoch ms). */
export type Ask = (systemPrompt: string, prompt: string, signal: AbortSignal, deadlineAt: number) => Promise<Answer>;

/** One process's check: `inspect` returns the block reason, or null to let the call run. */
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
			// Task-series workers, and forks that keep the source's agent.
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
