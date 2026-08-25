---
name: engineering-implementation-loop
description: Orchestrates an autonomous staged implementation loop for a code change — the implementation agent owns discovery, planning, implementation, verification, triage, and remediation, while parallel adversarial and architectural reviewers attack the finished diff. The loop runs unattended and surfaces only a final report, on completion or after three failed attempts on the same issue. Use when explicitly invoked to deliver a change with review-backed evidence.
disable-model-invocation: true
icon: code
color: blue
---

# Engineering Implementation Loop

You are the parent agent. You launch subagents, relay reviewer findings to the
writer, and produce the final report. The writer owns discovery, planning,
implementation, verification, triage, and remediation. Never perform a stage
that this skill assigns to the writer, and never interrupt the user mid-loop —
the loop ends with your final report, and only there.

## Subagents used

| Stage | Subagent | Mode |
| :--- | :--- | :--- |
| Discover, Plan, Implement, Verify, Triage, Remediate | `lbh-implementation-agent` | writer |
| Review, Re-review | `lbh-adversarial-code-reviewer` | read-only |
| Review, Re-review | `lbh-architectural-reviewer` | read-only |

Use one `lbh-implementation-agent` per task and resume that same subagent across
phases wherever resuming is available, so it keeps the context of what it
discovered, planned, and wrote. If resuming is not available, launch it fresh
and pass the full structured handoff instead.

## Non-negotiable rules

These apply to you and to every stage prompt you write. Restate them in the
prompts you send; subagents start with no memory of this conversation.

- Inspect the repository and obey project-local instructions (`AGENTS.md`,
  `.cursor/rules/`, `CONTRIBUTING.md`, linter and formatter config, existing
  patterns) before proposing or making changes.
- Make the smallest correct change that satisfies the request.
- No drive-by refactors, renames, reformatting, or cleanup outside the approved
  scope.
- Preserve unrelated changes already present in the working tree. Never revert,
  stash, or overwrite work you did not make.
- Never run `git commit`, `git push`, `git reset`, `git revert`, `git checkout --`,
  or any other history- or state-rewriting command unless the user explicitly
  requested that action.
- Never claim success without verification. "It should work" is not a result.
- Treat the complete diff as staged changes, unstaged changes, **and** newly
  created files. Untracked files are part of the change under review.

### Run unattended

This loop is autonomous. Do not stop to ask the user questions mid-loop — not
for scope, not for file count, not for dependencies, not for ambiguity. The
writer resolves what it can from the repository, records every consequential
decision in its output, and carries anything unresolved into the final report
as residual risk. The user is disturbed exactly once: when the loop ends.

### Three-attempt limit

If three attempts at the same issue fail, stop the loop. Do not try a fourth
variation. The final report uses `status: blocked` and records what was tried,
the exact error or failing output, what was ruled out, and the options the
user could choose between.

## Handoffs

Every prompt you send to a subagent must contain, in this order:

1. **Original request** — the user's request, verbatim, unedited. Pass it to
   every stage, including re-reviews.
2. **Stage** — which stage this is and, for the writer, the explicit
   `phase: discover | plan | implement | verify | remediate`.
3. **Inputs** — the structured output of the prior stages that this stage needs
   (discovery findings, the plan, verification results, review findings).
   Reviewer findings go to the writer raw — you relay them, you do not triage
   them.
4. **Rules** — the non-negotiable rules above that apply to this stage.
5. **Required output** — the exact fields you expect back.

Keep each stage's structured output in your own context. It is the input to
the next stage and the evidence for your final report.

## Stage 1 — Discover

Launch `lbh-implementation-agent` with `phase: discover` and the original
request. It inspects the repository, project-local instructions, relevant code
and tests, package-manager evidence, documented verification commands,
callers, dependencies, APIs, persistence boundaries, and established patterns.
It does not edit files in this phase.

Expect back: `repository_summary`, `relevant_files`, `project_constraints`,
`package_manager`, `test_commands`, `integration_points`, `risks`.

The writer answers its own open questions from the repository wherever
possible and carries the rest forward as risks. Do not ask the user.

