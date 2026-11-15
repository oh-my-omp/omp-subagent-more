// Low-cost issue loop for eval JS cells. Load (and reload at any time) with a cell that is only:
//   %load .tmp/lowcost/loop.js
// It defines globalThis.lc.
//
// Two things are kept apart, because the eval kernel is a REPL and can also die:
//   declarations  lc.<function> and lc.specs (briefs, gates, schemas). Reloading this file or an
//                 item file replaces them; nothing running is touched.
//   lifecycle     lc.items: one plain-data state per item, mirrored to <dir>/<id>.json, plus the
//                 append-only <dir>/ledger.jsonl and the item's whiteboard file. Subagents are
//                 referenced by agent id only, read through output() and messaged through
//                 agent://<id>, so a new kernel adopts running agents with lc.register().
// Nothing here waits: lc.step() looks at every item once, reacts to what its agents published
// and returns. Call it when a subagent result wakes the session.
//
// One item = one issue worked in its own checkout with its own whiteboard. A worker yields
//   {kind:"done", handoff} | {kind:"help", category, question, tried, evidence} | {kind:"blocked", reason, evidence}
// and each yield is answered to the SAME worker (gate feedback, review findings, a ruling), so it
// keeps its context. A worker that runs out of bounces is replaced by the next tier of the
// item's ladder, which starts from the whiteboard. The adjudicator only rules; it never implements.
(() => {
	const lc = (globalThis.lc ??= {});
	lc.specs ??= new Map();
	lc.items ??= new Map();
	lc.dir ??= "<omomp>/omp-config/.tmp/lowcost/runs";

	const now = () => new Date().toISOString();
	const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
	const tail = (text, max = 1800) => (text.length > max ? `…${text.slice(-max)}` : text);
	const strings = { type: "array", items: { type: "string" } };

	lc.fs = async () => (lc._fs ??= await import("node:fs"));
	lc.note = async (id, type, detail = {}) => {
		(await lc.fs()).appendFileSync(`${lc.dir}/ledger.jsonl`, `${JSON.stringify({ t: now(), item: id, type, ...detail })}\n`);
	};
	lc.ledger = async (id) => {
		const fs = await lc.fs();
		if (!fs.existsSync(`${lc.dir}/ledger.jsonl`)) return [];
		const rows = fs.readFileSync(`${lc.dir}/ledger.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		return id === undefined ? rows : rows.filter((row) => row.item === id);
	};
	lc.save = async (state) => {
		(await lc.fs()).writeFileSync(`${lc.dir}/${state.id}.json`, JSON.stringify(state, null, 1));
	};
	lc.exec = async (command, cwd, timeout = 600) => {
		try {
			// The orchestrating session may run in light mode; a gate or an evidence command must not inherit it.
			return { code: 0, out: String(await globalThis.sh(`unset OMOMP_MODE; ${command}`, { cwd, timeout })) };
		} catch (error) {
			return { code: error?.exitCode ?? error?.exit_code ?? 1, out: String(error?.output ?? error?.message ?? error) };
		}
	};
	lc.headOf = async (state) => (await lc.exec("git rev-parse HEAD", state.repo)).out.trim();
	lc.dirtyOf = async (state) => (await lc.exec("git status --porcelain", state.repo)).out.trim();
	lc.wb = async (state, author, section, text) => {
		(await lc.fs()).appendFileSync(state.whiteboard, `\n## ${now()} · ${author} · ${section}\n\n${String(text).trim()}\n`);
	};

	// ── deterministic gates (declarations; each runs in the item's checkout) ──
	lc.gates = {
		command: (name, command, options = {}) => ({
			name,
			run: async (state) => {
				const result = await lc.exec(typeof command === "function" ? command(state) : command, state.repo, options.timeout ?? 600);
				const pass = result.code === (options.expectExit ?? 0);
				return { pass, detail: pass ? `exit ${result.code}` : `exit ${result.code}\n${tail(result.out)}` };
			},
		}),
		committed: () => ({
			name: "committed",
			run: async (state) => {
				const dirty = await lc.dirtyOf(state);
				if (dirty) return { pass: false, detail: `uncommitted changes:\n${dirty}` };
				const head = await lc.headOf(state);
				return head === state.base ? { pass: false, detail: "HEAD is the base commit: nothing was committed" } : { pass: true, detail: head };
			},
		}),
		scope: (allowed) => ({
			name: "scope",
			run: async (state) => {
				const diff = await lc.exec(`git diff --name-only ${state.base} HEAD`, state.repo);
				const files = diff.out.split("\n").map((line) => line.trim()).filter(Boolean);
				const outside = files.filter((file) => !allowed.some((pattern) => pattern.test(file)));
				if (outside.length > 0) return { pass: false, detail: `changed files outside the allowed set: ${outside.join(", ")}` };
				return { pass: files.length > 0, detail: files.length > 0 ? files.join(", ") : "no file changed" };
			},
		}),
		absent: (name, pattern, paths) => ({
			name,
			run: async (state) => {
				const result = await lc.exec(`rg -n -e ${quote(pattern)} ${paths.map(quote).join(" ")}`, state.repo);
				return result.code === 1 ? { pass: true, detail: "no match" } : { pass: false, detail: `must not remain:\n${tail(result.out, 600)}` };
			},
		}),
		present: (name, pattern, paths) => ({
			name,
			run: async (state) => {
				const result = await lc.exec(`rg -n -e ${quote(pattern)} ${paths.map(quote).join(" ")}`, state.repo);
				return result.code === 0 ? { pass: true, detail: tail(result.out, 300) } : { pass: false, detail: `expected a match for /${pattern}/ in ${paths.join(", ")}` };
			},
		}),
	};

	lc.runGates = async (id, by) => {
		const spec = lc.specs.get(id);
		const state = lc.items.get(id);
		const head = await lc.headOf(state);
		const results = [];
		for (const gate of spec.gates) {
			let result;
			try {
				result = await gate.run(state);
			} catch (error) {
				result = { pass: false, detail: `gate crashed: ${error?.message ?? error}` };
			}
			results.push({ name: gate.name, pass: result.pass, detail: result.detail });
		}
		const pass = results.every((result) => result.pass);
		if (pass) state.passedHead = head;
		state.gateRuns = (state.gateRuns ?? 0) + 1;
		await lc.save(state);
		await lc.note(id, "gates", { by, head, pass, failed: results.filter((result) => !result.pass).map((result) => result.name) });
		await lc.wb(state, by, "GATES", `head ${head}: ${pass ? "all passed" : "FAILED"}\n${results.map((result) => `- ${result.pass ? "pass" : "FAIL"} ${result.name}${result.pass ? "" : `: ${result.detail}`}`).join("\n")}`);
		return { pass, head, gates: results };
	};

	// ── kernel tools of an item: thin names, bodies looked up on every call ──
	lc.toolNames = (id) => ({ gate: `gate_${id}`, wb: `wb_${id}` });
	lc.defineTools = (id) => {
		const names = lc.toolNames(id);
		const gateTool = async () => globalThis.lc.runGates(id, `worker:${globalThis.lc.items.get(id)?.worker?.tier ?? "unknown"}`);
		Object.defineProperty(gateTool, "name", { value: names.gate });
		globalThis.tool(gateTool, {
			description: "Run every acceptance gate of this assignment on the checkout's current commit. Returns {pass, head, gates:[{name, pass, detail}]}. Commit before calling.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		});
		const wbTool = async ({ kind, text }) => {
			const state = globalThis.lc.items.get(id);
			await globalThis.lc.wb(state, `worker:${state.worker?.tier ?? "unknown"}`, kind, text);
			await globalThis.lc.note(id, "whiteboard", { kind });
			return "appended";
		};
		Object.defineProperty(wbTool, "name", { value: names.wb });
		globalThis.tool(wbTool, {
			description: "Append one entry to this assignment's whiteboard file.",
			parameters: {
				type: "object",
				properties: { kind: { enum: ["PLAN", "FINDING", "DEAD_END", "NOTE"] }, text: { type: "string", minLength: 1 } },
				required: ["kind", "text"],
				additionalProperties: false,
			},
		});
	};

	// ── protocol ─────────────────────────────────────────────────────────────
	lc.HELP_CATEGORIES = ["contract_gap", "gate_unclear", "environment", "scope_conflict", "review_dispute"];
	// One flat object: `kind` selects the shape and the kernel checks the fields of that
	// kind. Object unions in a tool schema are rejected or rewritten by some providers.
	lc.workerSchema = (handoff) => ({
		type: "object",
		properties: {
			kind: { enum: ["done", "help", "blocked"] },
			handoff,
			category: { enum: lc.HELP_CATEGORIES },
			question: { type: "string" },
			tried: strings,
			evidence: strings,
			options: strings,
			reason: { type: "string" },
		},
		required: ["kind"],
		additionalProperties: false,
	});
	lc.rulingSchema = {
		type: "object",
		properties: {
			ruling: { type: "string", minLength: 1 },
			basis: { type: "array", items: { type: "object", properties: { source: { type: "string" }, quote: { type: "string" } }, required: ["source", "quote"], additionalProperties: false } },
			instruction: { type: "string", minLength: 1 },
			contract_gap: { type: "boolean" },
		},
		required: ["ruling", "basis", "instruction", "contract_gap"],
		additionalProperties: false,
	};
	lc.reviewSchema = {
		type: "object",
		properties: {
			verdicts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, verdict: { enum: ["pass", "fail", "unsure"] }, evidence: { type: "string" } }, required: ["id", "verdict", "evidence"], additionalProperties: false } },
			findings: { type: "array", items: { type: "object", properties: { severity: { enum: ["blocker", "ruling_needed", "minor"] }, where: { type: "string" }, problem: { type: "string" }, expected: { type: "string" } }, required: ["severity", "where", "problem", "expected"], additionalProperties: false } },
		},
		required: ["verdicts", "findings"],
		additionalProperties: false,
	};

	// The protocol itself is the loop:worker-* agent definition (.omp/agents); the brief adds only what differs per item.
	lc.workerProtocol = (state) => {
		const names = lc.toolNames(state.id);
		return [
			"## Tools of this assignment",
			`- Gate tool: \`${names.gate}\` (no arguments). It runs every acceptance gate on the checkout's current commit and returns each gate's pass or fail with the failing output.`,
			`- Whiteboard tool: \`${names.wb}\`. Whiteboard file: ${state.whiteboard}`,
		].join("\n");
	};

	lc.classifyWorker = (value) => {
		if (value && typeof value === "object") {
			if (value.kind === "done" && value.handoff && typeof value.handoff === "object") return { kind: "done", handoff: value.handoff };
			if (value.kind === "help" && typeof value.question === "string" && value.question.trim() && lc.HELP_CATEGORIES.includes(value.category)) {
				return { kind: "help", category: value.category, question: value.question, tried: value.tried ?? [], evidence: value.evidence ?? [], options: value.options };
			}
			if (value.kind === "blocked" && typeof value.reason === "string") return { kind: "blocked", reason: value.reason, evidence: value.evidence ?? [] };
			if (["done", "help", "blocked"].includes(value.kind)) {
				const missing = { done: "`handoff`", help: "`category`, `question`, `tried` and `evidence`", blocked: "`reason` and `evidence`" }[value.kind];
				return { kind: "malformed", reason: `a yield of kind "${value.kind}" needs ${missing}` };
			}
		}
		return { kind: "failed", reason: `yield outside the protocol: ${JSON.stringify(value)?.slice(0, 300)}` };
	};
	lc.classifyRuling = (value) =>
		value && typeof value === "object" && typeof value.ruling === "string" && typeof value.instruction === "string"
			? { kind: "ruling", ruling: value.ruling, basis: Array.isArray(value.basis) ? value.basis : [], instruction: value.instruction, contract_gap: value.contract_gap === true }
			: { kind: "failed", reason: `adjudicator yielded outside its schema: ${JSON.stringify(value)?.slice(0, 300)}` };
	lc.classifyReview = (value) =>
		value && typeof value === "object" && Array.isArray(value.findings) && Array.isArray(value.verdicts)
			? { kind: "review", verdicts: value.verdicts, findings: value.findings }
			: { kind: "failed", reason: `reviewer yielded outside its schema: ${JSON.stringify(value)?.slice(0, 300)}` };

	// ── agents by id: what agent://<id> holds now, or null while it works ─────
	lc.newRef = (id, extra = {}) => ({ id, since: Date.now(), sawRunning: false, ...extra });
	lc.outcome = async (ref, classify) => {
		let entry;
		try {
			entry = await globalThis.output(ref.id, { format: "json" });
		} catch (error) {
			return { kind: "failed", reason: `agent ${ref.id}: ${String(error?.message ?? error).slice(0, 300)}` };
		}
		if (entry.path.startsWith("agent://")) {
			if (/is running a newer turn/.test(entry.content)) {
				ref.sawRunning = true;
				return null;
			}
			const status = /^# \S+ \((\w+)\)/m.exec(entry.content)?.[1];
			ref.lastStatus = status ?? entry.content.slice(0, 120);
			if (status === "running") {
				ref.sawRunning = true;
				return null;
			}
			if (status === "aborted" || status === "failed") return { kind: "failed", reason: `agent ${ref.id} ${status}: ${entry.content.slice(0, 400)}` };
			if (ref.sawRunning) return { kind: "failed", reason: `agent ${ref.id} stopped (${status}) without publishing a result` };
			return null;
		}
		const fs = await lc.fs();
		if (fs.statSync(entry.path).mtimeMs <= ref.since) {
			return ref.sawRunning ? { kind: "failed", reason: `agent ${ref.id} stopped without publishing a new result` } : null;
		}
		let value;
		try {
			value = JSON.parse(fs.readFileSync(entry.path.replace(/\.md$/, ".json"), "utf8"));
		} catch {
			try {
				value = JSON.parse(entry.content);
			} catch {
				return { kind: "failed", reason: `agent ${ref.id} published output that is not JSON: ${entry.content.slice(0, 300)}` };
			}
		}
		return classify(value);
	};
	lc.send = async (ref, text) => {
		ref.since = Date.now();
		ref.sawRunning = false;
		await globalThis.tool.write({ path: `agent://${ref.id}`, content: String(text) });
	};

	// ── messages back to the worker ──────────────────────────────────────────
	lc.gateFeedback = (result) =>
		`The acceptance gates did not pass on ${result.head}, so the assignment is not complete:\n${result.gates.filter((gate) => !gate.pass).map((gate) => `- ${gate.name}: ${gate.detail}`).join("\n")}\n\nFix it, commit, run the gate tool, then yield again. If you cannot find the cause, yield {"kind": "help", "category": "gate_unclear", …}.`;
	// Only blockers go back: a worker that is also handed the minor findings rewrites code no check asked it to touch.
	lc.reviewFeedback = (review) =>
		`The review of your commit found problems, so the assignment is not complete:\n${review.findings.filter((finding) => finding.severity === "blocker").map((finding) => `- [${finding.severity}] ${finding.where}: ${finding.problem} → expected: ${finding.expected}`).join("\n")}\n${review.verdicts.filter((verdict) => verdict.verdict === "fail").map((verdict) => `- failed check ${verdict.id}: ${verdict.evidence}`).join("\n")}\n\nFix each blocker and each failed check and nothing else, commit, run the gate tool, then yield again. If you believe a finding is wrong, yield {"kind": "help", "category": "review_dispute", …} with your evidence instead of changing the code.`;
	lc.rulingMessage = (ruling) =>
		ruling
			? `Ruling on your question:\n${ruling.ruling}\n\nWhat to do now:\n${ruling.instruction}\n\nIt is recorded on the whiteboard. Continue the assignment and yield again.`
			: 'No ruling could be obtained. If you can continue without it, do so; otherwise yield {"kind": "blocked", …}.';

	// ── transitions ──────────────────────────────────────────────────────────
	lc.spawnWorker = async (id) => {
		const spec = lc.specs.get(id);
		const state = lc.items.get(id);
		const tier = state.ladder[state.tierIndex];
		const names = lc.toolNames(id);
		const since = Date.now();
		try {
			const handle = await globalThis.agent(`${spec.brief(state, tier).trim()}\n\n${lc.workerProtocol(state)}`, { agent: tier, label: `${id}:${tier}`, schema: lc.workerSchema(spec.handoffSchema), schemaMode: "strict", tools: [names.gate, names.wb] });
			state.worker = { id: handle.id, tier, since, sawRunning: false };
			state.workers.push({ id: handle.id, tier });
			state.phase = "working";
			state.turns = 0;
			state.gateBounces = 0;
			state.reviewBounces = 0;
			state.envHelps = 0;
			await lc.note(id, "spawn", { tier, agent: handle.id });
		} catch (error) {
			await lc.note(id, "spawn_failed", { tier, reason: String(error?.message ?? error).slice(0, 300) });
			await lc.nextTier(id, `${tier} could not be started: ${String(error?.message ?? error).slice(0, 200)}`);
		}
	};
	lc.nextTier = async (id, why) => {
		const state = lc.items.get(id);
		await lc.wb(state, "orchestrator", "WORKER_ENDED", `${why}. The next worker starts from this whiteboard.`);
		state.tierIndex += 1;
		if (state.tierIndex >= state.ladder.length) {
			state.phase = "exhausted";
			await lc.note(id, "end", { status: "exhausted", why });
			return;
		}
		await lc.spawnWorker(id);
	};
	lc.requestRuling = async (id, request) => {
		const spec = lc.specs.get(id);
		const state = lc.items.get(id);
		const text = [
			`## Request from ${request.from} (${request.category})`,
			"```json",
			JSON.stringify({ question: request.question, tried: request.tried, evidence: request.evidence, options: request.options }, null, 1),
			"```",
			`The whiteboard ${state.whiteboard} has the history of this item. Answer with one ruling object.`,
		].join("\n");
		await lc.note(id, "adjudicate", { from: request.from, category: request.category });
		state.pendingRequest = request;
		try {
			if (!state.adjudicator) {
				const since = Date.now();
				const handle = await globalThis.agent(`${spec.adjudicatorBrief(state).trim()}\n\n${text}`, { agent: state.adjudicatorTier, label: `${id}:adjudicator`, schema: lc.rulingSchema, schemaMode: "strict" });
				state.adjudicator = { id: handle.id, since, sawRunning: false };
			} else {
				await lc.send(state.adjudicator, text);
			}
			state.phase = "adjudicating";
		} catch (error) {
			await lc.note(id, "ruling_failed", { reason: String(error?.message ?? error).slice(0, 300) });
			await lc.send(state.worker, lc.rulingMessage(null));
			state.phase = "working";
		}
	};
	lc.startReview = async (id, head) => {
		const spec = lc.specs.get(id);
		const state = lc.items.get(id);
		const tier = spec.review.tierFor(state.worker.tier);
		const since = Date.now();
		// A follow-up review gets the previous one, so it re-judges what failed and reads only the delta for the rest.
		const handle = await globalThis.agent(spec.review.brief(state, head, state.reviews.at(-1)), { agent: tier, label: `${id}:review`, schema: lc.reviewSchema, schemaMode: "strict" });
		state.reviewer = { id: handle.id, tier, head, since, sawRunning: false };
		state.phase = "reviewing";
		await lc.note(id, "review_start", { tier, head, agent: handle.id });
	};

	lc.onWorkerYield = async (id, outcome) => {
		const spec = lc.specs.get(id);
		const state = lc.items.get(id);
		const tier = state.worker.tier;
		state.turns += 1;
		await lc.note(id, "yield", { tier, turn: state.turns, kind: outcome.kind, category: outcome.category, reason: outcome.reason?.slice(0, 300) });
		if (outcome.kind === "blocked" || outcome.kind === "failed") return lc.nextTier(id, `${tier} ended with ${outcome.kind}: ${outcome.reason}`);
		if (state.turns > state.maxTurns) return lc.nextTier(id, `${tier} used ${state.turns} rounds without completing`);
		if (outcome.kind === "malformed") return lc.send(state.worker, `Your yield was not accepted: ${outcome.reason}. Call \`yield\` again with the complete object.`);
		if (outcome.kind === "help") {
			await lc.wb(state, `worker:${tier}`, "HELP", `(${outcome.category}) ${outcome.question}\n\nTried:\n${outcome.tried.map((entry) => `- ${entry}`).join("\n")}\n\nEvidence:\n${outcome.evidence.map((entry) => `- ${entry}`).join("\n")}`);
			// The orchestrator owns the environment: it restores the kernel tools itself once before a ruling is asked for.
			if (outcome.category === "environment" && state.envHelps < 1) {
				state.envHelps += 1;
				lc.defineTools(id);
				return lc.send(state.worker, `The orchestrator restarted the kernel that serves \`${lc.toolNames(id).gate}\` and \`${lc.toolNames(id).wb}\`; both work again. Nothing of your checkout was touched. Call the gate tool on your current commit, record on the whiteboard what you could not record before, and yield again.`);
			}
			return lc.requestRuling(id, { from: `worker:${tier}`, ...outcome });
		}
		// done
		state.handoff = outcome.handoff;
		const head = await lc.headOf(state);
		const reusable = state.passedHead === head && (await lc.dirtyOf(state)) === "";
		const gateResult = reusable ? { pass: true, head, gates: [] } : await lc.runGates(id, "orchestrator");
		await lc.note(id, "done_check", { tier, head, reusedWorkerGate: reusable, pass: gateResult.pass });
		if (!gateResult.pass) {
			if (state.gateBounces < state.maxGateBounces) {
				state.gateBounces += 1;
				return lc.send(state.worker, lc.gateFeedback(gateResult));
			}
			return lc.nextTier(id, `${tier} yielded done ${state.gateBounces + 1} times without passing the gates`);
		}
		if (spec.review) return lc.startReview(id, head);
		state.phase = "passed";
		state.result = { tier, head };
		await lc.note(id, "end", { status: "passed", tier, head });
	};
	lc.onRuling = async (id, outcome) => {
		const state = lc.items.get(id);
		const request = state.pendingRequest;
		state.pendingRequest = undefined;
		state.phase = "working";
		if (outcome.kind !== "ruling") {
			await lc.note(id, "ruling_failed", { reason: outcome.reason?.slice(0, 300) });
			return lc.send(state.worker, lc.rulingMessage(null));
		}
		state.rulings.push({ request, ruling: outcome });
		await lc.note(id, "ruling", { contract_gap: outcome.contract_gap });
		const pendingReview = state.pendingReview;
		state.pendingReview = undefined;
		await lc.wb(state, "adjudicator", "RULING", `Q (${request.from}, ${request.category}): ${request.question}\n\nRuling: ${outcome.ruling}\n\nInstruction: ${outcome.instruction}\n\nBasis:\n${outcome.basis.map((entry) => `- ${entry.source}: ${entry.quote}`).join("\n")}${outcome.contract_gap ? "\n\nCONTRACT GAP: the orchestrator must write this ruling back into the issue contract." : ""}`);
		if (request.from.startsWith("reviewer:")) {
			return lc.send(state.worker, `A reviewer found that your commit decides a point the contract left open, and the adjudicator has ruled on it:\n${outcome.ruling}\n\nWhat to do now:\n${outcome.instruction}\n\nIt is recorded on the whiteboard and binds like the contract. Make the code conform (if it already does, change nothing), ${pendingReview ? `and fix these review findings as well:\n${lc.reviewFeedback(pendingReview)}\n\nThen ` : "then "}commit, run the gate tool and yield again.`);
		}
		return lc.send(state.worker, lc.rulingMessage(outcome));
	};
	lc.onReview = async (id, outcome) => {
		const state = lc.items.get(id);
		const reviewer = state.reviewer;
		const tier = state.worker.tier;
		if (outcome.kind !== "review") {
			await lc.note(id, "review_failed", { tier: reviewer.tier, reason: outcome.reason?.slice(0, 300) });
			state.phase = "review_unusable";
			return;
		}
		const blockers = outcome.findings.filter((finding) => finding.severity === "blocker");
		const open = outcome.findings.filter((finding) => finding.severity === "ruling_needed");
		const failed = outcome.verdicts.filter((verdict) => verdict.verdict === "fail");
		const pass = blockers.length === 0 && failed.length === 0 && open.length === 0;
		// A failed check without a finding cannot be acted on: the worker gets nothing to fix and the adjudicator nothing to rule on.
		if (failed.length > 0 && blockers.length === 0 && open.length === 0 && !reviewer.resent) {
			reviewer.resent = true;
			await lc.note(id, "review_incomplete", { tier: reviewer.tier, failed: failed.map((verdict) => verdict.id) });
			return lc.send(reviewer, `Your result marks ${failed.map((verdict) => verdict.id).join(", ")} as \`fail\` but its \`findings\` list has no \`blocker\` and no \`ruling_needed\` entry, so nobody can act on it. Yield the complete result again: the same verdicts, and for every failed check at least one finding (\`blocker\` when the code contradicts the contract, \`ruling_needed\` when the code decides a point the contract leaves open), each with where, problem and expected.`);
		}
		state.reviews.push({ tier: reviewer.tier, agent: reviewer.id, head: reviewer.head, pass, verdicts: outcome.verdicts, findings: outcome.findings });
		await lc.note(id, "review", { tier: reviewer.tier, head: reviewer.head, pass, blockers: blockers.length, failed: failed.map((verdict) => verdict.id), unsure: outcome.verdicts.filter((verdict) => verdict.verdict === "unsure").map((verdict) => verdict.id) });
		await lc.wb(state, `reviewer:${reviewer.tier}`, "REVIEW", `head ${reviewer.head}: ${pass ? "passed" : "FAILED"}\n${outcome.verdicts.map((verdict) => `- ${verdict.verdict} ${verdict.id}: ${verdict.evidence}`).join("\n")}\n\nFindings:\n${outcome.findings.map((finding) => `- [${finding.severity}] ${finding.where}: ${finding.problem} → ${finding.expected}`).join("\n") || "(none)"}`);
		if (pass) {
			state.phase = "passed";
			state.result = { tier, head: reviewer.head };
			return lc.note(id, "end", { status: "passed", tier, head: reviewer.head });
		}
		// An open point the code decided goes to the adjudicator first; its ruling then reaches the worker together with the review's defects.
		if (open.length > 0) {
			state.pendingReview = blockers.length > 0 || failed.length > 0 ? outcome : undefined;
			return lc.requestRuling(id, {
				from: `reviewer:${reviewer.tier}`,
				category: "review_dispute",
				question: `The reviewer of commit ${reviewer.head} reports that the code decides points the contract leaves open. Rule on each:\n${open.map((finding, index) => `${index + 1}. ${finding.where}: ${finding.problem} (alternatives: ${finding.expected})`).join("\n")}`,
				tried: [],
				evidence: open.map((finding) => finding.where),
			});
		}
		if (state.reviewBounces < state.maxReviewBounces) {
			state.reviewBounces += 1;
			state.phase = "working";
			return lc.send(state.worker, lc.reviewFeedback(outcome));
		}
		return lc.nextTier(id, `${tier} did not clear the review in ${state.reviewBounces + 1} rounds`);
	};

	// ── driving: one look at every item, never a wait ────────────────────────
	lc.stepItem = async (id) => {
		const state = lc.items.get(id);
		try {
			if (state.phase === "working") {
				const outcome = await lc.outcome(state.worker, lc.classifyWorker);
				if (outcome) await lc.onWorkerYield(id, outcome);
			} else if (state.phase === "adjudicating") {
				const outcome = await lc.outcome(state.adjudicator, lc.classifyRuling);
				if (outcome) await lc.onRuling(id, outcome);
			} else if (state.phase === "reviewing") {
				const outcome = await lc.outcome(state.reviewer, lc.classifyReview);
				if (outcome) await lc.onReview(id, outcome);
			}
		} catch (error) {
			await lc.note(id, "step_error", { reason: String(error?.stack ?? error?.message ?? error).slice(0, 600) });
		}
		await lc.save(state);
	};
	lc.view = () =>
		[...lc.items.values()].map((state) => ({
			id: state.id,
			phase: state.phase,
			tier: state.worker?.tier,
			worker: state.worker?.id,
			status: state.worker?.lastStatus,
			turns: state.turns,
			gateBounces: state.gateBounces,
			reviewBounces: state.reviewBounces,
			rulings: state.rulings.length,
			passedHead: state.passedHead?.slice(0, 9),
		}));
	lc.step = async (ids) => {
		for (const id of ids ?? lc.items.keys()) await lc.stepItem(id);
		return lc.view();
	};
	lc.start = async (ids) => {
		for (const id of ids ?? lc.items.keys()) {
			if (lc.items.get(id).phase === "new") {
				await lc.spawnWorker(id);
				await lc.save(lc.items.get(id));
			}
		}
		return lc.view();
	};

	/** Declares an item. Its lifecycle state is adopted from disk when it exists, else created. */
	lc.register = async (spec) => {
		const fs = await lc.fs();
		lc.specs.set(spec.id, spec);
		const file = `${lc.dir}/${spec.id}.json`;
		if (!lc.items.has(spec.id)) {
			if (fs.existsSync(file)) {
				lc.items.set(spec.id, JSON.parse(fs.readFileSync(file, "utf8")));
			} else {
				const state = {
					id: spec.id,
					repo: spec.repo,
					whiteboard: spec.whiteboard,
					ladder: spec.ladder,
					adjudicatorTier: spec.adjudicatorTier ?? "task:high",
					maxTurns: spec.maxTurns ?? 8,
					maxGateBounces: spec.maxGateBounces ?? 2,
					maxReviewBounces: spec.maxReviewBounces ?? 2,
					phase: "new",
					tierIndex: 0,
					turns: 0,
					gateBounces: 0,
					reviewBounces: 0,
					envHelps: 0,
					workers: [],
					reviews: [],
					rulings: [],
				};
				state.base = spec.base ?? (await lc.headOf(state));
				lc.items.set(spec.id, state);
				if (!fs.existsSync(state.whiteboard)) fs.writeFileSync(state.whiteboard, `# Whiteboard of ${spec.id}\n\nAppend-only. Entries below are in time order; each names its author and kind.\n`);
				await lc.save(state);
			}
		}
		lc.defineTools(spec.id);
		return lc.items.get(spec.id);
	};
})();
