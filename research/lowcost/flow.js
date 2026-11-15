// Staged issue flow for eval JS cells. Load after loop.js (it reuses lc.exec/outcome/send/gates):
//   %load .tmp/lowcost/loop.js
//   %load .tmp/lowcost/flow.js
// It defines globalThis.fl.
//
// An issue is delivered by small tasks, never by one agent holding the whole flow. Every task
// is a node; when a node's agent yields, the node kind's `expand` turns the returned object into
// the next nodes (a flatMap over agent results): a scout's slices become implement nodes, its
// open points become one ruling request, a worker's `followups` become new slices, a worker's
// question becomes a ruling request followed by a resume of that same worker.
//
// Correctness is decided by runtime behavior only: gates are commands the program runs on a
// commit, and a ruling arrives as runtime cases that the program adds to the gates. There is no
// review loop. One guardian per issue rules on open points and signs off once at the end.
//
// Declarations (fl.kinds, fl.specs, functions) are replaced by reloading. Lifecycle is plain
// data in fl.issues, mirrored to <dir>/<issue>/state.json with an append-only ledger.jsonl and
// the issue's board.md. Nothing here waits: fl.step() looks once and returns.
(() => {
	const lc = globalThis.lc;
	const fl = (globalThis.fl ??= {});
	fl.specs ??= new Map();
	fl.issues ??= new Map();
	fl.root ??= "<omomp>/omp-config/.tmp/lowcost/v2";
	fl.caps ??= {};
	const now = () => new Date().toISOString();
	const strings = { type: "array", items: { type: "string" } };

	fl.fs = async () => (fl._fs ??= await import("node:fs"));
	fl.dirOf = (issue) => `${fl.root}/${issue}`;
	fl.save = async (state) => (await fl.fs()).writeFileSync(`${fl.dirOf(state.id)}/state.json`, JSON.stringify(state, null, 1));
	fl.note = async (state, type, detail = {}) => (await fl.fs()).appendFileSync(`${fl.dirOf(state.id)}/ledger.jsonl`, `${JSON.stringify({ t: now(), type, ...detail })}\n`);
	fl.board = async (state, author, section, text) => (await fl.fs()).appendFileSync(state.board, `\n## ${now()} · ${author} · ${section}\n\n${String(text).trim()}\n`);
	fl.ledger = async (issue) => {
		const fs = await fl.fs();
		const path = `${fl.dirOf(issue)}/ledger.jsonl`;
		return fs.existsSync(path) ? fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	};

	// ── nodes ────────────────────────────────────────────────────────────────
	fl.add = (state, kind, input = {}, after = []) => {
		const id = `n${++state.seq}`;
		state.nodes[id] = { id, kind, input, after, status: "queued", ref: null, result: null };
		return id;
	};
	fl.laneOf = (state, node) => state.lanes[node.input.lane];
	fl.toolName = (state, lane) => `gate_${state.id}_${lane}`;
	fl.defineTools = (state) => {
		for (const lane of Object.keys(state.lanes)) {
			const issue = state.id;
			const gateTool = async () => globalThis.fl.runGates(globalThis.fl.issues.get(issue), lane, "worker");
			Object.defineProperty(gateTool, "name", { value: fl.toolName(state, lane) });
			globalThis.tool(gateTool, {
				description: "Run every gate of this assignment on the checkout's current commit. Returns {pass, head, gates:[{name, pass, detail}]}. Commit before calling.",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			});
		}
	};

	// ── gates: commands the program runs; a pass is recorded per lane and head ─
	fl.runGates = async (state, laneId, by) => {
		const spec = fl.specs.get(state.id);
		const lane = state.lanes[laneId];
		const view = { id: `${state.id}_${laneId}`, repo: lane.repo, base: state.base, cases: state.cases, casesPath: `${fl.dirOf(state.id)}/cases.json` };
		const head = (await lc.exec("git rev-parse HEAD", lane.repo)).out.trim();
		const results = [];
		for (const gate of spec.gates(state)) {
			let result;
			try {
				result = await gate.run(view);
			} catch (error) {
				result = { pass: false, detail: `gate crashed: ${error?.message ?? error}` };
			}
			results.push({ name: gate.name, pass: result.pass, detail: result.detail });
		}
		const pass = results.every((result) => result.pass);
		lane.gateRuns = (lane.gateRuns ?? 0) + 1;
		if (pass) lane.passedHead = head;
		await fl.save(state);
		await fl.note(state, "gates", { lane: laneId, by, head, pass, failed: results.filter((result) => !result.pass).map((result) => result.name) });
		return { pass, head, gates: results };
	};

	// ── schemas (flat objects: `kind` selects which fields apply) ─────────────
	fl.schemas = {
		scout: {
			type: "object",
			properties: {
				slices: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, files: strings, depends_on: strings, rows: strings, done_when: { type: "string" } }, required: ["id", "title", "files", "depends_on", "rows", "done_when"], additionalProperties: false } },
				open_points: { type: "array", items: { type: "object", properties: { id: { type: "string" }, point: { type: "string" }, input: { type: "string" }, outputs: strings, producer: { type: "string" }, searched: { type: "string" } }, required: ["id", "point", "input", "outputs", "producer", "searched"], additionalProperties: false } },
				gate_gaps: { type: "array", items: { type: "object", properties: { row: { type: "string" }, input: { type: "string" } }, required: ["row", "input"], additionalProperties: false } },
			},
			required: ["slices", "open_points", "gate_gaps"],
			additionalProperties: false,
		},
		// One schema for every request the guardian answers in its single session.
		guardian: {
			type: "object",
			properties: {
				kind: { enum: ["rulings", "signoff"], description: "rulings: answer to a request to rule on points. signoff: answer to a sign-off request." },
				verdict: { enum: ["pass", "fail"], description: "signoff only" },
				results: { type: "array", description: "signoff only: one entry per expected result of the contract", items: { type: "object", properties: { id: { type: "string" }, met: { type: "boolean" }, where: { type: "string" } }, required: ["id", "met", "where"], additionalProperties: false } },
				violations: { type: "array", description: "signoff only: empty when the verdict is pass", items: { type: "object", properties: { where: { type: "string" }, intent: { type: "string", description: "the goal, scenario, result, ruling or scope line it violates, quoted" }, required: { type: "string" } }, required: ["where", "intent", "required"], additionalProperties: false } },
				rulings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							point: { type: "string", description: "id of the point this answers" },
							outcome: { enum: ["contract_decides", "ruled", "dismissed"], description: "contract_decides: the contract already answers it. ruled: a new rule. dismissed: no producer emits the input and the contract does not name it, so no rule is made." },
							decision: { type: "string" },
							basis: { type: "string", description: "the contract or code passage, quoted with its source" },
							cases: { type: "array", description: "runtime cases that pin the decision, in the case format the request names; empty when none can be written", items: { type: "object", properties: { name: { type: "string" }, input: { type: "string" }, expect: { type: "string" } }, required: ["name", "input", "expect"], additionalProperties: false } },
						},
						required: ["point", "outcome", "decision", "basis", "cases"],
						additionalProperties: false,
					},
				},
			},
			required: ["kind"],
			additionalProperties: false,
		},
		work: {
			type: "object",
			properties: {
				kind: { enum: ["done", "help", "blocked"] },
				head: { type: "string", description: "done: the commit the gate tool passed on" },
				decisions: { type: "array", description: "done: implementation choices the contract and rulings did not dictate", items: { type: "object", properties: { point: { type: "string" }, choice: { type: "string" }, basis: { type: "string" } }, required: ["point", "choice", "basis"], additionalProperties: false } },
				followups: { type: "array", description: "done: work of this issue that can be proved separately and that you did not do", items: { type: "object", properties: { title: { type: "string" }, files: strings, done_when: { type: "string" } }, required: ["title", "files", "done_when"], additionalProperties: false } },
				deviations: { ...strings, description: "done: anything you did outside the assignment's rules" },
				risks: { ...strings, description: "done: what you could not verify" },
				points: { type: "array", description: "help: the points you need decided", items: { type: "object", properties: { id: { type: "string" }, point: { type: "string" }, input: { type: "string" }, outputs: strings, producer: { type: "string" } }, required: ["id", "point", "input", "outputs", "producer"], additionalProperties: false } },
				reason: { type: "string", description: "blocked: why no ruling could unblock you" },
				evidence: { ...strings, description: "help or blocked: path:line or command output" },
			},
			required: ["kind"],
			additionalProperties: false,
		},
	};

	// ── node kinds: how to start one, and what its result expands into ───────
	// start(state, node) → {session: "new", agent, brief, schema, tools?} | {session: "send", ref, brief} | {session: "program", run}
	// expand(state, node, value) → void (adds nodes with fl.add)
	fl.kinds = {
		scout: {
			start: (state, node) => ({ session: "new", agent: state.roles.scout, brief: fl.specs.get(state.id).scoutBrief(state), schema: fl.schemas.scout }),
			expand: async (state, node, value) => {
				// A file git ignores can never be part of a commit: drop it, and a slice left without files.
				const repo = Object.values(state.lanes)[0].repo;
				const slices = [];
				const dropped = [];
				for (const slice of value.slices) {
					const files = [];
					for (const file of slice.files) {
						if ((await lc.exec(`git check-ignore -q -- '${file.replace(/'/g, "")}'`, repo)).code === 0) dropped.push(`${slice.id}: ${file} (ignored by git)`);
						else files.push(file);
					}
					if (files.length > 0) slices.push({ ...slice, files, source: "scout" });
					else dropped.push(`${slice.id}: whole slice (no committable file)`);
				}
				const kept = new Set(slices.map((slice) => slice.id));
				state.slices = slices.map((slice) => ({ ...slice, depends_on: slice.depends_on.filter((dep) => kept.has(dep)) }));
				if (dropped.length > 0) await fl.board(state, "program", "DROPPED", dropped.join("\n"));
				state.gateGaps = value.gate_gaps;
				await fl.board(state, "scout", "PLAN", `Slices:\n${value.slices.map((slice) => `- ${slice.id}: ${slice.title} [${slice.files.join(", ")}] rows ${slice.rows.join(",")}`).join("\n")}\n\nOpen points:\n${value.open_points.map((point) => `- ${point.id}: ${point.point} (producer: ${point.producer})`).join("\n") || "(none)"}\n\nGate gaps:\n${value.gate_gaps.map((gap) => `- ${gap.row}: ${gap.input}`).join("\n") || "(none)"}`);
				if (value.open_points.length > 0 || value.gate_gaps.length > 0) fl.add(state, "rule", { points: value.open_points, gaps: value.gate_gaps, then: "implement" });
				else fl.implement(state, []);
			},
		},
		rule: {
			start: (state, node) => {
				const brief = fl.specs.get(state.id).ruleBrief(state, node.input);
				return state.guardian ? { session: "send", ref: state.guardian, brief } : { session: "new", agent: state.roles.guardian, brief: `${fl.specs.get(state.id).guardianIntro(state)}\n\n${brief}`, schema: fl.schemas.guardian, guardian: true };
			},
			expand: async (state, node, value) => {
				const rulings = Array.isArray(value.rulings) ? value.rulings : [];
				state.rulings.push(...rulings);
				for (const ruling of rulings) for (const item of ruling.cases ?? []) state.cases.push({ ...item, ruling: ruling.point });
				(await fl.fs()).writeFileSync(`${fl.dirOf(state.id)}/cases.json`, JSON.stringify(state.cases, null, 1));
				await fl.board(state, "guardian", "RULINGS", rulings.map((ruling) => `- ${ruling.point} [${ruling.outcome}]: ${ruling.decision}\n  basis: ${ruling.basis}${(ruling.cases ?? []).map((item) => `\n  case ${item.name}: ${item.input} → ${item.expect}`).join("")}`).join("\n") || "(none)");
				if (node.input.then === "implement") fl.implement(state, [node.id]);
				else fl.add(state, "work", { lane: node.input.lane, slice: node.input.slice, resume: fl.rulingText(rulings) });
			},
		},
		work: {
			start: (state, node) => {
				const lane = fl.laneOf(state, node);
				if (node.input.resume !== undefined) return { session: "send", ref: lane.worker, brief: node.input.resume };
				return { session: "new", agent: lane.agent, brief: fl.specs.get(state.id).workBrief(state, node.input, lane, fl.toolName(state, node.input.lane)), schema: fl.schemas.work, tools: [fl.toolName(state, node.input.lane)], lane: true };
			},
			expand: async (state, node, value) => {
				const lane = fl.laneOf(state, node);
				lane.turns = (lane.turns ?? 0) + 1;
				if (value.kind === "help" && Array.isArray(value.points) && value.points.length > 0) {
					lane.helps = (lane.helps ?? 0) + 1;
					fl.add(state, "rule", { points: value.points, gaps: [], then: "resume", lane: node.input.lane, slice: node.input.slice });
					return;
				}
				if (value.kind === "blocked") {
					lane.status = "blocked";
					lane.blocked = value.reason;
					return;
				}
				if (value.kind !== "done") {
					fl.add(state, "work", { lane: node.input.lane, slice: node.input.slice, resume: 'Your yield did not follow the protocol. Yield {"kind":"done", …} with `head`, {"kind":"help", …} with `points`, or {"kind":"blocked", …} with `reason`.' });
					return;
				}
				// The worker's own claim is never used: the pass the gate tool recorded on this head is.
				const head = (await lc.exec("git rev-parse HEAD", lane.repo)).out.trim();
				const dirty = (await lc.exec("git status --porcelain", lane.repo)).out.trim();
				let gate = lane.passedHead === head && !dirty ? { pass: true, head, gates: [], reused: true } : await fl.runGates(state, node.input.lane, "program");
				if (dirty) gate = { pass: false, head, gates: [{ name: "committed", pass: false, detail: `uncommitted changes:\n${dirty}` }] };
				await fl.note(state, "done_check", { lane: node.input.lane, head, pass: gate.pass, reused: gate.reused === true });
				if (!gate.pass) {
					lane.gateBounces = (lane.gateBounces ?? 0) + 1;
					if (lane.gateBounces > 3) {
						lane.status = "exhausted";
						return;
					}
					fl.add(state, "work", { lane: node.input.lane, slice: node.input.slice, resume: `The gates did not pass on ${head}, so the slice is not complete:\n${gate.gates.filter((item) => !item.pass).map((item) => `- ${item.name}: ${item.detail}`).join("\n")}\n\nFix it, commit, run the gate tool and yield again. A gate you cannot explain after two tries is a \`help\` request.` });
					return;
				}
				lane.handoffs = [...(lane.handoffs ?? []), { slice: node.input.slice, head, decisions: value.decisions ?? [], deviations: value.deviations ?? [], risks: value.risks ?? [] }];
				if (node.input.slice === "signoff-fix") {
					lane.status = "gated";
					fl.add(state, "signoff", { lane: node.input.lane, head });
					return;
				}
				lane.done = [...(lane.done ?? []), node.input.slice];
				// Dynamic split: work the worker found and left becomes new slices of the same lane.
				for (const [index, followup] of (value.followups ?? []).entries()) {
					const id = `${node.input.slice}.f${index + 1}`;
					state.slices.push({ id, title: followup.title, files: followup.files, depends_on: [node.input.slice], rows: [], done_when: followup.done_when, source: `followup of ${node.input.slice}` });
				}
				fl.advanceLane(state, node.input.lane);
			},
		},
		signoff: {
			start: (state, node) => ({ session: "send", ref: state.guardian, brief: fl.specs.get(state.id).signoffBrief(state, node.input, fl.laneOf(state, node)) }),
			expand: async (state, node, value) => {
				const lane = fl.laneOf(state, node);
				await fl.board(state, "guardian", "SIGNOFF", `lane ${node.input.lane} head ${node.input.head}: ${value.verdict}\n${(value.violations ?? []).map((item) => `- ${item.where}: violates ${item.intent} → ${item.required}`).join("\n") || "(no violations)"}`);
				if (value.verdict === "pass") {
					lane.status = "signed";
					lane.signedHead = node.input.head;
					return;
				}
				lane.signoffs = (lane.signoffs ?? 0) + 1;
				if (lane.signoffs > 1) {
					lane.status = "signoff_failed";
					return;
				}
				fl.add(state, "work", { lane: node.input.lane, slice: "signoff-fix", resume: `The guardian of this issue did not sign off on ${node.input.head}:\n${value.violations.map((item) => `- ${item.where}: violates "${item.intent}" → required: ${item.required}`).join("\n")}\n\nFix exactly these, commit, run the gate tool and yield again.` });
			},
		},
	};
	fl.rulingText = (rulings) => `Rulings on your points:\n${rulings.map((ruling) => `- ${ruling.point} [${ruling.outcome}]: ${ruling.decision}${(ruling.cases ?? []).map((item) => `\n  case ${item.name}: ${item.input} → ${item.expect}`).join("")}`).join("\n")}\n\nThey bind like the contract, and their cases are now part of the gates. Continue the slice and yield again.`;
	// Next slice of a lane whose dependencies that lane has finished; when none is left, sign off.
	fl.advanceLane = (state, laneId, after = []) => {
		const lane = state.lanes[laneId];
		const done = new Set(lane.done ?? []);
		const next = state.slices.find((slice) => !done.has(slice.id) && slice.depends_on.every((dep) => done.has(dep)));
		// Every slice gets a fresh worker session: no agent accumulates the whole issue.
		if (next) {
			fl.add(state, "work", { lane: laneId, slice: next.id }, after);
			return;
		}
		if (state.slices.every((slice) => done.has(slice.id))) {
			lane.status = "gated";
			if (state.signoffLanes.includes(laneId)) fl.add(state, "signoff", { lane: laneId, head: lane.passedHead });
		}
	};
	fl.implement = (state, after) => {
		for (const laneId of Object.keys(state.lanes)) fl.advanceLane(state, laneId, after);
	};

	// ── step: collect what running nodes published, expand, start what is ready ─
	// Caps are per agent definition across every issue: a provider's concurrency limit does not know about issues.
	fl.running = (state, agentName) => [...fl.issues.values()].flatMap((issue) => Object.values(issue.nodes)).filter((node) => node.status === "running" && node.agent === agentName).length;
	fl.startNode = async (state, node) => {
		const plan = fl.kinds[node.kind].start(state, node);
		if (plan.session === "send") {
			if (!plan.ref) throw new Error(`node ${node.id}: no agent session to send to`);
			// One request at a time per session: a second message would land inside the first answer.
			if (Object.values(state.nodes).some((other) => other.status === "running" && other.ref?.id === plan.ref.id)) return false;
			await lc.send(plan.ref, plan.brief);
			node.ref = plan.ref;
			node.agent = plan.ref.agent;
		} else {
			if (fl.caps[plan.agent] !== undefined && fl.running(state, plan.agent) >= fl.caps[plan.agent]) return false;
			const since = Date.now();
			// The guardian is created once; a second request before it exists waits for the next step.
			if (plan.guardian && Object.values(state.nodes).some((other) => other.status === "running" && other.kind === "rule")) return false;
			const handle = await globalThis.agent(plan.brief, { agent: plan.agent, label: `${state.id}:${node.kind}:${node.id}`, schema: plan.schema, schemaMode: "strict", ...(plan.tools ? { tools: plan.tools } : {}) });
			node.ref = { id: handle.id, agent: plan.agent, since, sawRunning: false };
			node.agent = plan.agent;
			if (plan.guardian) state.guardian = node.ref;
			if (plan.lane) fl.laneOf(state, node).worker = node.ref;
		}
		node.status = "running";
		node.startedAt = now();
		await fl.note(state, "start", { node: node.id, kind: node.kind, agent: node.agent, agentId: node.ref.id, lane: node.input.lane, slice: node.input.slice });
		return true;
	};
	fl.step = async (issue) => {
		const state = fl.issues.get(issue);
		for (const node of Object.values(state.nodes).filter((item) => item.status === "running")) {
			const outcome = await lc.outcome(node.ref, (value) => ({ kind: "value", value }));
			if (outcome === null) continue;
			node.endedAt = now();
			if (outcome.kind === "failed") {
				node.status = "failed";
				node.result = outcome.reason;
				await fl.note(state, "node_failed", { node: node.id, kind: node.kind, reason: outcome.reason });
				continue;
			}
			node.status = "done";
			node.result = outcome.value;
			await fl.note(state, "node_done", { node: node.id, kind: node.kind, lane: node.input.lane, yieldKind: outcome.value?.kind ?? outcome.value?.verdict });
			try {
				await fl.kinds[node.kind].expand(state, node, outcome.value);
			} catch (error) {
				node.status = "failed";
				node.result = `expand crashed: ${error?.message ?? error}`;
				await fl.note(state, "expand_failed", { node: node.id, reason: String(error?.message ?? error).slice(0, 300) });
			}
		}
		for (const node of Object.values(state.nodes).filter((item) => item.status === "queued")) {
			if (!node.after.every((id) => state.nodes[id]?.status === "done")) continue;
			try {
				await fl.startNode(state, node);
			} catch (error) {
				node.status = "failed";
				node.result = String(error?.message ?? error).slice(0, 300);
				await fl.note(state, "start_failed", { node: node.id, kind: node.kind, reason: node.result });
			}
		}
		await fl.save(state);
		return fl.view(issue);
	};
	fl.view = (issue) => {
		const state = fl.issues.get(issue);
		return {
			nodes: Object.values(state.nodes).map((node) => `${node.id} ${node.kind}${node.input.lane ? `:${node.input.lane}` : ""}${node.input.slice ? `:${node.input.slice}` : ""} ${node.status}${node.status === "failed" ? ` (${String(node.result).slice(0, 120)})` : ""}`),
			lanes: Object.fromEntries(Object.entries(state.lanes).map(([id, lane]) => [id, { status: lane.status ?? "open", turns: lane.turns ?? 0, helps: lane.helps ?? 0, gateRuns: lane.gateRuns ?? 0, gateBounces: lane.gateBounces ?? 0, head: lane.passedHead?.slice(0, 7) }])),
			rulings: state.rulings.length,
			cases: state.cases.length,
		};
	};

	// ── register an issue; adopts <dir>/<issue>/state.json when it exists ─────
	// spec: {id, base, lanes:{[lane]:{repo, agent}}, roles:{scout, guardian}, signoffLanes:[lane], gates(state)→gate[],
	//        scoutBrief, guardianIntro, ruleBrief, workBrief, signoffBrief, plan?:{slices, open_points, gate_gaps}}
	fl.register = async (spec) => {
		const fs = await fl.fs();
		fl.specs.set(spec.id, spec);
		const dir = fl.dirOf(spec.id);
		fs.mkdirSync(dir, { recursive: true });
		let state = fl.issues.get(spec.id);
		if (!state && fs.existsSync(`${dir}/state.json`)) state = JSON.parse(fs.readFileSync(`${dir}/state.json`, "utf8"));
		if (!state) {
			state = { id: spec.id, base: spec.base, board: `${dir}/board.md`, roles: spec.roles, lanes: Object.fromEntries(Object.entries(spec.lanes).map(([id, lane]) => [id, { ...lane }])), signoffLanes: spec.signoffLanes ?? Object.keys(spec.lanes), nodes: {}, seq: 0, slices: [], rulings: [], cases: [], gateGaps: [], guardian: null };
			fs.writeFileSync(state.board, `# Board of ${spec.id}\n`);
			fs.writeFileSync(`${dir}/cases.json`, "[]");
			if (spec.plan) await fl.kinds.scout.expand(state, { id: "given" }, spec.plan);
			else fl.add(state, "scout");
		}
		fl.issues.set(spec.id, state);
		fl.defineTools(state);
		await fl.save(state);
		return fl.view(spec.id);
	};
})();
