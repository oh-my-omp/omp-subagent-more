import { type Box, isArray, isObject, type Json, type Ref } from "./defs.ts";
import { answerKey, type Continuation, childKey, type Earlier, type Item, isFanned, itemKey, markOf, type State } from "./state.ts";

export type Firing = {
	readonly key: string;
	readonly box: string;
	readonly attempt: number;
	readonly inputs: Readonly<Record<string, Json>>;
	readonly continuation: Continuation | null;
	readonly earlier: Earlier | undefined;
	readonly depth: number;
};

export type Raised = { readonly key: string; readonly type: string; readonly detail: string; readonly handler: string | undefined };

export type Survey = {
	readonly problems: readonly string[];
	readonly stale: readonly string[];
	readonly illegal: readonly string[];
	readonly ready: readonly Firing[];
	readonly running: readonly string[];
	readonly raised: readonly Raised[];
	readonly needs: readonly string[];
	readonly waiting: readonly string[];
};

type Start = { readonly continuation: Continuation; readonly earlier: Earlier | undefined; readonly depth: number };
type Expected = {
	readonly key: string;
	readonly path: readonly number[];
	readonly inputs: Readonly<Record<string, Json>>;
	readonly start: Start | undefined;
};
type Expansion =
	| { readonly kind: "blocked" }
	| { readonly kind: "items"; readonly fanned: boolean; readonly input: string | undefined; readonly items: readonly Expected[] };
type Resolved = { readonly kind: "value"; readonly value: Json } | { readonly kind: "missing" };
type Leaf = { readonly path: readonly number[]; readonly value: Json };
type Produced =
	| { readonly kind: "one"; readonly value: Json }
	| { readonly kind: "many"; readonly leaves: readonly Leaf[] }
	| { readonly kind: "missing" };

const MISSING: Resolved = { kind: "missing" };
const UNPRODUCED: Produced = { kind: "missing" };

function walk(value: Json, path: readonly string[]): Resolved {
	let at = value;
	for (const key of path) {
		if (!isObject(at) || !(key in at)) return MISSING;
		at = at[key] ?? null;
	}
	return { kind: "value", value: at };
}

const handlersOf = (boxes: Readonly<Record<string, Box>>, box: string, type: string): string[] =>
	Object.entries(boxes)
		.filter(([, candidate]) =>
			Object.values(candidate.inputs).some((ref) => ref.source.kind === "raise" && ref.source.box === box && ref.source.type === type),
		)
		.map(([name]) => name)
		.sort();

export const handlerOf = (boxes: Readonly<Record<string, Box>>, box: string, type: string): string | undefined =>
	handlersOf(boxes, box, type)[0];

export function lint(boxes: Readonly<Record<string, Box>>): string[] {
	const problems: string[] = [];
	for (const [name, box] of Object.entries(boxes)) {
		for (const [input, ref] of Object.entries(box.inputs)) {
			if (ref.source.kind === "input") continue;
			const source = boxes[ref.source.box];
			if (!source) {
				problems.push(`${name}: in.${input} → no box \`${ref.source.box}\``);
				continue;
			}
			if (ref.source.kind === "raise" && !(source.kind === "agent" && source.raises.includes(ref.source.type))) {
				problems.push(`${name}: in.${input} → \`${ref.source.box}\` does not raise \`${ref.source.type}\``);
			}
		}
		if (box.kind === "command") {
			if (box.checks !== undefined) problems.push(...checkProblems(boxes, name, box.checks.box, Object.values(box.inputs)));
			continue;
		}
		for (const type of box.raises) {
			const handlers = handlersOf(boxes, name, type);
			if (handlers.length > 1) problems.push(`${name}!${type}: answered by more than one box (${handlers.join(", ")})`);
		}
		if (box.splits > 0 && !isFanned(box)) {
			problems.push(`${name}: \`splits\` needs a \`[]\` input; the parts of a split item take the place of its element`);
		}
		if (box.splits > 0 && box.isolated !== true) {
			problems.push(`${name}: \`splits\` needs \`isolated: true\`; the parts run as isolated forks of the splitting session`);
		}
	}
	const done = new Set<string>();
	const visit = (name: string, trail: readonly string[]): void => {
		if (trail.includes(name)) {
			problems.push(`cycle: ${[...trail.slice(trail.indexOf(name)), name].join(" → ")}`);
			return;
		}
		if (done.has(name)) return;
		for (const ref of Object.values(boxes[name]?.inputs ?? {})) {
			if (ref.source.kind === "box") visit(ref.source.box, [...trail, name]);
		}
		done.add(name);
	};
	for (const name of Object.keys(boxes).sort()) visit(name, []);
	return problems;
}

