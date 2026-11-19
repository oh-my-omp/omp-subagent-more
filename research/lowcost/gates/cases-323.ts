import { readFileSync } from "node:fs";
const src = process.env.SRC;
const casesPath = process.env.CASES;
if (!src || !casesPath) throw new Error("SRC and CASES are required");
const mod = await import(`${src}/agent/extensions/_shared/ask-answers.ts`);
const cases: { name: string; input: string; expect: string; ruling?: string }[] = JSON.parse(readFileSync(casesPath, "utf8"));
let failed = 0;
for (const item of cases) {
	let want: unknown;
	let details: unknown;
	try {
		details = JSON.parse(item.input);
		want = JSON.parse(item.expect);
	} catch {
		console.log(`UNREADABLE CASE ${item.name}: input and expect must be JSON text`);
		failed++;
		continue;
	}
	const answers = mod.askAnswers({ role: "toolResult", toolName: "ask", isError: false, details, content: [] });
	const got = answers === null ? null : mod.formatAskAnswers(answers);
	if (got !== want) {
		failed++;
		console.log(`FAIL ${item.name} (ruling ${item.ruling ?? "?"}): input ${item.input}\n  expected ${JSON.stringify(want)}\n  got      ${JSON.stringify(got)}`);
	}
}
console.log(`${cases.length - failed}/${cases.length} ruling cases pass`);
process.exit(failed === 0 ? 0 : 1);
