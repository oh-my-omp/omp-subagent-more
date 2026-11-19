import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const src = process.env.SRC;
if (!src) throw new Error("SRC is required");
const dir = mkdtempSync(`${tmpdir()}/typelink-323-`);
writeFileSync(`${dir}/ask-answers.ts`, readFileSync(`${src}/agent/extensions/_shared/ask-answers.ts`, "utf8"));
symlinkSync(`${src}/node_modules`, `${dir}/node_modules`);
cpSync(`${src}/node_modules/@oh-my-pi/pi-tui/dist/types`, `${dir}/types`, { recursive: true });
const base = JSON.parse(readFileSync(`${src}/tsconfig.json`, "utf8"));
writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { ...base.compilerOptions, paths: { "@oh-my-pi/pi-tui/*": ["./types/*"], "@oh-my-pi/pi-tui": ["./types/index"] } }, files: ["ask-answers.ts"] }));
const tsc = () => {
	const run = Bun.spawnSync([`${src}/node_modules/.bin/tsc`, "-p", `${dir}/tsconfig.json`], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
};
const control = tsc();
if (control.code !== 0) {
	console.log(`the module does not compile against the unchanged host types:\n${control.out.slice(0, 1500)}`);
	process.exit(1);
}
const variants = [
	{ id: "FormAnswer.answer renamed to text", file: "html-form/data.d.ts", from: "    answer: string;\n}", to: "    text: string;\n}" },
	{ id: "AskToolDetails.timedOut renamed to timeout", file: "tools/ask.d.ts", from: "    timedOut?: boolean;", to: "    timeout?: boolean;" },
	{ id: "AskToolDetails.notes renamed to remarks", file: "tools/ask.d.ts", from: "    notes?: OptionNote[];", to: "    remarks?: OptionNote[];" },
];
let missed = 0;
for (const variant of variants) {
	const path = `${dir}/types/${variant.file}`;
	const pristine = readFileSync(path, "utf8");
	if (!pristine.includes(variant.from)) throw new Error(`host type text not found for variant: ${variant.id}`);
	writeFileSync(path, pristine.replace(variant.from, variant.to));
	const run = tsc();
	writeFileSync(path, pristine);
	if (run.code === 0) {
		missed++;
		console.log(`MISSED: with ${variant.id} in the host types, tsc still passes on the module, so this host change would go unnoticed`);
	}
}
console.log(`${variants.length - missed}/${variants.length} host type changes fail tsc`);
process.exit(missed === 0 ? 0 : 1);
