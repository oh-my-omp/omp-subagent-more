(() => {
	const ISSUE = "/tmp/ghc/oh-my-omp-omp-config-323";
	const ROOT = "/tmp/delivering-issues/oh-my-omp-omp-config-323";
	const PROGRAM = "<omomp>/omp-config/.tmp/lowcost";
	const TARGET = "agent/extensions/_shared/ask-answers.ts";
	const CASE_FORMAT =
		"Case format: `input` is the `details` object of an `ask` tool result (toolName `ask`, isError false) as JSON text; `expect` is the exact string `formatAskAnswers(askAnswers(message))` returns, as JSON text with `\\n` escapes, or `null` when `askAnswers` returns null.";

	const sources = (repo) =>
		[
			"# Where things are",
			`- Contract: ${ISSUE}/body.md and the two decision excerpts it inherits, ${ISSUE}/refs/oh-my-omp-omp-config-320-6863721490-s1.md and ${ISSUE}/refs/oh-my-omp-omp-config-320-6863721490-s2.md. Its sections 预期结果, 责任与必要决策 (decision table), 范围边界, 约束 and the acceptance table are the specification.`,
			`- Checkout: ${repo} (a private clone of oh-my-omp/omp-config with dependencies installed).`,
			`- Module the issue changes: ${repo}/${TARGET}.`,
			`- Host types of the shape to parse: ${repo}/node_modules/@oh-my-pi/pi-tui/src/tools/ask.ts (AskToolDetails) and ${repo}/node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts (FormAnswer, OptionNote, formAnswers).`,
			`- Repository conventions: ${repo}/AGENTS.md, section "Code conventions".`,
		].join("\n");
	const gateList = [
		"- committed: the work is committed on top of the base commit and the tree is clean;",
		"- scope: only the slice's files changed;",
		"- driver: the contract's fixed acceptance script exits 0 (acceptance rows 1–5);",
		"- hygiene: `bun run check && bun run test` exits 0 (row 6);",
		"- stale-header: the header sentence saying the native tool reports `details.results[]` is gone;",
		"- type-link: with a field the parser depends on renamed in a copy of the host types (FormAnswer.answer, AskToolDetails.timedOut, AskToolDetails.notes), `tsc` fails on a copy of the module;",
		"- ruling-cases: every runtime case attached to a ruling gives its expected output.",
	].join("\n");
	const rulingsText = (state) =>
		state.rulings.length === 0
			? "(none)"
			: state.rulings.map((ruling) => `- ${ruling.point} [${ruling.outcome}]: ${ruling.decision}${(ruling.cases ?? []).map((item) => `\n  case ${item.name}: ${item.input} → ${item.expect}`).join("")}`).join("\n");

	globalThis.flow323 = async ({ id, lanes, plan, signoffLanes = [] }) => {
		const base = (await globalThis.lc.exec("git rev-parse HEAD", `${ROOT}/base`)).out.trim();
		const gates = globalThis.lc.gates;
		return globalThis.fl.register({
			id,
			base,
			lanes,
			roles: { scout: "loop:scout-mid", guardian: "loop:guardian" },
			signoffLanes,
			plan,
			gates: (state) => [
				gates.committed(),
				gates.scope([...new Set(state.slices.flatMap((slice) => slice.files))].map((file) => new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)).concat([/^ci\/.*\.test\.ts$/])),
				gates.command("driver", (view) => `SRC=${view.repo} bun ${PROGRAM}/gates/a4-ask.ts`, { timeout: 120 }),
				gates.command("hygiene", "bun run check && bun run test", { timeout: 300 }),
				gates.absent("stale-header", "both report `details\\.results\\[\\]`", [TARGET]),
				gates.command("type-link", (view) => `SRC=${view.repo} bun ${PROGRAM}/gates/typelink-323.ts`, { timeout: 120 }),
				gates.command("ruling-cases", (view) => `SRC=${view.repo} CASES=${view.casesPath} bun ${PROGRAM}/gates/cases-323.ts`, { timeout: 60 }),
			],
			scoutBrief: () => ["# Assignment", "Plan the delivery of GitHub issue oh-my-omp/omp-config#323 as slices, open points and gate gaps.", "", sources(`${ROOT}/base`), "- A plugin that also produces `ask` results on this machine: ~/.omp/plugins/node_modules/omp-ask-more (src/result.ts)."].join("\n"),
			guardianIntro: () =>
				[
					"# Issue",
					"GitHub issue oh-my-omp/omp-config#323. You are its guardian for this whole session.",
					"",
					sources(`${ROOT}/base`),
					`- The checkout above is the base commit (${base}); workers change private clones of it, one slice at a time.`,
					"- A plugin that also produces `ask` results on this machine: ~/.omp/plugins/node_modules/omp-ask-more (src/result.ts).",
					"",
					"# Gates the program runs on every worker commit",
					gateList,
					"",
					CASE_FORMAT,
				].join("\n"),
			ruleBrief: (state, input) =>
				[
					"# Request: rule on points",
					"Answer with `kind: \"rulings\"`: one entry per point id below, gate gaps included.",
					"",
					"## Open points",
					input.points.map((point) => `- ${point.id}: ${point.point}\n  input: ${point.input}\n  outputs the wording allows: ${(point.outputs ?? []).join(" | ")}\n  producer: ${point.producer}`).join("\n") || "(none)",
					"",
					"## Gate gaps",
					"Rows of the contract that its own acceptance commands never feed. The contract decides each one; give the runtime cases that observe it (outcome `contract_decides`). A gap that needs a real session rather than a call of the module gets an empty `cases` list and a decision saying which acceptance issue observes it.",
					input.gaps.map((gap, index) => `- gap${index + 1}: ${gap.row}\n  input: ${gap.input}`).join("\n") || "(none)",
					"",
					CASE_FORMAT,
				].join("\n"),
			workBrief: (state, input, lane, toolName) => {
				const slice = state.slices.find((item) => item.id === input.slice);
				return [
					"# Assignment",
					`Implement one slice of GitHub issue oh-my-omp/omp-config#323 in the checkout ${lane.repo}.`,
					`Slice ${slice.id}: ${slice.title}`,
					`Done when: ${slice.done_when}`,
					`Files you may change: ${slice.files.join(", ")}; a test, only if you add one, in a file matching ci/**/*.test.ts. Nothing else, including the consumers (turn-judge, user-prompt-inject) and tool-topics.`,
					"",
					sources(lane.repo),
					`- The contract's acceptance script, for your own runs: \`SRC=${lane.repo} bun /tmp/a4-ask.ts\`.`,
					"",
					"# Rulings already made on points the contract left open",
					rulingsText(state),
					"",
					"# Gates",
					`Gate tool: \`${toolName}\` (no arguments). It runs, on the checkout's current commit:`,
					gateList,
					"",
					"# Commit",
					`Plain git inside the checkout: \`git -C ${lane.repo} add …\` and \`git -C ${lane.repo} commit -m "fix: …"\`. No lgit, no CHANGELOG.md entry, no push, no pull request: the dispatcher does those.`,
				].join("\n");
			},
			signoffBrief: (state, input, lane) =>
				[
					"# Request: sign off",
					"Answer with `kind: \"signoff\"`.",
					`Commit ${input.head} in ${lane.repo}; the change is \`git -C ${lane.repo} diff ${base} ${input.head}\`.`,
					"Every gate listed in your first message passed on this commit, the ruling cases included.",
					"",
					"## Rulings of this issue",
					rulingsText(state),
					"",
					"## Decisions the workers made on their own",
					(lane.handoffs ?? []).flatMap((handoff) => handoff.decisions.map((decision) => `- ${decision.point}: ${decision.choice} (${decision.basis})`)).join("\n") || "(none)",
					"",
					"## Deviations and risks the workers reported",
					(lane.handoffs ?? []).flatMap((handoff) => [...handoff.deviations.map((item) => `- deviation: ${item}`), ...handoff.risks.map((item) => `- risk: ${item}`)]).join("\n") || "(none)",
					"",
					"`results`: one entry per 预期结果 of the contract (id `结果 1` … `结果 4`).",
				].join("\n"),
		});
	};
})();
