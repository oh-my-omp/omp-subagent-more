// Loaded into an eval JavaScript kernel with %load. Defines globalThis.flow: each function
// turns JavaScript values into one `tool.flow` call, prints the verdict the call returned, and
// throws when the call was refused. It keeps nothing: the flow's state is the tool's.
(() => {
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
	globalThis.flow = {
		define: (boxes) => verdict({ op: "define", boxes: JSON.stringify(boxes) }),
		supply: (name, value) => verdict({ op: "supply", name, value: JSON.stringify(value) }),
		run: () => verdict({ op: "run" }),
		stop: (reason) => verdict({ op: "stop", reason }),
		status: () => verdict({ op: "status" }),
		retract: (...keys) => verdict({ op: "retract", keys }),
		keep: (...keys) => verdict({ op: "keep", keys }),
		retry: (...keys) => verdict({ op: "retry", keys }),
		answer: (key, value) => verdict({ op: "answer", keys: [key], value: JSON.stringify(value) }),
		value: async (key) => (await call({ op: "value", keys: [key] })).details.values[key],
	};
})();
