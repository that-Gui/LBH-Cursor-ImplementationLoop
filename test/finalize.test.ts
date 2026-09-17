import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTestWeakening, isForbiddenPath, isTestPath, unjustifiedTestWeakening } from "../src/gates.ts";
import { completeRun, finalizeRepo, prepareRun, readManifest, writeManifest } from "../src/finalize.ts";
import { OperatorError, git } from "../src/git.ts";
import { mdCode, prBody } from "../src/pr-body.ts";
import {
  commitMessage,
  finalizableProblems,
  parseLoopResult,
  writeResult,
  type LoopResult,
} from "../src/result.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-finalize-"));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function rawGit(args: string[], cwd: string): string {
  const res = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.status !== 0) {
    const detail = res.error?.message || res.stderr || res.stdout || `status=${String(res.status)}`;
    throw new Error(`raw git ${args.join(" ")} failed: ${detail}`);
  }
  return res.stdout;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sampleResult(over: Partial<LoopResult> = {}): LoopResult {
  return {
    schemaVersion: 1,
    repo: "app",
    branch: "main",
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baselineFailures: 0,
    baselineFailureNames: [],
    buildPassed: true,
    testsRegressed: false,
    reviewers: "PASS",
    status: "completed",
    rounds: 1,
    unresolvedCriticals: [],
    warnings: [],
    implementationSummary: "Add rate limiting to the notifications endpoint.",
    testsRun: ["npm test — passed"],
    filesChanged: ["src/app.ts: added rate limiting"],
    residualRisks: [],
    originalRequest: "add rate limiting and open a PR",
    testChanges: [],
    ...over,
  };
}

function writeRoundLogs(loopDir: string, round = 1): void {
  fs.writeFileSync(path.join(loopDir, `round-${round}-build.log`), "build ok\n");
  fs.writeFileSync(path.join(loopDir, `round-${round}-test.log`), "tests ok\n");
}

type Fixture = {
  repoDir: string;
  remoteDir: string;
  loopDir: string;
  baseSha: string;
};

