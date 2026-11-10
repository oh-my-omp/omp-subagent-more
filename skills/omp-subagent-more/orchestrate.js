// omp-subagent-more orchestration for eval JS cells. Load with a cell that is only:
//   %load skill://omp-subagent-more/orchestrate.js
// It defines globalThis.orchestrate; usage is in skill://omp-subagent-more.
//
// Each item is a pipeline of stages; each stage is one subagent from the eval
// prelude's agent(). The subagent yields one of two shapes, validated by OMP's
// yield (strict schema): {kind:"done", data} or {kind:"needs_input", question,
// options?}. A failure (cancelled, schema exhausted, yield error) is the third
// outcome. drive() advances every item until all are settled or a new
// needs_input appears, and returns with no bridge call outstanding. answer()
// sends text to the same subagent, which continues in its own session.
//
// Outcome sources: a stage's first outcome comes from its handle (status, then
// wait on a settled handle). After an answer, or once OMP evicted the handle's
// job (`result expired`), the outcome is read from agent://<id>: the handle
// keeps the first result forever, so it cannot show what came after.
(() => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const protocolSchema = (data) => ({
		oneOf: [
			{
				type: "object",
				properties: { kind: { const: "done" }, data },
				required: ["kind", "data"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					kind: { const: "needs_input" },
					question: { type: "string", minLength: 1 },
					options: { type: "array", items: { type: "string" } },
				},
				required: ["kind", "question"],
				additionalProperties: false,
			},
		],
	});

	const PROTOCOL = [
		"## How to finish",
		"Finish by calling `yield` with its `data` argument set to exactly one of these objects. The object goes inside `data`; `kind` is never a top-level argument of `yield`.",
		'- The assignment is complete: `{"kind": "done", "data": <result>}`, where `<result>` matches the result schema you were given.',
		'- You reached a decision that belongs to whoever dispatched you and must not be guessed: `{"kind": "needs_input", "question": "…", "options": ["…", "…"]}`, where `options` (optional) is a JSON array of strings. Ask only about a choice the assignment leaves open, never about what the assignment is or whether it is complete. You were dispatched by code, not a person: a question goes only through this `yield`, never through the `ask` tool or any other tool. This is not a failure: the answer arrives as a message in this same session; continue the assignment and call `yield` again.',
	].join("\n");

	const taskText = (context, stage) =>
		[context ? `${context.trim()}\n` : "", stage.task.trim(), "", PROTOCOL].filter((part, i) => i > 0 || part).join("\n");

	/** A yield value as the protocol's outcome, or a failure naming what arrived. */
	const classify = (value) => {
		if (value && typeof value === "object" && value.kind === "done" && "data" in value) return { kind: "done", data: value.data };
		if (value && typeof value === "object" && value.kind === "needs_input" && typeof value.question === "string") {
			return { kind: "needs_input", question: value.question, options: Array.isArray(value.options) ? value.options : undefined };
		}
		return { kind: "failed", reason: `the subagent yielded outside the protocol: ${JSON.stringify(value)?.slice(0, 200)}` };
	};

	const isExpired = (error) => /result expired/.test(String(error?.message ?? error));

	/** The outcome OMP's agent://<id> holds now, or null while the stage is still working toward one. */
	async function publishedOutcome(id, since, watch) {
		const entry = await globalThis.output(id, { format: "json" });
		if (entry.path.startsWith("agent://")) {
			// No current output file: a superseded previous run, or the progress view of an unpublished one.
			if (/is running a newer turn/.test(entry.content)) {
				watch.sawRunning = true;
				return null;
			}
			const status = /^# \S+ \((\w+)\)/m.exec(entry.content)?.[1];
			if (status === "running") {
				watch.sawRunning = true;
				return null;
			}
			if (status === "aborted") return { kind: "failed", reason: `agent ${id} was aborted` };
			if (watch.sawRunning) return { kind: "failed", reason: `agent ${id} stopped (${status}) without publishing a result` };
			return null;
		}
		// %load runs this file as a cell script, which has no static imports.
		const fs = await import("node:fs/promises");
		const published = (await fs.stat(entry.path)).mtimeMs;
		if (published <= since) {
			return watch.sawRunning ? { kind: "failed", reason: `agent ${id} stopped without publishing a new result` } : null;
		}
		const sidecar = entry.path.replace(/\.md$/, ".json");
		let value;
		try {
			value = JSON.parse(await fs.readFile(sidecar, "utf8"));
		} catch {
			// No or partial sidecar: the output file itself holds the yield.
			try {
				value = JSON.parse(entry.content);
			} catch {
				return { kind: "failed", reason: `agent ${id} published output that is not JSON` };
			}
		}
		return classify(value);
	}

	/** The first outcome of a running stage from its handle, or null while it runs. */
	async function handleOutcome(item) {
		const run = item.run;
		let status;
		try {
			status = await run.handle.status();
		} catch (error) {
			if (!isExpired(error)) throw error;
			run.expired = true;
			return publishedOutcome(run.id, run.startedAt, run.watch);
		}
		if (status === "running") return null;
		const [value] = await globalThis.wait([run.handle], { raiseErrors: false });
		return value instanceof Error ? { kind: "failed", reason: value.message } : classify(value);
	}

	function orchestrate(spec) {
		if (!spec || !Array.isArray(spec.items) || spec.items.length === 0)
			throw new TypeError("orchestrate({ items: [...] }) needs at least one item");
		// How long drive() sleeps between rounds in which nothing settled.
		const pollMs = spec.pollMs ?? 1000;
		const ids = new Set();
		const items = spec.items.map((raw) => {
			if (typeof raw?.id !== "string" || raw.id.length === 0) throw new TypeError("every item needs a string id");
			if (ids.has(raw.id)) throw new TypeError(`duplicate item id ${raw.id}`);
			ids.add(raw.id);
			if (!Array.isArray(raw.stages) || raw.stages.length === 0) throw new TypeError(`item ${raw.id} needs at least one stage`);
			for (const stage of raw.stages) {
				if (typeof stage?.task !== "string" || !stage.task.trim()) throw new TypeError(`item ${raw.id}: every stage needs a task`);
				if (!stage.data || typeof stage.data !== "object") throw new TypeError(`item ${raw.id}: every stage needs a data schema`);
			}
			return { id: raw.id, stages: raw.stages, stage: 0, state: { kind: "pending" }, results: [], run: undefined };
		});

		const start = (item) => {
			const stage = item.stages[item.stage];
			const options = { schema: protocolSchema(stage.data), schemaMode: "strict", label: `${item.id}.${item.stage + 1}` };
			if (stage.agent !== undefined) options.agent = stage.agent;
			if (stage.isolated !== undefined) options.isolated = stage.isolated;
			// agent() returns a thenable that resolves to the handle once OMP allocated the subagent.
			const pending = globalThis.agent(taskText(spec.context, stage), options);
			item.run = {
				pending,
				handle: undefined,
				id: undefined,
				startedAt: Date.now(),
				answeredAt: undefined,
				expired: false,
				watch: { sawRunning: false },
			};
			item.state = { kind: "running" };
		};

		/** Applies a settled stage outcome; returns true when it is a new needs_input. */
		const settle = (item, outcome) => {
			switch (outcome.kind) {
				case "done":
					item.results.push({ stage: item.stage + 1, data: outcome.data });
					item.stage += 1;
					if (item.stage < item.stages.length) start(item);
					else item.state = { kind: "done" };
					return false;
				case "needs_input":
					item.state = { kind: "needs_input", question: outcome.question, options: outcome.options };
					return true;
				case "failed":
					item.state = { kind: "failed", reason: outcome.reason };
					return false;
				default:
					throw new Error(`unknown outcome ${outcome.kind}`);
			}
		};

		const poll = async (item) => {
			const run = item.run;
			if (run.handle === undefined) {
				try {
					run.handle = await run.pending;
				} catch (error) {
					return { kind: "failed", reason: String(error?.message ?? error) };
				}
				run.id = run.handle.id;
			}
			if (run.answeredAt === undefined && !run.expired) return handleOutcome(item);
			return publishedOutcome(run.id, run.answeredAt ?? run.startedAt, run.watch);
		};

		const snapshot = () => {
			const view = { done: [], failed: [], needs_input: [], running: [] };
			for (const item of items) {
				switch (item.state.kind) {
					case "done":
						view.done.push({ id: item.id, results: item.results.slice() });
						break;
					case "failed":
						view.failed.push({ id: item.id, stage: item.stage + 1, reason: item.state.reason, results: item.results.slice() });
						break;
					case "needs_input":
						view.needs_input.push({ id: item.id, stage: item.stage + 1, question: item.state.question, options: item.state.options });
						break;
					case "running":
					case "pending":
						view.running.push({ id: item.id, stage: item.stage + 1 });
						break;
					default:
						throw new Error(`unknown item state ${item.state.kind}`);
				}
			}
			return view;
		};

		const drive = async () => {
			for (const item of items) if (item.state.kind === "pending") start(item);
			for (;;) {
				const running = items.filter((item) => item.state.kind === "running");
				if (running.length === 0) return snapshot();
				const outcomes = await Promise.all(running.map((item) => poll(item)));
				let escalated = false;
				running.forEach((item, i) => {
					const outcome = outcomes[i];
					if (outcome) escalated = settle(item, outcome) || escalated;
				});
				if (escalated) return snapshot();
				if (outcomes.every((outcome) => outcome === null)) await sleep(pollMs);
			}
		};

		const answer = async (id, text) => {
			const item = items.find((candidate) => candidate.id === id);
			if (!item) throw new Error(`no item ${id}`);
			if (item.state.kind !== "needs_input") throw new Error(`item ${id} is not waiting for an answer (it is ${item.state.kind})`);
			const run = item.run;
			run.answeredAt = Date.now();
			run.watch = { sawRunning: false };
			await run.handle.send(String(text));
			item.state = { kind: "running" };
			return { id, stage: item.stage + 1 };
		};

		return { drive, answer, status: snapshot };
	}

	globalThis.orchestrate = orchestrate;
})();
