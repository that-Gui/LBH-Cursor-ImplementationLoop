# Run result schema

Write `result.json` to `$LOOP_DIR/result.json` with `schemaVersion: 1`. Never include
`GITHUB_TOKEN`, `.env` contents, clone URLs with credentials, or redacted secret material.

Helpers consume `result.json` during `npm run complete-run -- --loop-dir DIR` then
`npm run finalize -- --loop-dir DIR`. The parent derives verdict fields from the loop
ledger and recorded logs; do not copy the writer's trailer blindly if it disagrees with
that evidence.

## Rename the writer's keys — `result.json` is camelCase

Writers and reviewers report in snake_case. `result.json` is camelCase, and the parser
matches key names exactly. **Rename the key on every copy**, then copy the value verbatim:

| Writer / reviewer field | `result.json` key |
| :--- | :--- |
| `test_changes` | `testChanges` |
| `baseline_failure_names` | `baselineFailureNames` |
| `implementation_summary` | `implementationSummary` |
| `tests_run` | `testsRun` |
| `files_changed` | `filesChanged` |
| `residual_risks` | `residualRisks` |
| `original_request` | `originalRequest` |

"Verbatim" applies to the **value** — the entries, their wording, their order. It never
means keeping the snake_case key.

Getting this wrong is mostly silent. `testChanges` is optional, so a leftover
`test_changes` key is dropped as unknown, parses as `[]`, the result still looks
finalizable, and the first sign of trouble is finalize refusing the pull request with
`weakens tests with no recorded reason` for a change the writer did justify.

## `result.json`

```json
{
  "schemaVersion": 1,
  "repo": "<repository name>",
  "branch": "<branch at Stage 0>",
  "baseSha": "<BASELINE_SHA>",
  "baselineFailures": 0,
  "baselineFailureNames": [],
  "buildPassed": true,
  "testsRegressed": false,
  "reviewers": "PASS",
  "status": "completed",
  "rounds": 1,
  "unresolvedCriticals": [],
  "warnings": [],
  "implementationSummary": "<what changed and why>",
  "testsRun": ["npm test — passed"],
  "filesChanged": ["src/foo.ts: added rate limiting"],
  "residualRisks": [],
  "originalRequest": "<the user's request, verbatim>",
  "testChanges": [
    {
      "file": "test/foo.test.ts",
      "change": "asserted the new 429 body",
      "reason": "the request changed the contract that test pinned"
    }
  ]
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `schemaVersion` | number | Always `1`. |
| `repo` | string | Repository name from `prepare-run` / origin. |
| `branch` | string | Branch HEAD was on at Stage 0. |
| `baseSha` | string | `HEAD` at Stage 0. Must match the manifest. |
| `baselineFailures` | number | Count of baseline test failures still failing; `0` if none. |
| `baselineFailureNames` | string[] | Required, and `[]` when `baselineFailures` is `0`. |
| `buildPassed` | boolean | Final build in this round passed. |
| `testsRegressed` | boolean | A test that passed in the baseline now fails. |
| `reviewers` | `"PASS"` \| `"FAIL"` | `PASS` only if both reviewers returned `PASS` with zero criticals. |
| `status` | `"completed"` \| `"blocked"` \| `"partially_completed"` | Stage 4 status. Finalize requires `completed`. |
| `rounds` | number | Writer rounds actually dispatched, and the `N` in `round-N-*.log`. `complete-run` and `finalize` reject anything outside **1-50**. |
| `unresolvedCriticals` | Finding[] | Outstanding critical findings, or empty. |
| `warnings` | Finding[] | Non-blocking warnings and suggestions. An entry with `severity: "critical"` here is rejected. |
| `implementationSummary` | string | Loop Stage 4 summary. Truncate if huge; never include secrets. First line is the commit message. |
| `testsRun` | string[] | One line per command and actual result. At least one. |
| `filesChanged` | string[] | One line per path. |
| `residualRisks` | string[] | Known limitations, carried baseline failures, follow-up work. |
| `originalRequest` | string | The user's request, verbatim. |
| `testChanges` | array | Optional. One entry per test whose asserted behaviour this change required. |

Every field above except `testChanges` is required. A missing or mistyped one throws
`invalid loop result: <key> …` and `complete-run` refuses to advance the run.

Unknown top-level keys are accepted and silently dropped.

## Finding entries

Each finding needs `severity` (`critical` \| `warning` \| `suggestion`) and `title`.
Optional: `file`, `line`, `evidence`, `impact`, `recommendation`.

## Finalizable

`complete-run` / `finalize` are allowed only when all of these are true:

- `status` is `completed`
- `reviewers` is `PASS`
- `buildPassed` is true
- `testsRegressed` is false
- `unresolvedCriticals` is empty
- no `warnings` entry has `severity: "critical"`
- `rounds` is an integer 1–50
- `testsRun` is non-empty
- if `baselineFailures` > 0, `baselineFailureNames` is non-empty
- identity (`repo`, `branch`, `baseSha`) matches the Stage 0 manifest
- `$LOOP_DIR/round-N-build.log` and `round-N-test.log` exist as non-empty regular files (not symlinks)

`complete-run` records the sha256 of `result.json` and of those two logs. `finalize`
re-hashes both. A `result.json` that grows a `testChanges` entry after the only review
the run gets, or a log swapped behind the gate, refuses the pull request and asks for
`complete-run` again. Write the document and the logs once, before completing the run.
