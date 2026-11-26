import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { type Accessor, type JSXNode, type KeyEvent, nativeRendering, signal, type TextEdit } from "@oh-my-pi/pi-tui";
import { tr } from "../../omomp-shared/i18n.ts";
import { errorText } from "../fork-task/errors.ts";
import { node } from "./node.ts";
import type { BoxEdge, FlowView, Freshness, Handoff, MonitorOutcome, MonitorPort, MonitorRequest, UnitPhase, UnitView } from "./view.ts";

export type BoardProps = {
	readonly view: Accessor<FlowView>;
	readonly port: MonitorPort;
	readonly size: ExtensionUiHost["size"];
	readonly close?: () => void;
};

const STATUS_ROWS = 8;
const CARD_CHROME_ROWS = 2;
const ROW_MIN_COLUMNS = 80;
const STACK_GAP_ROWS = 2;

type Layout = { readonly kind: "row"; readonly lines: number } | { readonly kind: "stack"; readonly lines: number };

function layoutOf(columns: number, rows: number, native: boolean): Layout {
	const room = rows - STATUS_ROWS;
	return !native && columns >= ROW_MIN_COLUMNS
		? { kind: "row", lines: Math.max(0, room - CARD_CHROME_ROWS) }
		: { kind: "stack", lines: Math.max(0, Math.floor((room - 3 * CARD_CHROME_ROWS - STACK_GAP_ROWS) / 3)) };
}

type EditorMode =
	| { readonly kind: "browse" }
	| { readonly kind: "answer"; readonly key: string; readonly draft: string }
	| { readonly kind: "disagree"; readonly key: string; readonly draft: string }
	| { readonly kind: "stop"; readonly draft: string };

type DraftMode = Extract<EditorMode, { kind: "answer" | "disagree" | "stop" }>;

type RequestState =
	| { readonly kind: "idle" }
	| { readonly kind: "sending" }
	| { readonly kind: "accepted"; readonly summary: string }
	| { readonly kind: "refused"; readonly reasons: readonly string[] }
	| { readonly kind: "failed"; readonly message: string };

const GROUP_ORDER = ["attention", "running", "settled"] as const;
type UnitGroup = (typeof GROUP_ORDER)[number];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function groupOf(view: FlowView, unit: UnitView): UnitGroup {
	const watched = view.attention.some((entry) => entry.kind !== "stopped" && entry.key === unit.key);
	if (watched) return "attention";
	switch (unit.phase.kind) {
		case "raised":
			return "attention";
		case "running":
		case "reopened":
		case "retry":
			return "running";
		case "done":
		case "split":
		case "failed":
		case "cancelled":
			return "settled";
		default: {
			const unreachable: never = unit.phase;
			throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
		}
	}
}

function groupUnits(view: FlowView): Record<UnitGroup, readonly UnitView[]> {
	const groups: Record<UnitGroup, UnitView[]> = { attention: [], running: [], settled: [] };
	for (const unit of view.units) groups[groupOf(view, unit)].push(unit);
	return groups;
}

function orderedUnits(view: FlowView): readonly UnitView[] {
	const groups = groupUnits(view);
	return GROUP_ORDER.flatMap((group) => groups[group]);
}

function selectedUnit(units: readonly UnitView[], key: string | null): UnitView | undefined {
	if (key !== null) {
		const found = units.find((unit) => unit.key === key);
		if (found !== undefined) return found;
	}
	return units[0];
}

function movedKey(units: readonly UnitView[], key: string | null, step: -1 | 1): string | null {
	if (units.length === 0) return null;
	const current = selectedUnit(units, key);
	const index = current === undefined ? 0 : units.indexOf(current);
	const next = Math.min(units.length - 1, Math.max(0, index + step));
	return units[next]?.key ?? null;
}

function groupTitle(group: UnitGroup): string {
	switch (group) {
		case "attention":
			return tr("attention", "待处理");
		case "running":
			return tr("running", "运行中");
		case "settled":
			return tr("settled", "已结束");
		default: {
			const unreachable: never = group;
			throw new Error(`Unexpected unit group: ${String(unreachable)}`);
		}
	}
}

function phaseLabel(phase: UnitPhase): string {
	switch (phase.kind) {
		case "running":
			return tr("running", "运行中");
		case "done":
			return tr("done", "完成");
		case "raised":
			return `${tr("raised", "提问")} ${phase.type}`;
		case "split":
			return `${tr("split", "拆分")} ${phase.parts}`;
		case "reopened":
			return tr("reopened", "重开");
		case "failed":
			return `${tr("failed", "失败")} ${phase.name}`;
		case "retry":
			return `${tr("retry", "重试")} ${phase.name}`;
		case "cancelled":
			return tr("cancelled", "已取消");
		default: {
			const unreachable: never = phase;
			throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
		}
	}
}

