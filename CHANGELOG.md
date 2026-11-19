# Changelog

## [Unreleased]

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
