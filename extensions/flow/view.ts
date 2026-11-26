import type { Json } from "./defs.ts";

export type Handoff =
	| { readonly kind: "parsed"; readonly did: string; readonly decided: readonly string[]; readonly unverified: readonly string[] }
	| { readonly kind: "raw"; readonly text: string }
	| { readonly kind: "none" };

export type UnitPhase =
	| { readonly kind: "running" }
	| { readonly kind: "done"; readonly handoff: Handoff }
	| { readonly kind: "raised"; readonly type: string; readonly detail: string; readonly handoff: Handoff }
	| { readonly kind: "split"; readonly parts: number; readonly handoff: Handoff }
	| {
			readonly kind: "reopened";
			readonly check: string;
			readonly output: string;
			readonly snapshot: readonly SnapshotEntry[];
			readonly handoff: Handoff;
	  }
	| { readonly kind: "failed"; readonly name: string; readonly reason: string }
	| { readonly kind: "retry"; readonly name: string; readonly reason: string }
	| { readonly kind: "cancelled" };

export type SnapshotEntry = { readonly field: string; readonly text: string };

export type Freshness = "current" | "stale" | "illegal";

export type SessionRef = { readonly id: string; readonly transcript: string | null };

export type BoardRef = { readonly path: string; readonly summary: string };

export type UnitView = {
	readonly key: string;
	readonly box: string;
	readonly attempt: number;
	readonly chain: number;
	readonly bound: number | null;
	readonly phase: UnitPhase;
	readonly freshness: Freshness;
	readonly parent: string | null;
	readonly brief: string;
	readonly agent: string | null;
	readonly model: string | null;
	readonly session: SessionRef | null;
	readonly branch: string | null;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly activity: string | null;
	readonly board: BoardRef | null;
	readonly patch: string | null;
};

export type EdgeSource = { readonly kind: "input"; readonly name: string } | { readonly kind: "box"; readonly box: string };

export type EdgeRef = { readonly kind: "value" } | { readonly kind: "fan" } | { readonly kind: "raise"; readonly type: string };

export type BoxEdge = { readonly field: string; readonly source: EdgeSource; readonly ref: EdgeRef };

export type Tally = { readonly done: number; readonly running: number; readonly attention: number };

export type Rejection = {
	readonly check: string;
	readonly key: string;
	readonly output: string;
	readonly snapshot: readonly SnapshotEntry[];
};

export type LoopView = {
	readonly round: number;
	readonly bound: number;
	readonly rejected: Rejection | null;
};

export type BoxView = {
	readonly name: string;
	readonly kind: "agent" | "command";
	readonly agent: string | null;
	readonly model: string | null;
	readonly rank: number;
	readonly edges: readonly BoxEdge[];
	readonly checks: readonly string[];
	readonly raises: readonly string[];
	readonly tally: Tally;
	readonly fan: number | null;
	readonly loop: LoopView | null;
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

export type Progress = { readonly done: number; readonly total: number };

export type MonitorRequest =
	| { readonly kind: "answer"; readonly key: string; readonly text: string }
	| { readonly kind: "agree"; readonly key: string }
	| { readonly kind: "disagree"; readonly key: string; readonly reason: string }
	| { readonly kind: "stop"; readonly reason: string }
	| { readonly kind: "retract"; readonly key: string }
	| { readonly kind: "noEscape"; readonly on: boolean };

export type MonitorOutcome =
	| { readonly kind: "accepted"; readonly summary: string }
	| { readonly kind: "refused"; readonly reasons: readonly string[] };

export type LastRequest = { readonly at: number; readonly request: MonitorRequest; readonly outcome: MonitorOutcome };

export type DecisionSource = "operator" | "agent" | "check";

export type DecisionAct =
	| { readonly kind: "answer"; readonly key: string; readonly text: string }
	| { readonly kind: "agree"; readonly key: string }
	| { readonly kind: "disagree"; readonly key: string; readonly reason: string }
	| { readonly kind: "retract"; readonly keys: readonly string[] }
	| { readonly kind: "stop"; readonly reason: string }
	| { readonly kind: "noEscape"; readonly on: boolean }
	| { readonly kind: "reopen"; readonly key: string; readonly check: string; readonly output: string };

export type DecisionEvent = { readonly at: number; readonly source: DecisionSource; readonly act: DecisionAct };

export type FlowView = {
	readonly mode: ModeView;
	readonly noEscape: boolean;
	readonly counts: Counts;
	readonly progress: Progress;
	readonly boxes: readonly BoxView[];
	readonly units: readonly UnitView[];
	readonly attention: readonly Attention[];
	readonly decisions: readonly DecisionEvent[];
	readonly last: LastRequest | null;
};

export type WaitingSplit = { readonly key: string; readonly session: string; readonly parts: readonly Json[] };

export type SessionFacts = {
	readonly agent: string | null;
	readonly model: string | null;
	readonly transcript: string | null;
	readonly branch: string | null;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly activity: string | null;
	readonly patch: string | null;
};

export type MonitorPort = {
	readonly send: (request: MonitorRequest) => Promise<MonitorOutcome>;
};
