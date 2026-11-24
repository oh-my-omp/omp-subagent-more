await (async () => {
	const presets = await import(`data:text/javascript,${encodeURIComponent(await read("skill://omp-subagent-ng/presets.js"))}`);
	const call = async (args) => {
		const result = await tool.flow(args);
		const text = typeof result === "string" ? result : result.text;
		if (typeof result !== "string" && result.hasError) throw new Error(text);
		return { text, details: typeof result === "string" ? undefined : result.details };
	};
	const verdict = async (args) => {
		const { text } = await call(args);
		print(text);
	};
	const SPEC_KEYS = new Set(["boxes", "inputs", "noEscape"]);
	const isSpec = (value) =>
		typeof value?.boxes === "object" && value.boxes !== null && Object.keys(value).every((key) => SPEC_KEYS.has(key));
	const define = (boxes, opts) =>
		verdict({ op: "define", boxes: JSON.stringify(boxes), ...(opts?.noEscape === undefined ? {} : { noEscape: opts.noEscape }) });
	const supply = (name, value) => verdict({ op: "supply", name, value: JSON.stringify(value) });
	globalThis.flow = {
		define,
		use: async (spec, opts) => {
			const full = isSpec(spec) ? spec : { boxes: spec };
			await define(full.boxes, { noEscape: opts?.noEscape ?? full.noEscape });
			for (const [name, value] of Object.entries({ ...full.inputs, ...opts?.inputs })) await supply(name, value);
		},
		presets: { swarm: presets.swarm, loop: presets.loop },
		supply,
		run: () => verdict({ op: "run" }),
		stop: (reason) => verdict({ op: "stop", reason }),
		status: () => verdict({ op: "status" }),
		retract: (...keys) => verdict({ op: "retract", keys }),
		keep: (...keys) => verdict({ op: "keep", keys }),
		retry: (...keys) => verdict({ op: "retry", keys }),
		answer: (key, value) => verdict({ op: "answer", keys: [key], value: JSON.stringify(value) }),
		agree: (key) => verdict({ op: "agree", keys: [key] }),
		disagree: (key, reason) => verdict({ op: "disagree", keys: [key], reason }),
		value: async (key) => (await call({ op: "value", keys: [key] })).details.values[key],
	};
})();
