# Board of p323

## 2026-11-14T20:28:24.289Z · scout · PLAN

Slices:
- answers-shape: Read the host `answers[]` ask details in `_shared/ask-answers.ts`: timedOut gating, note pairing, blank-answer skipping, schema tied to `AskToolDetails` [agent/extensions/_shared/ask-answers.ts] rows 1,2,3,4,5,6

Open points:
- op-whitespace-answer: Whether a whitespace-only `answer` ("   ") counts as 空白 and is skipped: the decision row 「原生答案为空时的表现」 says 空白答案按未作答跳过, while its evidence only fixes `answer: ""` as 未作答 (宿主 `formAnswers` 对没填的字段写 `answer: ""`), so both readings are allowed and they differ when it is the only entry. (producer: node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts:245-247 (`answerText` returns `String(value)` untrimmed) for the text field built at node_modules/@oh-my-pi/pi-tui/src/html-form/parse.ts:553-558; the submitted value passes through `textValue` at node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts:70-76 untrimmed, and the model authors the form (`params.html`, node_modules/@oh-my-pi/pi-coding-agent/src/tools/ask.ts:453))
- op-duplicate-answers: Two `answers[]` entries can carry the same `name` and `question` (two same-named text controls, neither labeled); 结果 1 says each answered question occupies one line of `formatAskAnswers`, which allows either one line per entry or one deduplicated line. (producer: node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts:230-243 emits one `FormAnswer` per `form.fields` entry, and node_modules/@oh-my-pi/pi-tui/src/html-form/parse.ts:553-558 adds one text field per control without deduplicating the name (only radios/checkboxes group, parse.ts:530-551))
- op-multiline-answer: A `textarea` answer keeps its newlines, so `formatAskAnswers` would put one answered question on several physical lines although the contract fixes 每个作答问题一行 and only rules whitespace folding for note text. (producer: node_modules/@oh-my-pi/pi-tui/src/html-form/parse.ts:500-507 builds a `textarea` field with `multiline: true`, and node_modules/@oh-my-pi/pi-tui/src/html-form/data.ts:245-247 returns `String(value)` unchanged)

