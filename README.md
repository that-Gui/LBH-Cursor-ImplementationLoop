# LBH Engineering Implementation Loop

A native Cursor Plugin that packages an autonomous staged engineering
workflow: the implementation agent discovers, plans, implements, verifies,
triages review findings, and remediates, while parallel adversarial and
architectural reviewers attack the finished diff — repeating remediation and
re-review until verification passes and no actionable findings remain. The
loop runs unattended and surfaces a single final report.

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
parent agent — the one you are talking to. It defines the stages, the handoff
contract between them, the operating rules (smallest correct change, no drive-by
refactors, no commit or push unless asked, never claim success without
verification, never interrupt the user mid-loop), the three-attempt limit, and
the exact shape of the final report.

Launching subagents, relaying findings, and final reporting deliberately stay
in the parent agent. Discovery, planning, writing, and triage are delegated to
the writer; review is delegated to the two reviewers.

The skill is set to `disable-model-invocation: true`, so it never loads from
ambient context. It applies only when you invoke it explicitly.

### The subagents

| Subagent | Role | Write access |
| :--- | :--- | :--- |
| `lbh-implementation-agent` | Writer, planner, and triager, one phase per invocation: `discover`, `plan`, `implement`, `verify`, or `remediate` | Read-write |
| `lbh-adversarial-code-reviewer` | Correctness, regressions, security, missing tests | Read-only |
| `lbh-architectural-reviewer` | Fit, boundaries, coupling, duplication, over-engineering | Read-only |

Both reviewers are launched together in a single parent message so they run in
parallel, and only after the writer has finished. Each returns findings with
`severity`, `title`, `file`, `line`, `evidence`, `impact`, and `recommendation`,
or exactly `No actionable findings.` Findings are relayed raw to the writer,
which triages them — accepting or rejecting each with a stated reason.

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
  remediation and re-review until the exit condition is met. Whether that
  happens exactly as written depends on the model following the instructions.
- **`readonly: true` is enforced by Cursor.** The two reviewers genuinely cannot
  edit files or run state-changing shell commands. That guarantee is real and
  does not depend on model compliance.
- **Everything else relies on model compliance.** The stage order, the
  reviewers-after-writer rule, the "smallest correct change" and
  "no drive-by refactors" policies, the run-unattended rule, the three-attempt
  limit, and the exact final report format are all prompt instructions, not
  enforced constraints.

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
switch it off — which is usually what you want, since the loop spans planning,
implementation, review, and remediation across several turns.

The loop runs unattended — it never pauses to ask questions mid-loop. You hear
from it exactly once: the final report, delivered on completion or with
`status: blocked` after three failed attempts on the same issue.

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
