import { type AgentBox, type CommandBox, fill, isObject, type Json, type JsonObject, textOf } from "./defs.ts";
import type { Firing } from "./plan.ts";
import { SPLIT_TOOL } from "./split.ts";
import type { Continuation, Outcome } from "./state.ts";

const HANDOFF_SCHEMA: JsonObject = {
	type: "object",
	additionalProperties: false,
	required: ["did", "decided", "unverified"],
	properties: {
		did: { type: "string", description: "What was done and where things stand." },
		decided: { type: "array", items: { type: "string" }, description: "Choices made that the assignment did not dictate." },
		unverified: { type: "array", items: { type: "string" }, description: "What was not checked." },
	},
};

export const splittable = (box: AgentBox, depth: number): boolean => depth < box.splits;

const fannedInput = (box: AgentBox): string | undefined =>
	Object.entries(box.inputs).find(([, ref]) => ref.multi && ref.source.kind !== "raise")?.[0];

export function yieldSchema(box: AgentBox, depth: number): JsonObject {
	const raising = box.raises.length > 0;
	const splitting = splittable(box, depth);
	return {
		type: "object",
		additionalProperties: false,
		required: ["status", "handoff"],
		properties: {
			status: { enum: ["done", ...(raising ? ["raise"] : []), ...(splitting ? ["split"] : [])] },
			value: box.out,
			...(raising ? { raise: { enum: box.raises }, detail: { type: "string" } } : {}),
			handoff: HANDOFF_SCHEMA,
		},
	};
}

export type Surroundings = {
	readonly board: string;
	readonly inherited: boolean;
};

function continuationText(continuation: Exclude<Continuation, { kind: "part" }>): string {
	switch (continuation.kind) {
		case "answer":
			return [
				"## Continuation",
				"An earlier session worked on this same assignment and stopped to raise a question. You start fresh: nothing of that session reaches you except its handoff.",
				"Handoff of the earlier session:",
				textOf(continuation.previous),
				"Answer to what it raised:",
				textOf(continuation.answer),
			].join("\n");
		case "check":
			return [
				"## Continuation",
				`An earlier session finished this same assignment and handed its work back: its changes are in your workspace. Then the program ran the check \`${continuation.check}\` on that work, and the check failed. You start fresh: nothing of that session reaches you except its handoff.`,
				"Handoff of the earlier session:",
				textOf(continuation.previous),
				"Output of the failed check:",
				continuation.output,
				"Find what in the work makes the check fail and correct it. The check itself is not yours to change.",
			].join("\n");
		default: {
			const unreachable: never = continuation;
			return unreachable;
		}
	}
}

