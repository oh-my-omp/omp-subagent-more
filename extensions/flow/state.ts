import { type Box, type Json, parseBox } from "./defs.ts";

export type Outcome =
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raise"; readonly type: string; readonly detail: string; readonly handoff: Json }
	| { readonly kind: "split"; readonly parts: readonly Json[]; readonly handoff: Json }
	| { readonly kind: "rejected"; readonly output: string }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

export type Earlier = { readonly session: string; readonly yielded: boolean };

export type Continuation =
	| { readonly kind: "answer"; readonly answer: Json; readonly previous: Json }
	| {
			readonly kind: "check";
			readonly check: string;
			readonly output: string;
			readonly snapshot: Readonly<Record<string, Json>>;
			readonly previous: Json;
	  }
	| { readonly kind: "part"; readonly part: number; readonly of: number };

export type Action =
	| { readonly kind: "defined"; readonly boxes: Readonly<Record<string, Json>>; readonly noEscape: boolean | undefined }
	| { readonly kind: "supplied"; readonly name: string; readonly value: Json }
	| { readonly kind: "observed"; readonly agents: Readonly<Record<string, string | null>> }
	| { readonly kind: "retracted"; readonly keys: readonly string[] }
	| { readonly kind: "kept"; readonly keys: readonly string[] }
	| { readonly kind: "retried"; readonly keys: readonly string[] }
	| { readonly kind: "answered"; readonly key: string; readonly value: Json }
	| { readonly kind: "started" }
	| { readonly kind: "resumed" }
	| { readonly kind: "halted"; readonly reason: string }
	| { readonly kind: "idled" }
	| {
			readonly kind: "fired";
			readonly key: string;
			readonly box: string;
			readonly attempt: number;
			readonly continuation: Continuation | null;
			readonly inputs: Readonly<Record<string, Json>>;
	  }
	| { readonly kind: "spawned"; readonly key: string; readonly attempt: number; readonly session: string }
	| { readonly kind: "settled"; readonly key: string; readonly attempt: number; readonly outcome: Outcome };

export type Phase =
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raised"; readonly type: string; readonly detail: string; readonly handoff: Json }
	| { readonly kind: "split"; readonly parts: readonly Json[]; readonly handoff: Json }
	| {
			readonly kind: "reopened";
			readonly check: string;
			readonly output: string;
			readonly snapshot: Readonly<Record<string, Json>>;
			readonly handoff: Json;
	  }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "retry"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

export type Item = {
	readonly key: string;
	readonly box: string;
	readonly attempt: number;
	readonly depth: number;
	readonly fingerprint: string;
	readonly phase: Phase;
	readonly chain: number;
	readonly refires: Readonly<Record<string, number>>;
	readonly inputs: Readonly<Record<string, Json>>;
	readonly continuation: Continuation | null;
	readonly answer: Json | undefined;
	readonly session: string | undefined;
	readonly last: Earlier | undefined;
};

export type StopCause =
	| { readonly kind: "exception"; readonly key: string; readonly name: string; readonly reason: string }
	| { readonly kind: "halt"; readonly reason: string };

export type Mode = { readonly kind: "idle" } | { readonly kind: "running" } | { readonly kind: "stopped"; readonly cause: StopCause };

export type State = {
	readonly raw: Readonly<Record<string, Json>>;
	readonly boxes: Readonly<Record<string, Box>>;
	readonly inputs: Readonly<Record<string, Json>>;
	readonly agents: Readonly<Record<string, string>>;
	readonly items: Readonly<Record<string, Item>>;
	readonly mode: Mode;
	readonly noEscape: boolean;
};

export const EMPTY: State = { raw: {}, boxes: {}, inputs: {}, agents: {}, items: {}, mode: { kind: "idle" }, noEscape: false };

const TRANSIENT: Record<string, true> = { session: true, timeout: true, protocol: true, schema: true };

export const nextChain = (earlier: Item | undefined): number =>
	earlier === undefined ? 1 : earlier.phase.kind === "raised" || earlier.phase.kind === "reopened" ? earlier.chain + 1 : earlier.chain;

export const definitionKey = (agent: string): string => `definition ${agent}`;
export const modelKey = (agent: string): string => `model ${agent}`;

export const markOf = (state: State, box: Box): string =>
	box.kind === "agent"
		? `${box.fingerprint}+${state.agents[definitionKey(box.agent)] ?? "unknown"}+${state.agents[modelKey(box.model ?? box.agent)] ?? "unknown"}`
		: box.fingerprint;

export type KeyParts = {
	readonly box: string;
	readonly path: readonly number[] | undefined;
	readonly source: { readonly key: string; readonly attempt: number } | undefined;
};

export const itemKey = (box: string, path: readonly number[]): string => `${box}#${path.join(".")}`;
export const childKey = (key: string, part: number): string => `${key}.${part}`;
export const answerKey = (box: string, sourceKey: string, attempt: number): string => `${box}<${sourceKey}@${attempt}>`;

