import { type ZodLikeSchema, z } from "@oh-my-pi/omptype/zod";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import type {
	Attention,
	BoxView,
	Counts,
	FlowView,
	Handoff,
	ModeView,
	MonitorOutcome,
	MonitorRequest,
	StopView,
	UnitPhase,
	UnitView,
} from "./view.ts";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type PanelFrame =
	| { readonly kind: "view"; readonly view: FlowView }
	| { readonly kind: "outcome"; readonly id: number; readonly outcome: MonitorOutcome }
	| { readonly kind: "failed"; readonly id: number; readonly message: string };

export type ExtensionFrame = { readonly kind: "request"; readonly id: number; readonly request: MonitorRequest };

const handoff: ZodLikeSchema<Handoff> = z.union([
	z.object({ kind: z.literal("parsed"), did: z.string(), decided: z.array(z.string()), unverified: z.array(z.string()) }),
	z.object({ kind: z.literal("raw"), text: z.string() }),
	z.object({ kind: z.literal("none") }),
]);

const phase: ZodLikeSchema<UnitPhase> = z.union([
	z.object({ kind: z.literal("running") }),
	z.object({ kind: z.literal("done"), handoff }),
	z.object({ kind: z.literal("raised"), type: z.string(), detail: z.string(), handoff }),
	z.object({ kind: z.literal("split"), parts: z.number(), handoff }),
	z.object({ kind: z.literal("reopened"), check: z.string(), output: z.string(), handoff }),
	z.object({ kind: z.literal("failed"), name: z.string(), reason: z.string() }),
	z.object({ kind: z.literal("retry"), name: z.string(), reason: z.string() }),
	z.object({ kind: z.literal("cancelled") }),
]);

const unit: ZodLikeSchema<UnitView> = z.object({
	key: z.string(),
	box: z.string(),
	attempt: z.number(),
	chain: z.number(),
	bound: z.number().nullable(),
	phase,
	session: z.string().nullable(),
	freshness: z.enum(["current", "stale", "illegal"]),
});

const box: ZodLikeSchema<BoxView> = z.object({
	name: z.string(),
	kind: z.enum(["agent", "command"]),
	agent: z.string().nullable(),
	model: z.string().nullable(),
	edges: z.array(
		z.object({
			field: z.string(),
			source: z.union([z.object({ kind: z.literal("input"), name: z.string() }), z.object({ kind: z.literal("box"), box: z.string() })]),
			ref: z.union([
				z.object({ kind: z.literal("value") }),
				z.object({ kind: z.literal("fan") }),
				z.object({ kind: z.literal("raise"), type: z.string() }),
			]),
		}),
	),
	checks: z.array(z.string()),
	raises: z.array(z.string()),
});

const stop: ZodLikeSchema<StopView> = z.union([
	z.object({ kind: z.literal("exception"), key: z.string(), name: z.string(), reason: z.string() }),
	z.object({ kind: z.literal("halt"), reason: z.string() }),
]);

const mode: ZodLikeSchema<ModeView> = z.union([
	z.object({ kind: z.literal("idle"), complete: z.boolean() }),
	z.object({ kind: z.literal("running") }),
	z.object({ kind: z.literal("stopped"), cause: stop }),
]);

const attention: ZodLikeSchema<Attention> = z.union([
	z.object({ kind: z.literal("raise"), key: z.string(), type: z.string(), detail: z.string() }),
	z.object({ kind: z.literal("split"), key: z.string(), session: z.string(), parts: z.array(z.string()) }),
	z.object({ kind: z.literal("stopped"), cause: stop }),
]);

const counts: ZodLikeSchema<Counts> = z.object({
	done: z.number(),
	split: z.number(),
	running: z.number(),
	raised: z.number(),
	failed: z.number(),
	cancelled: z.number(),
});

const view: ZodLikeSchema<FlowView> = z.object({
	mode,
	noEscape: z.boolean(),
	counts,
	boxes: z.array(box),
	units: z.array(unit),
	attention: z.array(attention),
});

const outcome: ZodLikeSchema<MonitorOutcome> = z.union([
	z.object({ kind: z.literal("accepted"), summary: z.string() }),
	z.object({ kind: z.literal("refused"), reasons: z.array(z.string()) }),
]);

const request: ZodLikeSchema<MonitorRequest> = z.union([
	z.object({ kind: z.literal("answer"), key: z.string(), text: z.string() }),
	z.object({ kind: z.literal("agree"), key: z.string() }),
	z.object({ kind: z.literal("disagree"), key: z.string(), reason: z.string() }),
	z.object({ kind: z.literal("stop"), reason: z.string() }),
]);

const frameId = z.number().int().nonnegative();

const panelFrame: ZodLikeSchema<PanelFrame> = z.union([
	z.object({ kind: z.literal("view"), view }),
	z.object({ kind: z.literal("outcome"), id: frameId, outcome }),
	z.object({ kind: z.literal("failed"), id: frameId, message: z.string() }),
]);

const extensionFrame: ZodLikeSchema<ExtensionFrame> = z.object({ kind: z.literal("request"), id: frameId, request });

function decode<T>(schema: ZodLikeSchema<T>, line: string): T | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	const parsed = schema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

export function parsePanelFrame(line: string): PanelFrame | undefined {
	return decode(panelFrame, line);
}

export function parseExtensionFrame(line: string): ExtensionFrame | undefined {
	return decode(extensionFrame, line);
}

export function monitorEndpoint(flowDir: string): string {
	return ipcEndpoint(flowDir, "monitor");
}
