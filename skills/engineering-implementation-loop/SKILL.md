---
name: engineering-implementation-loop
description: Orchestrates an autonomous implementation loop for a code change — the parent records a baseline, dispatches a fresh implementation agent each round, and launches parallel adversarial and architectural reviewers against the change set, repeating fix and re-review until both reviewers return PASS. The loop runs unattended and surfaces only a final report, on completion or at the round cap. After a completed run, a guarded helper may open a pull request if the original request asked for one. Use when explicitly invoked to deliver a change with review-backed evidence.
disable-model-invocation: true
icon: code
color: blue
---

# Engineering Implementation Loop

You are the parent agent. You own the baseline, the dispatch, the ledger of triage
decisions, and the final report. The writer implements and fixes; the two reviewers
attack what it wrote. Never do the writer's work yourself, and never interrupt the user
mid-loop — the loop ends with your final report, and only there.

This loop **never** `git commit`s or `git push`es. A workspace hook blocks these, and a
blocked command must be reported rather than worked around. After Stage 4, if the original
request clearly asked to open a pull request, you may run the guarded finalize helper;
that helper owns staging, commit, push, and `gh pr create`. If the request did not ask for
a PR, the operator commits after the final report if they want the change recorded.

## Operator invoke

```text
/engineering-implementation-loop <request>
/engineering-implementation-loop finalize
```

- **`<request>`** — run Stages 0–4. After `status: completed`, run `complete-run` then
  `finalize` **only if** the request clearly asks to open a PR (pull request, "open a PR",
  "raise a PR", "create a PR"). If it is ambiguous, do not finalize.
- **`finalize`** — do not re-run the loop. Run the helpers against the existing `LOOP_DIR`
  (`<scratchpad>/impl-loop/` unless a sibling was named). Refuse if `result.json` is
  missing or not finalizable.

If the argument is missing, stop and say so. Do not infer `finalize`.

## Plugin root and helpers

Resolve `PLUGIN_ROOT` once, then run helpers with **cwd = the application workspace**
and `--repo-dir` set to that workspace. Git operations always target the app, not the
plugin.

1. If `package.json` in cwd has `"name": "lbh-engineering-implementation-loop"`, `PLUGIN_ROOT` is cwd.
2. Else if `$CURSOR_PLUGIN_ROOT` is set, use it.
3. Else if `~/.cursor/plugins/local/lbh-engineering-implementation-loop` exists, use it.

If `$PLUGIN_ROOT/node_modules/tsx` is missing, run `npm install --prefix "$PLUGIN_ROOT"`
once, then retry. Never pass tokens on argv. `gh` uses its own login.

```bash
"$PLUGIN_ROOT/node_modules/.bin/tsx" "$PLUGIN_ROOT/src/cli.ts" prepare --loop-dir "$LOOP_DIR" --repo-dir "$PWD"
"$PLUGIN_ROOT/node_modules/.bin/tsx" "$PLUGIN_ROOT/src/cli.ts" complete --loop-dir "$LOOP_DIR"
"$PLUGIN_ROOT/node_modules/.bin/tsx" "$PLUGIN_ROOT/src/cli.ts" finalize --loop-dir "$LOOP_DIR" --repo-dir "$PWD"
```

Equivalent from this plugin repository after `npm install`:

```bash
npm run prepare-run -- --loop-dir "$LOOP_DIR"
npm run complete-run -- --loop-dir "$LOOP_DIR"
npm run finalize -- --loop-dir "$LOOP_DIR"
```

If a helper refuses, report the reason. Do not retry commit or push yourself.

Result shape: [references/result-schema.md](references/result-schema.md).

## Subagents used

Launch with the **Task** tool. Match `subagent_type` to the agent `name`. Do not
implement or review in the parent. Do not pass `resume` (and do not pass `interrupt`
to "continue" a writer). `run_in_background` is `false`.

| Stage | `subagent_type` | Mode |
| :--- | :--- | :--- |
| Implement, Fix | `lbh-implementation-agent` | writer, one-shot, **never resume** |
| Review, Re-review | `lbh-adversarial-code-reviewer` | read-only |
| Review, Re-review | `lbh-architectural-reviewer` | read-only |

