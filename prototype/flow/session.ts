// What one session of an agent box is told and what it must hand back.
//
// A session returns exactly one object through `yield`: the result, or one of the exception
// types its box declares. Either way it carries a handoff, because the next session of the item
// (after an answer, or after a failure) starts fresh and has nothing else of this one.
import { type AgentBox, fill, isObject, type Json, type JsonObject, textOf } from "./defs.ts";
import type { Firing } from "./plan.ts";
import type { Outcome } from "./state.ts";

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

/** JSON Schema of the object a session of `box` yields. */
export function yieldSchema(box: AgentBox): JsonObject {
	const raising = box.raises.length > 0;
	return {
		type: "object",
		additionalProperties: false,
		required: ["status", "handoff"],
		properties: {
			status: { enum: raising ? ["done", "raise"] : ["done"] },
			value: box.out,
			...(raising ? { raise: { enum: box.raises }, detail: { type: "string" } } : {}),
			handoff: HANDOFF_SCHEMA,
		},
	};
}

/** The assignment of one session: the box's brief with its inputs, what came before, and how to finish. */
export function briefOf(box: AgentBox, firing: Firing): string {
	const parts = [fill(box.brief, firing.inputs).trim()];
	if (firing.continuation) {
		parts.push(
			[
				"## Continuation",
				"An earlier session worked on this same assignment and stopped to raise a question. You start fresh: nothing of that session reaches you except its handoff.",
				"Handoff of the earlier session:",
				textOf(firing.continuation.previous),
				"Answer to what it raised:",
				textOf(firing.continuation.answer),
			].join("\n"),
		);
	}
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
	finish.push(
		"`handoff` is required either way: `did` (what you did and where things stand), `decided` (choices you made that the assignment did not dictate), `unverified` (what you did not check). A later session may continue from it and has nothing else of yours.",
	);
	parts.push(finish.join("\n"));
	return parts.join("\n\n");
}

/** A session's yielded data as the outcome of its attempt; data outside the protocol is a named runtime exception. */
export function interpret(box: AgentBox, data: Json | undefined): Outcome {
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
	return protocol(`unknown status \`${String(data.status)}\``);
}
