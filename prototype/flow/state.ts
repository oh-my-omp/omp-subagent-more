// The state of a flow is a fold over its actions; nothing else is stored.
//
// An item is one unit of a box's work: the box itself, one element of a fanned-out input
// (`box#3`), or the answer to one raise (`box<work#1@2>`: `work#1` raised in its session 2).
// Every session of an item is a new attempt; no attempt continues an earlier session.
//
// A value that changes takes the values computed from it with it: supplying an input again or
// retracting an item removes every item that depends on it.
//
// What an agent box runs is its own definition, the definition of the agent it names, and the
// model setting it uses. The last two live outside the flow, so the state holds a mark of each
// as last observed, and an item records all three under which it ran.
import { type Box, type Json, parseBox } from "./defs.ts";

export type Outcome =
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raise"; readonly type: string; readonly detail: string; readonly handoff: Json }
	/** A check ran and rejected the result it checks. This is the check's verdict, not an exception. */
	| { readonly kind: "rejected"; readonly output: string }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

/** An ended session of an item: a later session of the same item starts from what it left. */
export type Earlier = { readonly session: string; readonly yielded: boolean };

/** What a session that follows an earlier one of its item is given besides the box's inputs; `previous` is the earlier handoff. */
export type Continuation =
	/** The earlier session raised, and this is the answer. */
	| { readonly kind: "answer"; readonly answer: Json; readonly previous: Json }
	/** The earlier session finished, and the check box `check` failed on its result with this output. */
	| { readonly kind: "check"; readonly check: string; readonly output: string; readonly previous: Json };

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
	/** Where the session of an attempt can be read from outside the flow. */
	| { readonly kind: "spawned"; readonly key: string; readonly attempt: number; readonly session: string }
	| { readonly kind: "settled"; readonly key: string; readonly attempt: number; readonly outcome: Outcome };

export type Phase =
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly value: Json; readonly handoff: Json }
	| { readonly kind: "raised"; readonly type: string; readonly detail: string; readonly handoff: Json }
	/** A check on the item's result failed: the item continues in a new session that is given the check's output. */
	| { readonly kind: "reopened"; readonly check: string; readonly output: string; readonly handoff: Json }
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
	/** Sessions of this item that followed one another through answered raises and failed checks, this one included. */
	readonly chain: number;
	/** How many times each handled runtime exception has already made this item fire again. */
	readonly refires: Readonly<Record<string, number>>;
	readonly continuation: Continuation | null;
	/** An answer to the item's raise given from outside the flow. */
	readonly answer: Json | undefined;
	/** Id of the latest attempt's session, once it has one. */
	readonly session: string | undefined;
	/** The last session of this item that ran to an end, and whether it ended by yielding. */
	readonly last: Earlier | undefined;
};

export type StopCause =
	| { readonly kind: "exception"; readonly key: string; readonly name: string; readonly reason: string }
	/** Stopped from outside the flow: by its caller, or because the process driving it ended. */
	| { readonly kind: "halt"; readonly reason: string };

export type Mode = { readonly kind: "idle" } | { readonly kind: "running" } | { readonly kind: "stopped"; readonly cause: StopCause };

export type State = {
	readonly raw: Readonly<Record<string, Json>>;
	readonly boxes: Readonly<Record<string, Box>>;
	readonly inputs: Readonly<Record<string, Json>>;
	/** Marks as last observed, under `definitionKey(agent)` and `modelKey(agent)`. */
	readonly agents: Readonly<Record<string, string>>;
	readonly items: Readonly<Record<string, Item>>;
	readonly mode: Mode;
};

export const EMPTY: State = { raw: {}, boxes: {}, inputs: {}, agents: {}, items: {}, mode: { kind: "idle" } };

/** Where the mark of an agent's own definition (prompt, tools) is kept. */
export const definitionKey = (agent: string): string => `definition ${agent}`;
/** Where the mark of an agent's model setting is kept. */
export const modelKey = (agent: string): string => `model ${agent}`;

/** Identity of what a box runs now: an item produced under another mark is stale. */
export const markOf = (state: State, box: Box): string =>
	box.kind === "agent"
		? `${box.fingerprint}+${state.agents[definitionKey(box.agent)] ?? "unknown"}+${state.agents[modelKey(box.model ?? box.agent)] ?? "unknown"}`
		: box.fingerprint;

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

/** The item a check item checks: the item of the same index when the checked box is fanned, else its only item. */
export function checkedKey(boxes: Readonly<Record<string, Box>>, key: string): string | undefined {
	const parts = partsOf(key);
	const box = boxes[parts.box];
	if (box?.kind !== "command" || box.checks === undefined) return undefined;
	if (!isFanned(boxes[box.checks])) return box.checks;
	return parts.index === undefined ? undefined : itemKey(box.checks, parts.index);
}

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

function settle(state: State, ended: Item, outcome: Outcome): State {
	const yielded = outcome.kind === "done" || outcome.kind === "raise";
	const item: Item = ended.session === undefined ? ended : { ...ended, last: { session: ended.session, yielded } };
	const put = (phase: Phase, extra: Partial<Item> = {}): State => ({
		...state,
		items: { ...state.items, [item.key]: { ...item, ...extra, phase } },
	});
	const fail = (name: string, said: string): State => {
		const allowed = state.boxes[item.box]?.handle[name] ?? 0;
		const spent = item.refires[name] ?? 0;
		if (spent < allowed) return put({ kind: "retry", name, reason: said }, { refires: { ...item.refires, [name]: spent + 1 } });
		const failed = put({ kind: "failed", name, reason: said });
		return state.mode.kind === "running"
			? { ...failed, mode: { kind: "stopped", cause: { kind: "exception", key: item.key, name, reason: said } } }
			: failed;
	};
	// A check's rejection is the flow's own way back to the work it checks: that item continues in a
	// new session, and what was computed from its result, this check included, is gone with the result.
	const reject = (output: string): State => {
		const checkedAt = checkedKey(state.boxes, item.key);
		const checked = checkedAt === undefined ? undefined : state.items[checkedAt];
		const checkedBox = checked === undefined ? undefined : state.boxes[checked.box];
		if (checked?.phase.kind !== "done" || checkedBox?.kind !== "agent") return fail("exit", output);
		if (checked.chain >= checkedBox.bound) {
			return fail(
				"bound_exceeded",
				`\`${item.box}\` rejected the result of \`${checked.key}\` in its last allowed session (bound ${checkedBox.bound}): ${output}`,
			);
		}
		const gone = dependents(state, new Set(), new Set([checked.key]));
		const reopened: Item = { ...checked, phase: { kind: "reopened", check: item.box, output, handoff: checked.phase.handoff } };
		return { ...state, items: { ...without(state.items, gone), [checked.key]: reopened } };
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
			return { ...state, mode: { kind: "stopped", cause: { kind: "halt", reason: action.reason } } };
		case "idled":
			return state.mode.kind === "running" ? { ...state, mode: { kind: "idle" } } : state;
		case "fired": {
			const box = state.boxes[action.box];
			if (!box) return state;
			const earlier = state.items[action.key];
			const item: Item = {
				key: action.key,
				box: action.box,
				attempt: action.attempt,
				chain:
					earlier === undefined
						? 1
						: earlier.phase.kind === "raised" || earlier.phase.kind === "reopened"
							? earlier.chain + 1
							: earlier.chain,
				fingerprint: markOf(state, box),
				phase: { kind: "running" },
				refires: earlier?.refires ?? {},
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