function phaseTone(phase: UnitPhase) {
	switch (phase.kind) {
		case "running":
			return "pending";
		case "done":
			return "success";
		case "raised":
			return "warning";
		case "split":
			return "info";
		case "reopened":
			return "warning";
		case "failed":
			return "error";
		case "retry":
			return "warning";
		case "cancelled":
			return "muted";
		default: {
			const unreachable: never = phase;
			throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
		}
	}
}

function freshnessLabel(freshness: Freshness): string {
	switch (freshness) {
		case "current":
			return tr("current", "最新");
		case "stale":
			return tr("stale", "过期");
		case "illegal":
			return tr("illegal", "非法");
		default: {
			const unreachable: never = freshness;
			throw new Error(`Unexpected freshness: ${String(unreachable)}`);
		}
	}
}

function settledCount(units: readonly UnitView[]): number {
	let settled = 0;
	for (const unit of units) {
		switch (unit.phase.kind) {
			case "done":
			case "split":
			case "failed":
			case "cancelled":
				settled++;
				break;
			case "running":
			case "raised":
			case "reopened":
			case "retry":
				break;
			default: {
				const unreachable: never = unit.phase;
				throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
			}
		}
	}
	return settled;
}

function raisedCount(units: readonly UnitView[]): number {
	return units.filter((unit) => unit.phase.kind === "raised").length;
}

function mermaidLabel(text: string): string {
	return `"${text.replaceAll('"', "#quot;")}"`;
}

function edgeText(edge: BoxEdge): string {
	const suffix = edge.ref.kind === "fan" ? " fan" : edge.ref.kind === "raise" ? ` raise ${edge.ref.type}` : "";
	return `${edge.field}${suffix}`.replaceAll("|", "/").replaceAll("\n", " ");
}

function boxState(units: readonly UnitView[]): string {
	const raised = raisedCount(units);
	return `${settledCount(units)}/${units.length}${raised > 0 ? ` !${raised}` : ""}`;
}

function unitsOfBoxes(view: FlowView): ReadonlyMap<string, readonly UnitView[]> {
	const unitsByBox = new Map<string, UnitView[]>();
	for (const unit of view.units) {
		const own = unitsByBox.get(unit.box);
		if (own === undefined) unitsByBox.set(unit.box, [unit]);
		else own.push(unit);
	}
	return unitsByBox;
}

function wiring(view: FlowView): string {
	const unitsByBox = unitsOfBoxes(view);
	const inputs: string[] = [];
	for (const box of view.boxes) {
		for (const edge of box.edges) if (edge.source.kind === "input" && !inputs.includes(edge.source.name)) inputs.push(edge.source.name);
	}
	const missing: string[] = [];
	for (const box of view.boxes) {
		for (const edge of box.edges) {
			const name = edge.source.kind === "box" ? edge.source.box : undefined;
			if (name !== undefined && !view.boxes.some((known) => known.name === name) && !missing.includes(name)) missing.push(name);
		}
	}
	const inputIds = new Map(inputs.map((name, index) => [name, `i${index}`]));
	const boxIds = new Map([...view.boxes.map((box) => box.name), ...missing].map((name, index) => [name, `b${index}`]));
	const lines = ["flowchart TD"];
	for (const name of inputs) lines.push(`\t${inputIds.get(name)}([${mermaidLabel(`input: ${name}`)}])`);
	for (const box of view.boxes) {
		const units = unitsByBox.get(box.name) ?? [];
		lines.push(`\t${boxIds.get(box.name)}[${mermaidLabel(`${box.name} ${boxState(units)}`)}]`);
	}
	for (const name of missing) lines.push(`\t${boxIds.get(name)}[${mermaidLabel(name)}]`);
	for (const box of view.boxes) {
		const target = boxIds.get(box.name);
		for (const edge of box.edges) {
			const source = edge.source.kind === "input" ? inputIds.get(edge.source.name) : boxIds.get(edge.source.box);
			lines.push(`\t${source} -->|${edgeText(edge)}| ${target}`);
		}
	}
	return lines.join("\n");
}

function handoffList(head: string, lines: readonly string[]): JSXNode {
	return node("col", {
		gap: "none",
		children: [
			node("text", { text: head, tone: "muted" }),
			node("list", {
				children: lines.map((line, index) => node("item", { label: line }, `h${index}`)),
			}),
		],
	});
}

