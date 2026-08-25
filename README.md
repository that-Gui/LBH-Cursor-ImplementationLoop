# LBH Engineering Implementation Loop

A native Cursor Plugin that packages an autonomous engineering workflow: the
parent agent records a baseline, a fresh implementation agent makes the change,
and parallel adversarial and architectural reviewers attack the result —
repeating fix and re-review until both reviewers return `PASS` or the loop hits
its four-round cap. The loop runs unattended and surfaces a single final report.

Built for distribution through a private London Borough of Hackney Team
Marketplace.

## Components

The plugin is a Cursor Plugin, identified by its `.cursor-plugin/plugin.json`
manifest. The manifest declares no component paths, so Cursor discovers the
skill and the agents from their default folders (`skills/` and `agents/`).

```text
LBH-Cursor-ImplementationLoop/
├── .cursor-plugin/
│   └── plugin.json
├── skills/
│   └── engineering-implementation-loop/
│       └── SKILL.md
├── agents/
│   ├── lbh-implementation-agent.md
│   ├── lbh-adversarial-code-reviewer.md
│   └── lbh-architectural-reviewer.md
└── README.md
```

### The skill

`engineering-implementation-loop` is the orchestrator, and it is written for the
parent agent — the one you are talking to. It defines the five stages, the handoff
contract between them, the operating rules (smallest correct change, no drive-by
refactors, no commit or push unless asked, never claim success without
verification, never interrupt the user mid-loop), the round cap, and the exact
shape of the final report.

```text
Stage 0  parent      baseline: BASELINE_SHA, pre-existing dirty/untracked, BASELINE_RESULTS
Stage 1  writer      round 1: the request | rounds 2+: outstanding criticals   (fresh each round)
Stage 2  reviewers   both launched in one message, in parallel
Stage 3  parent      PASS + PASS -> Stage 4;  either FAIL -> collect criticals -> Stage 1
Stage 4  parent      inspect the change set, then emit the final report
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
| `lbh-adversarial-code-reviewer` | Correctness, regressions, security, missing tests | Read-only |
| `lbh-architectural-reviewer` | Fit, boundaries, coupling, duplication, over-engineering | Read-only |

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

- `lbh-implementation-agent`: `claude-opus-5-thinking-max` (Opus 5, extra-high reasoning)
- `lbh-adversarial-code-reviewer`: `kimi-k3-max` (Kimi K3, maximum reasoning)
- `lbh-architectural-reviewer`: `gpt-5.6-sol-max` (GPT 5.6 Sol, extra-high reasoning)

Cursor may still fall back to a compatible model when team policy, plan
availability, or account access prevents the configured model from being used.

## What this is, and what it is not

This is an instruction-driven workflow built from native Cursor components. It is
**not** a deterministic pipeline.

- **Not a DAG.** Nothing schedules the stages. The skill instructs the parent
  agent to run them in order, launch the reviewers in parallel, and loop
  fix and re-review until the exit condition is met. Whether that
  happens exactly as written depends on the model following the instructions.
- **`readonly: true` is enforced by Cursor.** The two reviewers genuinely cannot
  edit files or run state-changing shell commands. That guarantee is real and
  does not depend on model compliance.
- **Two things are at least objective.** `BASELINE_SHA` makes "the change" a fact any
  agent can recompute rather than a recollection, and the `PASS`/`FAIL` verdict makes
  "are we done" a line to read rather than a judgement to make. The parent still has to
  honour them, but it is no longer deciding what they mean.
- **Everything else relies on model compliance.** The stage order, the
  reviewers-after-writer rule, the fresh-writer-every-round rule, the "smallest correct
  change" and "no drive-by refactors" policies, the run-unattended rule, the round cap,
  and the exact final report format are all prompt instructions, not enforced
  constraints.

Treat the loop as a strong, reviewable default rather than a guarantee. Read the
final report and check the diff.

## Using it

Once the plugin is installed, invoke the skill explicitly in Agent chat:

```text
/engineering-implementation-loop add rate limiting to the notifications endpoint
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

**Default On** is a reasonable starting point for a workflow plugin like this
one: teammates get it without hunting for it, and anyone who does not want it can
opt out.

### Keeping it current

Enable **Auto Refresh** in **Marketplace Settings** to re-index on every push to
the tracked branch. This requires the Cursor GitHub App installed on the
repository. Cursor re-indexes at most once every ten minutes, batching rapid
pushes to the latest commit. Marketplaces created with **Import from Repo**
re-read the full manifest on refresh, so plugins added to the repository later
are picked up automatically. Otherwise, use **Refresh** to update manually.

Developers then find the plugin in **Customize** in the sidebar.

## Scope of this repository

This repository contains declarative Cursor assets only — one manifest, one
skill, and three agent definitions. There is no build step, no dependency, no
hook, no rule, no CI configuration, and no installer.

Publishing is out of scope here: nothing in this repository commits or pushes
code, and nothing configures the Cursor dashboard. Pushing the repository and
setting up the Team Marketplace are manual steps you perform yourself.