function checkProblems(boxes: Readonly<Record<string, Box>>, name: string, checked: string, inputs: readonly Ref[]): string[] {
	const target = boxes[checked];
	if (!target) return [`${name}: checks → no box \`${checked}\``];
	if (target.kind !== "agent") return [`${name}: checks → \`${checked}\` is a command box; only an agent box can be reopened`];
	if (Object.values(target.inputs).some((ref) => ref.source.kind === "raise")) {
		return [`${name}: checks → \`${checked}\` answers raises; its items cannot be reopened`];
	}
	const refs = inputs.filter((ref) => ref.source.kind === "box" && ref.source.box === checked);
	if (refs.length === 0) return [`${name}: checks \`${checked}\` but takes no input from it`];
	if (isFanned(target) && !refs.some((ref) => ref.multi && ref.path.length === 0)) {
		return [`${name}: \`${checked}\` has many items; take \`${checked}[]\` as an input so that each item is checked on its own`];
	}
	return [];
}

export function answerOf(state: State, item: Item): Json | undefined {
	if (item.phase.kind !== "raised") return undefined;
	if (item.answer !== undefined) return item.answer;
	const handler = handlerOf(state.boxes, item.box, item.phase.type);
	if (handler === undefined) return undefined;
	const answer = state.items[answerKey(handler, item.key, item.attempt)];
	return answer?.phase.kind === "done" ? answer.phase.value : undefined;
}

