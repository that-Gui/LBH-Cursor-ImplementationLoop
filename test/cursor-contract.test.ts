import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/**
 * Collapses runs of whitespace so an assertion pins the wording of a rule rather than
 * where its paragraph happens to wrap. Reflowing a prompt must not turn CI red.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Minimal frontmatter reader. These files use flat `key: value` lines only, and this
 * refuses anything richer instead of mis-parsing it: a block scalar (`|`, `>`), a nested
 * mapping, or a list item would otherwise be read as a meaningless bare string. Matching
 * surrounding quotes are stripped so `model: "x"` and `model: x` compare equal.
 */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m?.[1], "missing YAML frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    assert.doesNotMatch(line, /^\s/, `indented frontmatter line, which this reader cannot parse: ${line}`);
    assert.doesNotMatch(line, /^-\s/, `frontmatter list item, which this reader cannot parse: ${line}`);
    const i = line.indexOf(":");
    assert.notEqual(i, -1, `frontmatter line has no key: ${line}`);
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    assert.doesNotMatch(raw, /^[|>]/, `frontmatter ${key} uses a block scalar, which this reader cannot parse`);
    const quoted = raw.length >= 2 && /^(['"])[\s\S]*\1$/.test(raw);
    out[key] = quoted ? raw.slice(1, -1) : raw;
  }
  return out;
}

/**
 * Body of a Markdown section, by exact heading line, up to the next heading of the same
 * or higher level. Assertions scoped through this pin the rule the section carries rather
 * than matching an incidental occurrence of the same word in a heading or in frontmatter.
 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.notEqual(start, -1, `missing section heading ${JSON.stringify(heading)}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i] ?? "");
    if (m?.[1] && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Contents of every fenced shell block — the lines a reader is meant to actually run. */
function shellBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

const skills = {
  loop: "skills/engineering-implementation-loop/SKILL.md",
} as const;

const agents = {
  writer: "agents/lbh-implementation-agent.md",
  adversarial: "agents/lbh-adversarial-code-reviewer.md",
  architectural: "agents/lbh-architectural-reviewer.md",
} as const;

const prompts = [...Object.values(agents), ...Object.values(skills)];

describe("Cursor asset names", () => {
  it("matches folder and file conventions to frontmatter name", () => {
    const loop = frontmatter(read(skills.loop));
    assert.equal(loop.name, "engineering-implementation-loop");
    assert.equal(path.basename(path.dirname(path.join(root, skills.loop))), loop.name);

    for (const rel of Object.values(agents)) {
      const fm = frontmatter(read(rel));
      assert.equal(path.basename(rel, ".md"), fm.name);
    }
  });
});

describe("skill frontmatter", () => {
  it("sets disable-model-invocation: true on the loop skill", () => {
    assert.equal(frontmatter(read(skills.loop))["disable-model-invocation"], "true");
  });
});

/**
 * Slugs Cursor's catalog accepts in agent frontmatter. An unlisted slug is not a typo that
 * degrades gracefully — Cursor refuses the launch with `Invalid model selection "..."`, so
 * what has to be pinned is membership of this list, not the spelling of any one pin.
 */
const KNOWN_MODELS = [
  "claude-opus-5-thinking-high",
  "composer-2.5-fast",
  "cursor-grok-4.6-high",
  "gpt-5.6-sol-medium",
  "muse-spark-1.3-high",
];

/** Accepts `slug` and `slug[effort=...]`; the bracket suffix is documented Cursor syntax. */
function assertKnownModel(rel: string, pin: string | undefined): void {
  assert.ok(pin, `${rel} must pin a model`);
  const slug = /^([A-Za-z0-9._-]+)(\[[^\]]+\])?$/.exec(pin)?.[1];
  assert.ok(slug, `${rel} model ${JSON.stringify(pin)} is not a slug or slug[effort=...]`);
  assert.ok(
    KNOWN_MODELS.includes(slug),
    `${rel} pins ${JSON.stringify(slug)}, which Cursor's catalog does not ship. Allowed: ${KNOWN_MODELS.join(", ")}`,
  );
}

describe("agent frontmatter", () => {
  it("pins models Cursor's catalog actually ships", () => {
    assertKnownModel(agents.writer, frontmatter(read(agents.writer)).model);
    assertKnownModel(agents.adversarial, frontmatter(read(agents.adversarial)).model);
    assertKnownModel(agents.architectural, frontmatter(read(agents.architectural)).model);
  });

  /**
   * The two reviewers read the same change set, so pinning them to one model would cost the
   * loop its second opinion: a blind spot in that model goes unchallenged.
   */
  it("keeps the two reviewers on different models", () => {
    assert.notEqual(
      frontmatter(read(agents.adversarial)).model,
      frontmatter(read(agents.architectural)).model,
    );
  });

  it("keeps reviewers read-only and the writer writable", () => {
    assert.equal(frontmatter(read(agents.writer)).readonly, "false");
    assert.equal(frontmatter(read(agents.adversarial)).readonly, "true");
    assert.equal(frontmatter(read(agents.architectural)).readonly, "true");
  });
});

