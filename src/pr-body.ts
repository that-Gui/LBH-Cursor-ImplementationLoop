import type { Finding, LoopResult, TestChange } from "./result.ts";

export const MAX_BODY_CHARS = 60_000;
export const MAX_SUMMARY_CHARS = 20_000;
const MAX_CODE_CHARS = 200;
const MAX_TEXT_CHARS = 400;
const MAX_TEST_CHANGES = 20;
const MIN_SUMMARY_CHARS = 200;
const EMPTY_CELL = "—";

const GATE_CLAIMS =
  "Before opening this PR, finalize scanned the committed diff and would have refused it outright if the loop had committed on the branch (HEAD moved off the recorded baseline), if Stage 0 had recorded pre-existing dirty or untracked work, if the diff touched a protected path (`.github`, `.cursor`, `.env`, …), if it left only build artefacts, or if it deleted a test file, moved one out of the test tree, or added a skip/ignore/`xit`/`it.skip` without a `testChanges` entry naming that file. " +
  "Those scans read the diff for those constructs and nothing else: they do not judge whether a test that kept running still asserts as much as it did, so read the test diff yourself.";

export function mdCode(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > MAX_CODE_CHARS ? `${flat.slice(0, MAX_CODE_CHARS)}…` : flat;
  const escaped = clipped.replaceAll("|", "\\|");
  const longest = Math.max(0, ...[...escaped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

export function mdText(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS)}…` : flat;
  return clipped
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("#", "&#35;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "\\|")
    .replaceAll("@", "&#64;");
}

function findingLine(finding: Finding): string {
  const where = finding.file ? ` — ${mdCode(finding.file)}${finding.line ? `:${mdCode(finding.line)}` : ""}` : "";
  const detail = finding.recommendation ?? finding.impact ?? finding.evidence;
  const tail = detail ? ` — ${mdText(detail)}` : "";
  return `- ${mdText(finding.severity)}: ${mdText(finding.title)}${where}${tail}`;
}

function fencedSummary(summary: string, budget: number): string {
  const text = summary.length > budget ? `${summary.slice(0, budget - 16)}\n…(truncated)` : summary;
  const longest = Math.max(3, ...[...text.matchAll(/^`{3,}/gm)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function testChangesSection(changes: TestChange[]): string[] {
  if (!changes.length) return [];
  const lines = ["", "#### Tests the change recorded", ""];
  for (const change of changes.slice(0, MAX_TEST_CHANGES)) {
    lines.push(
      `- ${mdCode(change.file) || EMPTY_CELL}: ${mdText(change.change) || EMPTY_CELL} — ${mdText(change.reason) || EMPTY_CELL}`,
    );
  }
  if (changes.length > MAX_TEST_CHANGES) {
    lines.push(`- …${changes.length - MAX_TEST_CHANGES} more test change(s) omitted.`);
  }
  return lines;
}

function runSummarySection(result: LoopResult): string[] {
  const lines = ["### Agent run summary", ""];
  const verification =
    result.baselineFailures === 0
      ? "Build and tests both passed in the agent's workspace."
      : `Build passed; tests still report the ${result.baselineFailures} failure(s) that were already failing on the base branch, and no others.`;
  lines.push(
    `- Verification: ${verification}`,
    `- Loop verdict: reviewers ${mdCode(result.reviewers)}, status ${mdCode(result.status)}, after ${result.rounds} writer round(s).`,
  );
  if (result.testsRun.length) {
    lines.push("- Commands run:");
    for (const command of result.testsRun) lines.push(`  - ${mdCode(command) || EMPTY_CELL}`);
  }
  if (result.filesChanged.length) {
    lines.push("- Files changed:");
    for (const file of result.filesChanged) lines.push(`  - ${mdText(file) || EMPTY_CELL}`);
  }
  if (result.baselineFailureNames.length) {
    lines.push(`- Carried baseline failures (${result.baselineFailureNames.length}):`);
    for (const name of result.baselineFailureNames) lines.push(`  - ${mdCode(name) || EMPTY_CELL}`);
  }
  if (result.residualRisks.length) {
    lines.push("- Residual risks:");
    for (const risk of result.residualRisks) lines.push(`  - ${mdText(risk) || EMPTY_CELL}`);
  }
  if (result.warnings.length) {
    lines.push("- Warnings:");
    for (const warning of result.warnings) lines.push(`  ${findingLine(warning)}`);
  }
  lines.push(...testChangesSection(result.testChanges ?? []));
  return lines;
}

export function prBody(result: LoopResult): string {
  const baselineFailures = result.baselineFailures;
  const tests =
    baselineFailures === 0
      ? "Build and tests both pass — the loop opens no PR otherwise."
      : `${baselineFailures} test(s) were already failing on the base branch before this change and still fail, unchanged; no test that was passing now fails — the loop opens no PR otherwise.`;
  const checklist = ["- [ ] Code pipeline builds correctly"];
  if (baselineFailures > 0) {
    checklist.push(`- [ ] The ${baselineFailures} pre-existing test failure(s) are confirmed on the base branch`);
  }

  const head = [
    "## Engineering implementation loop.",
    "",
    "Opened by the engineering-implementation-loop after a review-backed run. Humans remain the merge gate.",
    "",
    "### ` Describe this PR `",
    "",
    mdText(result.originalRequest) || "_No original request recorded._",
    "",
    "### ` What is the problem we're trying to solve? `",
    "",
    mdText(result.originalRequest) || "_No original request recorded._",
    "",
    "### ` What changes have we introduced? `",
    "",
    `${mdText(result.implementationSummary) || "_No summary recorded._"} ${tests}`,
    "",
    GATE_CLAIMS,
    "",
    ...runSummarySection(result),
    "",
    "The agent's own summary of the run, quoted verbatim (untrusted repo output):",
    "",
  ].join("\n");

  const tail = [
    "",
    "#### ` Checklist `",
    "",
    ...checklist,
    "",
    "### ` Follow up actions after merging PR `",
    "",
    result.residualRisks.length ? result.residualRisks.map((r) => `- ${mdText(r)}`).join("\n") : "None.",
  ].join("\n");

  const budget = Math.min(MAX_SUMMARY_CHARS, MAX_BODY_CHARS - head.length - tail.length - 64);
  const block =
    budget < MIN_SUMMARY_CHARS
      ? "_Run summary omitted: the sections above already fill GitHub's pull request body limit._"
      : fencedSummary(result.implementationSummary, budget);
  const body = `${head}${block}\n${tail}`;
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 16)}\n…(truncated)` : body;
}