export function partsOf(key: string): KeyParts {
	const open = key.indexOf("<");
	if (open >= 0 && key.endsWith(">")) {
		const inner = key.slice(open + 1, -1);
		const at = inner.lastIndexOf("@");
		return { box: key.slice(0, open), path: undefined, source: { key: inner.slice(0, at), attempt: Number(inner.slice(at + 1)) } };
	}
	const hash = key.indexOf("#");
	if (hash >= 0)
		return {
			box: key.slice(0, hash),
			path: key
				.slice(hash + 1)
				.split(".")
				.map(Number),
			source: undefined,
		};
	return { box: key, path: undefined, source: undefined };
}

export function parentKey(key: string): string | undefined {
	const parts = partsOf(key);
	return parts.path === undefined || parts.path.length < 2 ? undefined : itemKey(parts.box, parts.path.slice(0, -1));
}

export const isFanned = (box: Box | undefined): boolean =>
	box !== undefined && Object.values(box.inputs).some((ref) => ref.multi && ref.source.kind !== "raise");

export function checkedKeys(boxes: Readonly<Record<string, Box>>, key: string): readonly string[] {
	const parts = partsOf(key);
	const checks = boxes[parts.box]?.checks;
	if (checks === undefined) return [];
	return checks.boxes.flatMap((target) => {
		if (!isFanned(boxes[target])) return [target];
		return parts.path === undefined ? [] : [itemKey(target, parts.path)];
	});
}

function dependents(state: State, changedInputs: ReadonlySet<string>, changedItems: ReadonlySet<string>): Set<string> {
	const gone = new Set(changedItems);
	const goneBoxes = new Set([...gone].map((key) => partsOf(key).box));
	const found = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const item of Object.values(state.items)) {
			if (gone.has(item.key)) continue;
			const box = state.boxes[item.box];
			if (!box) continue;
			const parts = partsOf(item.key);
			const parent = parentKey(item.key);
			const orphaned = parent !== undefined && gone.has(parent);
			const hit =
				orphaned ||
				Object.values(box.inputs).some((ref) => {
					switch (ref.source.kind) {
						case "input":
							return changedInputs.has(ref.source.name);
						case "raise":
							return parts.source !== undefined && gone.has(parts.source.key);
						case "box": {
							const mirrored = ref.multi && ref.path.length === 0 && isFanned(state.boxes[ref.source.box]);
							return mirrored && parts.path !== undefined ? gone.has(itemKey(ref.source.box, parts.path)) : goneBoxes.has(ref.source.box);
						}
						default: {
							const unreachable: never = ref.source;
							return unreachable;
						}
					}
				});
			if (!hit) continue;
			gone.add(item.key);
			goneBoxes.add(item.box);
			found.add(item.key);
			grew = true;
		}
	}
	return found;
}

const without = <T>(record: Readonly<Record<string, T>>, keys: Iterable<string>): Record<string, T> => {
	const copy = { ...record };
	for (const key of keys) delete copy[key];
	return copy;
};