type HooksConfig = {
  version: number;
  hooks: { beforeShellExecution?: { command: string; matcher: string; failClosed: boolean }[] };
};

function hooksConfig(): HooksConfig {
  return JSON.parse(read("hooks/hooks.json")) as HooksConfig;
}

/**
 * Commands the hook exists to intercept, in the spellings the prompts and a careless agent
 * actually produce. The matcher's *value* belongs to `hooks.json`; what this suite owns is
 * that whatever value is there still selects all of these.
 */
const MUTATING_SHELL_COMMANDS = [
  "git commit -m x",
  "git push",
  "git push --force origin main",
  "git reset --hard",
  "git checkout -- .",
  "git switch main",
  "git restore .",
  "git stash",
  "git rebase main",
  "git cherry-pick abc123",
  "git add -A",
  "git\tcommit",
  "  git   commit -m x",
];

/** Mutating git verbs, matched against a single command line including a `-C` form. */
const MUTATING_GIT_LINE =
  /\bgit\b(?:\s+-[A-Za-z]\s+\S+)*\s+(?:commit|push|add|reset|revert|checkout|switch|restore|stash|rebase|cherry-pick)\b/;

describe("git guardrail contract", () => {
  it("registers a fail-closed beforeShellExecution hook pointing at a script on disk", () => {
    const config = hooksConfig();
    assert.equal(config.version, 1);

    const before = config.hooks.beforeShellExecution;
    assert.ok(Array.isArray(before), "hooks.beforeShellExecution must be an array");
    assert.equal(before.length, 1);

    const [hook] = before;
    assert.ok(hook, "hooks.beforeShellExecution must not be empty");
    assert.equal(hook.failClosed, true);
    assert.ok(
      fs.existsSync(path.join(root, hook.command)),
      `hook command ${hook.command} does not exist on disk`,
    );
    assert.match(hook.command, /^\.\/hooks\//);
  });

  it("selects every mutating git command with the matcher as written", () => {
    const before = hooksConfig().hooks.beforeShellExecution;
    const hook = before?.[0];
    assert.ok(hook, "hooks.beforeShellExecution must not be empty");

    let matcher: RegExp;
    try {
      matcher = new RegExp(hook.matcher);
    } catch (e) {
      throw new assert.AssertionError({
        message: `hooks.json matcher ${JSON.stringify(hook.matcher)} is not a valid regular expression: ${String(e)}`,
      });
    }

    for (const command of MUTATING_SHELL_COMMANDS) {
      assert.ok(
        matcher.test(command),
        `hooks.json matcher ${JSON.stringify(hook.matcher)} does not select ${JSON.stringify(command)}, so the hook never runs for it`,
      );
    }
  });

  it("tells every agent that commit and push are forbidden and hook-enforced", () => {
    for (const rel of Object.values(agents)) {
      const text = read(rel);
      assert.match(text, /Never\*{0,2} (?:run )?`git commit`, `git push`/, `${rel} must forbid commit and push`);
      assert.match(text, /`git reset`.*`git checkout`/, `${rel} must forbid the other state-changing commands`);
      assert.match(flat(text), /A workspace hook blocks these/, `${rel} must say a hook enforces it`);
    }
  });

  it("states the ban with no exception clause carved out of it", () => {
    for (const rel of [...Object.values(agents), skills.loop]) {
      const rule = /`git commit`[\s\S]{0,500}?A workspace hook blocks these/.exec(flat(read(rel)));
      assert.ok(rule, `${rel} must ban the mutating git commands and name the hook that enforces it`);
      assert.doesNotMatch(
        rule[0] ?? "",
        /\bunless\b|\bexcept\b|\bif you need\b|\bwhen necessary\b/i,
        `${rel} carves an exception out of the mutating-git ban`,
      );
    }
  });

  it("never puts a hook-denied git command in a runnable block", () => {
    for (const rel of prompts) {
      for (const block of shellBlocks(read(rel))) {
        for (const line of block.split("\n")) {
          assert.doesNotMatch(
            line,
            MUTATING_GIT_LINE,
            `${rel} tells an agent to run a command the hook denies: ${line.trim()}`,
          );
        }
      }
    }
  });

  it("keeps the same rule in the loop skill and names the hook there too", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /This loop \*\*never\*\* `git commit`s or `git push`es/);
    assert.match(text, /Never run `git commit`, `git push`/);
    assert.match(text, /A workspace hook blocks these, and a blocked command must be reported rather than worked around/);
  });
});

