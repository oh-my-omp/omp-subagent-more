# Changelog

## [Unreleased]

### Added

- `fork_task` and the `fork:self` agent, moved from omp-config's local `fork-task` extension with the same parameters, results, rejection codes, topics (`xd://fork_task/limits`, `xd://fork_task/batch`) and staging under `$TMPDIR/omp-fork-task/`. The hidden reminder it delivers is now `<system-reminder source="omp-subagent-more/fork-task">`.
- The report-limit check on `fork_task`: items whose `agent` is `task:*` or omitted are blocked when the shared `context` or the item's `task` caps the length of the worker's report. The model comes from the role `@omp-subagent-more`, then the `default` chain; no model or no verdict lets the call run. Each judged call logs `omp-subagent-more report-limit verdicts`.
- The skill `omp-subagent-more` with the eval JS library `orchestrate.js` (`%load skill://omp-subagent-more/orchestrate.js`): `orchestrate(spec)` runs items of one or more subagent stages without a global barrier; each stage yields `done` with schema-checked data or `needs_input` with a question; `drive()` returns on every new question, `answer(id, text)` continues the same subagent.
