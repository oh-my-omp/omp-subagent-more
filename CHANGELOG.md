# Changelog

## [Unreleased]

### Changed

- An `eval` cell whose source, including a script it runs with `%load`, calls the eval prelude's `agent()` or `workpool()` is refused before it runs, in the main session and in subagent sessions, with a reason naming the function and pointing to `help://flow/eval`: subagents started from eval go through the `flow` tool, whose background job is not cancelled when the cell is interrupted ([#57](https://github.com/oh-my-omp/omp-subagent-ng/issues/57))
- The daily `omomp-check` run, and a manual run with `report_issue` set, keeps one tracking issue in this repository open while the check fails, naming the first failing stage, its error and the `@oh-my-pi/*` versions, and closes it once the check passes; the check now also runs the `oh-my-omp/shared` gate on both extensions ([#43](https://github.com/oh-my-omp/omp-subagent-ng/issues/43))

## [0.5.1] - 2026-11-26

### Fixed

- `help://flow/eval` documents `flow.define(boxes, opts)` and that it passes `opts.noEscape`, instead of saying the helper takes the boxes only and that changing `noEscape` needs a direct `tool.flow` call

## [0.5.0] - 2026-11-26

### Added

- A box may take several `[]` inputs, which pair by leaf path: item `review#2` takes the element at path `2` of every `[]` input; a path only some of them reach gets no item, is reported `unpaired` in the verdict and keeps the flow from becoming `complete` ([#36](https://github.com/oh-my-omp/omp-subagent-ng/issues/36))
- `checks` names one agent box or a non-empty array of them, and the checking box may be an agent box as well as a command box: an agent check rejects by yielding `{"status": "reject", "feedback": "…"}`, and a rejection reopens every checked item at the check's path at once ([#36](https://github.com/oh-my-omp/omp-subagent-ng/issues/36), [#37](https://github.com/oh-my-omp/omp-subagent-ng/issues/37))
- A session reopened by a check is given, beside its earlier handoff and the check's output or `feedback`, the values the check was given in that round ([#37](https://github.com/oh-my-omp/omp-subagent-ng/issues/37))
- `flow` op `define` takes an optional boolean `noEscape` for flows that run unattended: while it is on, `run` is refused until every input a box takes is supplied, sessions are offered only the raise types some box answers, a split request that passes its checks is approved without a message to the author, `session`, `timeout`, `protocol` and `schema` failures that the box's `handle` does not name fire the item once more, and the verdict carries a `noEscape: on` line ([#36](https://github.com/oh-my-omp/omp-subagent-ng/issues/36), [#37](https://github.com/oh-my-omp/omp-subagent-ng/issues/37))
- `flow.js` adds `flow.use(spec, opts)`, which defines a `{ boxes, inputs?, noEscape? }` spec or a plain boxes map and supplies its inputs, and the presets `flow.presets.swarm(options, ...workers)` and `flow.presets.loop(options, ...agents)`, which return such specs; `flow.define(boxes, opts)` passes `opts.noEscape` ([#38](https://github.com/oh-my-omp/omp-subagent-ng/issues/38))

### Changed

- `flow:adjudicator` rules in two levels: inside the flow its ruling resumes the worker without waking anyone, and it may send the worker back to probe while the item has sessions left under `bound`; only a product, scope or trade-off question that neither the code facts nor the request decide leaves the flow, as an outward raise such as `ask_user` that its box declares, and under `noEscape` that raise is not offered ([#37](https://github.com/oh-my-omp/omp-subagent-ng/issues/37))
- An item's last allowed session is offered no raise type, so a raise from it fails with `protocol` instead of `bound_exceeded`; `bound_exceeded` is left for a check that rejects the result of an item's last allowed session, in which case no checked item is reopened ([#37](https://github.com/oh-my-omp/omp-subagent-ng/issues/37))
- A box with `splits` takes exactly one `[]` input, and a check of a box with many items reaches it only through `[]` inputs along boxes that do not split and may not split itself; `run` is refused for any other wiring ([#36](https://github.com/oh-my-omp/omp-subagent-ng/issues/36))

## [0.4.0] - 2026-11-23

### Breaking Changes

- The plugin is renamed from `omp-subagent-more` to `omp-subagent-ng`: the package name and install URL (`https://github.com/oh-my-omp/omp-subagent-ng`), the model role `@omp-subagent-ng`, the skill `omp-subagent-ng` (`skill://omp-subagent-ng/flow.js`), the topic namespaces, reminder sources and log lines all use the new name; subagent progress recorded in sessions by earlier versions still loads

### Added

- The `flow` tool runs a flow of boxes, fresh subagent sessions and shell commands wired to each other by name, from one append-only log per session: one background job starts every ready item and wakes the main session once when the flow comes to rest or stops; fan-out (`<box>[]`), wired raises (`<box>!<type>`), checks that reopen the checked item, forced handoffs, per-item notes files, workspace carried between sessions of an item across models, named runtime exceptions that stop the flow, and stale results after a definition, agent prompt or model setting changes
- `rejects` on a check box names the exit codes that reject the checked result (`[1]` when absent); any other non-zero exit of a check is the `exit` exception
- `splits` on a fanned, isolated agent box lets a session ask the flow's author for a split with its `flow_split` tool: the call carries the parts and the details for the author and blocks until the author answers with `flow` op `agree`, or op `disagree` and a `reason`, which the session continues with. After an agree the session yields `{"status": "split", "handoff": …}`, each approved part becomes an item of the same box (`work#0.0`, `work#0.1`) whose first session is a fork of the splitting session in its own worktree, without shake; `<box>[]` fans out over the leaves by path, `<box>` is the array of the leaves' results, and no session joins the parts
- `flow.agree(key)` and `flow.disagree(key, reason)` in `flow.js` answer a split request from an eval cell
- The agents `flow:scout`, `flow:worker`, `flow:adjudicator`, `flow:guardian` and `flow:verifier`, with their own system prompts and no model of their own; a box's `model` names the tier they run on
- `%load skill://omp-subagent-ng/flow.js` defines `flow.*` for eval cells: each call takes JavaScript values, prints the verdict and throws when refused
- A box's `prepare` command runs in the subagent's workspace after inherited changes are applied and before its first turn, as part of the same start of every subagent that applies `fork_task` overlays

### Removed

- `skill://omp-subagent-ng/orchestrate.js` and its `orchestrate(spec)`, `drive()` and `answer()`: answering continued the same subagent session, and its state lived in the eval kernel; `flow.js` replaces it

### Changed

- Updated the shared copy of `compact-handoff.ts` to oh-my-omp/shared@db9dde4.
- `workspace: "isolated_from_source"` in plan mode is refused with `child-not-isolated` and a reason that names plan mode, instead of one that also named an explicit `workspace: "shared"`, which that field cannot combine with

## [0.3.1] - 2026-11-23

### Changed

- Added `compact-handoff.ts` to `omomp-shared` from `oh-my-omp/shared@8f2c5e5`
- Updated `subagent-progress` (`withProgress` and `registerSubagentProgress`) to splice `<subagent-progress>` via `computeSafePostCompactInsertIndex` past `anthropicCompaction` `assistant` + `toolResult` fold boundaries and register `omp-subagent-more` as a `plugin-managed` `StatefulHarnessHandoff` in the shared compact coordinator (silently gated when no live subagents exist)

## [0.3.0] - 2026-11-22

### Added

- A fork child is told, as `<system-reminder source="omp-subagent-more/fork-diff">`, which tools its copied declaration names but it has no registration for, which of those are registered again, and which context files under its working directory are missing from, new to or changed against the source's system prompt, or sit at another path with the same content, each read from disk at the time; the reminder is replaced when the difference changes and withdrawn when nothing differs ([#24](https://github.com/oh-my-omp/omp-subagent-more/issues/24))

### Changed

- Migrated `fork_task` tool documentation topic pointers from `xd://fork_task/*` to `help://fork_task/*` and removed the outdated `write xd://yield` note from the fork `yield` instruction for omp 19.1.0 compatibility
- Updated the shared copy of `context-delta.ts` to oh-my-omp/shared@3d09cd4.
- A fork child's id is allocated from the requested `name` the way `task` allocates it: `Probe`, then `Probe-2` when an earlier agent of the session holds `Probe`, without the four-character suffix; an omitted `name` gets a generated name instead of `Fork_…` ([#23](https://github.com/oh-my-omp/omp-subagent-more/issues/23))
- Every request of a fork child declares exactly the source's tools, also when the child runs another model or the source declares no `eval`; the child's own tools are no longer appended to the declaration ([#23](https://github.com/oh-my-omp/omp-subagent-more/issues/23))
- Request copies, parked sources' requests, workspace starts, inherited overlays and staged transcripts live in the OMP session's artifacts directory; `$TMPDIR/omp-fork-task/` is no longer created and no startup sweep runs ([#23](https://github.com/oh-my-omp/omp-subagent-more/issues/23))
- Every fork child delivers its result only by calling `yield` directly: `fork:self` declares `structured: true` and a default `output` of `{report: string}`, a role named in `agent` lends its `output`, and the caller's `outputSchema` still comes first ([#25](https://github.com/oh-my-omp/omp-subagent-more/issues/25))
- The `yield` instructions reach every fork child, whatever model it runs and whether the source declared `eval`; they tell the child to call `yield` as a direct function call, and the fork notice no longer offers finishing with a final report ([#25](https://github.com/oh-my-omp/omp-subagent-more/issues/25))
- A fork child running in another working directory than its source, such as an isolated worktree, learns both directories and the repository roots whose relative paths correspond from the `omp-subagent-more/fork-diff` reminder; the fork notice no longer forbids paths under the parent's checkout ([#26](https://github.com/oh-my-omp/omp-subagent-more/issues/26))
- When the host pins a fork child's final reminder to `yield`, which the replicated declaration does not name, the request goes out without that pin instead of being forced onto `eval` ([#25](https://github.com/oh-my-omp/omp-subagent-more/issues/25))

### Fixed

- A fork child no longer fails before its first turn with "cannot clone source tool" when the source declared a tool the child has no registration for; the child runs with the tools OMP registered for it ([#23](https://github.com/oh-my-omp/omp-subagent-more/issues/23))
- A fork child is no longer told to call `yield` from an `eval` cell, which OMP rejects; the plugin no longer re-emits a `yield` submitted from `eval` as a tool event ([#25](https://github.com/oh-my-omp/omp-subagent-more/issues/25))

## [0.2.1] - 2026-11-21

### Changed

- Updated the shared copy of `context-delta.ts` to oh-my-omp/shared@80068ad.

## [0.2.0] - 2026-11-20

### Added

- When a session compacts, every live subagent below it (running or idle) is asked, the same way `/btw` asks, what it is responsible for, its goal and how it is doing it. Replies that arrive before the summary, or within 10 s after it, are placed in a `<subagent-progress>` block right after the compaction summary in every later request of that session and recorded once as an `omp-subagent-more.subagent-progress` session entry; a subagent still silent 10 s after the summary is cancelled and left out, and with no reply nothing is added ([#19](https://github.com/oh-my-omp/omp-subagent-more/issues/19))

### Changed

- `xd://fork_task/limits` lists `steps` among the host `task` fields a fork item does not take: a host item takes `steps` in place of `task`, and a fork item takes one `task`; the list no longer names `sourceSession`.

## [0.1.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.1.0] - 2026-11-12

### Added

- `fork_task` and the `fork:self` agent, moved from omp-config's local `fork-task` extension with the same parameters, results, rejection codes, topics (`xd://fork_task/limits`, `xd://fork_task/batch`) and staging under `$TMPDIR/omp-fork-task/`. The hidden reminder it delivers is now `<system-reminder source="omp-subagent-more/fork-task">`.
- The report-limit check on `fork_task`: items whose `agent` is `task:*` or omitted are blocked when the shared `context` or the item's `task` caps the length of the worker's report. The model comes from the role `@omp-subagent-more`, then the `default` chain; no model or no verdict lets the call run. Each judged call logs `omp-subagent-more report-limit verdicts`.
- The skill `omp-subagent-more` with the eval JS library `orchestrate.js` (`%load skill://omp-subagent-more/orchestrate.js`): `orchestrate(spec)` runs items of one or more subagent stages without a global barrier; each stage yields `done` with schema-checked data or `needs_input` with a question; `drive()` returns on every new question, `answer(id, text)` continues the same subagent.

### Changed

- Moved the documented install command to the `release` branch, which a daily 02:00 GMT+9 run advances by promoting `## [Unreleased]` into a tagged version section