describe("secret handling contract", () => {
  it("forbids echoing GITHUB_TOKEN in every agent prompt and the loop skill", () => {
    for (const rel of prompts) {
      assert.match(
        flat(read(rel)),
        /[Nn]ever (?:echo|put) `?GITHUB_TOKEN/,
        `${rel} must forbid echoing GITHUB_TOKEN`,
      );
    }
  });
});

describe("loop skill contract", () => {
  it("scopes the fresh-writer and parallel-reviewer rules to the sections that carry them", () => {
    const text = read(skills.loop);

    const freshWriter = flat(section(text, "### Launch the writer fresh every round"));
    assert.match(freshWriter, /fresh/i);
    assert.match(freshWriter, /Never resume an `lbh-implementation-agent`/);
    assert.match(freshWriter, /Every round gets a \*\*new\*\* Task invocation/);

    const parallelReviewers = flat(section(text, "### Launch reviewers in parallel after the writer"));
    assert.match(
      parallelReviewers,
      /launch \*\*both\*\* reviewers \*\*in a single parent message\*\*/,
      "the loop skill must require both reviewers in one parent message",
    );
    assert.match(parallelReviewers, /so they run in parallel/);
    assert.match(parallelReviewers, /Never let a reviewer run while the writer is still editing/);

    assert.match(flat(text), /[Ff]our rounds/);
    assert.match(flat(text), /three rounds/);
  });

  it("gates status: completed on the final round's build and test logs", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /`status: completed` additionally requires/);
    assert.match(text, /final writer round's build and test logs exist under `LOOP_DIR`/);
    assert.match(
      text,
      /show a passing build with no failing test that is absent from the baseline/,
      "existing logs are not enough; the loop must require them to be green",
    );
    assert.match(text, /prepare-run/);
    assert.match(text, /complete-run/);
    assert.match(text, /finalize/);
    assert.match(text, /result\.json/);
    assert.match(
      text,
      /Only if\*\* the original request clearly asked for a pull request/,
      "finalize must stay opt-in on the original request",
    );
  });

  it("asks the writer for every field the parent has to forward", () => {
    const stage1 = flat(section(read(skills.loop), "## Stage 1 — Implement (writer)"));
    assert.match(stage1, /`changed_files`, `diff_stat`, `implementation_summary`, `tests_run`/);
    assert.match(stage1, /`test_changes`/);
    assert.match(stage1, /`triage_decisions`/);
  });

  it("names the round number in the handoff so $N is defined for the writer", () => {
    const text = flat(read(skills.loop));
    assert.match(
      text,
      /`ROUND_NUMBER`: the current round `N`, stated as a number/,
      "the handoff contract must carry the round number",
    );

    const stage1 = flat(section(read(skills.loop), "## Stage 1 — Implement (writer)"));
    assert.match(
      stage1,
      /State `ROUND_NUMBER` explicitly in the prompt/,
      "Stage 1 must pass the round number to the writer, which has no way to infer it",
    );
    assert.match(stage1, /\$LOOP_DIR\/round-\$N-build\.log/);
    assert.match(stage1, /\$LOOP_DIR\/round-\$N-test\.log/);
  });

  it("makes the adversarial reviewer's log comparison a per-round instruction", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /\$LOOP_DIR\/round-\$N-build\.log/);
    assert.match(text, /\$LOOP_DIR\/round-\$N-test\.log/);
    assert.match(text, /read this round's two logs and compare them against `BASELINE_RESULTS`/);
    assert.match(text, /That comparison is what replaces rerunning the suite, so it happens every round/);
  });
});

describe("writer contract", () => {
  it("requires every field the parent has to forward, under the writer's own names", () => {
    const writer = read(agents.writer);
    assert.match(writer, /^changed_files: /m);
    assert.match(writer, /^implementation_summary: /m);
    assert.match(writer, /^tests_run: /m);
    assert.match(writer, /^known_limitations: /m);
    assert.match(writer, /^test_changes: <one entry per test file/m);
    assert.match(writer, /^- file: <path to the test file/m);
    assert.match(writer, /^  change: <what you did to it/m);
    assert.match(writer, /^  reason: <why the request required it/m);
  });

  it("makes the writer, and only the writer, responsible for this round's logs", () => {
    const writer = flat(read(agents.writer));
    assert.match(
      writer,
      /`\$LOOP_DIR\/round-\$N-build\.log`/,
      "the writer is the only agent that can create the build log the reviewer demands",
    );
    assert.match(
      writer,
      /`\$LOOP_DIR\/round-\$N-test\.log`/,
      "the writer is the only agent that can create the test log the reviewer demands",
    );
  });

  it("defines $N so the writer does not guess the log filename", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /`ROUND_NUMBER`/, "the writer must be told which variable carries the round");
    assert.match(
      writer,
      /`ROUND_NUMBER` from the prompt is the `\$N` in every `round-\$N-/,
      "$N is undefined unless the writer prompt binds it to ROUND_NUMBER",
    );
    assert.match(writer, /Never reuse an earlier round's filename and never default to `1`/);
  });

  it("keeps the test-change escape hatch, and keeps the weakening ban absolute", () => {
    const writer = flat(read(agents.writer));
    assert.match(
      writer,
      /A test may change \*\*only\*\* where the request genuinely changes the behaviour that test asserts/,
      "removing the escape hatch leaves the writer no legitimate way to record a forced test change",
    );

    const ban = /Deleting, skipping, or weakening a test is never the fix([\s\S]{0,200}?)no removing/.exec(writer);
    assert.ok(ban, "writer must ban weakening tests and then list the mechanisms");
    assert.doesNotMatch(
      ban[1] ?? "",
      /\bexcept\b|\bunless\b|\bmay delete\b/i,
      "writer carves an exception out of the test-weakening ban",
    );
  });

  it("keeps the honest-reporting rule", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /Never claim something works when you have not run it/);
    assert.match(writer, /Never report a test as passing that you did not see pass/);
  });

  it("scopes the no-redirection rule to repository edits, not to log capture", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /never edit repository files via shell redirection or heredocs/);
    assert.match(
      writer,
      /persisting the build and test logs under `\$LOOP_DIR` by redirection is required/,
      "the writer cannot both be banned from redirection and required to persist logs by it",
    );
  });
});

