// Flow definitions: boxes written as plain data and parsed once at the store boundary.
//
// A box is an agent box (`agent`, `brief`, `out`) or a command box (`command`). `in` maps
// input names to references, written as name paths:
//   "input.issue"       a value supplied from outside the flow
//   "scout.slices"      a field of the result of box `scout`
//   "scout.slices[]"    one item of this box per element of that array
//   "work!question"     one item of this box per item of `work` that raised `question`;
//                       its result answers the raise, and `work` continues in a new session
// A box takes at most one reference of the last two kinds.
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

export type RefSource =
	| { readonly kind: "input"; readonly name: string }
	| { readonly kind: "box"; readonly box: string }
	| { readonly kind: "raise"; readonly box: string; readonly type: string };

export type Ref = {
	readonly text: string;
	readonly source: RefSource;
	readonly path: readonly string[];
	/** The owning box gets one item per element (`[]`) or per raising item (`!type`). */
	readonly multi: boolean;
};

type Common = {
	readonly inputs: Readonly<Record<string, Ref>>;
	/** Named runtime exceptions this box answers by firing the item again, with the number of times. */
	readonly handle: Readonly<Record<string, number>>;
	/** Most items of this box in flight at once. */
	readonly limit: number | undefined;
	/** Identity of the definition: a value produced under another fingerprint is stale. */
	readonly fingerprint: string;
};

export type AgentBox = Common & {
	readonly kind: "agent";
	/** The agent definition whose system prompt and tools the sessions run with. */
	readonly agent: string;
	/** The agent whose model setting the sessions use; absent: that of `agent`. */
	readonly model: string | undefined;
	readonly brief: string;
	/** JSON Schema of the box's result. */
	readonly out: JsonObject;
	/** Exception types the agent may raise instead of returning a result. */
	readonly raises: readonly string[];
	/** `true`: each session in its own worktree; `false`: sessions share the caller's workspace on purpose; absent: the host decides. */
	readonly isolated: boolean | undefined;
	/** A command run in the session's workspace before the session's first turn. */
	readonly prepare: string | undefined;
	/** Most sessions one item may take through answered raises: the first, and one per answer. */
	readonly bound: number;
};

export type CommandBox = Common & {
	readonly kind: "command";
	readonly command: string;
	/** The box whose item this command checks: a non-zero exit reopens that item instead of stopping the flow. */
	readonly checks: string | undefined;
};

