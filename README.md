# LBH Engineering Implementation Loop

A native Cursor Plugin that packages an autonomous engineering workflow: the
parent agent records a baseline, a fresh implementation agent makes the change,
and parallel adversarial and architectural reviewers attack the result —
repeating fix and re-review until both reviewers return `PASS` or the loop hits
its four-round cap. A fail-closed shell hook blocks mutating git. After a
completed run, a guarded helper may open a pull request **if the original
request asked for one**. The loop runs unattended and surfaces a single final
report.

Built for distribution through a private London Borough of Hackney Team
Marketplace.

**This plugin requires Node.js on PATH.** The git-write hook is a Node script.
Opening a pull request also requires the GitHub CLI (`gh`) logged in, and a
one-time `npm install` in the plugin directory so the finalize helpers can run.

## Components

The plugin is a Cursor Plugin, identified by its `.cursor-plugin/plugin.json`
manifest. The manifest declares no component paths, so Cursor discovers the
skill, the agents, and the hooks from their default folders (`skills/`,
`agents/`, and `hooks/hooks.json`).

```text
LBH-Cursor-ImplementationLoop/
├── .cursor-plugin/
│   └── plugin.json
├── skills/
│   └── engineering-implementation-loop/
│       ├── SKILL.md
│       └── references/
├── agents/
│   ├── lbh-implementation-agent.md
│   ├── lbh-adversarial-code-reviewer.md
│   └── lbh-architectural-reviewer.md
├── hooks/
│   ├── hooks.json
│   ├── block-git-writes.sh
│   └── block-git-writes.mjs
├── src/
├── test/
├── package.json
└── README.md
```

### The skill

`engineering-implementation-loop` is the orchestrator, and it is written for the
parent agent — the one you are talking to. It defines the five stages, the handoff
contract between them, the operating rules (smallest correct change, no drive-by
refactors, **never commit or push**, never claim success without verification,
never interrupt the user mid-loop), the round cap, and the exact shape of the
final report.

```text
Stage 0  parent      baseline: BASELINE_SHA, pre-existing dirty/untracked, BASELINE_RESULTS, LOOP_DIR, prepare-run
Stage 1  writer      round 1: the request | rounds 2+: outstanding criticals   (fresh each round)
Stage 2  reviewers   both launched in one message, in parallel
Stage 3  parent      PASS + PASS -> Stage 4;  either FAIL -> collect criticals -> Stage 1
Stage 4  parent      inspect the change set and the round logs, write result.json, emit the final report
                     if the request asked for a PR and status is completed: complete-run then finalize
```

The baseline, the dispatch, the ledger of triage decisions, and the final report stay
in the parent agent. Implementation and the triage of findings are delegated to the
writer; review is delegated to the two reviewers.

**The writer is launched fresh every round, never resumed.** A stateless writer reads
the current state of the repository instead of trusting its recollection of what it
meant to do three rounds ago, and it comes to the findings without having to defend
code it wrote itself. This is what `BASELINE_SHA` is for: it makes the change set —
`git diff <BASELINE_SHA>` plus any untracked files created since — reconstructible by an
agent that has never seen the task before. Untracked files never show up in `git diff`,
so they are called out separately at every stage.

Every handoff names **`LOOP_DIR`** (the parent scratchpad folder for this run) and
**`ROUND_NUMBER`**. The writer persists this round's build and test output as
`$LOOP_DIR/round-$N-build.log` and `$LOOP_DIR/round-$N-test.log`. Reviewers read those
logs instead of rerunning commands that would write artefacts into the tree under
review. A missing, stale, or regressed log is a critical finding.

Because each writer is new, the parent carries a **rejection ledger**: every finding and
what became of it, accepted and resolved or rejected with the writer's stated reason,
passed into every later prompt. Without it a fresh writer would re-argue what its
predecessor already settled.

The skill is set to `disable-model-invocation: true`, so it never loads from
ambient context. It applies only when you invoke it explicitly.

### The subagents

| Subagent | Role | Write access |
| :--- | :--- | :--- |
| `lbh-implementation-agent` | Writer and triager, one task per invocation: the change requested, or the critical findings against it | Read-write |
| `lbh-adversarial-code-reviewer` | Correctness, regressions, security, missing tests, log comparison, unjustified test weakening | Read-only |
| `lbh-architectural-reviewer` | Fit, boundaries, coupling, duplication, over-engineering, scope creep | Read-only |

Both reviewers are launched together in a single parent message so they run in
parallel, and only after the writer has finished. Each returns findings with
`severity` (`critical`, `warning`, or `suggestion`), `title`, `file`, `line`,
`evidence`, `impact`, and `recommendation` — or exactly `No actionable findings.` —
and closes with a verdict line, `PASS` for zero criticals or `FAIL` for any new
critical or any prior critical still unfixed. Findings are relayed raw to the writer,
which triages them — accepting or rejecting each with a stated reason.

