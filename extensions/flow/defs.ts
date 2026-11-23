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
	readonly multi: boolean;
};

type Common = {
	readonly inputs: Readonly<Record<string, Ref>>;
	readonly handle: Readonly<Record<string, number>>;
	readonly limit: number | undefined;
	readonly fingerprint: string;
};

export type AgentBox = Common & {
	readonly kind: "agent";
	readonly agent: string;
	readonly model: string | undefined;
	readonly brief: string;
	readonly out: JsonObject;
	readonly raises: readonly string[];
	readonly isolated: boolean | undefined;
	readonly prepare: string | undefined;
	readonly bound: number;
};

export type Check = { readonly box: string; readonly rejects: readonly number[] };

export type CommandBox = Common & {
	readonly kind: "command";
	readonly command: string;
	readonly checks: Check | undefined;
};

export type Box = AgentBox | CommandBox;

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PATH_KEY = /^[^.[\]!#<>@\s]+$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

export const isName = (text: string): boolean => NAME.test(text);
export const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);
export const isObject = (value: Json): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

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
const COMMAND_KEYS: Record<string, true> = { command: true, in: true, handle: true, limit: true, checks: true, rejects: true };
const DEFAULT_REJECTS: readonly number[] = [1];
const isRejectCode = (value: Json): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 125;

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
		const rejectsRaw = raw.rejects;
		if (rejectsRaw !== undefined) {
			if (checksRaw === undefined) say("`rejects` belongs to a box that `checks` another");
			else if (!isArray(rejectsRaw) || rejectsRaw.length === 0 || !rejectsRaw.every(isRejectCode))
				say("`rejects` is a non-empty array of exit codes from 1 to 125");
		}
		if (problems.length > 0) return { ok: false, problems };
		const checks: Check | undefined =
			typeof checksRaw === "string"
				? { box: checksRaw, rejects: rejectsRaw !== undefined && isArray(rejectsRaw) ? rejectsRaw.filter(isRejectCode) : DEFAULT_REJECTS }
				: undefined;
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

export const textOf = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(value, null, 1));

export function fill(template: string, inputs: Readonly<Record<string, Json>>, quote: (text: string) => string = (text) => text): string {
	return template.replace(PLACEHOLDER, (_whole, name: string) => quote(textOf(inputs[name] ?? null)));
}

export const shellWord = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