function handoffNodes(handoff: Handoff): readonly JSXNode[] {
	switch (handoff.kind) {
		case "none":
			return [];
		case "raw":
			return [node("text", { text: handoff.text, wrap: "word" })];
		case "parsed": {
			const nodes: JSXNode[] = [node("text", { text: handoff.did, wrap: "word" })];
			if (handoff.decided.length > 0) nodes.push(handoffList(tr("decided", "已决定"), handoff.decided));
			if (handoff.unverified.length > 0) nodes.push(handoffList(tr("unverified", "未验证"), handoff.unverified));
			return nodes;
		}
		default: {
			const unreachable: never = handoff;
			throw new Error(`Unexpected handoff: ${String(unreachable)}`);
		}
	}
}

function phaseDetail(phase: UnitPhase): readonly JSXNode[] {
	switch (phase.kind) {
		case "running":
			return [];
		case "done":
			return handoffNodes(phase.handoff);
		case "raised":
			return [node("text", { text: `${phase.type}: ${phase.detail}`, tone: "warning", wrap: "word" }), ...handoffNodes(phase.handoff)];
		case "split":
			return [node("text", { text: `${phase.parts} ${tr("parts", "部分")}`, tone: "info" }), ...handoffNodes(phase.handoff)];
		case "reopened":
			return [node("text", { text: `${phase.check}: ${phase.output}`, tone: "warning", wrap: "word" }), ...handoffNodes(phase.handoff)];
		case "failed":
			return [node("text", { text: `${phase.name}: ${phase.reason}`, tone: "error", wrap: "word" })];
		case "retry":
			return [node("text", { text: `${phase.name}: ${phase.reason}`, tone: "warning", wrap: "word" })];
		case "cancelled":
			return [node("text", { text: tr("cancelled", "已取消"), tone: "muted" })];
		default: {
			const unreachable: never = phase;
			throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
		}
	}
}

function detailNodes(unit: UnitView | undefined): readonly JSXNode[] {
	if (unit === undefined) return [node("text", { text: tr("No units yet", "暂无单元"), tone: "muted" })];
	const rows: { k: string; v: string }[] = [
		{ k: tr("box", "盒子"), v: unit.box },
		{ k: tr("attempt", "尝试"), v: String(unit.attempt) },
		{ k: tr("chain", "链"), v: String(unit.chain) },
		{ k: tr("phase", "阶段"), v: phaseLabel(unit.phase) },
		{ k: tr("freshness", "时效"), v: freshnessLabel(unit.freshness) },
	];
	if (unit.bound !== null) rows.push({ k: tr("bound", "绑定"), v: String(unit.bound) });
	if (unit.session !== null) rows.push({ k: tr("session", "会话"), v: `history://${unit.session}` });
	return [node("text", { text: unit.key, tone: "accent", wrap: "word" }), node("kv", { items: rows }), ...phaseDetail(unit.phase)];
}

function unitItem(unit: UnitView): JSXNode {
	return node(
		"item",
		{
			label: unit.key,
			detail: `${unit.box} · ${phaseLabel(unit.phase)}`,
			tone: phaseTone(unit.phase),
			value: unit.freshness === "current" ? `#${unit.attempt}` : freshnessLabel(unit.freshness),
		},
		unit.key,
	);
}

function unitsColumn(groups: Record<UnitGroup, readonly UnitView[]>, selected: string | null, lines: number): JSXNode {
	const sections = GROUP_ORDER.map((group) => {
		const units = groups[group];
		if (units.length === 0) return undefined;
		return node("col", {
			gap: "none",
			children: [
				node("text", { text: groupTitle(group), tone: "muted" }),
				node("list", { selected, children: units.map((unit) => unitItem(unit)) }),
			],
		});
	});
	const empty = sections.every((section) => section === undefined)
		? [node("text", { text: tr("No units yet", "暂无单元"), tone: "muted" })]
		: [];
	return node("card", {
		variant: "bare",
		head: tr("units", "单元"),
		collapsed: true,
		preview: { lines },
		grow: 1,
		basis: 0,
		min: { w: "24ch" },
		children: [...empty, ...sections],
	});
}

function boxStates(view: FlowView): JSXNode {
	const unitsByBox = unitsOfBoxes(view);
	return node("kv", { items: view.boxes.map((box) => ({ k: box.name, v: boxState(unitsByBox.get(box.name) ?? []) })) });
}

