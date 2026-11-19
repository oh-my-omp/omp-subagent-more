(() => {
	const FILE = "<omomp>/omp-config/.tmp/lowcost/catalog.json";
	const key = (ref) => ref.replace("/", "-").replace("#", "-");
	const cells = (line) =>
		line
			.replace(/^\s*\|/, "")
			.replace(/\|\s*$/, "")
			.split(/(?<!\\)\|/)
			.map((cell) => cell.replace(/\\\|/g, "|").trim());
	const SANDBOX = /沙箱|sandbox|docker exec|OrbStack|容器/i;
	const WINDOWS = /g16pro|Windows/;
	const TERN = /Tern 窗口|TERN_PANE/;
	const INTERACTIVE = /docker exec -it|TUI|PTY|exec_command|ssh g16pro|Tern 窗口|键入|敲|按 ?`?(Esc|Enter|回车)|输入 ?`\/|交互/;

	const parseRows = (body) => {
		const start = body.search(/^## 验收标准/m);
		if (start < 0) return [];
		const section = body.slice(start).split(/^## /m)[1] ?? "";
		const lines = section.split("\n").filter((line) => /^\s*\|/.test(line));
		const header = lines.findIndex((line) => /\|\s*#\s*\|/.test(line));
		if (header < 0) return [];
		const names = cells(lines[header]).map((name) => name.toLowerCase());
		const at = (name) => names.indexOf(name);
		const rows = [];
		for (const line of lines.slice(header + 2)) {
			const row = cells(line);
			if (row.length < names.length || !/^\d+$/.test(row[at("#")] ?? "")) continue;
			rows.push({ n: row[at("#")], kind: row[at("面")], form: row[at("dimension")], cover: row[at("check")], command: row[at("command")], env: row[at("env")], expect: row[at("expect")] });
		}
		const byNumber = Object.fromEntries(rows.map((row) => [row.n, row]));
		const resolve = (field) => {
			let previous = "";
			for (const row of rows) {
				const text = row[field] ?? "";
				const numbered = text.match(/^同第 (\d+) 行/);
				const same = /^同上/.test(text);
				const base = numbered ? (byNumber[numbered[1]]?.[`${field}Full`] ?? "") : same ? previous : "";
				row[`${field}Full`] = base ? `${base} ${text}` : text;
				previous = row[`${field}Full`];
			}
		};
		resolve("env");
		resolve("command");
		for (const row of rows) {
			const text = `${row.commandFull} ${row.envFull}`;
			row.where = WINDOWS.test(text) ? "windows" : TERN.test(text) ? "tern" : SANDBOX.test(text) ? "sandbox" : "local";
			row.mode = INTERACTIVE.test(text) ? "interactive" : "command";
			const outsideCode = row.command.replace(/`[^`]*`/g, "");
			row.exec = /^同(上|第)/.test(row.command.trim()) || (/`/.test(row.command) && !/[\u4e00-\u9fff]/.test(outsideCode)) ? "literal" : "prose";
		}
		return rows;
	};

	globalThis.rebuildCatalog = () => {
		const fs = require("node:fs");
		const catalog = JSON.parse(fs.readFileSync(FILE, "utf8"));
		for (const entry of catalog) entry.rows = parseRows(fs.readFileSync(`/tmp/ghc/${key(entry.ref)}/body.md`, "utf8"));
		fs.writeFileSync(FILE, JSON.stringify(catalog, null, 1));
		globalThis.catalog = catalog;
		return catalog;
	};
})();
