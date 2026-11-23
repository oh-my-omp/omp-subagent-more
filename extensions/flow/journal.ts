import * as fs from "node:fs";
import * as path from "node:path";
import { isArray, isObject, type Json, type JsonObject, parseJson } from "./defs.ts";
import type { Action, Continuation, Outcome } from "./state.ts";

class Fields {
	failed = false;
	constructor(readonly data: JsonObject) {}

	#miss<T>(fallback: T): T {
		this.failed = true;
		return fallback;
	}
	text(key: string): string {
		const value = this.data[key];
		return typeof value === "string" ? value : this.#miss("");
	}
	count(key: string): number {
		const value = this.data[key];
		return typeof value === "number" ? value : this.#miss(0);
	}
	json(key: string): Json {
		const value = this.data[key];
		return value === undefined ? this.#miss(null) : value;
	}
	texts(key: string): string[] {
		const value = this.data[key];
		if (value === undefined || !isArray(value)) return this.#miss([]);
		return value.map((entry) => (typeof entry === "string" ? entry : this.#miss("")));
	}
	object(key: string): JsonObject {
		const value = this.data[key];
		return value !== undefined && isObject(value) ? value : this.#miss({});
	}
}

function outcomeOf(data: JsonObject): Outcome | undefined {
	const fields = new Fields(data);
	let outcome: Outcome;
	switch (data.kind) {
		case "done":
			outcome = { kind: "done", value: fields.json("value"), handoff: fields.json("handoff") };
			break;
		case "raise":
			outcome = { kind: "raise", type: fields.text("type"), detail: fields.text("detail"), handoff: fields.json("handoff") };
			break;
		case "split": {
			const parts = fields.json("parts");
			if (!isArray(parts)) return undefined;
			outcome = { kind: "split", parts, handoff: fields.json("handoff") };
			break;
		}
		case "rejected":
			outcome = { kind: "rejected", output: fields.text("output") };
			break;
		case "failed":
			outcome = { kind: "failed", name: fields.text("name"), reason: fields.text("reason") };
			break;
		case "cancelled":
			outcome = { kind: "cancelled" };
			break;
		default:
			return undefined;
	}
	return fields.failed ? undefined : outcome;
}

function continuationOf(data: JsonObject): Continuation | undefined {
	const fields = new Fields(data);
	let continuation: Continuation;
	switch (data.kind) {
		case "answer":
			continuation = { kind: "answer", answer: fields.json("answer"), previous: fields.json("previous") };
			break;
		case "check":
			continuation = { kind: "check", check: fields.text("check"), output: fields.text("output"), previous: fields.json("previous") };
			break;
		case "part":
			continuation = { kind: "part", part: fields.count("part"), of: fields.count("of") };
			break;
		default:
			return undefined;
	}
	return fields.failed ? undefined : continuation;
}

export function actionOf(data: Json): Action | undefined {
	if (!isObject(data)) return undefined;
	const fields = new Fields(data);
	let action: Action;
	switch (data.kind) {
		case "defined":
			action = { kind: "defined", boxes: fields.object("boxes") };
			break;
		case "supplied":
			action = { kind: "supplied", name: fields.text("name"), value: fields.json("value") };
			break;
		case "observed": {
			const agents: Record<string, string | null> = {};
			for (const [name, mark] of Object.entries(fields.object("agents"))) {
				if (mark !== null && typeof mark !== "string") return undefined;
				agents[name] = mark;
			}
			action = { kind: "observed", agents };
			break;
		}
		case "retracted":
			action = { kind: "retracted", keys: fields.texts("keys") };
			break;
		case "kept":
			action = { kind: "kept", keys: fields.texts("keys") };
			break;
		case "retried":
			action = { kind: "retried", keys: fields.texts("keys") };
			break;
		case "answered":
			action = { kind: "answered", key: fields.text("key"), value: fields.json("value") };
			break;
		case "started":
			action = { kind: "started" };
			break;
		case "resumed":
			action = { kind: "resumed" };
			break;
		case "halted":
			action = { kind: "halted", reason: fields.text("reason") };
			break;
		case "idled":
			action = { kind: "idled" };
			break;
		case "fired": {
			const raw = fields.json("continuation");
			const continuation = raw === null ? null : isObject(raw) ? continuationOf(raw) : undefined;
			if (continuation === undefined) return undefined;
			action = { kind: "fired", key: fields.text("key"), box: fields.text("box"), attempt: fields.count("attempt"), continuation };
			break;
		}
		case "spawned":
			action = { kind: "spawned", key: fields.text("key"), attempt: fields.count("attempt"), session: fields.text("session") };
			break;
		case "settled": {
			const outcome = outcomeOf(fields.object("outcome"));
			if (!outcome) return undefined;
			action = { kind: "settled", key: fields.text("key"), attempt: fields.count("attempt"), outcome };
			break;
		}
		default:
			return undefined;
	}
	return fields.failed ? undefined : action;
}

export function readLog(file: string): Action[] {
	if (!fs.existsSync(file)) return [];
	const lines = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
	const actions: Action[] = [];
	for (const [index, line] of lines.entries()) {
		const data = parseJson(line);
		if (!data.ok) {
			if (index === lines.length - 1) break;
			throw new Error(`${file}: line ${index + 1} is not JSON`);
		}
		const action = actionOf(data.value);
		if (!action) throw new Error(`${file}: line ${index + 1} is not a flow action`);
		actions.push(action);
	}
	return actions;
}

export function appendLog(file: string, entry: Action): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
