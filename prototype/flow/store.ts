// The store: the one writer of a flow's action log.
//
// A caller's request is a command. The store judges it against the current state and the
// definitions alone; a legal command becomes actions, appended to the log and folded into the
// state, and an illegal one changes nothing and says why. Whatever needs the outside world
// (starting a session, running a command) happens elsewhere and comes back as `settle`.
import { isName, type Json, parseBox, stableText } from "./defs.ts";
import { type Firing, lint, type Survey, survey } from "./plan.ts";
import { delta, headline, type Marks, marksOf } from "./report.ts";
import { type Action, EMPTY, markOf, type Outcome, reduce, type State } from "./state.ts";

export type Command =
	/** Boxes in plain-data form; `null` drops a box. */
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
	/** Why the command was refused; empty when accepted. */
	readonly refusals: readonly string[];
	/** Where the flow stands, then what changed since the last verdict. */
	readonly lines: readonly string[];
};

/** A session the outside world still runs although its item no longer waits for it. */
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
				if (box.kind === "agent" && !(box.agent in state.agents)) refusals.push(`${name}: there is no agent named \`${box.agent}\``);
			}
			const found = survey(state);
			for (const key of found.illegal) refusals.push(`${key}: its box is no longer defined; retract it or define the box again`);
			for (const key of found.stale) {
				refusals.push(
					`${key}: produced under an earlier definition of its box; keep it (the value stands) or retract it (it is produced again)`,
				);
			}
			// An exception that stopped the flow has to be handled before the flow goes on: by a changed
			// definition of the box, by retracting the item, or by saying it may fire again as it is.
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

export class Store {
	#state: State = EMPTY;
	#seen: Marks = {};
	readonly #append: (action: Action) => void;

	/** A store over an existing log; `append` receives every later action, in order. */
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

	/** Agent names the definitions use, for the caller to look up outside the flow. */
	agentNames(): string[] {
		return [...new Set(Object.values(this.#state.boxes).flatMap((box) => (box.kind === "agent" ? [box.agent] : [])))].sort();
	}

	/** Records the marks of agent definitions as they are now; `null` for a name with no definition. */
	observe(agents: Readonly<Record<string, string | null>>): void {
		const changed: Record<string, string | null> = {};
		for (const [name, mark] of Object.entries(agents)) {
			if ((this.#state.agents[name] ?? null) !== mark) changed[name] = mark;
		}
		if (Object.keys(changed).length > 0) this.#dispatch({ kind: "observed", agents: changed });
	}

	/** Judges a command and, when legal, applies it. */
	submit(command: Command): Verdict {
		const { actions, refusals } = judge(this.#state, command);
		for (const action of actions) this.#dispatch(action);
		return { accepted: refusals.length === 0, refusals, lines: this.changes() };
	}

	/** Where the flow stands, and what changed since the last time this was asked. */
	changes(): string[] {
		const found = survey(this.#state);
		const marks = marksOf(this.#state, found);
		const lines = [...headline(this.#state, found), ...delta(this.#seen, marks)];
		this.#seen = marks;
		return lines;
	}

	/** Where the flow stands, with every box, input and item. */
	everything(): string[] {
		const found = survey(this.#state);
		return [...headline(this.#state, found), ...delta({}, marksOf(this.#state, found))];
	}

	/** While the flow runs: records what starts now and returns it; records that the flow came to rest when nothing can. */
	advance(): readonly Firing[] {
		if (this.#state.mode.kind !== "running") return [];
		const found = survey(this.#state);
		for (const firing of found.ready) {
			this.#dispatch({ kind: "fired", key: firing.key, box: firing.box, attempt: firing.attempt, continuation: firing.continuation });
		}
		if (found.ready.length === 0 && found.running.length === 0) this.#dispatch({ kind: "idled" });
		return found.ready;
	}

	/** The id under which the session of an attempt can be read outside the flow. */
	spawned(key: string, attempt: number, session: string): void {
		this.#dispatch({ kind: "spawned", key, attempt, session });
	}

	/** The end of one session, however it ended. */
	settle(key: string, attempt: number, outcome: Outcome): void {
		this.#dispatch({ kind: "settled", key, attempt, outcome });
	}

	/** Of the sessions still alive outside, those whose result nothing waits for: the flow stopped, or their item is gone. */
	orphans(live: readonly Live[]): readonly Live[] {
		const stopped = this.#state.mode.kind === "stopped";
		return live.filter(({ key, attempt }) => {
			const item = this.#state.items[key];
			return stopped || !item || item.attempt !== attempt || item.phase.kind !== "running";
		});
	}

	/** After a restart nothing of the earlier process is alive: its running items end as cancelled. */
	recover(): void {
		for (const item of Object.values(this.#state.items)) {
			if (item.phase.kind === "running") this.settle(item.key, item.attempt, { kind: "cancelled" });
		}
		if (this.#state.mode.kind === "running") this.#dispatch({ kind: "halted", reason: "the process that ran the flow ended" });
	}
}