export function survey(state: State): Survey {
	const problems = lint(state.boxes);
	const names = Object.keys(state.boxes).sort();
	const cyclic = problems.some((problem) => problem.startsWith("cycle:"));
	const expansions = new Map<string, Expansion>();
	const needs = new Set<string>();

	const expand = (name: string): Expansion => {
		const known = expansions.get(name);
		if (known) return known;
		const box = state.boxes[name];
		const made: Expansion = box && !cyclic ? expandBox(name, box) : { kind: "blocked" };
		expansions.set(name, made);
		return made;
	};

	const leavesOf = (key: string, path: readonly number[], into: Leaf[]): boolean => {
		const phase = state.items[key]?.phase;
		if (phase?.kind === "done") {
			into.push({ path, value: phase.value });
			return true;
		}
		if (phase?.kind !== "split") return false;
		return phase.parts.every((_part, index) => leavesOf(childKey(key, index), [...path, index], into));
	};

	const resultOf = (name: string): Produced => {
		const expansion = expand(name);
		if (expansion.kind === "blocked") return UNPRODUCED;
		if (expansion.fanned) {
			const leaves: Leaf[] = [];
			for (const expected of expansion.items) if (!leavesOf(expected.key, expected.path, leaves)) return UNPRODUCED;
			return { kind: "many", leaves };
		}
		const values: Json[] = [];
		for (const expected of expansion.items) {
			const phase = state.items[expected.key]?.phase;
			if (phase?.kind !== "done") return UNPRODUCED;
			values.push(phase.value);
		}
		const only = values[0];
		return only === undefined ? UNPRODUCED : { kind: "one", value: only };
	};

	const flatten = (produced: Produced): Resolved => {
		switch (produced.kind) {
			case "one":
				return { kind: "value", value: produced.value };
			case "many":
				return { kind: "value", value: produced.leaves.map((leaf) => leaf.value) };
			case "missing":
				return MISSING;
			default: {
				const unreachable: never = produced;
				return unreachable;
			}
		}
	};

	const resolve = (ref: Ref): Resolved => {
		switch (ref.source.kind) {
			case "input": {
				if (!(ref.source.name in state.inputs)) {
					needs.add(ref.source.name);
					return MISSING;
				}
				return walk(state.inputs[ref.source.name] ?? null, ref.path);
			}
			case "box": {
				const result = flatten(resultOf(ref.source.box));
				return result.kind === "value" ? walk(result.value, ref.path) : MISSING;
			}
			case "raise":
				return MISSING;
			default: {
				const unreachable: never = ref.source;
				return unreachable;
			}
		}
	};

	const elementsOf = (ref: Ref): readonly Leaf[] | undefined => {
		if (ref.source.kind === "box" && ref.path.length === 0) {
			const produced = resultOf(ref.source.box);
			if (produced.kind === "many") return produced.leaves;
		}
		const resolved = resolve(ref);
		if (resolved.kind === "missing" || !isArray(resolved.value)) return undefined;
		return resolved.value.map((value, index) => ({ path: [index], value }));
	};

	const expandBox = (name: string, box: Box): Expansion => {
		const single: Record<string, Json> = {};
		let multi: { readonly input: string; readonly ref: Ref } | undefined;
		for (const [input, ref] of Object.entries(box.inputs)) {
			if (ref.multi) {
				multi = { input, ref };
				continue;
			}
			const resolved = resolve(ref);
			if (resolved.kind === "missing") return { kind: "blocked" };
			single[input] = resolved.value;
		}
		if (!multi)
			return { kind: "items", fanned: false, input: undefined, items: [{ key: name, path: [], inputs: single, start: undefined }] };
		const { input, ref } = multi;
		if (ref.source.kind === "raise") {
			const { box: sourceBox, type } = ref.source;
			const items = Object.values(state.items)
				.filter((item) => item.box === sourceBox && item.phase.kind === "raised" && item.phase.type === type)
				.sort((a, b) => a.key.localeCompare(b.key))
				.map((item): Expected => {
					const phase = item.phase;
					const raise: Json =
						phase.kind === "raised" ? { item: item.key, type: phase.type, detail: phase.detail, handoff: phase.handoff } : null;
					return { key: answerKey(name, item.key, item.attempt), path: [], inputs: { ...single, [input]: raise }, start: undefined };
				});
			return { kind: "items", fanned: false, input: undefined, items };
		}
		const elements = elementsOf(ref);
		if (elements === undefined) return { kind: "blocked" };
		return {
			kind: "items",
			fanned: true,
			input,
			items: elements.map(
				(element): Expected => ({
					key: itemKey(name, element.path),
					path: element.path,
					inputs: { ...single, [input]: element.value },
					start: undefined,
				}),
			),
		};
	};

	const childrenOf = (item: Item, expected: Expected, input: string | undefined): Expected[] => {
		if (item.phase.kind !== "split" || input === undefined) return [];
		const { parts } = item.phase;
		return parts.map((part, index) => ({
			key: childKey(item.key, index),
			path: [...expected.path, index],
			inputs: { ...expected.inputs, [input]: part },
			start: {
				continuation: { kind: "part", part: index, of: parts.length },
				earlier: item.last,
				depth: item.depth + 1,
			},
		}));
	};

	const ready: Firing[] = [];
	const raised: Raised[] = [];
	const waiting: string[] = [];
	for (const name of names) {
		const box = state.boxes[name];
		const expansion = expand(name);
		if (!box) continue;
		if (expansion.kind === "blocked") {
			waiting.push(name);
			continue;
		}
		let inFlight = Object.values(state.items).filter((item) => item.box === name && item.phase.kind === "running").length;
		const queue = [...expansion.items];
		for (let at = 0; at < queue.length; at += 1) {
			const expected = queue[at];
			if (!expected) continue;
			const item = state.items[expected.key];
			let next: Firing | undefined;
			if (!item) {
				next = {
					key: expected.key,
					box: name,
					attempt: 1,
					inputs: expected.inputs,
					continuation: expected.start?.continuation ?? null,
					earlier: expected.start?.earlier,
					depth: expected.start?.depth ?? 0,
				};
			} else {
				const again = {
					key: item.key,
					box: name,
					attempt: item.attempt + 1,
					inputs: expected.inputs,
					earlier: item.last,
					depth: item.depth,
				};
				switch (item.phase.kind) {
					case "running":
					case "done":
						break;
					case "split":
						queue.push(...childrenOf(item, expected, expansion.input));
						break;
					case "raised": {
						const answer = answerOf(state, item);
						if (answer === undefined) {
							raised.push({
								key: item.key,
								type: item.phase.type,
								detail: item.phase.detail,
								handler: handlerOf(state.boxes, item.box, item.phase.type),
							});
						} else {
							next = { ...again, continuation: { kind: "answer", answer, previous: item.phase.handoff } };
						}
						break;
					}
					case "reopened":
						next = {
							...again,
							continuation: { kind: "check", check: item.phase.check, output: item.phase.output, previous: item.phase.handoff },
						};
						break;
					case "failed":
					case "retry":
					case "cancelled":
						next = { ...again, continuation: item.continuation };
						break;
					default: {
						const unreachable: never = item.phase;
						return unreachable;
					}
				}
			}
			if (!next || (box.limit !== undefined && inFlight >= box.limit)) continue;
			ready.push(next);
			inFlight += 1;
		}
	}

	const stale: string[] = [];
	const illegal: string[] = [];
	const running: string[] = [];
	for (const item of Object.values(state.items)) {
		const box = state.boxes[item.box];
		if (item.phase.kind === "running") running.push(item.key);
		if (!box) illegal.push(item.key);
		else if (item.fingerprint !== markOf(state, box) && ["done", "raised", "split"].includes(item.phase.kind)) stale.push(item.key);
	}
	return {
		problems,
		stale: stale.sort(),
		illegal: illegal.sort(),
		ready,
		running: running.sort(),
		raised,
		needs: [...needs].sort(),
		waiting,
	};
}

export function lookup(state: State, key: string): Json | undefined {
	if (key.startsWith("input.")) return state.inputs[key.slice("input.".length)];
	const phase = state.items[key]?.phase;
	if (phase?.kind === "done") return phase.value;
	if (!(key in state.boxes)) return undefined;
	const values = Object.values(state.items)
		.filter((item) => item.box === key && item.phase.kind !== "split")
		.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
		.map((item) => (item.phase.kind === "done" ? item.phase.value : null));
	return values.length > 0 ? values : undefined;
}