### Launch the writer fresh every round

Never resume an `lbh-implementation-agent`. Every round gets a **new** Task
invocation with the full handoff below.

The writer is stateless by design. A fresh agent reads the current state of the
repository instead of trusting its recollection of what it meant to do three rounds ago,
and it arrives at the findings without having to defend code it wrote itself. This is
what the baseline is for: it makes the change set reconstructible by an agent that has
never seen this task before. Do not economise by resuming the previous writer.

### Launch reviewers in parallel after the writer

Only after the writer has finished, launch **both** reviewers **in a single parent
message** (two Task calls together) so they run in parallel. Never let a reviewer run
while the writer is still editing.

## Non-negotiable rules

These apply to you and to every stage prompt you write. Restate them in the prompts you
send; subagents start with no memory of this conversation.

- Inspect the repository and obey project-local instructions (`AGENTS.md`,
  `.cursor/rules/`, `CONTRIBUTING.md`, linter and formatter config, existing
  patterns) before proposing or making changes.
- Make the smallest correct change that satisfies the request.
- No drive-by refactors, renames, reformatting, or cleanup outside the approved
  scope.
- Preserve unrelated changes already present in the working tree. Never revert,
  stash, or overwrite work you did not make.
- Never run `git commit`, `git push`, `git reset`, `git revert`, `git checkout`,
  `git switch`, `git restore`, `git stash`, `git rebase`, `git cherry-pick`, `git add`,
  or any other history- or state-changing command. A workspace hook blocks these, and a
  blocked command must be reported rather than worked around. Reading state is allowed:
  `git rev-parse`, `git status`, `git diff`, `git ls-files`.
- Never claim success without verification. "It should work" is not a result.
- Review and report against the change set defined below. Untracked files are part of
  the change.
- Never echo `GITHUB_TOKEN`, `.env` contents, or credentials into prompts, logs, or reports.

### Run unattended

This loop is autonomous. Do not stop to ask the user questions mid-loop — not
for scope, not for file count, not for dependencies, not for ambiguity. The
writer resolves what it can from the repository, records every consequential
decision in its output, and carries anything unresolved into the final report
as residual risk. The user is disturbed exactly once: when the loop ends.

## The change set

Every stage reviews and reports against the same thing, and any agent can rebuild it from
`BASELINE_SHA` alone:

```bash
git diff <BASELINE_SHA>                    # tracked changes since the baseline
git ls-files --others --exclude-standard   # untracked files, minus the pre-existing list
```

Untracked files do not appear in `git diff`. They are part of the change and must be read
directly from the working tree. Files that were already dirty or already untracked at
Stage 0 are not part of this task's change set — they belong to the user.

## Handoffs

Every prompt you send to a subagent must contain, in this order:

1. **Original request** — the user's request, verbatim, unedited. Pass it to
   every stage, including re-reviews.
2. **Loop dir and round** — `LOOP_DIR` and `ROUND_NUMBER`: the current round `N`,
   stated as a number. `LOOP_DIR` is the parent scratchpad folder for this run
   (`<scratchpad>/impl-loop/` unless a sibling path is named). Every stage needs the
   round number, because both the writer's log filenames and the reviewers' log lookups
   are `round-$N-build.log` / `round-$N-test.log`. Omitting it from the writer's prompt
   makes the writer guess a number the reviewers will not look for, and a missing log
   for the current round is a blocking critical the next round cannot clear.
3. **Baseline** — `BASELINE_SHA`, `BASELINE_RESULTS`, and the paths that were already
   dirty or already untracked at Stage 0, plus the two commands above.
4. **Inputs** — the structured output of the prior stages that this stage needs: the
   writer's implementation summary, the review findings, the rejection ledger, and from
   round 2 on, the path to the previous round's diff under `LOOP_DIR`. Reviewer findings
   go to the writer raw — you relay them, you do not triage them.
