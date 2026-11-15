# Whiteboard of smoke

Append-only. Entries below are in time order; each names its author and kind.

## 2026-11-14T19:45:12.540Z · orchestrator · GATES

head 21d748d522fd47c6c08516c377295ca0d4b5ce81: FAILED
- FAIL committed: HEAD is the base commit: nothing was committed
- FAIL scope: no file changed
- FAIL driver: exit 1
{
  "hostAnswers": [
    {
      "name": "db",
      "question": "Database",
      "answer": "SQLite"
    },
    {
      "name": "ticks",
      "question": "Backfill",
      "answer": "no"
    }
  ],
  "native": null,
  "notes": null,
  "blankField": [
    {
      "name": "ticks",
      "question": "Backfill",
      "answer": ""
    }
  ],
  "blankAnswer": null,
  "emptyAnswers": null,
  "timedOut": null,
  "notTimedOut": null,
  "legacyBatch": "Database → SQLite + \"in WAL\"",
  "legacySingle": "Database → SQLite",
  "legacyNoSelection": null,
  "otherTool": null,
  "errorResult": null,
  "persisted": []
}
A4 expectation failed

- pass hygiene
- FAIL stale-header: must not remain:
5: * native tool and the omp-ask-more plugin both report `details.results[]`

- FAIL host-type-link: expected a match for /AskToolDetails/ in agent/extensions/_shared/ask-answers.ts