describe("reviewer contracts", () => {
  it("makes the adversarial reviewer compare this round's logs against the baseline every round", () => {
    const text = read(agents.adversarial);
    assert.match(text, /Compare this round's logs \(mandatory, every round\)/);
    assert.match(text, /\$LOOP_DIR\/round-\$N-build\.log/);
    assert.match(text, /\$LOOP_DIR\/round-\$N-test\.log/);
    assert.match(text, /against `BASELINE_RESULTS` and `\$LOOP_DIR\/baseline-test\.log`/);
    assert.match(text, /either log for the current round is missing/);
  });

  it("excludes build output from the staleness comparison", () => {
    const text = flat(read(agents.adversarial));
    assert.match(
      text,
      /Exclude build artefacts from that comparison/,
      "bin/ and obj/ are newer than every log in a tree that does not gitignore them",
    );
    for (const artefact of [/`bin\/`/, /`obj\/`/, /`node_modules\/`/, /`coverage\/`/]) {
      assert.match(text, artefact, `staleness rule must name ${artefact} as build output`);
    }
  });

  it("keeps both reviewers off mutating build and test commands", () => {
    assert.match(read(agents.adversarial), /\*\*Do not run\*\* the project's build, test, restore/);
    assert.match(read(agents.architectural), /\*\*Do not run\*\* the project's build, test, restore/);
  });

  it("defines the architectural reviewer's critical as a design flaw, never style", () => {
    const text = read(agents.architectural);
    assert.match(text, /`critical` means a design flaw that produces/);
    assert.match(text, /wrong behaviour or forces rework/);
    assert.match(text, /Style, naming, formatting, file/);
    assert.match(text, /it is at most a `suggestion`, and it never justifies a `FAIL`/);
  });

  it("keeps style taste out of scope for the architectural reviewer", () => {
    const outOfScope = flat(section(read(agents.architectural), "## Out of scope"));
    assert.match(
      outOfScope,
      /Do not report style taste: naming preference, formatting, file layout aesthetics/,
      "inverting this section lets a style nit FAIL the loop",
    );
    assert.match(
      outOfScope,
      /Line-level correctness, security, and test coverage belong to the adversarial reviewer, not to you/,
    );
  });

  it("routes diff_stat from the writer to both reviewers as the index of what to inspect", () => {
    const writer = read(agents.writer);
    assert.match(writer, /^diff_stat: <output of `git /m);
    assert.match(writer, /reviewers read `diff_stat` as the index of what to inspect/);

    assert.match(read(agents.adversarial), /`diff_stat` as the index of what to check/);
    assert.match(read(agents.architectural), /Read the writer's `diff_stat` against the original request/);
  });

  it("treats unjustified test weakening as a critical for the adversarial reviewer", () => {
    const adversarial = read(agents.adversarial);
    assert.match(adversarial, /\*\*Tests weakened, deleted, or skipped\*\*/);
    assert.match(adversarial, /the writer did not record the behaviour change that justified it/);
  });
});
