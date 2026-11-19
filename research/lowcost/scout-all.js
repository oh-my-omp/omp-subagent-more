(() => {
	const lc = globalThis.lc;
	const fl = globalThis.fl;
	const sc = (globalThis.sc ??= {});
	sc.cap ??= 6;
	sc.dir = "<omomp>/omp-config/.tmp/lowcost/scouts";
	sc.jobs ??= {};
	const local = (repo) => `<omomp>/${repo}`;
	sc.checkoutOf = (ref) => {
		const repo = ref.split("#")[0].split("/")[1];
		if (repo === "omp-config") return "/tmp/delivering-issues/oh-my-omp-omp-config-323/base";
		if (repo === "pi-bansos") return "/tmp/delivering-issues/scout/pi-bansos";
		return local(repo);
	};
	sc.keyOf = (ref) => ref.replace("/", "-").replace("#", "-");
	sc.brief = (ref) => {
		const dir = `/tmp/ghc/${sc.keyOf(ref)}`;
		const checkout = sc.checkoutOf(ref);
		return [
			"# Assignment",
			`Plan the delivery of GitHub issue ${ref} as slices, open points and gate gaps.`,
			"",
			"# Where things are",
			`- Contract: ${dir}/body.md, and every file under ${dir}/refs/ (the decisions it inherits). Its sections 预期结果, 责任与必要决策 (decision table), 范围 / 范围边界, 约束 and the acceptance table (验收标准) are the specification.`,
			`- Checkout of the repository at its default branch, read-only for you: ${checkout}. Its AGENTS.md holds the repository's conventions.`,
			"- Your session's working directory is a different checkout; take no file contents from it.",
			"",
			"# Result",
			"`slices`: id, title, files (repository-relative), depends_on (slice ids), rows (acceptance row numbers of the contract this slice makes pass), done_when (one observable sentence).",
			"`open_points`: id, point, input (the concrete input), outputs (each output the contract's wording would allow), producer (path:line of who can emit that input, or `none`), searched (what you searched to establish the producer).",
			"`gate_gaps`: row (the expected result or decision-table row), input (the input that would observe it).",
		].join("\n");
	};
	sc.register = (refs) => {
		for (const ref of refs) sc.jobs[ref] ??= { ref, status: "queued", ref_: null };
	};
	sc.step = async () => {
		const fs = await fl.fs();
		fs.mkdirSync(sc.dir, { recursive: true });
		for (const job of Object.values(sc.jobs).filter((item) => item.status === "running")) {
			const outcome = await lc.outcome(job.agent, (value) => ({ kind: "value", value }));
			if (outcome === null) continue;
			if (outcome.kind === "failed") {
				job.status = "failed";
				job.reason = outcome.reason;
				continue;
			}
			job.status = "done";
			job.endedAt = Date.now();
			fs.writeFileSync(`${sc.dir}/${sc.keyOf(job.ref)}.json`, JSON.stringify({ ref: job.ref, agent: job.agent.id, seconds: Math.round((job.endedAt - job.agent.since) / 1000), ...outcome.value }, null, 1));
		}
		for (const job of Object.values(sc.jobs).filter((item) => item.status === "queued")) {
			if (Object.values(sc.jobs).filter((item) => item.status === "running").length >= sc.cap) break;
			if (fs.existsSync(`${sc.dir}/${sc.keyOf(job.ref)}.json`)) {
				job.status = "done";
				continue;
			}
			const since = Date.now();
			try {
				const handle = await globalThis.agent(sc.brief(job.ref), { agent: "loop:scout", label: `scout:${sc.keyOf(job.ref)}`, schema: fl.schemas.scout, schemaMode: "strict" });
				job.agent = { id: handle.id, since, sawRunning: false };
				job.status = "running";
			} catch (error) {
				job.status = "failed";
				job.reason = String(error?.message ?? error).slice(0, 300);
			}
		}
		return Object.values(sc.jobs).map((job) => `${job.ref} ${job.status}${job.reason ? ` (${job.reason.slice(0, 100)})` : ""}`);
	};
})();
