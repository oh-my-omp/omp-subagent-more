import type { Accessor, JSXNode } from "@oh-my-pi/pi-tui";
import { tr } from "../../omomp-shared/i18n.ts";
import { node } from "./node.ts";
import type { Attention, BoxView, Counts, FlowView, ModeView, StopView, UnitPhase, UnitView } from "./view.ts";

function modeWord(mode: ModeView): string {
	switch (mode.kind) {
		case "running":
			return tr("running", "运行中");
		case "idle":
			return mode.complete ? tr("complete", "已完成") : tr("idle", "空闲");
		case "stopped":
			return tr("STOPPED", "已停止");
		default: {
			const unreachable: never = mode;
			throw new Error(`Unexpected flow mode: ${String(unreachable)}`);
		}
	}
}

function countsText(counts: Counts): string {
	const parts = [
		`${tr("done", "完成")} ${counts.done}`,
		`${tr("running", "运行")} ${counts.running}`,
		`${tr("raised", "提问")} ${counts.raised}`,
		`${tr("failed", "失败")} ${counts.failed}`,
	];
	if (counts.split > 0) parts.push(`${tr("split", "拆分")} ${counts.split}`);
	if (counts.cancelled > 0) parts.push(`${tr("cancelled", "取消")} ${counts.cancelled}`);
	return parts.join(" · ");
}

function settledPhase(phase: UnitPhase): boolean {
	switch (phase.kind) {
		case "done":
		case "split":
		case "failed":
		case "cancelled":
			return true;
		case "running":
		case "raised":
		case "reopened":
		case "retry":
			return false;
		default: {
			const unreachable: never = phase;
			throw new Error(`Unexpected unit phase: ${String(unreachable)}`);
		}
	}
}

function boxText(box: BoxView, units: readonly UnitView[]): string {
	const own = units.filter((unit) => unit.box === box.name);
	const settled = own.filter((unit) => settledPhase(unit.phase)).length;
	return `${box.name} ${settled}/${own.length}`;
}

function causeReason(cause: StopView): string {
	switch (cause.kind) {
		case "exception":
			return cause.reason;
		case "halt":
			return cause.reason;
		default: {
			const unreachable: never = cause;
			throw new Error(`Unexpected stop cause: ${String(unreachable)}`);
		}
	}
}

function attentionText(attention: readonly Attention[]): string {
	const first = attention[0];
	if (first === undefined) return tr("alt+w opens the board", "alt+w 打开面板");
	const more = attention.length > 1 ? ` +${attention.length - 1}` : "";
	switch (first.kind) {
		case "raise":
			return `${tr("raise", "提问")} ${first.key} ${first.type}${more}`;
		case "split":
			return `${tr("split", "拆分")} ${first.key} ${first.parts.length} ${tr("parts", "部分")}${more}`;
		case "stopped":
			return `${tr("stopped", "停止")} ${causeReason(first.cause)}${more}`;
		default: {
			const unreachable: never = first;
			throw new Error(`Unexpected attention: ${String(unreachable)}`);
		}
	}
}

function summaryText(view: FlowView): string {
	const parts = [`flow ${modeWord(view.mode)}`, countsText(view.counts), ...view.boxes.map((box) => boxText(box, view.units))];
	return parts.join(" · ");
}

export function trayNode(view: Accessor<FlowView | undefined>): JSXNode {
	const hidden = (): boolean => {
		const current = view();
		return current === undefined || current.boxes.length === 0;
	};
	return node("col", {
		role: "flow.tray",
		gap: "none",
		hidden,
		children: () => {
			const current = view();
			if (current === undefined || current.boxes.length === 0) return [];
			return [
				node("text", { text: summaryText(current), wrap: "none", truncate: "end" }),
				node("text", { text: attentionText(current.attention), wrap: "none", truncate: "end", tone: "muted" }),
			];
		},
	});
}
