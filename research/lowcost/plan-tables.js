(() => {
	const SESSION = "~/.omp/agent/sessions/-Ext-code-omomp-omp-config/2026-11-14T19-28-16-207Z_01a1db88-294f-7611-840e-4299ba2a5305";
	const LOCKFILES = new Set(["bun.lock", "package-lock.json", "pnpm-lock.yaml"]);
	const key = (ref) => ref.replace("/", "-").replace("#", "-");
	const repoOf = (ref) => ref.split("#")[0];
	const short = (ref) => `${repoOf(ref).split("/")[1]}#${ref.split("#")[1]}`;
	const link = (ref) => `[${short(ref)}](https://github.com/${repoOf(ref)}/issues/${ref.split("#")[1]})`;

	globalThis.planTables = async () => {
		const fs = require("node:fs");
		const catalog = globalThis.catalog;
		const scoutOf = (ref) => {
			const path = `${globalThis.sc.dir}/${key(ref)}.json`;
			return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
		};
		const costOf = (agentId) => {
			const path = `${SESSION}/${agentId}.jsonl`;
			if (!agentId || !fs.existsSync(path)) return null;
			let cost = 0;
			let requests = 0;
			for (const line of fs.readFileSync(path, "utf8").split("\n")) {
				if (!line.includes('"usage"')) continue;
				try {
					const entry = JSON.parse(line);
					const message = entry.message ?? entry;
					if (message.role === "assistant" && message.usage) {
						cost += message.usage.cost?.total ?? 0;
						requests += 1;
					}
				} catch {
				}
			}
			return { cost, requests };
		};
		const kept = (slice) => slice.files.some((file) => !LOCKFILES.has(file.split("/").pop()));
		const trees = [];
		const totals = { children: 0, scouted: 0, slices: 0, dropped: 0, open: 0, openProduced: 0, gaps: 0, command: 0, interactive: 0, scoutCost: 0, scoutSeconds: 0 };
		const filesByRepo = {};
		for (const root of ["320", "321", "322"]) {
			const lines = [
				`### 树 [#${root}](https://github.com/oh-my-omp/omp-config/issues/${root})`,
				"",
				"| issue | 测试形态 | 验收行：程序执行 / 执行者 / 其中要沙箱 | 切片（文件数） | 开放点：有生产者 / 无 | 门禁缺口 | 侦察 |",
				"|---|---|---|---|---|---|---|",
			];
			for (const item of catalog.filter((entry) => entry.root === root)) {
				const rows = item.rows;
				const local = rows.filter((row) => row.exec === "literal").length;
				const interactive = rows.length - local;
				const sandbox = rows.filter((row) => row.where === "sandbox").length;
				if (/^总体验收/.test(item.title)) {
					lines.push(`| ${link(item.ref)}（总体验收） | e2e | ${local} / ${interactive} / ${sandbox} | 不实现 | — | — | — |`);
					continue;
				}
				totals.children += 1;
				totals.command += local;
				totals.interactive += interactive;
				totals.sandbox = (totals.sandbox ?? 0) + sandbox;
				const scout = scoutOf(item.ref);
				if (!scout) {
					lines.push(`| ${link(item.ref)} | ${item.form} | ${local} / ${interactive} / ${sandbox} | 未侦察 | | | |`);
					continue;
				}
				totals.scouted += 1;
				const slices = scout.slices.filter(kept);
				const produced = scout.open_points.filter((point) => !/^\s*`?none\b/i.test(String(point.producer))).length;
				const cost = costOf(scout.agent);
				totals.slices += slices.length;
				totals.dropped += scout.slices.length - slices.length;
				totals.open += scout.open_points.length;
				totals.openProduced += produced;
				totals.gaps += scout.gate_gaps.length;
				totals.scoutCost += cost?.cost ?? 0;
				totals.scoutSeconds += scout.seconds ?? 0;
				for (const slice of slices) for (const file of slice.files) ((filesByRepo[repoOf(item.ref)] ??= {})[file] ??= new Set()).add(`${root}:${short(item.ref)}`);
				lines.push(
					`| ${link(item.ref)} | ${item.form} | ${local} / ${interactive} / ${sandbox} | ${slices.map((slice) => `${slice.id}（${slice.files.length}）`).join(" → ") || "无"} | ${produced} / ${scout.open_points.length - produced} | ${scout.gate_gaps.length} | ${scout.seconds === undefined ? "试跑时侦察" : `${scout.seconds} s`}${cost ? `，$${cost.cost.toFixed(2)}` : ""} |`,
				);
			}
			trees.push(lines.join("\n"));
		}
		const overlaps = [];
		for (const [repo, files] of Object.entries(filesByRepo))
			for (const [file, owners] of Object.entries(files)) {
				if (owners.size < 2 || file === "CHANGELOG.md") continue;
				const list = [...owners];
				const roots = new Set(list.map((owner) => owner.split(":")[0]));
				overlaps.push(`| \`${file}\` | ${repo.split("/")[1]} | ${list.map((owner) => `${owner.split(":")[1].split("#")[1].replace(/^/, "#")}（树 ${owner.split(":")[0]}）`).join("、")} | ${roots.size > 1 ? "跨树" : "同树"} |`);
			}
		return { trees: trees.join("\n\n"), overlaps: overlaps.sort().join("\n"), totals };
	};
})();