export function briefOf(box: AgentBox, firing: Firing, around: Surroundings): string {
	const brief = fill(box.brief, firing.inputs).trim();
	const continuation = firing.continuation;
	const parts =
		continuation?.kind === "part"
			? [
					[
						"## Your part",
						`The conversation above is yours up to your split, which the author of this flow approved. You are now one of ${continuation.of} forks of that session, each given one part, and what you changed before the split is in your workspace. This fork is given part ${continuation.part + 1}, and this assignment replaces the whole assignment above:`,
					].join("\n"),
					brief,
					"Do this part only: every other part is the assignment of another fork.",
				]
			: [brief];
	if (around.inherited && continuation?.kind !== "part") {
		parts.push(
			[
				"## Earlier work",
				"An earlier session of this same assignment ended before it could hand its work back. Its uncommitted changes are already in your workspace. Inspect them first (`git status`, `git diff`), keep what is right, and continue from there instead of starting over.",
			].join("\n"),
		);
	}
	parts.push(
		[
			"## Notes file",
			`\`${around.board}\` belongs to this assignment alone. Read it before you start: earlier sessions of this assignment may have left notes. Append short notes a later session would need (what you tried, what you found). It is scratch: your result and handoff go through \`yield\`, and nothing reads the notes for you.`,
		].join("\n"),
	);
	if (continuation !== null && continuation.kind !== "part") parts.push(continuationText(continuation));
	const finish = [
		"## How to finish",
		"Finish by calling `yield` with its `data` argument set to exactly one object. Never use `yield`'s `error` argument: it aborts the session and nothing of your work reaches anyone.",
		'- The assignment is complete: `{"status": "done", "value": <result>, "handoff": {…}}`, where `<result>` matches the result schema.',
	];
	if (box.raises.length > 0) {
		finish.push(
			`- You cannot complete it and guessing would be wrong: \`{"status": "raise", "raise": "<type>", "detail": "…", "handoff": {…}}\`, where \`<type>\` is one of ${box.raises.map((type) => `\`${type}\``).join(", ")} and \`detail\` says concretely what is needed. A raise is an ordinary result sent as \`data\`; it is answered, and a later session continues. No person reads this session: never use the \`ask\` tool.`,
		);
	}
	const input = fannedInput(box);
	if (splittable(box, firing.depth) && input !== undefined) {
		finish.push(
			`- The assignment is too large for one session and falls into pieces that can each be done and checked on their own: ask the author of this flow for a split with the \`${SPLIT_TOOL}\` tool, giving the pieces and the details the author needs to judge them. Each piece takes the place of the \`${input}\` input of this assignment, in the same form; together the pieces cover everything of this assignment you leave undone, and nothing of it comes back to you. The call blocks until the author answers. If the author disagrees, the tool result gives the reason and you continue this session. If the author agrees, yield \`{"status": "split", "handoff": {…}}\` at once and do not do the pieces yourself: each piece goes to a fork of this session, which keeps this conversation and starts in an isolated workspace from your changes.`,
		);
	}
	finish.push(
		"`handoff` is required either way: `did` (what you did and where things stand), `decided` (choices you made that the assignment did not dictate), `unverified` (what you did not check). A later session may continue from it and has nothing else of yours.",
	);
	parts.push(finish.join("\n"));
	return parts.join("\n\n");
}

export type CommandRun = {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly output: string;
};

const clipOutput = (text: string): string =>
	text.length > 8000 ? `${text.slice(0, 2000)}\n… ${text.length - 8000} characters left out …\n${text.slice(-6000)}` : text;

export function commandOutcome(box: CommandBox, run: CommandRun): Outcome {
	if (run.cancelled) return { kind: "cancelled" };
	const output = clipOutput(run.output.trim());
	if (run.timedOut) return { kind: "failed", name: "timeout", reason: output };
	if (run.exitCode === 0) return { kind: "done", value: run.output.trimEnd(), handoff: null };
	const said = `exit code ${run.exitCode ?? "unknown"}:\n${output}`;
	const rejected = box.checks !== undefined && run.exitCode !== undefined && box.checks.rejects.includes(run.exitCode);
	return rejected ? { kind: "rejected", output: said } : { kind: "failed", name: "exit", reason: said };
}

export function interpret(box: AgentBox, depth: number, data: Json | undefined, approved: readonly Json[] | undefined): Outcome {
	const protocol = (reason: string): Outcome => ({ kind: "failed", name: "protocol", reason });
	if (data === undefined || !isObject(data)) return protocol("the session ended without yielding an object");
	const handoff = data.handoff;
	if (handoff === undefined || !isObject(handoff)) return protocol("the yielded object has no handoff");
	if (data.status === "done") {
		if (!("value" in data)) return protocol("`status` is `done` but there is no `value`");
		return { kind: "done", value: data.value ?? null, handoff };
	}
	if (data.status === "raise") {
		const type = data.raise;
		if (typeof type !== "string" || !box.raises.includes(type))
			return protocol(`raised \`${String(type)}\`, which the box does not declare`);
		return { kind: "raise", type, detail: typeof data.detail === "string" ? data.detail : "", handoff };
	}
	if (data.status === "split") {
		if (!splittable(box, depth)) return protocol("split, which this session may not do: its box allows no further split");
		if (approved === undefined)
			return protocol(`yielded \`split\` without a split the author of the flow approved through \`${SPLIT_TOOL}\``);
		return { kind: "split", parts: approved, handoff };
	}
	return protocol(`unknown status \`${String(data.status)}\``);
}