export type Box = AgentBox | CommandBox;

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PATH_KEY = /^[^.[\]!#<>@\s]+$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

export const isName = (text: string): boolean => NAME.test(text);
export const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);
export const isObject = (value: Json): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON text with object keys in sorted order, so equal data has equal text. */
export function stableText(value: Json): string {
	if (isArray(value)) return `[${value.map(stableText).join(",")}]`;
	if (isObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableText(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const fingerprintOf = (value: Json): string => createHash("sha256").update(stableText(value)).digest("hex").slice(0, 12);

export function parseJson(text: string): Result<Json> {
	try {
		// JSON.parse yields JSON data by construction; no runtime check can add to that.
		return { ok: true, value: JSON.parse(text) as Json };
	} catch (error) {
		return { ok: false, problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

export function parseRef(text: string): Result<Ref> {
	const bad = (why: string): Result<Ref> => ({ ok: false, problems: [`reference "${text}": ${why}`] });
	const each = text.endsWith("[]");
	const body = each ? text.slice(0, -2) : text;
	const bang = body.indexOf("!");
	if (bang >= 0) {
		const box = body.slice(0, bang);
		const type = body.slice(bang + 1);
		if (each) return bad("a raise port takes no `[]`; it already yields one item per raising item");
		if (!NAME.test(box) || !NAME.test(type)) return bad("expected `<box>!<type>`");
		return { ok: true, value: { text, source: { kind: "raise", box, type }, path: [], multi: true } };
	}
	const parts = body.split(".");
	const head = parts[0] ?? "";
	if (!NAME.test(head)) return bad("expected `<box>`, `<box>.<field>` or `input.<name>`");
	if (head === "input") {
		const name = parts[1] ?? "";
		if (!NAME.test(name)) return bad("expected `input.<name>`");
		const path = parts.slice(2);
		if (!path.every((key) => PATH_KEY.test(key))) return bad("empty or malformed field name");
		return { ok: true, value: { text, source: { kind: "input", name }, path, multi: each } };
	}
	const path = parts.slice(1);
	if (!path.every((key) => PATH_KEY.test(key))) return bad("empty or malformed field name");
	return { ok: true, value: { text, source: { kind: "box", box: head }, path, multi: each } };
}

const AGENT_KEYS: Record<string, true> = {
	agent: true,
	model: true,
	brief: true,
	in: true,
	out: true,
	raises: true,
	handle: true,
	isolated: true,
	prepare: true,
	limit: true,
	bound: true,
};
const COMMAND_KEYS: Record<string, true> = { command: true, in: true, handle: true, limit: true, checks: true };

/** One box from its plain-data form; every problem found is reported, not only the first. */
export function parseBox(name: string, raw: Json): Result<Box> {
	const problems: string[] = [];
	const say = (text: string): void => {
		problems.push(`${name}: ${text}`);
	};
	if (!NAME.test(name) || name === "input") return { ok: false, problems: [`"${name}" is not a usable box name`] };
	if (!isObject(raw)) return { ok: false, problems: [`${name}: a box is an object`] };
	const isAgent = "agent" in raw;
	const isCommand = "command" in raw;
	if (isAgent === isCommand) return { ok: false, problems: [`${name}: a box has exactly one of \`agent\` and \`command\``] };
	for (const key of Object.keys(raw)) {
		if ((isAgent ? AGENT_KEYS : COMMAND_KEYS)[key] !== true) say(`unknown field \`${key}\``);
	}

	const text = (key: string): string => {
		const value = raw[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
		say(`\`${key}\` is a non-empty string`);
		return "";
	};
	const count = (key: string, fallback: number | undefined): number | undefined => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
		say(`\`${key}\` is a positive integer`);
		return fallback;
	};
	const record = <T>(key: string, read: (entry: Json, field: string) => T | undefined): Record<string, T> => {
		const value = raw[key];
		const out: Record<string, T> = {};
		if (value === undefined) return out;
		if (!isObject(value)) {
			say(`\`${key}\` is an object`);
			return out;
		}
		for (const [field, entry] of Object.entries(value)) {
			if (!NAME.test(field)) {
				say(`\`${key}.${field}\` is not a usable name`);
				continue;
			}
			const parsed = read(entry, field);
			if (parsed !== undefined) out[field] = parsed;
		}
		return out;
	};

	const inputs = record<Ref>("in", (entry, field) => {
		if (typeof entry !== "string") {
			say(`\`in.${field}\` is a reference string`);
			return undefined;
		}
		const ref = parseRef(entry);
		if (ref.ok) return ref.value;
		for (const problem of ref.problems) say(problem);
		return undefined;
	});
	if (Object.values(inputs).filter((ref) => ref.multi).length > 1) say("at most one input may be `[]` or a raise port");
	const handle = record<number>("handle", (entry, field) => {
		if (typeof entry === "number" && Number.isInteger(entry) && entry > 0) return entry;
		say(`\`handle.${field}\` is a positive integer`);
		return undefined;
	});
	const limit = count("limit", undefined);
	const template = isAgent ? text("brief") : text("command");
	const prepare = isAgent && raw.prepare !== undefined ? text("prepare") : undefined;
	for (const match of `${template}\n${prepare ?? ""}`.matchAll(PLACEHOLDER)) {
		const used = match[1] ?? "";
		if (!(used in inputs)) say(`\`{{${used}}}\` names no input of this box`);
	}
	const fingerprint = fingerprintOf(raw);

	if (!isAgent) {
		const checksRaw = raw.checks;
		if (checksRaw !== undefined && (typeof checksRaw !== "string" || !NAME.test(checksRaw))) say("`checks` names a box");
		if (problems.length > 0) return { ok: false, problems };
		const checks = typeof checksRaw === "string" ? checksRaw : undefined;
		return { ok: true, value: { kind: "command", command: template, checks, inputs, handle, limit, fingerprint } };
	}

	const agent = text("agent");
	const modelRaw = raw.model;
	if (modelRaw !== undefined && (typeof modelRaw !== "string" || modelRaw.trim().length === 0)) say("`model` names an agent");
	const out = raw.out;
	if (out === undefined || !isObject(out)) say("`out` is the JSON Schema of the result");
	const raisesRaw = raw.raises;
	const raises: string[] = [];
	if (raisesRaw !== undefined) {
		if (!isArray(raisesRaw)) say("`raises` is an array of names");
		else
			for (const entry of raisesRaw) {
				if (typeof entry === "string" && NAME.test(entry)) raises.push(entry);
				else say("`raises` is an array of names");
			}
	}
	const isolatedRaw = raw.isolated;
	if (isolatedRaw !== undefined && typeof isolatedRaw !== "boolean") say("`isolated` is a boolean");
	const bound = count("bound", 3) ?? 3;
	if (problems.length > 0 || out === undefined || !isObject(out)) return { ok: false, problems };
	return {
		ok: true,
		value: {
			kind: "agent",
			agent,
			model: typeof modelRaw === "string" ? modelRaw : undefined,
			brief: template,
			out,
			raises,
			isolated: typeof isolatedRaw === "boolean" ? isolatedRaw : undefined,
			prepare,
			bound,
			inputs,
			handle,
			limit,
			fingerprint,
		},
	};
}

/** The text an input stands for: a string as written, anything else as JSON. */
export const textOf = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(value, null, 1));

/** `{{name}}` replaced by the input's text, passed through `quote`. */
export function fill(template: string, inputs: Readonly<Record<string, Json>>, quote: (text: string) => string = (text) => text): string {
	return template.replace(PLACEHOLDER, (_whole, name: string) => quote(textOf(inputs[name] ?? null)));
}

/** One POSIX shell word holding `text` exactly. */
export const shellWord = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