Only criticals send the loop round again. Warnings and suggestions are collected and
handed to you in the final report to triage yourself.

Each subagent has an explicit model profile:

- `lbh-implementation-agent`: `cursor-grok-4.6-high`
- `lbh-adversarial-code-reviewer`: `claude-opus-5-thinking-high`
- `lbh-architectural-reviewer`: `gpt-5.6-sol-medium`

The two reviewers are pinned to different model families so a blind spot in one
does not go unchallenged. Cursor may still fall back to a compatible model when
team policy, plan availability, or account access prevents the configured model
from being used.

### The git-write hook

Cursor agent frontmatter cannot deny individual commands, so
[`hooks/hooks.json`](hooks/hooks.json) registers a fail-closed
`beforeShellExecution` hook that blocks `commit`, `push`, `reset`, `revert`,
`checkout`, `switch`, `restore`, `stash`, `rebase`, `add`, and the rest of Git's
state-changing subcommands, while leaving `status`, `diff`, `log`, `show`,
`rev-parse`, and `ls-files` — everything the loop actually inspects — alone.

**The hook is always-on while this plugin is installed.** It fires on Agent Chat
shell commands, not only when `/engineering-implementation-loop` is invoked. That
is why marketplace install should stay **Default Off**: teammates opt in, rather
than discovering that every agent session in the workspace can no longer
`git commit`.

The matcher is `""`, which fires on every command, because a matcher that looked
for the word `git` would never be consulted for `git<TAB>commit` or
`$(which git) commit`. The script allows all read-only git and all non-git lines.
It does not stop an interpreter the agent asks to run a mutation for it
(`sh push.sh`, `node -e`, `make push`); nothing static can. The prompts carry
that limitation in prose. What the hook guarantees is that direct and accidental
shell mutation stops here — it is a guardrail, not a sandbox against an agent
that sets out to work around it.

The loop never commits. Agents never run `git commit` or `git push`. If the original
request clearly asked to open a pull request and Stage 4 reports `status: completed`,
the parent runs `complete-run` then `finalize`: those helpers gate on the recorded
evidence, then commit, push, and `gh pr create` (or adopt an existing PR for the
branch) via `spawnSync`, which the git-write hook never sees. If the request did not
ask for a PR, you commit after the final report if you want the change recorded.
`/engineering-implementation-loop finalize` runs the helpers against an existing
`LOOP_DIR` without re-running the loop.

## What this is, and what it is not

This is an instruction-driven workflow built from native Cursor components, with
one mechanically enforced guardrail. It is **not** a deterministic pipeline.

- **Not a DAG.** Nothing schedules the stages. The skill instructs the parent
  agent to run them in order, launch the reviewers in parallel, and loop
  fix and re-review until the exit condition is met. Whether that
  happens exactly as written depends on the model following the instructions.
- **`readonly: true` is enforced by Cursor.** The two reviewers genuinely cannot
  edit files or run state-changing shell commands. That guarantee is real and
  does not depend on model compliance.
- **The git-write hook is enforced by Cursor.** Direct `git commit` / `git push`
  / `git add` and the rest of the mutating set are denied at the shell, fail-closed.
- **Two things are at least objective.** `BASELINE_SHA` makes "the change" a fact any
  agent can recompute rather than a recollection, and the `PASS`/`FAIL` verdict makes
  "are we done" a line to read rather than a judgement to make. The parent still has to
  honour them, but it is no longer deciding what they mean.
- **Everything else relies on model compliance.** The stage order, the
  reviewers-after-writer rule, the fresh-writer-every-round rule, the "smallest correct
  change" and "no drive-by refactors" policies, the run-unattended rule, the round cap,
  log-backed `status: completed`, and the exact final report format are all prompt
  instructions, not enforced constraints.

Treat the loop as a strong, reviewable default rather than a guarantee. Read the
final report and check the diff.

## Using it

Once the plugin is installed, invoke the skill explicitly in Agent chat:

```text
/engineering-implementation-loop add rate limiting to the notifications endpoint
/engineering-implementation-loop add rate limiting and open a PR
/engineering-implementation-loop finalize
```

Invoked with `/`, a skill attaches to that single message. For a multi-turn task
where you want the loop to govern the whole session, pin it as a **Custom Mode**
with `Option`+`Enter` (macOS) or `Alt`+`Enter` (Windows) instead of pressing
`Enter`. The mode stays active, showing a badge in the chat input, until you
switch it off — which is usually what you want, since the loop spans
implementation, review, and fixing across several rounds.

