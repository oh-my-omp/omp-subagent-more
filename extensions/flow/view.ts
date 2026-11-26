import type { Json } from "./defs.ts";

export type Handoff =
	| { readonly kind: "parsed"; readonly did: string; readonly decided: readonly string[]; readonly unverified: readonly string[] }
	| { readonly kind: "raw"; readonly text: string };

export type UnitPhase =
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly handoff: Handoff }
	| { readonly kind: "raised"; readonly type: string; readonly detail: string; readonly handoff: Handoff }
	| { readonly kind: "split"; readonly parts: number; readonly handoff: Handoff }
	| { readonly kind: "reopened"; readonly check: string; readonly output: string; readonly handoff: Handoff }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "retry"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

export type Freshness = "current" | "stale" | "illegal";

export type UnitView = {
	readonly key: string;
	readonly box: string;
	readonly attempt: number;
	readonly chain: number;
	readonly bound: number | null;
	readonly phase: UnitPhase;
	readonly session: string | null;
	readonly freshness: Freshness;
};

export type EdgeSource = { readonly kind: "input"; readonly name: string } | { readonly kind: "box"; readonly box: string };

export type EdgeRef = { readonly kind: "value" } | { readonly kind: "fan" } | { readonly kind: "raise"; readonly type: string };

export type BoxEdge = { readonly field: string; readonly source: EdgeSource; readonly ref: EdgeRef };

export type BoxView = {
	readonly name: string;
	readonly kind: "agent" | "command";
	readonly agent: string | null;
	readonly model: string | null;
	readonly edges: readonly BoxEdge[];
	readonly checks: readonly string[];
	readonly raises: readonly string[];
};

export type StopView =
	| { readonly kind: "exception"; readonly key: string; readonly name: string; readonly reason: string }
	| { readonly kind: "halt"; readonly reason: string };

export type ModeView =
	| { readonly kind: "idle"; readonly complete: boolean }
	| { readonly kind: "running" }
	| { readonly kind: "stopped"; readonly cause: StopView };

export type Attention =
	| { readonly kind: "raise"; readonly key: string; readonly type: string; readonly detail: string }
	| { readonly kind: "split"; readonly key: string; readonly session: string; readonly parts: readonly string[] }
	| { readonly kind: "stopped"; readonly cause: StopView };

export type Counts = {
	readonly done: number;
	readonly split: number;
	readonly running: number;
	readonly raised: number;
	readonly failed: number;
	readonly cancelled: number;
};

export type FlowView = {
	readonly mode: ModeView;
	readonly noEscape: boolean;
	readonly counts: Counts;
	readonly boxes: readonly BoxView[];
	readonly units: readonly UnitView[];
	readonly attention: readonly Attention[];
};

export type WaitingSplit = { readonly key: string; readonly session: string; readonly parts: readonly Json[] };

export type MonitorRequest =
	| { readonly kind: "answer"; readonly key: string; readonly text: string }
	| { readonly kind: "agree"; readonly key: string }
	| { readonly kind: "disagree"; readonly key: string; readonly reason: string }
	| { readonly kind: "stop"; readonly reason: string };

export type MonitorOutcome =
	| { readonly kind: "accepted"; readonly summary: string }
	| { readonly kind: "refused"; readonly reasons: readonly string[] };

export type MonitorPort = {
	readonly send: (request: MonitorRequest) => Promise<MonitorOutcome>;
};