function wiringColumn(view: FlowView, lines: number): JSXNode {
	return node("card", {
		variant: "bare",
		head: tr("wiring", "接线"),
		collapsed: true,
		preview: { lines },
		grow: 1,
		basis: 0,
		min: { w: "24ch" },
		children:
			view.boxes.length === 0
				? [node("text", { text: tr("No boxes defined", "尚未定义盒子"), tone: "muted" })]
				: [boxStates(view), node("md", { text: `\`\`\`mermaid\n${wiring(view)}\n\`\`\`` })],
	});
}

function detailColumn(unit: UnitView | undefined, lines: number): JSXNode {
	return node("card", {
		variant: "bare",
		head: tr("detail", "详情"),
		collapsed: true,
		preview: { lines },
		grow: 1,
		basis: 0,
		min: { w: "28ch" },
		children: detailNodes(unit),
	});
}

function requestLine(state: RequestState): string {
	switch (state.kind) {
		case "idle":
			return tr("No request sent yet", "尚未发送请求");
		case "sending":
			return tr("Sending…", "发送中…");
		case "accepted":
			return `${tr("accepted", "已接受")}: ${state.summary}`;
		case "refused":
			return `${tr("refused", "被拒绝")}: ${state.reasons.join("; ")}`;
		case "failed":
			return `${tr("request failed", "请求失败")}: ${state.message}`;
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected request state: ${String(unreachable)}`);
		}
	}
}

function requestTone(state: RequestState) {
	switch (state.kind) {
		case "idle":
			return "muted";
		case "sending":
			return "pending";
		case "accepted":
			return "success";
		case "refused":
			return "error";
		case "failed":
			return "error";
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected request state: ${String(unreachable)}`);
		}
	}
}

function hints(editing: EditorMode): string {
	return editing.kind === "browse"
		? tr(
				"up/down select · a answer · g agree · d disagree · s stop · esc close",
				"up/down 选择 · a 答复 · g 同意拆分 · d 拒绝 · s 停止 · esc 关闭",
			)
		: tr("enter submit · esc cancel", "enter 提交 · esc 取消");
}

function promptOf(editing: EditorMode): string {
	switch (editing.kind) {
		case "browse":
			return "";
		case "answer":
			return `${tr("answer", "答复")} ${editing.key}: `;
		case "disagree":
			return `${tr("disagree", "拒绝")} ${editing.key}: `;
		case "stop":
			return `${tr("stop", "停止")}: `;
		default: {
			const unreachable: never = editing;
			throw new Error(`Unexpected editor mode: ${String(unreachable)}`);
		}
	}
}

function placeholderOf(editing: EditorMode): string {
	switch (editing.kind) {
		case "browse":
			return "";
		case "answer":
			return tr("what to send", "要发送的内容");
		case "disagree":
			return tr("why refuse", "拒绝的理由");
		case "stop":
			return tr("why stop", "停止的理由");
		default: {
			const unreachable: never = editing;
			throw new Error(`Unexpected editor mode: ${String(unreachable)}`);
		}
	}
}

function draftOf(editing: EditorMode): string {
	return editing.kind === "browse" ? "" : editing.draft;
}

function draftLength(editing: EditorMode): number {
	return editing.kind === "browse" ? 0 : editing.draft.length;
}

function withDraft(mode: DraftMode, draft: string): EditorMode {
	switch (mode.kind) {
		case "answer":
			return { kind: "answer", key: mode.key, draft };
		case "disagree":
			return { kind: "disagree", key: mode.key, draft };
		case "stop":
			return { kind: "stop", draft };
		default: {
			const unreachable: never = mode;
			throw new Error(`Unexpected editor mode: ${String(unreachable)}`);
		}
	}
}

function applyEdit(mode: EditorMode, edit: TextEdit): EditorMode {
	if (mode.kind === "browse") return mode;
	if (edit.len !== mode.draft.length) return mode;
	return withDraft(mode, `${mode.draft.slice(0, edit.from)}${edit.text}${mode.draft.slice(edit.to)}`);
}

function dropLast(text: string): string {
	if (text === "") return "";
	let last = 0;
	for (const part of segmenter.segment(text)) last = part.index;
	return text.slice(0, last);
}

function typedText(key: KeyEvent): string | undefined {
	if (key.kind === "release") return undefined;
	const text = key.text;
	if (text === undefined || text.length === 0) return undefined;
	return /[\p{Cc}]/u.test(text) ? undefined : text;
}