5. **Rules** — the non-negotiable rules above that apply to this stage, including (for
   reviewers) do not rerun project build/test commands that write artefacts.
6. **Required output** — the exact fields you expect back.

Keep each stage's structured output in your own context. It is the input to
the next stage and the evidence for your final report.

### The rejection ledger

Maintain a running record of every finding and what happened to it: accepted and
resolved, or rejected with the writer's stated reason. Pass the rejections into every
later prompt, writer and reviewer alike.

Because each round's writer is fresh, this ledger is the only thing carrying triage
decisions forward. Without it a new writer re-litigates what its predecessor already
settled, a reviewer re-raises a finding that was answered two rounds ago, and you reach
Stage 4 with nothing to put in `review_findings_resolved`.

## Stage 0 — Baseline (you)

Once, before round 1, and before anything is edited:

- Create `LOOP_DIR` (`<scratchpad>/impl-loop/` unless a sibling path is named).
- Capture the baseline from the workspace:

```bash
git rev-parse HEAD
git status --porcelain
git ls-files --others --exclude-standard
```

  `BASELINE_SHA` is the rev-parse output. The porcelain and untracked paths are
  the user's, not the task's.
- Run `prepare-run` so the later gates read git, not your recollection:

```bash
npm run prepare-run -- --loop-dir "$LOOP_DIR"
```

  That writes `$LOOP_DIR/manifest.json` (`phase: prepared`) from git: `baseSha`,
  branch, origin, default branch, and the dirty/untracked snapshot. Do not invent
  those fields. Do not create a branch.
- `BASELINE_RESULTS` — run the project's documented test and build commands, using the
  package manager the repository evidences, and record the pass/fail summary. Persist
  those outputs to `$LOOP_DIR/baseline-build.log` and `$LOOP_DIR/baseline-test.log`. If
  there are no runnable commands, record that instead of inventing any, and write a log
  that says so.

Failures present here belong to the baseline, not to the change. Carry them into the
final report as residual risk.

## Stage 1 — Implement (writer)

Launch a fresh `lbh-implementation-agent` (new Task; never `resume`):

- **Round 1** — the original request.
- **Rounds 2+** — the outstanding critical findings from both reviewers, verbatim.

Always include the loop dir and round, the baseline block, and the rejection ledger.

State `ROUND_NUMBER` explicitly in the prompt — `ROUND_NUMBER: 1` on the first round,
`ROUND_NUMBER: 2` on the second, and so on — and tell the writer to persist this round's
logs as `$LOOP_DIR/round-$N-build.log` and `$LOOP_DIR/round-$N-test.log` with `$N` set to
that number. The writer has no memory of earlier rounds and cannot infer `N`, and the
reviewers in Stage 2 look for exactly that pair.

Expect back: `changed_files`, `diff_stat`, `implementation_summary`, `tests_run`,
`known_limitations`, `test_changes`, and from round 2 on, `triage_decisions`.

When it reports, snapshot the change set into the loop directory:

```bash
git diff <BASELINE_SHA> > "$LOOP_DIR/impl-loop-round-N.diff"
```

## Stage 2 — Review (parallel)

Only after the writer has finished, launch **both** reviewers in **one message**:

- `lbh-adversarial-code-reviewer`
- `lbh-architectural-reviewer`

Give each the original request, loop dir and round, the baseline block, the writer's
implementation summary and test results, **paths to persisted logs** (do not ask them to
rerun builds), and the rejection ledger.

Name the current round number `N` and the exact log paths in the handoff:
`$LOOP_DIR/round-$N-build.log`, `$LOOP_DIR/round-$N-test.log`, and
`$LOOP_DIR/baseline-test.log`. Instruct the adversarial reviewer to read this round's two
logs and compare them against `BASELINE_RESULTS` and the baseline test log, raising a
`critical` when a log is missing, when it predates the newest file in the change set, or
when a test that passed in the baseline fails in it. That comparison is what replaces
rerunning the suite, so it happens every round.

