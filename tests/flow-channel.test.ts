import { describe, expect, test } from "bun:test";
import { type ExtensionFrame, type PanelFrame, parseExtensionFrame, parsePanelFrame } from "../extensions/flow/channel.ts";
import type { Json } from "../extensions/flow/defs.ts";
import { viewOf } from "../extensions/flow/project.ts";
import { definitionKey, modelKey } from "../extensions/flow/state.ts";
import { Store } from "../extensions/flow/store.ts";
import type { FlowView } from "../extensions/flow/view.ts";

const HANDOFF: Json = { did: "work", decided: ["kept"], unverified: [] };
const WORK: Json = {
	agent: "task:low",
	brief: "Do {{slice}}",
	in: { slice: "input.slices[]" },
	out: { type: "object" },
	raises: ["question"],
};

function busyView(): FlowView {
	const store = new Store([], () => {});
	store.observe({ [definitionKey("task:low")]: "low-1", [modelKey("task:low")]: "cheap" });
	store.submit({ kind: "define", boxes: { work: WORK } });
	store.submit({ kind: "supply", name: "slices", value: ["a", "b", "c"] });
	store.submit({ kind: "run" });
	store.advance();
	store.settle("work#1", 1, { kind: "raise", type: "question", detail: "which?", handoff: HANDOFF });
	store.settle("work#2", 1, { kind: "done", value: {}, handoff: "free text" });
	return viewOf(store.state, store.survey(), [{ key: "work#0", session: "Flowwork_0_s1", parts: ["x", "y"] }]);
}

describe("the monitor channel", () => {
	test("every frame either side sends parses back to the same value", () => {
		const panel: PanelFrame[] = [
			{ kind: "view", view: busyView() },
			{ kind: "outcome", id: 3, outcome: { kind: "accepted", summary: "agreed" } },
			{ kind: "outcome", id: 4, outcome: { kind: "refused", reasons: ["work#9: not an item that raised"] } },
			{ kind: "failed", id: 5, message: "boom" },
		];
		for (const frame of panel) expect(parsePanelFrame(JSON.stringify(frame))).toEqual(frame);

		const extension: ExtensionFrame[] = [
			{ kind: "request", id: 0, request: { kind: "answer", key: "work#1", text: "blue" } },
			{ kind: "request", id: 1, request: { kind: "agree", key: "work#0" } },
			{ kind: "request", id: 2, request: { kind: "disagree", key: "work#0", reason: "keep it whole" } },
			{ kind: "request", id: 3, request: { kind: "stop", reason: "" } },
		];
		for (const frame of extension) expect(parseExtensionFrame(JSON.stringify(frame))).toEqual(frame);
	});

	test("frames outside the contract are dropped", () => {
		const view = busyView();
		const { counts: _counts, ...countless } = view;
		expect(parsePanelFrame("not json")).toBeUndefined();
		expect(parsePanelFrame(JSON.stringify({ kind: "snapshot", view }))).toBeUndefined();
		expect(parsePanelFrame(JSON.stringify({ kind: "view", view: countless }))).toBeUndefined();
		expect(parsePanelFrame(JSON.stringify({ kind: "view", view: { ...view, mode: { kind: "paused" } } }))).toBeUndefined();
		expect(parsePanelFrame(JSON.stringify({ kind: "outcome", id: -1, outcome: { kind: "accepted", summary: "x" } }))).toBeUndefined();
		expect(parseExtensionFrame(JSON.stringify({ kind: "request", id: 1, request: { kind: "disagree", key: "work#0" } }))).toBeUndefined();
		expect(parseExtensionFrame(JSON.stringify({ kind: "request", id: 1.5, request: { kind: "agree", key: "work#0" } }))).toBeUndefined();
	});
});
