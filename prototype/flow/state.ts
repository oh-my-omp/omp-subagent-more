// The state of a flow is a fold over its actions; nothing else is stored.
//
// An item is one unit of a box's work: the box itself, one element of a fanned-out input
// (`box#3`), or the answer to one raise (`box<work#1@2>`: `work#1` raised in its session 2).
// Every session of an item is a new attempt; no attempt continues an earlier session.
//
// A value that changes takes the values computed from it with it: supplying an input again or
// retracting an item removes every item that depends on it.
//
// What an agent box runs is its own definition plus the definition of the agent it names. The
// second lives outside the flow, so the state holds a mark of it as last observed, and an item
// records both under which it ran.
import { type Box, type Json, parseBox } from "./defs.ts";

export type Outcome =
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raise"; readonly type: string; readonly detail: string; readonly handoff: Json }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

/** What an attempt after an answered raise is given besides the box's inputs. */
export type Continuation = { readonly answer: Json; readonly previous: Json };

export type Action =
	/** Boxes in plain-data form; `null` drops a box. */
	| { readonly kind: "defined"; readonly boxes: Readonly<Record<string, Json>> }
	| { readonly kind: "supplied"; readonly name: string; readonly value: Json }
	/** Marks of agent definitions as observed outside the flow; `null` when there is no such agent. */
	| { readonly kind: "observed"; readonly agents: Readonly<Record<string, string | null>> }
	/** Item keys and `input.<name>` entries. */
	| { readonly kind: "retracted"; readonly keys: readonly string[] }
	| { readonly kind: "kept"; readonly keys: readonly string[] }
	/** Failed items the caller lets fire again as they are. */
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
	  }
	| { readonly kind: "settled"; readonly key: string; readonly attempt: number; readonly outcome: Outcome };

export type Phase =
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raised"; readonly type: string; readonly detail: string; readonly handoff: Json }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	/** A runtime exception the box handles: the item fires again. */
	| { readonly kind: "retry"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

export type Item = {
	readonly key: string;
	readonly box: string;
	readonly attempt: number;
	/** Mark of what the latest attempt ran under. */
	readonly fingerprint: string;
	readonly phase: Phase;
	/** Handled runtime exceptions already spent on this item. */
	readonly refires: number;
	readonly continuation: Continuation | null;
	/** An answer to the item's raise given from outside the flow. */
	readonly answer: Json | undefined;
};

export type StopCause =
	| { readonly kind: "exception"; readonly key: string; readonly name: string; readonly reason: string }
	| { readonly kind: "caller"; readonly reason: string };

export type Mode = { readonly kind: "idle" } | { readonly kind: "running" } | { readonly kind: "stopped"; readonly cause: StopCause };

export type State = {
	readonly raw: Readonly<Record<string, Json>>;
	readonly boxes: Readonly<Record<string, Box>>;
	readonly inputs: Readonly<Record<string, Json>>;
	/** Agent name → mark of its definition and model binding, as last observed. */
	readonly agents: Readonly<Record<string, string>>;
	readonly items: Readonly<Record<string, Item>>;
	readonly mode: Mode;
};

export const EMPTY: State = { raw: {}, boxes: {}, inputs: {}, agents: {}, items: {}, mode: { kind: "idle" } };

/** Identity of what a box runs now: an item produced under another mark is stale. */
export const markOf = (state: State, box: Box): string =>
	box.kind === "agent" ? `${box.fingerprint}+${state.agents[box.agent] ?? "unknown"}` : box.fingerprint;

export type KeyParts = {
	readonly box: string;
	readonly index: number | undefined;
	readonly source: { readonly key: string; readonly attempt: number } | undefined;
};

export const itemKey = (box: string, index: number): string => `${box}#${index}`;
export const answerKey = (box: string, sourceKey: string, attempt: number): string => `${box}<${sourceKey}@${attempt}>`;

export function partsOf(key: string): KeyParts {
	const open = key.indexOf("<");
	if (open >= 0 && key.endsWith(">")) {
		const inner = key.slice(open + 1, -1);
		const at = inner.lastIndexOf("@");
		return { box: key.slice(0, open), index: undefined, source: { key: inner.slice(0, at), attempt: Number(inner.slice(at + 1)) } };
	}
	const hash = key.indexOf("#");
	if (hash >= 0) return { box: key.slice(0, hash), index: Number(key.slice(hash + 1)), source: undefined };
	return { box: key, index: undefined, source: undefined };
}

/** A box whose items are the elements of an array input. */
export const isFanned = (box: Box | undefined): boolean =>
	box !== undefined && Object.values(box.inputs).some((ref) => ref.multi && ref.source.kind !== "raise");

/** Item keys whose inputs came from a changed input or item, transitively. */
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
			const hit = Object.values(box.inputs).some((ref) => {
				switch (ref.source.kind) {
					case "input":
						return changedInputs.has(ref.source.name);
					case "raise":
						return parts.source !== undefined && gone.has(parts.source.key);
					case "box": {
						const mirrored = ref.multi && ref.path.length === 0 && parts.index !== undefined && isFanned(state.boxes[ref.source.box]);
						return mirrored ? gone.has(itemKey(ref.source.box, parts.index ?? 0)) : goneBoxes.has(ref.source.box);
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

function settle(state: State, item: Item, outcome: Outcome): State {
	const put = (phase: Phase, extra: Partial<Item> = {}): State => ({
		...state,
		items: { ...state.items, [item.key]: { ...item, ...extra, phase } },
	});
	const fail = (name: string, reason: string): State => {
		const allowed = state.boxes[item.box]?.handle[name] ?? 0;
		if (item.refires < allowed) return put({ kind: "retry", name, reason }, { refires: item.refires + 1 });
		const failed = put({ kind: "failed", name, reason });
		return state.mode.kind === "running"
			? { ...failed, mode: { kind: "stopped", cause: { kind: "exception", key: item.key, name, reason } } }
			: failed;
	};
	switch (outcome.kind) {
		case "done":
			return put({ kind: "done", value: outcome.value, handoff: outcome.handoff });
		case "raise": {
			const box = state.boxes[item.box];
			if (box?.kind === "agent" && item.attempt >= box.bound) {
				return fail("bound_exceeded", `raised \`${outcome.type}\` in session ${item.attempt} of at most ${box.bound}: ${outcome.detail}`);
			}
			return put({ kind: "raised", type: outcome.type, detail: outcome.detail, handoff: outcome.handoff });
		}
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
				// The store refuses a definition with problems before it is logged; one that got here parses.
				const parsed = parseBox(name, data);
				if (!parsed.ok) continue;
				raw[name] = data;
				boxes[name] = parsed.value;
			}
			return { ...state, raw, boxes };
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
			return { ...state, mode: { kind: "stopped", cause: { kind: "caller", reason: action.reason } } };
		case "idled":
			return state.mode.kind === "running" ? { ...state, mode: { kind: "idle" } } : state;
		case "fired": {
			const box = state.boxes[action.box];
			if (!box) return state;
			const item: Item = {
				key: action.key,
				box: action.box,
				attempt: action.attempt,
				fingerprint: markOf(state, box),
				phase: { kind: "running" },
				refires: state.items[action.key]?.refires ?? 0,
				continuation: action.continuation,
				answer: undefined,
			};
			return { ...state, items: { ...state.items, [action.key]: item } };
		}
		case "settled": {
			const item = state.items[action.key];
			// A session that outlived its item (retracted, or fired again since) has nothing to report to.
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