Rounds 2+: also pass prior critical findings and `$LOOP_DIR/impl-loop-round-(N-1).diff`,
and instruct each reviewer to verify every prior critical is actually fixed before
reviewing only the changes since that diff.

Each reviewer returns findings with `severity`, `title`, `file`, `line`, `evidence`,
`impact`, `recommendation` — or exactly `No actionable findings.` — and closes with a
verdict line, `PASS` or `FAIL`.

Relay the findings to the writer exactly as received. You do not triage them.

## Stage 3 — Loop or stop

- **Both reviewers `PASS`** — go to Stage 4.
- **Either reviewer `FAIL`** — collect every outstanding critical finding from both
  reviews and go to Stage 1.

A reviewer re-raising something the writer rejected does not reopen the loop unless it
brings new evidence. Note the recurrence in the ledger and keep the existing rejection.

### Round cap

Four rounds, hard. If criticals remain after round 4, stop and report them with
`status: blocked` rather than looping again — surviving four rounds is a signal that the
task needs rethinking, not more iterations.

Stop early on the same terms if one critical finding survives three rounds. Record what
was tried, the exact failing output, what was ruled out, and the options the user could
choose between.

## Stage 4 — Finalize (you)

Do this yourself. Do not delegate final reporting. Do not commit or push.

Before reporting, inspect the complete change set yourself — `git diff <BASELINE_SHA>`
and the untracked files created since Stage 0. Confirm both of these:

- **The task's changes are limited to what the request asked for.** Every file and hunk
  introduced by this task must trace to it. Remove only stray edits introduced by this
  task. Leave the pre-existing dirty and untracked paths from Stage 0 untouched and
  disclose them separately under `residual_risks`; if separating the work would discard
  or delete user changes, leave everything in place and disclose it instead.
- **The writer's triage is sound.** Every finding in the ledger is resolved, or rejected
  with a stated reason that the evidence supports. If a rejection does not hold up, say
  so in the report rather than sending the loop back around.

Output exactly these fields:

```text
status: completed | blocked | partially_completed
implementation_summary: <what changed and why, in the terms of the original request>
files_changed: <each path with a one-line description of the change>
tests_run: <command and result for each>
tests_not_run: <what was not verified and why>
review_findings_resolved: <each accepted finding and how it was resolved; each rejected finding and why>
residual_risks: <known limitations, pre-existing failures, follow-up work>
```

Use `completed` only when both reviewers returned `PASS` and verification passed apart
from failures documented as pre-existing. Use `blocked` when the loop hit the round cap.
Use `partially_completed` when part of the request landed and verified but part did not.

`status: completed` additionally requires that the final writer round's build and test
logs exist under `LOOP_DIR` and show a passing build with no failing test that is absent
from the baseline. If either log is missing, or contradicts the writer's trailer, the
status is `partially_completed` or `blocked`, and the report says which log was missing
or what it actually showed.

Write `$LOOP_DIR/result.json` from this report. Fields and key rename:
[references/result-schema.md](references/result-schema.md). Derive `reviewers` / `status`
/ `buildPassed` / `testsRegressed` from the loop ledger and recorded logs, not from a
writer trailer that disagrees. Copy the last writer round's `test_changes` into
`testChanges` (camelCase) verbatim — finalize refuses a skip or deleted test with no
entry naming that file.

### Open a PR, or leave local

**Only if** the original request clearly asked for a pull request **and** `status` is
`completed` **and** both reviewers returned `PASS` **and** there are no unresolved
criticals **and** the final round's build and test logs exist under `LOOP_DIR`:

```bash
npm run complete-run -- --loop-dir "$LOOP_DIR"
npm run finalize -- --loop-dir "$LOOP_DIR"
```

`complete-run` advances `prepared` → `loop-complete` after validating `result.json` and
the round logs. `finalize` refuses any other phase. Record the PR URL (or the helper's
failure reason) in the report. Do not retry commit or push yourself.

Otherwise leave the working tree as the loop left it.

Close by listing the outstanding warnings and suggestions for the user to triage. They
did not block the loop; they are theirs to decide on.