Gate gaps:
- 结果 3 — 没有 `notes`、备注全部配不上、或备注文本折叠后为空时，输出与结果 1 相同 (all-notes-unmatched branch): {"toolName":"ask","isError":false,"details":{"answers":[{"name":"db","question":"Database","answer":"SQLite"},{"name":"ticks","question":"Backfill","answer":"no"}],"notes":[{"name":"gone","question":"Removed","option":"Other","value":"other","text":"orphan note"}]}} — the script only mixes one orphan note with two matching ones, so it cannot show that an all-unmatched `notes` array leaves the output equal to `native`.
- 结果 3 / 决策表「宿主的 `notes`（选项备注）去向」— 备注文本折叠后为空的不并入: {"toolName":"ask","isError":false,"details":{"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[{"name":"db","question":"Database","option":"SQLite","value":"sqlite","text":" \n\t "}]}} — expect "Database → SQLite" with no bracket; neither fixture note collapses to empty. (The form dialog already drops such notes at node_modules/@oh-my-pi/pi-tui/src/html-form/dialog.ts:449, so this branch has no live host producer.)
- 决策表「宿主的 `notes`（选项备注）去向」— 与回答按 `name` 和 `question` 同时相同配对: {"toolName":"ask","isError":false,"details":{"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[{"name":"db","question":"Something else","option":"SQLite","value":"sqlite","text":"near miss"},{"name":"other","question":"Database","option":"SQLite","value":"sqlite","text":"other near miss"}]}} — expect "Database → SQLite" with neither note; the fixture's orphan differs in both fields, so pairing on only one of them would still pass row 3.
- 结果 4 [保持] — 两种形状都不成立的 `details` 仍返回 `null`: `{"toolName":"ask","isError":false,"details":{}}` and `{"toolName":"ask","isError":false,"details":{"results":"nope"}}` — the script feeds `otherTool`/`errorResult` only with the host shape and `legacyNoSelection` only with a legacy shape, so no reading observes a `details` that fits neither shape.
- 结果 1、结果 2 — turn-judge `before()` 的 `用户在ask中回答` 条目与 `livePrompts()` 的 `{{ask_answers}}` 渲染: A session branch whose tool results are `{"toolName":"ask","isError":false,"details":{"answers":[{"name":"db","question":"Database","answer":"SQLite"}]}}` and `{"toolName":"ask","isError":false,"details":{"answers":[{"name":"ticks","question":"Backfill","answer":"no"}],"timedOut":true}}`, read through agent/extensions/turn-judge/index.ts:565 and agent/extensions/user-prompt-inject/index.ts:301 — no acceptance command calls either consumer (the driver only reads the persisted path, transcript.ts:308-315 and 349-359); the tree's overall acceptance issue #337 is what observes these two surfaces in a real session.

## 2026-11-14T20:29:07.971Z · guardian · RULINGS

- op-whitespace-answer [ruled]: A whitespace-only native `answer` is blank and is skipped. Native answer text is folded first (runs of whitespace incl. newlines/tabs → one space, trimmed); an answer that is empty after folding is 未作答. With that as the only entry, `askAnswers` returns null.
  basis: Contract decision row 「原生答案为空时的表现」: "空白答案按未作答跳过；全部为空或 `answers: []` 返回 `null`"; the existing code already treats blank legacy input the same way (`answerOf` trims `customInput` and returns null when nothing is left, so the entry is dropped). Treating `"   "` as an answer would produce the `question → ` content-free line that the row rejects as 「没有内容的『回答』」.
  case whitespace-only-answer-is-blank: {"answers":[{"name":"ticks","question":"Backfill","answer":"   "}]} → null
  case whitespace-only-skipped-next-to-real-answer: {"answers":[{"name":"ticks","question":"Backfill","answer":" \n\t "},{"name":"db","question":"Database","answer":"SQLite"}]} → "Database → SQLite"
- op-duplicate-answers [ruled]: No deduplication: one output line per non-blank `answers[]` entry, in host order, even when two entries have the same `name` and `question`. A note pairs with every entry whose `name` and `question` both match it.
  basis: Contract 结果 1: "`details.answers[]` 里的每个作答问题在 `formatAskAnswers` 输出中占一行 … `askAnswers` 返回全部作答" — the host emits one `FormAnswer` per field (data.ts:230-243) and `askAnswers` returns all of them; dropping an entry would lose an operator submission the host recorded, and the nearest similar case (legacy `results[]`, which is also not deduplicated) keeps every entry.
  case duplicate-entries-two-lines: {"answers":[{"name":"x","question":"x","answer":"v"},{"name":"x","question":"x","answer":"v"}]} → "x → v\nx → v"
- op-multiline-answer [ruled]: The one-line-per-question rule holds for native answers: the answer text is folded the same way note text is (newlines and runs of whitespace become a single space, trimmed). The fold applies only to `answers[]` text; legacy `results[]`/single-question parsing stays byte-for-byte as the base commit (结果 4), so a legacy `customInput` is not folded.
  basis: Contract 结果 1: "每个作答问题在 `formatAskAnswers` 输出中占一行 `question → answer`" and 目标 "每个作答问题一行"; the consumers (turn-judge before(), livePrompts(), transcript answerTexts()) join `formatAskAnswers` output as-is, so a textarea newline would otherwise break the line contract. Nearest similar case: the decision table folds 换行与连续空白 to one space for note text. 结果 4 [保持] limits the fold to the new shape.
  case textarea-newline-folded: {"answers":[{"name":"notes","question":"Notes","answer":"line one\nline two"}]} → "Notes → line one line two"
  case legacy-custom-input-not-folded: {"results":[{"question":"Database","selectedOptions":["SQLite"],"customInput":"in WAL"}]} → "Database → SQLite + \"in WAL\""
- gap1 [contract_decides]: A `notes` array in which no entry pairs with an answer changes nothing: the output equals the one without `notes`, and the orphan note is not printed.
  basis: 结果 3: "没有 `notes`、备注全部配不上、或备注文本折叠后为空时，输出与结果 1 相同"; decision row: "配不上任何回答的备注不输出".
  case all-notes-unmatched: {"answers":[{"name":"db","question":"Database","answer":"SQLite"},{"name":"ticks","question":"Backfill","answer":"no"}],"notes":[{"name":"gone","question":"Removed","option":"Other","value":"other","text":"orphan note"}]} → "Database → SQLite\nBackfill → no"
  case empty-notes-array: {"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[]} → "Database → SQLite"
- gap2 [contract_decides]: A paired note whose text collapses to empty after whitespace folding is not merged; the line has no bracket.
  basis: Decision row 「宿主的 `notes`（选项备注）去向」: "折叠后为空的不并入"; 结果 3: "备注文本折叠后为空时，输出与结果 1 相同".
  case blank-note-not-merged: {"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[{"name":"db","question":"Database","option":"SQLite","value":"sqlite","text":" \n\t "}]} → "Database → SQLite"
  case blank-note-skipped-real-note-kept: {"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[{"name":"db","question":"Database","option":"SQLite","value":"sqlite","text":" \n "},{"name":"db","question":"Database","option":"SQLite","value":"sqlite","text":"WAL on"}]} → "Database → SQLite [note: SQLite — WAL on]"
- gap3 [contract_decides]: A note pairs with an answer only when both `name` and `question` are equal; a note matching on just one of the two is an orphan and is not output.
  basis: Decision row 「宿主的 `notes`（选项备注）去向」: "与回答按 `name` 和 `question` 同时相同配对 … 配不上任何回答的备注不输出"; rationale: host `describeAnswer` pairs by `name` + `question`.
  case near-miss-notes-not-paired: {"answers":[{"name":"db","question":"Database","answer":"SQLite"}],"notes":[{"name":"db","question":"Something else","option":"SQLite","value":"sqlite","text":"near miss"},{"name":"other","question":"Database","option":"SQLite","value":"sqlite","text":"other near miss"}]} → "Database → SQLite"
- gap4 [contract_decides]: A `details` that fits neither the host shape (`answers[]`) nor the legacy shapes (`results[]`, single `{question, selectedOptions}`) makes `askAnswers` return null. `answers[]` is parsed as the host's shape, not as an unknown shape.
  basis: 结果 4: "非 `ask` 工具、`isError: true`、两种形状都不成立的 `details` 仍返回 `null`".
  case empty-details: {} → null
  case results-not-array: {"results":"nope"} → null
  case answers-not-array: {"answers":"nope"} → null
- gap5 [contract_decides]: These two surfaces are not observable by calling the module. The consumers only use `askAnswers`/`formatAskAnswers` unchanged (turn-judge before() at index.ts:565-566, livePrompts() at user-prompt-inject/index.ts:301-302), so the module's output contract is what the gates check: the first result yields `Database → SQLite`, and the `timedOut: true` result yields null so no `用户在ask中回答` entry and no `{{ask_answers}}` block appear. Observing the real timeline entry and the `<ask_answer index="0">` block in a session belongs to the tree's overall acceptance issue oh-my-omp/omp-config#337; no runtime case here.
  basis: 结果 1/2 and 影响 section: "turn-judge、user-prompt-inject … 只消费 `askAnswers` 与 `formatAskAnswers`，不改"; 依赖关系: "Blocks: oh-my-omp/omp-config#337（总体验收在真实会话里观察原生 `ask` 的作答进入 turn-judge 时间线与被注入的 `{{ask_answers}}`）".

## 2026-11-14T20:39:49.319Z · guardian · SIGNOFF

lane haiku head 0f79a46c85c82938f64c6c7f5fd39bd1ce90194c: pass
(no violations)

## 2026-11-14T20:44:09.255Z · guardian · SIGNOFF

lane haiku head dc767b792a7975c18ae44e2a8112e317660d8dcd: pass
(no violations)
