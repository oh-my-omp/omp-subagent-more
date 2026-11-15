// Pilot item for oh-my-omp/omp-config#323. Load after loop.js with a cell that is only:
//   %load .tmp/lowcost/pilot-323.js
// It defines globalThis.pilot323(id, ladder) → registers the lc item (state adopted from disk when present).
// The roles' standing instructions live in .omp/agents/loop-*.md; the texts here carry only this issue.
(() => {
	const ISSUE = "/tmp/ghc/oh-my-omp-omp-config-323";
	const ROOT = "/tmp/delivering-issues/oh-my-omp-omp-config-323";
	const PROGRAM = "<omomp>/omp-config/.tmp/lowcost";
	const TARGET = "agent/extensions/_shared/ask-answers.ts";
	const strings = { type: "array", items: { type: "string" } };

	const handoffSchema = {
		type: "object",
		properties: {
			head: { type: "string", minLength: 7 },
			files_changed: strings,
			results: {
				type: "array",
				items: { type: "object", properties: { id: { type: "string" }, met: { type: "boolean" }, where: { type: "string" } }, required: ["id", "met", "where"], additionalProperties: false },
			},
			decisions: {
				type: "array",
				items: { type: "object", properties: { point: { type: "string" }, choice: { type: "string" }, basis: { type: "string" } }, required: ["point", "choice", "basis"], additionalProperties: false },
			},
			compile_time_link: { type: "string", minLength: 1 },
			deviations: strings,
			risks: strings,
		},
		required: ["head", "files_changed", "results", "decisions", "compile_time_link", "deviations", "risks"],
		additionalProperties: false,
	};

	const sources = (state) =>
		[
			"# Where things are",
			`- Checkout: ${state.repo} (a private clone of oh-my-omp/omp-config with dependencies installed; base commit ${state.base}).`,
			`- Contract: ${ISSUE}/body.md and the two decision excerpts it inherits, ${ISSUE}/refs/oh-my-omp-omp-config-320-6863721490-s1.md and ${ISSUE}/refs/oh-my-omp-omp-config-320-6863721490-s2.md. Its sections 预期结果, 责任与必要决策 (decision table), 范围边界 and 约束 are the specification.`,
			`- Whiteboard: ${state.whiteboard}`,
			`- Repository conventions: ${state.repo}/AGENTS.md, section "Code conventions".`,
			`- Target module: ${state.repo}/${TARGET}.`,
			`- Host types of the shape to parse: ${state.repo}/node_modules/@oh-my-pi/pi-tui/src/tools/ask.ts (AskToolDetails) and ${state.repo}/node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts (FormAnswer, OptionNote, formAnswers).`,
		].join("\n");

	const brief = (state) =>
		[
			"# Assignment",
			`Implement GitHub issue oh-my-omp/omp-config#323 in the checkout: \`askAnswers\` parses the host's \`details.answers[]\` result of the native \`ask\` tool, as the contract specifies.`,
			"",
			sources(state),
			`- Acceptance driver for your own runs: \`SRC=${state.repo} bun /tmp/a4-ask.ts\`. The gate tool runs its own copy.`,
			"",
			"# Allowed changes",
			`${TARGET}; a test, only if you add one, in a file matching ci/**/*.test.ts. The consumers (turn-judge, user-prompt-inject) and tool-topics stay untouched. Commit message: \`fix: …\`. CHANGELOG.md is written by the integrator, not by you.`,
			"",
			"# Handoff fields",
			"`results`: one entry per 预期结果 of the contract (id `结果 1` … `结果 4`). `compile_time_link`: how a change of the host's AskToolDetails shape becomes a compile error in this module, and how you observed that it does.",
		].join("\n");

	const followUp = (state, head, previous) =>
		previous === undefined || previous.head === head
			? []
			: [
					"# Follow-up review",
					`Commit ${previous.head} was reviewed before. Checks that passed then: ${previous.verdicts.filter((verdict) => verdict.verdict === "pass").map((verdict) => verdict.id).join(", ") || "none"}. Not passed then: ${previous.verdicts.filter((verdict) => verdict.verdict !== "pass").map((verdict) => verdict.id).join(", ") || "none"}; the findings are in the REVIEW entry of the whiteboard.`,
					`Judge the checks that did not pass afresh on ${head}. For the ones that passed, read only \`git -C ${state.repo} diff ${previous.head} ${head}\` and keep the verdict unless that change breaks it; do not redo them from the start.`,
					"",
				];

	const reviewBrief = (state, head, previous) =>
		[
			"# Assignment",
			`Review commit ${head} of the checkout against its contract.`,
			"",
			...followUp(state, head, previous),
			sources(state),
			`- The change: \`git -C ${state.repo} diff ${state.base} ${head}\`.`,
			"",
			"# Checks",
			"- R1 … R4: 预期结果 1–4 of the contract, each read against the code.",
			"- D1: option notes follow the decision table exactly (pairing on name and question both, ` [note: <option> — <text>]` per note in order, whitespace collapsed, empty or unpaired notes dropped).",
			"- D2: blank answers are skipped; all blank or `answers: []` returns null.",
			"- X1: the file header no longer says the native tool reports `details.results[]`, and describes the current shapes truthfully.",
			"- X2: no path hands a `timedOut: true` submission to consumers; `timedOut: false` and an absent field parse as answers.",
			"- C1: the parsed shape is tied to the host's exported AskToolDetails at compile time, so that a host change of that shape (a renamed, added or removed field, optional ones included) fails `tsc` in this module rather than silently returning null. Say what in the code achieves it and whether it really would fail.",
			"- C2: AGENTS.md code conventions hold in the changed lines (no `any`; `as` only with a one-line reason; external input parsed once at the boundary; no comments that restate code).",
			"- S1: nothing outside the contract's scope changed (formatAskAnswers output for legacy shapes, consumers, other modules).",
			"- O1: the code decides no open point on its own: every behavior a user of `formatAskAnswers` can observe is dictated by the contract or by a ruling on the whiteboard.",
		].join("\n");

	const adjudicatorBrief = (state) =>
		[
			"# Item",
			"GitHub issue oh-my-omp/omp-config#323.",
			"",
			sources(state),
			`- Gates of the item: the commit is clean and on top of the base; only the target (and ci/**/*.test.ts) changed; \`SRC=${state.repo} bun ${PROGRAM}/gates/a4-ask.ts\` exits 0; \`bun run check && bun run test\` exits 0; the old header sentence is gone; AskToolDetails is referenced.`,
		].join("\n");

	const reviewerOf = {
		"task:free1": "loop:reviewer-low",
		"task:low": "loop:reviewer-mid",
		"task:mid": "loop:reviewer-low",
		"loop:worker-free": "loop:reviewer-low",
		"loop:worker-low": "loop:reviewer-mid",
		"loop:worker-mid": "loop:reviewer-low",
	};
	globalThis.pilot323 = async (id, ladder) => {
		const repo = `${ROOT}/${id}/repo`;
		// The untouched clone names the base commit; a worker's checkout has already moved past it.
		const base = (await globalThis.lc.exec("git rev-parse HEAD", `${ROOT}/base`)).out.trim();
		return globalThis.lc.register({
			id,
			repo,
			base,
			whiteboard: `${PROGRAM}/runs/323-${id}.md`,
			ladder,
			adjudicatorTier: ladder[0].startsWith("loop:") ? "loop:adjudicator" : "task:high",
			handoffSchema,
			brief,
			adjudicatorBrief,
			review: { tierFor: (tier) => reviewerOf[tier] ?? "loop:reviewer-mid", brief: reviewBrief },
			gates: [
				globalThis.lc.gates.committed(),
				globalThis.lc.gates.scope([/^agent\/extensions\/_shared\/ask-answers\.ts$/, /^ci\/.*\.test\.ts$/]),
				globalThis.lc.gates.command("driver", `SRC=${repo} bun ${PROGRAM}/gates/a4-ask.ts`, { timeout: 120 }),
				globalThis.lc.gates.command("hygiene", "bun run check && bun run test", { timeout: 300 }),
				globalThis.lc.gates.absent("stale-header", "both report `details\\.results\\[\\]`", [TARGET]),
				globalThis.lc.gates.present("host-type-link", "AskToolDetails", [TARGET]),
			],
		});
	};
})();
