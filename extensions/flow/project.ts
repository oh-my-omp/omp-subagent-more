import { type Box, isArray, isObject, type Json, type Ref, textOf } from "./defs.ts";
import type { Survey } from "./plan.ts";
import type { Item, Phase, State, StopCause } from "./state.ts";
import type {
	Attention,
	BoardRef,
	BoxEdge,
	BoxView,
	Counts,
	DecisionEvent,
	FlowView,
	Freshness,
	Handoff,
	LastRequest,
	ModeView,
	SessionFacts,
	StopView,
	UnitPhase,
	UnitView,
	WaitingSplit,
} from "./view.ts";

export type ProjectionInput = {
	readonly state: State;
	readonly survey: Survey;
	readonly splits: readonly WaitingSplit[];
	readonly sessions: ReadonlyMap<string, SessionFacts>;
	readonly boards: ReadonlyMap<string, BoardRef>;
	readonly decisions: readonly DecisionEvent[];
	readonly last: LastRequest | null;
};

const stringsOf = (value: Json): readonly string[] | undefined => {
	if (!isArray(value)) return undefined;
	const found: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return undefined;
		found.push(entry);
	}
	return found;
};

export function handoffOf(handoff: Json): Handoff {
	if (handoff === null) return { kind: "none" };
	if (isObject(handoff)) {
		const did = handoff.did;
		const choices = stringsOf(handoff.decided ?? null);
		const unproven = stringsOf(handoff.unverified ?? null);
		if (typeof did === "string" && choices !== undefined && unproven !== undefined) {
			return { kind: "parsed", did, decided: choices, unverified: unproven };
		}
	}
	return { kind: "raw", text: textOf(handoff) };
}

const stopView = (cause: StopCause): StopView => {
	switch (cause.kind) {
		case "exception":
			return { kind: "exception", key: cause.key, name: cause.name, reason: cause.reason };
		case "halt":
			return { kind: "halt", reason: cause.reason };
		default: {
			const unreachable: never = cause;
			return unreachable;
		}
	}
};

const modeView = (state: State, survey: Survey): ModeView => {
	switch (state.mode.kind) {
		case "running":
			return { kind: "running" };
		case "stopped":
			return { kind: "stopped", cause: stopView(state.mode.cause) };
		case "idle": {
			const complete =
				Object.keys(state.boxes).length > 0 &&
				survey.waiting.length === 0 &&
				survey.ready.length === 0 &&
				survey.unpaired.length === 0 &&
				Object.values(state.items).every((item) => item.phase.kind === "done" || item.phase.kind === "split");
			return { kind: "idle", complete };
		}
		default: {
			const unreachable: never = state.mode;
			return unreachable;
		}
	}
};

const countsOf = (state: State): Counts => {
	const count = (kind: Item["phase"]["kind"]): number => Object.values(state.items).filter((item) => item.phase.kind === kind).length;
	return {
		done: count("done"),
		split: count("split"),
		running: count("running"),
		raised: count("raised"),
		failed: count("failed"),
		cancelled: count("cancelled"),
	};
};

const edgeOf = (field: string, ref: Ref): BoxEdge => {
	switch (ref.source.kind) {
		case "input":
			return { field, source: { kind: "input", name: ref.source.name }, ref: ref.multi ? { kind: "fan" } : { kind: "value" } };
		case "box":
			return { field, source: { kind: "box", box: ref.source.box }, ref: ref.multi ? { kind: "fan" } : { kind: "value" } };
		case "raise":
			return { field, source: { kind: "box", box: ref.source.box }, ref: { kind: "raise", type: ref.source.type } };
		default: {
			const unreachable: never = ref.source;
			return unreachable;
		}
	}
};

const boxView = (name: string, box: Box): BoxView => {
	const edges = Object.entries(box.inputs)
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([field, ref]) => edgeOf(field, ref));
	const checks = box.checks?.boxes ?? [];
	switch (box.kind) {
		case "agent":
			return { name, kind: "agent", agent: box.agent, model: box.model ?? null, edges, checks, raises: box.raises };
		case "command":
			return { name, kind: "command", agent: null, model: null, edges, checks, raises: [] };
		default: {
			const unreachable: never = box;
			return unreachable;
		}
	}
};

const phaseView = (phase: Phase): UnitPhase => {
	switch (phase.kind) {
		case "running":
			return { kind: "running" };
		case "done":
			return { kind: "done", handoff: handoffOf(phase.handoff) };
		case "raised":
			return { kind: "raised", type: phase.type, detail: phase.detail, handoff: handoffOf(phase.handoff) };
		case "split":
			return { kind: "split", parts: phase.parts.length, handoff: handoffOf(phase.handoff) };
		case "reopened":
			return { kind: "reopened", check: phase.check, output: phase.output, handoff: handoffOf(phase.handoff) };
		case "failed":
			return { kind: "failed", name: phase.name, reason: phase.reason };
		case "retry":
			return { kind: "retry", name: phase.name, reason: phase.reason };
		case "cancelled":
			return { kind: "cancelled" };
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
};

const freshnessOf = (state: State, survey: Survey, item: Item): Freshness => {
	if (survey.illegal.includes(item.key) || !(item.box in state.boxes)) return "illegal";
	return survey.stale.includes(item.key) ? "stale" : "current";
};

const unitView = (state: State, survey: Survey, item: Item): UnitView => {
	const box = state.boxes[item.box];
	return {
		key: item.key,
		box: item.box,
		attempt: item.attempt,
		chain: item.chain,
		bound: box !== undefined && box.kind === "agent" ? box.bound : null,
		phase: phaseView(item.phase),
		session: item.session ?? null,
		freshness: freshnessOf(state, survey, item),
	};
};

const attentionOf = (state: State, survey: Survey, splits: readonly WaitingSplit[]): readonly Attention[] => {
	const found: Attention[] = [];
	for (const raise of survey.raised) {
		if (raise.handler === undefined) found.push({ kind: "raise", key: raise.key, type: raise.type, detail: raise.detail });
	}
	for (const split of splits) {
		found.push({
			kind: "split",
			key: split.key,
			session: split.session,
			parts: split.parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))),
		});
	}
	if (state.mode.kind === "stopped") found.push({ kind: "stopped", cause: stopView(state.mode.cause) });
	return found;
};

export function viewOf(state: State, survey: Survey, splits: readonly WaitingSplit[]): FlowView {
	return {
		mode: modeView(state, survey),
		noEscape: state.noEscape,
		counts: countsOf(state),
		boxes: Object.entries(state.boxes)
			.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
			.map(([name, box]) => boxView(name, box)),
		units: Object.values(state.items)
			.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
			.map((item) => unitView(state, survey, item)),
		attention: attentionOf(state, survey, splits),
	};
}
