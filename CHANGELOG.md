# Changelog

## [Unreleased]

### Added

- Added a `flow` tool exposing box state, lifecycle operations and raise answering, with lifecycle and eval documentation topics
- Added an eval-kernel `flow` helper that issues flow calls, prints verdicts and throws on refused calls
- Added host-side flow driving that runs ready tasks, records session outcomes and settles each flow on stop or rest

### Changed

- Changed box `isolated` to a tri-state setting: `false` shares the caller's workspace on purpose and an absent value leaves isolation to the host's default for the agent
- Changed raise session bounds to count only sessions chained through answered raises, so failed attempts no longer consume the budget
- Changed exception refire budgets to count separately per handled exception name
- Changed flow output to truncate stopped-flow reasons and show session history links on running task labels
- Changed session instructions to forbid `yield`'s error argument and to answer raises as ordinary data rather than through the `ask` tool

## [0.1.0] - 2026-11-12

### Added

- `fork_task` and the `fork:self` agent, moved from omp-config's local `fork-task` extension with the same parameters, results, rejection codes, topics (`xd://fork_task/limits`, `xd://fork_task/batch`) and staging under `$TMPDIR/omp-fork-task/`. The hidden reminder it delivers is now `<system-reminder source="omp-subagent-more/fork-task">`.
- The report-limit check on `fork_task`: items whose `agent` is `task:*` or omitted are blocked when the shared `context` or the item's `task` caps the length of the worker's report. The model comes from the role `@omp-subagent-more`, then the `default` chain; no model or no verdict lets the call run. Each judged call logs `omp-subagent-more report-limit verdicts`.
- The skill `omp-subagent-more` with the eval JS library `orchestrate.js` (`%load skill://omp-subagent-more/orchestrate.js`): `orchestrate(spec)` runs items of one or more subagent stages without a global barrier; each stage yields `done` with schema-checked data or `needs_input` with a question; `drive()` returns on every new question, `answer(id, text)` continues the same subagent.

### Changed

- Moved the documented install command to the `release` branch, which a daily 02:00 GMT+9 run advances by promoting `## [Unreleased]` into a tagged version section
