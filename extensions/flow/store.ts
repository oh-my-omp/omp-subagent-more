import { isName, type Json, parseBox, stableText } from "./defs.ts";
import { type Firing, lint, type Survey, survey } from "./plan.ts";
import { delta, headline, type Marks, marksOf, wiring } from "./report.ts";
import { type Action, definitionKey, EMPTY, markOf, modelKey, type Outcome, reduce, type State } from "./state.ts";

export type Command =
	| { readonly kind: "define"; readonly boxes: Readonly<Record<string, Json>> }
	| { readonly kind: "supply"; readonly name: string; readonly value: Json }
	| { readonly kind: "retract"; readonly keys: readonly string[] }
	| { readonly kind: "keep"; readonly keys: readonly string[] }
	| { readonly kind: "retry"; readonly keys: readonly string[] }
	| { readonly kind: "answer"; readonly key: string; readonly value: Json }
	| { readonly kind: "run" }
	| { readonly kind: "stop"; readonly reason: string };

export type Verdict = {
	readonly accepted: boolean;
	readonly refusals: readonly string[];
	readonly lines: readonly string[];
};

export type Live = { readonly key: string; readonly attempt: number };

function judge(state: State, command: Command): { readonly actions: readonly Action[]; readonly refusals: readonly string[] } {
	const refuse = (...refusals: string[]) => ({ actions: [], refusals });
	const accept = (...actions: Action[]) => ({ actions, refusals: [] });
	switch (command.kind) {
		case "define": {
			const refusals: string[] = [];
			const changed: Record<string, Json> = {};
			for (const [name, data] of Object.entries(command.boxes)) {
				if (data === null) {
					if (name in state.boxes) changed[name] = null;
					else refusals.push(`${name}: there is no such box to drop`);
					continue;
				}
				const parsed = parseBox(name, data);
				if (!parsed.ok) refusals.push(...parsed.problems);
				else if (state.boxes[name]?.fingerprint !== parsed.value.fingerprint) changed[name] = data;
			}
			if (refusals.length > 0) return refuse(...refusals);
			return Object.keys(changed).length > 0 ? accept({ kind: "defined", boxes: changed }) : accept();
		}
		case "supply": {
			if (!isName(command.name)) return refuse(`"${command.name}" is not a usable input name`);
			const same = command.name in state.inputs && stableText(state.inputs[command.name] ?? null) === stableText(command.value);
			return same ? accept() : accept({ kind: "supplied", name: command.name, value: command.value });
		}
		case "retract": {
			const unknown = command.keys.filter((key) =>
				key.startsWith("input.") ? !(key.slice("input.".length) in state.inputs) : !(key in state.items),
			);
			if (command.keys.length === 0) return refuse("name the items or inputs to retract");
			if (unknown.length > 0) return refuse(...unknown.map((key) => `${key}: there is no such item or input`));
			return accept({ kind: "retracted", keys: command.keys });
		}
		case "keep": {
			const stale = survey(state).stale;
			const wrong = command.keys.filter((key) => !stale.includes(key));
			if (command.keys.length === 0) return refuse("name the stale items to keep");
			if (wrong.length > 0) return refuse(...wrong.map((key) => `${key}: not a stale item`));
			return accept({ kind: "kept", keys: command.keys });
		}
		case "retry": {
			const wrong = command.keys.filter((key) => state.items[key]?.phase.kind !== "failed");
			if (command.keys.length === 0) return refuse("name the failed items to fire again");
			if (wrong.length > 0) return refuse(...wrong.map((key) => `${key}: not a failed item`));
			return accept({ kind: "retried", keys: command.keys });
		}
		case "answer": {
			if (state.items[command.key]?.phase.kind !== "raised") return refuse(`${command.key}: not an item that raised`);
			return accept({ kind: "answered", key: command.key, value: command.value });
		}
		case "run": {
			if (state.mode.kind === "running") return accept();
			const refusals: string[] = [];
			if (Object.keys(state.boxes).length === 0) refusals.push("no box is defined");
			refusals.push(...lint(state.boxes));
			for (const [name, box] of Object.entries(state.boxes)) {
				if (box.kind !== "agent") continue;
				if (!(definitionKey(box.agent) in state.agents)) refusals.push(`${name}: there is no agent named \`${box.agent}\``);
				const model = box.model ?? box.agent;
				if (!(modelKey(model) in state.agents)) refusals.push(`${name}: agent \`${model}\` has no model setting to use`);
			}
			const found = survey(state);
			for (const key of found.illegal) refusals.push(`${key}: its box is no longer defined; retract it or define the box again`);
			for (const key of found.stale) {
				refusals.push(
					`${key}: produced under an earlier definition of its box; keep it (the value stands) or retract it (it is produced again)`,
				);
			}
			for (const item of Object.values(state.items)) {
				const box = state.boxes[item.box];
				if (item.phase.kind !== "failed" || !box || markOf(state, box) !== item.fingerprint) continue;
				refusals.push(
					`${item.key}: failed with \`${item.phase.name}\` and nothing about it has changed; redefine box \`${item.box}\`, retract the item, or retry it`,
				);
			}
			if (refusals.length > 0) return refuse(...refusals);
			return accept({ kind: state.mode.kind === "stopped" ? "resumed" : "started" });
		}
		case "stop":
			return state.mode.kind === "running" ? accept({ kind: "halted", reason: command.reason }) : refuse("the flow is not running");
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

export function moves(state: State): string[] {
	const found = survey(state);
	const legal = (command: Command): boolean => judge(state, command).refusals.length === 0;
	const list: string[] = [];
	for (const name of found.needs) list.push(`supply ${name}`);
	if (found.stale.length > 0) list.push(`keep or retract ${found.stale.join(", ")}`);
	if (found.illegal.length > 0) list.push(`retract ${found.illegal.join(", ")}`);
	const failed = Object.values(state.items).filter((item) => {
		const box = state.boxes[item.box];
		return item.phase.kind === "failed" && box !== undefined && markOf(state, box) === item.fingerprint;
	});
	if (failed.length > 0) {
		const boxes = [...new Set(failed.map((item) => item.box))].sort();
		list.push(`retry or retract ${failed.map((item) => item.key).join(", ")}, or define ${boxes.join(", ")} again`);
	}
	for (const raise of found.raised) if (raise.handler === undefined) list.push(`answer ${raise.key}`);
	if (state.mode.kind !== "running" && found.ready.length > 0 && legal({ kind: "run" })) list.push("run");
	if (legal({ kind: "stop", reason: "" })) list.push("stop");
	return list;
}

export class Store {
	#state: State = EMPTY;
	#seen: Marks = {};
	readonly #append: (action: Action) => void;

	constructor(log: Iterable<Action>, append: (action: Action) => void) {
		for (const action of log) this.#state = reduce(this.#state, action);
		this.#append = append;
	}

	get state(): State {
		return this.#state;
	}

	survey(): Survey {
		return survey(this.#state);
	}

	#dispatch(action: Action): void {
		this.#append(action);
		this.#state = reduce(this.#state, action);
	}

	agentNames(): string[] {
		return [
			...new Set(Object.values(this.#state.boxes).flatMap((box) => (box.kind === "agent" ? [box.agent, box.model ?? box.agent] : []))),
		].sort();
	}

	observe(agents: Readonly<Record<string, string | null>>): void {
		const changed: Record<string, string | null> = {};
		for (const [name, mark] of Object.entries(agents)) {
			if ((this.#state.agents[name] ?? null) !== mark) changed[name] = mark;
		}
		if (Object.keys(changed).length > 0) this.#dispatch({ kind: "observed", agents: changed });
	}

	submit(command: Command): Verdict {
		const { actions, refusals } = judge(this.#state, command);
		for (const action of actions) this.#dispatch(action);
		return { accepted: refusals.length === 0, refusals, lines: this.changes() };
	}

	changes(): string[] {
		const found = survey(this.#state);
		const marks = marksOf(this.#state, found);
		const lines = [...headline(this.#state, found), ...this.#next(), ...delta(this.#seen, marks)];
		this.#seen = marks;
		return lines;
	}

	everything(): string[] {
		const found = survey(this.#state);
		return [...headline(this.#state, found), ...this.#next(), ...wiring(this.#state), ...delta({}, marksOf(this.#state, found))];
	}

	#next(): string[] {
		const open = moves(this.#state);
		return open.length > 0 ? [`next: ${open.join(" | ")}`] : [];
	}

	advance(): readonly Firing[] {
		if (this.#state.mode.kind !== "running") return [];
		const found = survey(this.#state);
		for (const firing of found.ready) {
			this.#dispatch({ kind: "fired", key: firing.key, box: firing.box, attempt: firing.attempt, continuation: firing.continuation });
		}
		if (found.ready.length === 0 && found.running.length === 0) this.#dispatch({ kind: "idled" });
		return found.ready;
	}

	spawned(key: string, attempt: number, session: string): void {
		this.#dispatch({ kind: "spawned", key, attempt, session });
	}

	settle(key: string, attempt: number, outcome: Outcome): void {
		this.#dispatch({ kind: "settled", key, attempt, outcome });
	}

	orphans(live: readonly Live[]): readonly Live[] {
		const stopped = this.#state.mode.kind === "stopped";
		return live.filter(({ key, attempt }) => {
			const item = this.#state.items[key];
			return stopped || !item || item.attempt !== attempt || item.phase.kind !== "running";
		});
	}

	recover(): void {
		for (const item of Object.values(this.#state.items)) {
			if (item.phase.kind === "running") this.settle(item.key, item.attempt, { kind: "cancelled" });
		}
		if (this.#state.mode.kind === "running") this.#dispatch({ kind: "halted", reason: "the process that ran the flow ended" });
	}
}