## Stage 2 — Plan

Resume the same `lbh-implementation-agent` with `phase: plan`.

Expect back:

- `implementation_plan` — ordered, concrete steps naming the files to change
  and the change to make in each.
- `acceptance_criteria` — observable conditions that define done, traceable
  to the request.
- `verification_plan` — the exact commands to run and the specific manual
  checks to perform, based on the detected package manager and the project's
  documented commands, noting anything that cannot be verified in this
  environment.

Continue directly to Stage 3. Do not pause for plan approval.

## Stage 3 — Implement

Resume `lbh-implementation-agent` with `phase: implement`.

Expect back: `changed_files`, `implementation_summary`, `tests_run`,
`known_limitations`.

## Stage 4 — Verify

Resume the same `lbh-implementation-agent` with `phase: verify`.

Expect back: `verification_results`, `remaining_failures`, `tests_run`, and any
updates to `changed_files` and `known_limitations`.

Pre-existing failures unrelated to this change are not the writer's to fix.
Record them and carry them into your final report as residual risk.

## Stage 5 — Review (parallel)

Only after the writer has finished and verification has been attempted, launch
**both** reviewers **in a single message** so they run in parallel:

- `lbh-adversarial-code-reviewer`
- `lbh-architectural-reviewer`

Give each one the original request, the writer's plan, the implementation
summary, the verification results, and instructions to review the complete diff
including untracked files. Never let a reviewer run while the writer is still
editing.

Each reviewer returns either findings with `severity`, `title`, `file`, `line`,
`evidence`, `impact`, `recommendation`, or exactly `No actionable findings.`

Relay the findings to the writer exactly as received. You do not triage them.

## Stage 6 — Triage and remediate

Enter this stage if verification failed or any reviewer returned findings.

Resume `lbh-implementation-agent` with `phase: remediate`, the raw findings
from both reviewers, the failures to fix, its current `changed_files`, and the
complete current task diff.

The writer triages: it accepts or rejects each finding with a stated reason,
then resolves the accepted findings in severity order. A finding is actionable
when it identifies a real defect, risk, or design problem in this change;
out-of-scope improvements and pre-existing issues are rejected and recorded as
residual risks or follow-up work.

Expect back: `triage_decisions`, `remediation_summary`,
`updated_verification_results`, `changed_files`, `tests_run`,
`known_limitations`.

Every finding ends the loop as resolved or rejected with a reason. A rejection
holds for the rest of the loop unless a reviewer brings new evidence against
it.

## Stage 7 — Re-review (parallel)

Whenever remediation changed code or tests, launch both reviewers again in a
single message, with the original request, the triage decisions, the
remediation summary, the updated verification results, and the complete
current diff.

Repeat Stages 6 and 7 until **both** of these hold:

- Verification passes, apart from failures documented as pre-existing.
- No finding the writer accepted remains outstanding.

A reviewer re-raising something the writer already rejected does not reopen
the loop unless it brings new evidence. The writer notes the recurrence and
keeps the existing rejection and its reason.

The three-attempt limit applies to each specific issue. If remediation cannot
close an issue after three attempts, stop the loop and report `blocked`.

## Stage 8 — Finalize (you, the parent)

Do this yourself. Do not delegate final reporting.

Before reporting, inspect the complete diff yourself — staged changes,
unstaged changes, and newly created files. Confirm both of these:

- **The task's changes are limited to the writer's plan.** Every file and hunk
  introduced by this task must trace to the plan. Remove only stray edits
  introduced by this task. Leave pre-existing unrelated changes untouched and
  disclose them separately under `residual_risks`; if separating the work would
  discard or delete user changes, leave everything in place and disclose it
  instead.
- **The writer's triage is sound.** Every finding is resolved, or rejected
  with a stated reason that the evidence supports. If a rejection does not
  hold up, say so in the report rather than sending the loop back around.

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

Use `completed` only when verification passed and no accepted actionable
finding remains. Use `blocked` when the loop hit the three-attempt limit. Use
`partially_completed` when part of the request landed and verified but part
did not.