function settle(state: State, ended: Item, outcome: Outcome): State {
	const yielded = outcome.kind === "done" || outcome.kind === "raise" || outcome.kind === "split";
	const item: Item = ended.session === undefined ? ended : { ...ended, last: { session: ended.session, yielded } };
	const put = (phase: Phase, extra: Partial<Item> = {}): State => ({
		...state,
		items: { ...state.items, [item.key]: { ...item, ...extra, phase } },
	});
	const fail = (name: string, said: string): State => {
		const allowed = state.boxes[item.box]?.handle[name] ?? (state.noEscape && TRANSIENT[name] === true ? 1 : 0);
		const spent = item.refires[name] ?? 0;
		if (spent < allowed) return put({ kind: "retry", name, reason: said }, { refires: { ...item.refires, [name]: spent + 1 } });
		const failed = put({ kind: "failed", name, reason: said });
		return state.mode.kind === "running"
			? { ...failed, mode: { kind: "stopped", cause: { kind: "exception", key: item.key, name, reason: said } } }
			: failed;
	};
	const reject = (output: string): State => {
		const gate = state.boxes[item.box];
		const keys = checkedKeys(state.boxes, item.key);
		const targets: { readonly item: Item; readonly bound: number; readonly handoff: Json }[] = [];
		for (const key of keys) {
			const checked = state.items[key];
			const checkedBox = checked === undefined ? undefined : state.boxes[checked.box];
			if (checked?.phase.kind !== "done" || checkedBox?.kind !== "agent") break;
			targets.push({ item: checked, bound: checkedBox.bound, handoff: checked.phase.handoff });
		}
		if (keys.length === 0 || targets.length !== keys.length) return fail(gate?.kind === "agent" ? "protocol" : "exit", output);
		const spent = targets.filter((target) => target.item.chain >= target.bound);
		if (spent.length > 0) {
			const which = spent.map((target) => `\`${target.item.key}\``).join(", ");
			const bounds = spent.map((target) => target.bound).join(", ");
			return fail(
				"bound_exceeded",
				`\`${item.box}\` rejected the result of ${which} in its last allowed session (bound ${bounds}): ${output}`,
			);
		}
		const gone = dependents(state, new Set(), new Set(keys));
		const items = without(state.items, gone);
		for (const target of targets) {
			items[target.item.key] = {
				...target.item,
				phase: { kind: "reopened", check: item.box, output, snapshot: item.inputs, handoff: target.handoff },
			};
		}
		return { ...state, items };
	};
	switch (outcome.kind) {
		case "done":
			return put({ kind: "done", value: outcome.value, handoff: outcome.handoff });
		case "raise": {
			const box = state.boxes[item.box];
			if (box?.kind === "agent" && item.chain >= box.bound) {
				return fail(
					"bound_exceeded",
					`raised \`${outcome.type}\` again after ${item.chain - 1} answered raises (bound ${box.bound}): ${outcome.detail}`,
				);
			}
			return put({ kind: "raised", type: outcome.type, detail: outcome.detail, handoff: outcome.handoff });
		}
		case "split":
			return put({ kind: "split", parts: outcome.parts, handoff: outcome.handoff });
		case "rejected":
			return reject(outcome.output);
		case "failed":
			return fail(outcome.name, outcome.reason);
		case "cancelled":
			return put({ kind: "cancelled" });
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

export function reduce(state: State, action: Action): State {
	switch (action.kind) {
		case "defined": {
			const raw = { ...state.raw };
			const boxes = { ...state.boxes };
			for (const [name, data] of Object.entries(action.boxes)) {
				if (data === null) {
					delete raw[name];
					delete boxes[name];
					continue;
				}
				const parsed = parseBox(name, data);
				if (!parsed.ok) continue;
				raw[name] = data;
				boxes[name] = parsed.value;
			}
			return { ...state, raw, boxes, noEscape: action.noEscape ?? state.noEscape };
		}
		case "supplied": {
			const gone = dependents(state, new Set([action.name]), new Set());
			return { ...state, inputs: { ...state.inputs, [action.name]: action.value }, items: without(state.items, gone) };
		}
		case "observed": {
			const agents = { ...state.agents };
			for (const [name, mark] of Object.entries(action.agents)) {
				if (mark === null) delete agents[name];
				else agents[name] = mark;
			}
			return { ...state, agents };
		}
		case "retracted": {
			const inputs = action.keys.filter((key) => key.startsWith("input.")).map((key) => key.slice("input.".length));
			const items = action.keys.filter((key) => !key.startsWith("input."));
			const gone = dependents(state, new Set(inputs), new Set(items));
			return { ...state, inputs: without(state.inputs, inputs), items: without(state.items, [...items, ...gone]) };
		}
		case "kept": {
			const items = { ...state.items };
			for (const key of action.keys) {
				const item = items[key];
				const box = item ? state.boxes[item.box] : undefined;
				if (item && box) items[key] = { ...item, fingerprint: markOf(state, box) };
			}
			return { ...state, items };
		}
		case "retried": {
			const items = { ...state.items };
			for (const key of action.keys) {
				const item = items[key];
				if (item?.phase.kind === "failed")
					items[key] = { ...item, phase: { kind: "retry", name: item.phase.name, reason: item.phase.reason } };
			}
			return { ...state, items };
		}
		case "answered": {
			const item = state.items[action.key];
			if (!item) return state;
			return { ...state, items: { ...state.items, [action.key]: { ...item, answer: action.value } } };
		}
		case "started":
		case "resumed":
			return { ...state, mode: { kind: "running" } };
		case "halted":
			return { ...state, mode: { kind: "stopped", cause: { kind: "halt", reason: action.reason } } };
		case "idled":
			return state.mode.kind === "running" ? { ...state, mode: { kind: "idle" } } : state;
		case "fired": {
			const box = state.boxes[action.box];
			if (!box) return state;
			const earlier = state.items[action.key];
			const parentAt = parentKey(action.key);
			const parent = parentAt === undefined ? undefined : state.items[parentAt];
			const item: Item = {
				key: action.key,
				box: action.box,
				attempt: action.attempt,
				depth: earlier?.depth ?? (parent?.phase.kind === "split" ? parent.depth + 1 : 0),
				chain: nextChain(earlier),
				fingerprint: markOf(state, box),
				phase: { kind: "running" },
				refires: earlier?.refires ?? {},
				inputs: action.inputs,
				continuation: action.continuation,
				answer: undefined,
				session: undefined,
				last: earlier?.last,
			};
			return { ...state, items: { ...state.items, [action.key]: item } };
		}
		case "spawned": {
			const item = state.items[action.key];
			if (!item || item.attempt !== action.attempt) return state;
			return { ...state, items: { ...state.items, [action.key]: { ...item, session: action.session } } };
		}
		case "settled": {
			const item = state.items[action.key];
			if (!item || item.attempt !== action.attempt || item.phase.kind !== "running") return state;
			return settle(state, item, action.outcome);
		}
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

export const replay = (actions: Iterable<Action>): State => {
	let state = EMPTY;
	for (const action of actions) state = reduce(state, action);
	return state;
};