function makeFixture(name: string): Fixture {
  const dir = path.join(tmpRoot, name);
  const repoDir = path.join(dir, "repo");
  const remoteDir = path.join(dir, "app.git");
  const loopDir = path.join(dir, "loop");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(loopDir, { recursive: true });
  rawGit(["init", "-b", "main"], repoDir);
  rawGit(["config", "user.name", "fixture"], repoDir);
  rawGit(["config", "user.email", "fixture@example.com"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# app\n");
  rawGit(["add", "."], repoDir);
  rawGit(["commit", "-m", "init"], repoDir);
  rawGit(["init", "--bare", "-b", "main", remoteDir], dir);
  rawGit(["remote", "add", "origin", remoteDir], repoDir);
  rawGit(["push", "-u", "origin", "main"], repoDir);
  rawGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoDir);
  const baseSha = rawGit(["rev-parse", "HEAD"], repoDir).trim();
  return { repoDir, remoteDir, loopDir, baseSha };
}

function seedSuccess(fx: Fixture, extra?: { file?: string; contents?: string; result?: Partial<LoopResult> }): LoopResult {
  prepareRun(fx.loopDir, fx.repoDir);
  const target = extra?.file ?? "src/app.ts";
  fs.mkdirSync(path.dirname(path.join(fx.repoDir, target)), { recursive: true });
  fs.writeFileSync(path.join(fx.repoDir, target), extra?.contents ?? "export const limit = 10;\n");
  const result = sampleResult({
    repo: "app",
    branch: "main",
    baseSha: fx.baseSha,
    ...extra?.result,
  });
  writeResult(fx.loopDir, result);
  writeRoundLogs(fx.loopDir, result.rounds);
  completeRun(fx.loopDir);
  return result;
}

const okCreate = () => ({
  status: 0,
  stdout: "https://github.com/example/app/pull/1\n",
  stderr: "",
});
const adoptCreate = () => ({
  status: 1,
  stdout: "",
  stderr: "GraphQL: Validation Failed (HTTP 422)\na pull request already exists for this branch\n",
});
const listExisting: import("../src/git.ts").GhRunner = () => '[{"url":"https://github.com/example/app/pull/9"}]\n';

describe("prBody", () => {
  it("uses the Hackney checklist headings and the original request", () => {
    const body = prBody(sampleResult());
    assert.match(body, /### ` Describe this PR `/);
    assert.match(body, /### ` What is the problem we're trying to solve\? `/);
    assert.match(body, /### ` What changes have we introduced\? `/);
    assert.match(body, /#### ` Checklist `/);
    assert.match(body, /add rate limiting and open a PR/);
    assert.match(body, /Add rate limiting to the notifications endpoint/);
    assert.match(body, /HEAD moved off the recorded baseline/);
  });

  it("fences the agent summary so GitHub does not autolink it", () => {
    const body = prBody(sampleResult({ implementationSummary: "See issue #12 and @octocat" }));
    assert.match(body, /```+text\nSee issue #12 and @octocat\n```+/);
  });
});

describe("mdCode", () => {
  it("wraps a value in a fence longer than any backtick run inside it", () => {
    assert.equal(mdCode("Newtonsoft.Json"), "`Newtonsoft.Json`");
    assert.equal(mdCode("a ` b"), "``a ` b``");
  });
});

describe("finalizableProblems", () => {
  it("accepts a completed PASS result", () => {
    assert.deepEqual(finalizableProblems(sampleResult()), []);
  });

  it("refuses blocked status, FAIL reviewers, and a critical filed under warnings", () => {
    assert.ok(finalizableProblems(sampleResult({ status: "blocked" })).some((p) => /status/.test(p)));
    assert.ok(finalizableProblems(sampleResult({ reviewers: "FAIL" })).some((p) => /reviewers/.test(p)));
    assert.ok(
      finalizableProblems(
        sampleResult({ warnings: [{ severity: "critical", title: "misfiled" }] }),
      ).some((p) => /warnings holds/.test(p)),
    );
  });

  it("refuses an empty testsRun and a carried failure with no names", () => {
    assert.ok(finalizableProblems(sampleResult({ testsRun: [] })).some((p) => /testsRun/.test(p)));
    assert.ok(
      finalizableProblems(sampleResult({ baselineFailures: 1, baselineFailureNames: [] })).some((p) =>
        /baselineFailureNames/.test(p),
      ),
    );
  });
});

describe("parseLoopResult", () => {
  it("drops unknown keys and parses optional testChanges as []", () => {
    const parsed = parseLoopResult({ ...sampleResult(), extra: true, testChanges: undefined });
    assert.equal(parsed.testChanges?.length, 0);
    assert.equal("extra" in parsed, false);
  });
});

describe("commitMessage", () => {
  it("takes the first non-empty line and truncates", () => {
    assert.equal(commitMessage("\nHello world\nMore"), "Hello world");
    assert.ok(commitMessage("x".repeat(80)).length <= 72);
  });
});

describe("test weakening gates", () => {
  it("treats test/ and *.test.ts as test paths", () => {
    assert.equal(isTestPath("test/foo.test.ts"), true);
    assert.equal(isTestPath("src/app.ts"), false);
  });

  it("flags an added it.skip and a deleted test file", () => {
    const skip = findTestWeakening(
      [
        "diff --git a/test/foo.test.ts b/test/foo.test.ts",
        "--- a/test/foo.test.ts",
        "+++ b/test/foo.test.ts",
        "@@ -1,0 +1 @@",
        "+it.skip('x', () => {})",
      ].join("\n"),
    );
    assert.ok(skip.some((w) => w.token === "it.skip"));

    const deleted = findTestWeakening(
      [
        "diff --git a/test/foo.test.ts b/test/foo.test.ts",
        "deleted file mode 100644",
        "--- a/test/foo.test.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-it('x', () => {})",
      ].join("\n"),
    );
    assert.ok(deleted.some((w) => w.token === "deleted test file"));
  });

  it("accepts a skip when testChanges names the file", () => {
    const weakenings = findTestWeakening(
      [
        "diff --git a/test/foo.test.ts b/test/foo.test.ts",
        "--- a/test/foo.test.ts",
        "+++ b/test/foo.test.ts",
        "@@ -1,0 +1 @@",
        "+it.skip('x', () => {})",
      ].join("\n"),
    );
    const leftover = unjustifiedTestWeakening(weakenings, [
      { file: "test/foo.test.ts", change: "skipped flaky case", reason: "request dropped that behaviour" },
    ]);
    assert.equal(leftover.length, 0);
  });
});

describe("isForbiddenPath", () => {
  it("protects .github, .cursor, and .env", () => {
    assert.equal(isForbiddenPath(".github/workflows/ci.yml"), true);
    assert.equal(isForbiddenPath(".cursor/hooks.json"), true);
    assert.equal(isForbiddenPath(".env"), true);
    assert.equal(isForbiddenPath("src/app.ts"), false);
  });
});

describe("prepareRun", () => {
  it("writes a prepared manifest from git", () => {
    const fx = makeFixture("prepare");
    const manifest = prepareRun(fx.loopDir, fx.repoDir);
    assert.equal(manifest.phase, "prepared");
    assert.equal(manifest.repo, "app");
    assert.equal(manifest.branch, "main");
    assert.equal(manifest.baseSha, fx.baseSha);
    assert.equal(manifest.dirty.length, 0);
    assert.equal(readManifest(fx.loopDir).baseSha, fx.baseSha);
  });
});

describe("completeRun", () => {
  it("advances prepared to loop-complete and records digests", () => {
    const fx = makeFixture("complete");
    seedSuccess(fx);
    const manifest = readManifest(fx.loopDir);
    assert.equal(manifest.phase, "loop-complete");
    assert.ok(manifest.resultDigest);
    assert.ok(manifest.roundLogsDigest);
  });

  it("refuses a result that is not finalizable", () => {
    const fx = makeFixture("complete-blocked");
    prepareRun(fx.loopDir, fx.repoDir);
    writeResult(fx.loopDir, sampleResult({ repo: "app", branch: "main", baseSha: fx.baseSha, status: "blocked" }));
    writeRoundLogs(fx.loopDir);
    assert.throws(() => completeRun(fx.loopDir), OperatorError);
  });

  it("refuses missing round logs", () => {
    const fx = makeFixture("complete-nologs");
    prepareRun(fx.loopDir, fx.repoDir);
    writeResult(fx.loopDir, sampleResult({ repo: "app", branch: "main", baseSha: fx.baseSha }));
    assert.throws(() => completeRun(fx.loopDir), /round-1-build\.log/);
  });
});

describe("finalizeRepo", () => {
  it("commits, pushes, and opens a PR", async () => {
    const fx = makeFixture("happy");
    seedSuccess(fx);
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(outcome.prUrl, "https://github.com/example/app/pull/1");
    assert.equal(readManifest(fx.loopDir).phase, "finalized");
    const pushed = rawGit(["ls-remote", "--heads", fx.remoteDir], fx.repoDir);
    assert.match(pushed, /refs\/heads\/loop\//);
  });

  it("adopts an existing PR when gh reports 422", async () => {
    const fx = makeFixture("adopt");
    seedSuccess(fx);
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, adoptCreate, listExisting);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(outcome.prUrl, "https://github.com/example/app/pull/9");
  });

  it("refuses when HEAD moved off baseSha", async () => {
    const fx = makeFixture("committed");
    seedSuccess(fx);
    rawGit(["add", "."], fx.repoDir);
    rawGit(["commit", "-m", "loop committed"], fx.repoDir);
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /baseSha/);
  });

  it("refuses pre-existing dirty work recorded at Stage 0", async () => {
    const fx = makeFixture("dirty");
    fs.writeFileSync(path.join(fx.repoDir, "scratch.txt"), "operator work\n");
    prepareRun(fx.loopDir, fx.repoDir);
    fs.mkdirSync(path.join(fx.repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(fx.repoDir, "src/app.ts"), "export const limit = 10;\n");
    writeResult(fx.loopDir, sampleResult({ repo: "app", branch: "main", baseSha: fx.baseSha }));
    writeRoundLogs(fx.loopDir);
    completeRun(fx.loopDir);
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /pre-existing dirty/);
  });

  it("refuses a protected path", async () => {
    const fx = makeFixture("protected");
    seedSuccess(fx, { file: ".env", contents: "SECRET=1\n" });
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /protected paths/);
  });

  it("refuses when the loop left only artefacts", async () => {
    const fx = makeFixture("artefacts");
    prepareRun(fx.loopDir, fx.repoDir);
    fs.mkdirSync(path.join(fx.repoDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(fx.repoDir, "bin/out.dll"), "dll");
    writeResult(fx.loopDir, sampleResult({ repo: "app", branch: "main", baseSha: fx.baseSha }));
    writeRoundLogs(fx.loopDir);
    completeRun(fx.loopDir);
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /no non-artifact changes/);
  });

  it("refuses an unexplained test skip", async () => {
    const fx = makeFixture("skip");
    seedSuccess(fx, {
      file: "test/foo.test.ts",
      contents: "it.skip('x', () => {});\n",
    });
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests/);
  });

  it("refuses when result.json changed after complete-run", async () => {
    const fx = makeFixture("digest");
    const result = seedSuccess(fx);
    writeResult(fx.loopDir, { ...result, implementationSummary: "tampered after the gate" });
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /result\.json changed/);
  });

  it("refuses a forged loop-complete with no digests", async () => {
    const fx = makeFixture("forged");
    seedSuccess(fx);
    const manifest = readManifest(fx.loopDir);
    writeManifest(fx.loopDir, { ...manifest, resultDigest: undefined, roundLogsDigest: undefined });
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /no gate digest/);
  });

  it("refuses when round logs were swapped after the gate", async () => {
    const fx = makeFixture("swapped-logs");
    seedSuccess(fx);
    fs.writeFileSync(path.join(fx.loopDir, "round-1-test.log"), "tampered\n");
    const outcome = await finalizeRepo(fx.loopDir, fx.repoDir, git, okCreate, listExisting);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /logs changed/);
  });
});

describe("sha256 helper used by the digest tests", () => {
  it("is stable", () => {
    assert.equal(sha256("a").length, 64);
  });
});
