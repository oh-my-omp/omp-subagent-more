const OUT = { type: "object" };

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const fanned = (box) => Object.values(box.in ?? {}).some((ref) => ref.endsWith("[]"));

const named = (kind, spec) => {
	if (typeof spec?.name !== "string" || spec.name === "") throw new Error(`${kind}: every spec needs a non-empty \`name\``);
	const { name, ...box } = spec;
	return [name, box];
};

const gateOf = (spec, checked) => {
	const { name = "gate", ...box } = spec;
	const inputs = Object.fromEntries(checked.map(([source, box]) => [source, fanned(box) ? `${source}[]` : source]));
	return [name, { ...box, in: { ...inputs, ...box.in }, checks: checked.map(([source]) => source) }];
};

const reduceOf = (spec, sources) => {
	const { name = "reduce", ...box } = spec;
	return [name, { out: OUT, ...box, in: { ...Object.fromEntries(sources.map((source) => [source, source])), ...box.in } }];
};

const spec = (boxes, options) => ({
	boxes,
	...(options.inputs === undefined ? {} : { inputs: options.inputs }),
	...(options.noEscape === undefined ? {} : { noEscape: options.noEscape }),
});

export function swarm(options, ...workers) {
	if (workers.length === 0) throw new Error("swarm: give at least one worker");
	const boxes = {};
	const built = workers.map((worker) => {
		const [name, box] = named("swarm", worker);
		const full = defined({
			agent: "flow:worker",
			model: options.model,
			out: OUT,
			isolated: true,
			...box,
			raises: [...new Set(["question", ...(box.raises ?? [])])],
		});
		boxes[name] = full;
		boxes[`${name}_ruling`] = defined({
			agent: "flow:adjudicator",
			model: options.rulingModel ?? options.model,
			brief:
				options.rulingBrief ??
				`Rule on what the worker \`${name}\` raised.\n\n{{raised}}${options.request === undefined ? "" : "\n\nThe request the work serves:\n\n{{request}}"}`,
			in: { raised: `${name}!question`, ...(options.request === undefined ? {} : { request: options.request }) },
			out: OUT,
			raises: ["ask_user"],
			isolated: false,
		});
		return [name, full];
	});
	if (options.gate !== undefined) {
		const [name, box] = gateOf(options.gate, built);
		boxes[name] = box;
	}
	if (options.reduce !== undefined) {
		const [name, box] = reduceOf(
			options.reduce,
			built.map(([name]) => name),
		);
		boxes[name] = box;
	}
	return spec(boxes, options);
}

export function loop(options, ...agents) {
	if (agents.length === 0) throw new Error("loop: give at least one agent");
	if (typeof options.over !== "string" || !options.over.endsWith("[]")) {
		throw new Error('loop: `over` is the `[]` reference every agent fans out over, for example "input.items[]"');
	}
	if (options.check === undefined) throw new Error("loop: `check` is the box that checks every agent's item at each path");
	const as = options.as ?? "item";
	const boxes = {};
	const built = agents.map((agent) => {
		const [name, box] = named("loop", agent);
		const full = defined({
			agent: "flow:worker",
			model: options.model,
			out: OUT,
			bound: options.rounds,
			...box,
			in: { [as]: options.over, ...box.in },
		});
		boxes[name] = full;
		return [name, full];
	});
	const [gate, box] = gateOf({ name: "check", ...options.check }, built);
	boxes[gate] = box;
	if (options.reduce !== undefined) {
		const [name, reduce] = reduceOf(options.reduce, [gate]);
		boxes[name] = reduce;
	}
	return spec(boxes, options);
}