The loop runs unattended — it never pauses to ask questions mid-loop. You hear
from it exactly once: the final report, delivered when both reviewers return `PASS`,
or with `status: blocked` if criticals are still standing after four rounds — or after
three rounds on one stubborn finding, whichever comes first.

`status: completed` also requires the final writer round's build and test logs to
exist under `LOOP_DIR` and not contradict the writer's report. A pull request is
opened only when the original request clearly asked for one and that status is
`completed`. `finalize` on its own does not re-run the loop: it gates and opens
a PR against the existing `LOOP_DIR`.

The finalize helpers need `gh` authenticated (`gh auth login`) and the plugin's
own `node_modules` (run `npm install` once in the plugin directory if marketplace
install did not). Git identity is the repository's `user.name` / `user.email`.

## Testing locally before rollout

Optional, and useful for verifying the components load before publishing
anything.

1. Symlink this repository into Cursor's local plugin folder. Run this from the
   repository root; the first command matters because `~/.cursor/plugins/local`
   may not exist yet, and `ln -s` fails if the parent directory is missing:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s "$(pwd)" ~/.cursor/plugins/local/lbh-engineering-implementation-loop
```

Copying the folder works too, but a symlink lets you iterate without re-copying.

2. Restart Cursor, or run **Developer: Reload Window**.
3. Open **Customize** in the sidebar and confirm the skill appears under
   **Skills** and the three subagents are listed.
4. In Agent chat, type `/` and check that `engineering-implementation-loop`
   appears, then run it against a small real change and watch which subagents get
   launched.

If you used the symlink, remove it when you are finished so the local copy does
not shadow the installed plugin:

```bash
rm ~/.cursor/plugins/local/lbh-engineering-implementation-loop
```

If you copied the plugin instead, inspect and remove that copied directory
manually.

### Contract tests

The hook and the skill/agent contracts are pinned by a Node test suite. From the
repository root:

```bash
npm install
npm run check
```

`check` typechecks and runs the tests. Those tests never call GitHub. They
extract every `git …` command line from `skills/` and `agents/` so a prompt edit
that introduces a command the guardrail would block fails the suite rather than
stalling a run. Finalize is exercised against a local git repo and a fake `gh`
on PATH: commit, push, adopt-on-422, and the refusal gates (HEAD moved, dirty
Stage 0, protected paths, unexplained test skips, digest mismatch).

## Rolling out through a private Team Marketplace

Team marketplaces are available on Teams and Enterprise plans. On Teams, one
marketplace; on Enterprise, unlimited, and only admins can add them. The
marketplace stays private to the team.

**This repository must be pushed to GitHub first.** The marketplace imports from
a Git repository, so `https://github.com/that-Gui/LBH-Cursor-ImplementationLoop`
has to exist and contain these files before the import will find anything.

1. Push this repository to GitHub.
2. Go to **Dashboard → Plugins**.
3. Under **Team Marketplaces**, click **Add Marketplace**.
4. Choose **Import from Repo** and give it this repository's URL.
5. Review the discovered plugin and add it with **Add to Marketplace**.
6. Under **Marketplace Settings**, set **Marketplace Access** — available to the
   whole team by default, or restricted to selected Organization Groups — then
   save.

### Installation modes

Set per plugin, for whichever audience you granted access:

| Mode | Behaviour |
| :--- | :--- |
| **Default Off** | Developers can find it and choose to install it. |
| **Default On** | Installed by default; developers can opt out. |
| **Required** | Always installed; cannot be uninstalled. |

**Default Off** is the right starting point for this plugin. The git-write hook
is always-on while the plugin is installed, so Default On would block mutating
git in every agent session for everyone who has not opted out. Teammates who
want the loop install it; everyone else is left alone.

### Keeping it current

Enable **Auto Refresh** in **Marketplace Settings** to re-index on every push to
the tracked branch. This requires the Cursor GitHub App installed on the
repository. Cursor re-indexes at most once every ten minutes, batching rapid
pushes to the latest commit. Marketplaces created with **Import from Repo**
re-read the full manifest on refresh, so plugins added to the repository later
are picked up automatically. Otherwise, use **Refresh** to update manually.

Developers then find the plugin in **Customize** in the sidebar.

## Scope of this repository

This repository contains Cursor plugin assets — one manifest, one skill, three
agent definitions, and a git-write hook — plus TypeScript helpers that prepare,
complete, and finalize a run, and a Node test suite that pins those contracts.
There is no installer and no helper that starts the agent loop.

Publishing the plugin is out of scope here: nothing configures the Cursor
dashboard. Pushing this repository and setting up the Team Marketplace are
manual steps you perform yourself. The finalize helper commits and pushes
**application** code only when a loop run asked for a pull request and the
gates pass.