function outcomeState(outcome: MonitorOutcome): RequestState {
	switch (outcome.kind) {
		case "accepted":
			return { kind: "accepted", summary: outcome.summary };
		case "refused":
			return { kind: "refused", reasons: outcome.reasons };
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unexpected monitor outcome: ${String(unreachable)}`);
		}
	}
}

export function boardNode(props: BoardProps): JSXNode {
	const view = props.view;
	const selectedKey = signal<string | null>(null);
	const editor = signal<EditorMode>({ kind: "browse" });
	const request = signal<RequestState>({ kind: "idle" });

	const dispatch = (message: MonitorRequest): void => {
		request.set({ kind: "sending" });
		void props.port.send(message).then(
			(outcome) => request.set(outcomeState(outcome)),
			(error: unknown) => request.set({ kind: "failed", message: errorText(error) }),
		);
	};

	const submit = (mode: DraftMode): void => {
		editor.set({ kind: "browse" });
		switch (mode.kind) {
			case "answer":
				dispatch({ kind: "answer", key: mode.key, text: mode.draft });
				return;
			case "disagree":
				dispatch({ kind: "disagree", key: mode.key, reason: mode.draft });
				return;
			case "stop":
				dispatch({ kind: "stop", reason: mode.draft });
				return;
			default: {
				const unreachable: never = mode;
				throw new Error(`Unexpected editor mode: ${String(unreachable)}`);
			}
		}
	};

	const onKey = (key: KeyEvent): boolean => {
		const editing = editor.peek();
		if (editing.kind !== "browse") {
			switch (key.id) {
				case "escape":
					editor.set({ kind: "browse" });
					return true;
				case "enter":
					submit(editing);
					return true;
				case "backspace":
					editor.set(withDraft(editing, dropLast(editing.draft)));
					return true;
				default: {
					const text = typedText(key);
					if (text === undefined) return false;
					editor.set(withDraft(editing, editing.draft + text));
					return true;
				}
			}
		}
		const units = orderedUnits(view());
		switch (key.id) {
			case "up":
				selectedKey.set(movedKey(units, selectedKey.peek(), -1));
				return true;
			case "down":
				selectedKey.set(movedKey(units, selectedKey.peek(), 1));
				return true;
			case "a": {
				const unit = selectedUnit(units, selectedKey.peek());
				if (unit === undefined) return true;
				editor.set({ kind: "answer", key: unit.key, draft: "" });
				return true;
			}
			case "g": {
				const unit = selectedUnit(units, selectedKey.peek());
				if (unit !== undefined) dispatch({ kind: "agree", key: unit.key });
				return true;
			}
			case "d": {
				const unit = selectedUnit(units, selectedKey.peek());
				if (unit !== undefined) editor.set({ kind: "disagree", key: unit.key, draft: "" });
				return true;
			}
			case "s":
				editor.set({ kind: "stop", draft: "" });
				return true;
			case "escape":
				props.close?.();
				return true;
			default:
				return false;
		}
	};

	const onEdit = (edit: TextEdit): void => {
		editor.set(applyEdit(editor.peek(), edit));
	};

	const columns = (): JSXNode => {
		const flow = view();
		const groups = groupUnits(flow);
		const ordered = GROUP_ORDER.flatMap((group) => groups[group]);
		const current = selectedUnit(ordered, selectedKey());
		const size = props.size();
		const layout = layoutOf(size.columns, size.rows, nativeRendering());
		const cards = [
			unitsColumn(groups, current?.key ?? null, layout.lines),
			wiringColumn(flow, layout.lines),
			detailColumn(current, layout.lines),
		];
		switch (layout.kind) {
			case "row":
				return node("row", { gap: "md", align: "stretch", children: cards });
			case "stack":
				return node("col", { gap: "sm", children: cards });
			default: {
				const unreachable: never = layout;
				throw new Error(`Unexpected board layout: ${String(unreachable)}`);
			}
		}
	};

	const footer = node("col", {
		gap: "xs",
		children: [
			node("text", { text: () => requestLine(request()), tone: () => requestTone(request()), wrap: "word" }),
			node("input", {
				hidden: () => editor().kind === "browse",
				text: () => draftOf(editor()),
				cursor: () => draftLength(editor()),
				prompt: () => promptOf(editor()),
				placeholder: () => placeholderOf(editor()),
				onEdit,
			}),
			node("text", { text: () => hints(editor()), tone: "muted", wrap: "word" }),
		],
	});

	return node("col", {
		role: "omp.flow.board",
		gap: "sm",
		onKey,
		children: [columns, footer],
	});
}
