# Changelog

## [Unreleased]

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
