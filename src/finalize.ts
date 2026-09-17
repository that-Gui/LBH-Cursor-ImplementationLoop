import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultBranch,
  git,
  gh,
  ghAllowFail,
  isBaseCommit,
  isSafeName,
  loopDirInsideRepo,
  OperatorError,
  redact,
  repoNameFromRemote,
  requireIdentity,
  sha256,
  GIT_SHA,
  type GitRunner,
  type GhRunner,
} from "./git.ts";
import {
  findTestWeakening,
  isArtifactPath,
  isForbiddenPath,
  resolveExistingDir,
  unquoteGitPath,
  unjustifiedTestWeakening,
} from "./gates.ts";
import { prBody } from "./pr-body.ts";
import {
  commitMessage,
  finalizableProblems,
  readResultBytes,
  verifyRoundLogs,
  writeJsonAtomic,
  type LoopResult,
} from "./result.ts";

export const RUN_SCHEMA_VERSION = 1;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export type RunPhase = "prepared" | "loop-complete" | "finalized" | "failed";

export type RunManifest = {
  schemaVersion: 1;
  phase: RunPhase;
  repo: string;
  repoDir: string;
  branch: string;
  defaultBranch: string;
  originUrl: string;
  baseSha: string;
  dirty: string[];
  untracked: string[];
  createdAt: string;
  resultDigest?: string;
  roundLogsDigest?: string;
};

export type GateDigests = { resultDigest: string; roundLogsDigest: string };

export type FinalizeOutcome = {
  ok: boolean;
  loopDir: string;
  reason?: string;
  prUrl?: string;
  logPath?: string;
};

const PHASES: readonly RunPhase[] = ["prepared", "loop-complete", "finalized", "failed"];

const ALLOWED_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  prepared: ["loop-complete", "failed"],
  "loop-complete": ["finalized", "failed"],
  failed: ["failed"],
  finalized: ["finalized"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) throw new OperatorError(`invalid run manifest: ${key} must be a non-empty string`);
  return v;
}

function reqStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new OperatorError(`invalid run manifest: ${key} must be an array of strings`);
  }
  return v;
}

export function manifestPath(loopDir: string): string {
  return path.join(loopDir, "manifest.json");
}

export function parseManifest(value: unknown): RunManifest {
  if (!isRecord(value)) throw new OperatorError("invalid run manifest: expected an object");
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new OperatorError(`invalid run manifest: schemaVersion must be ${RUN_SCHEMA_VERSION}`);
  }
  const phase = value.phase;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) {
    throw new OperatorError("invalid run manifest: phase is invalid");
  }
  const repoDir = reqString(value, "repoDir");
  if (!path.isAbsolute(repoDir)) throw new OperatorError("invalid run manifest: repoDir must be absolute");
  const baseSha = reqString(value, "baseSha");
  if (!GIT_SHA.test(baseSha)) throw new OperatorError("invalid run manifest: baseSha is invalid");
  const repo = reqString(value, "repo");
  if (!isSafeName(repo)) throw new OperatorError(`invalid run manifest: repo is invalid`);
  const manifest: RunManifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    phase: phase as RunPhase,
    repo,
    repoDir: path.resolve(repoDir),
    branch: reqString(value, "branch"),
    defaultBranch: reqString(value, "defaultBranch"),
    originUrl: reqString(value, "originUrl"),
    baseSha,
    dirty: reqStringArray(value, "dirty"),
    untracked: reqStringArray(value, "untracked"),
    createdAt: reqString(value, "createdAt"),
  };
  for (const key of ["resultDigest", "roundLogsDigest"] as const) {
    const digest = value[key];
    if (digest === undefined) continue;
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new OperatorError(`invalid run manifest: ${key} must be a sha256 hex digest`);
    }
    manifest[key] = digest;
  }
  return manifest;
}

export function readManifest(loopDir: string): RunManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath(loopDir), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperatorError(
        `no manifest.json in ${loopDir}: run \`npm run prepare-run -- --loop-dir ${loopDir}\` first`,
      );
    }
    throw e;
  }
  return parseManifest(raw);
}

export function writeManifest(loopDir: string, manifest: RunManifest): void {
  writeJsonAtomic(manifestPath(loopDir), manifest);
}

function swapPhase(loopDir: string, manifest: RunManifest, next: RunPhase, digests?: GateDigests): RunManifest {
  const onDisk = readManifest(loopDir);
  if (onDisk.phase !== manifest.phase) {
    throw new OperatorError(
      `run changed phase underneath this handle: it was read at ${manifest.phase}, the loop directory now says ${onDisk.phase}; re-read the manifest before transitioning`,
    );
  }
  const updated: RunManifest = { ...onDisk, ...digests, phase: next };
  writeManifest(loopDir, updated);
  return updated;
}

export function transitionPhase(loopDir: string, manifest: RunManifest, next: RunPhase, digests?: GateDigests): RunManifest {
  const allowed = ALLOWED_TRANSITIONS[manifest.phase];
  if (!allowed.includes(next)) {
    throw new OperatorError(`illegal phase transition: ${manifest.phase} -> ${next}`);
  }
  return swapPhase(loopDir, manifest, next, digests);
}

function porcelainLines(repoDir: string, runGit: GitRunner): string[] {
  return runGit(["status", "--porcelain"], repoDir)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

function untrackedLines(repoDir: string, runGit: GitRunner): string[] {
  return runGit(["ls-files", "--others", "--exclude-standard"], repoDir)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function excludeLoopDir(paths: string[], loopRel: string | undefined): string[] {
  if (!loopRel) return paths;
  const prefix = loopRel.replace(/\\/g, "/").replace(/\/$/, "");
  return paths.filter((p) => {
    const body = p.replace(/^.. /, "").replace(/\\/g, "/");
    return body !== prefix && !body.startsWith(`${prefix}/`);
  });
}

export function prepareRun(
  loopDirRaw: string,
  repoDirRaw: string,
  runGit: GitRunner = git,
): RunManifest {
  const loopDir = resolveExistingDir(loopDirRaw, "--loop-dir");
  const repoDir = resolveExistingDir(repoDirRaw, "--repo-dir");
  fs.mkdirSync(loopDir, { recursive: true, mode: 0o700 });

  let originUrl = "";
  try {
    originUrl = runGit(["remote", "get-url", "origin"], repoDir).trim();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new OperatorError(`repository has no origin remote; finalize cannot push (${why})`);
  }
  if (!originUrl) throw new OperatorError("repository has no origin remote; finalize cannot push");
  const repo = repoNameFromRemote(originUrl);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim();
  if (!branch || branch === "HEAD") {
    throw new OperatorError("refusing to prepare a detached HEAD; check out a branch first");
  }
  const baseSha = runGit(["rev-parse", "HEAD"], repoDir).trim();
  if (!GIT_SHA.test(baseSha)) throw new OperatorError("could not read HEAD as a git sha");
  const def = defaultBranch(repoDir, runGit);
  const loopRel = loopDirInsideRepo(loopDir, repoDir);
  const dirty = excludeLoopDir(porcelainLines(repoDir, runGit), loopRel);
  const untracked = excludeLoopDir(untrackedLines(repoDir, runGit), loopRel);

  const manifest: RunManifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    phase: "prepared",
    repo,
    repoDir,
    branch,
    defaultBranch: def,
    originUrl,
    baseSha,
    dirty,
    untracked,
    createdAt: new Date().toISOString(),
  };
  writeManifest(loopDir, manifest);
  return manifest;
}

function gateDigests(loopDir: string, resultBytes: Buffer, result: LoopResult): GateDigests {
  return {
    resultDigest: sha256(resultBytes),
    roundLogsDigest: verifyRoundLogs(loopDir, result),
  };
}

function assertResultIdentity(manifest: RunManifest, result: LoopResult): void {
  if (result.repo !== manifest.repo || result.branch !== manifest.branch || result.baseSha !== manifest.baseSha) {
    throw new OperatorError(
      `result identity does not match the run: expected repo=${manifest.repo} branch=${manifest.branch} baseSha=${manifest.baseSha}`,
    );
  }
}

export function completeRun(loopDirRaw: string): RunManifest {
  const loopDir = resolveExistingDir(loopDirRaw, "--loop-dir");
  const manifest = readManifest(loopDir);
  const { bytes, result } = readResultBytes(loopDir);
  assertResultIdentity(manifest, result);
  const problems = finalizableProblems(result);
  if (problems.length) {
    throw new OperatorError(`result is not finalizable: ${problems.join("; ")}`);
  }
  const digests = gateDigests(loopDir, bytes, result);
  if (manifest.phase === "loop-complete") return swapPhase(loopDir, manifest, "loop-complete", digests);
  return transitionPhase(loopDir, manifest, "loop-complete", digests);
}

function loopBranchName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  return `loop/${stamp}`;
}

function excludeFromCommit(repoDir: string, patterns: string[]): void {
  const excludeFile = path.join(repoDir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(excludeFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (!missing.length) return;
  const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludeFile, `${lead}${missing.join("\n")}\n`);
}

function parsePrUrl(text: string): string | undefined {
  const m = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text);
  return m?.[0];
}

function adoptExistingPr(repoDir: string, head: string, runGh: GhRunner): string | undefined {
  const out = runGh(
    ["pr", "list", "--head", head, "--state", "open", "--json", "url", "--limit", "1"],
    repoDir,
  );
  try {
    const parsed = JSON.parse(out) as { url?: string }[];
    return parsed[0]?.url;
  } catch {
    return parsePrUrl(out);
  }
}

export async function finalizeRepo(
  loopDirRaw: string,
  repoDirRaw?: string,
  runGit: GitRunner = git,
  runGhCreate: typeof ghAllowFail = ghAllowFail,
  runGh: GhRunner = gh,
): Promise<FinalizeOutcome> {
  const loopDir = resolveExistingDir(loopDirRaw, "--loop-dir");
  const events: string[] = [`finalize at ${new Date().toISOString()}`];
  const note = (text: string): void => {
    events.push(text);
  };
  let logPath: string | undefined;
  let restoreIndex: (() => void) | undefined;
  let createdBranch: string | undefined;
  let originalBranch: string | undefined;
  let repoDir = "";

  const persistLog = (): void => {
    try {
      logPath = path.join(loopDir, "finalize.log");
      fs.writeFileSync(logPath, `${redact(events.join("\n"))}\n`, { mode: 0o600 });
    } catch {
      // the outcome is what matters
    }
  };
  const finish = (outcome: FinalizeOutcome): FinalizeOutcome => {
    persistLog();
    return { ...outcome, logPath };
  };
  const fail = (reason: string): FinalizeOutcome => {
    note(`REFUSED: ${reason}`);
    restoreIndex?.();
    if (createdBranch && originalBranch && repoDir) {
      try {
        runGit(["switch", "-q", "--", originalBranch], repoDir);
        runGit(["branch", "-D", "--", createdBranch], repoDir);
      } catch {
        // best effort
      }
    }
    return finish({ ok: false, reason: redact(reason), loopDir });
  };

  try {
    const manifest = readManifest(loopDir);
    repoDir = resolveExistingDir(repoDirRaw ?? manifest.repoDir, "--repo-dir");
    if (path.resolve(manifest.repoDir) !== path.resolve(repoDir)) {
      return fail(`manifest repoDir ${manifest.repoDir} does not match --repo-dir ${repoDir}`);
    }
    note(`repo=${manifest.repo} branch=${manifest.branch} baseSha=${manifest.baseSha} phase=${manifest.phase}`);
    if (manifest.phase !== "loop-complete") {
      return fail(`run is not loop-complete (phase ${manifest.phase})`);
    }

    const gated = readResultBytes(loopDir);
    const result = gated.result;
    const problems = finalizableProblems(result);
    if (problems.length) {
      return fail(`result is not finalizable: ${problems.join("; ")}`);
    }
    assertResultIdentity(manifest, result);

    const roundLogsDigest = verifyRoundLogs(loopDir, result);
    const resultDigest = sha256(gated.bytes);
    if (!manifest.resultDigest || !manifest.roundLogsDigest) {
      return fail(
        `run carries no gate digest, so its evidence was never reviewed by complete-run; re-run \`npm run complete-run -- --loop-dir ${loopDir}\` and finalize after it passes`,
      );
    }
    if (manifest.resultDigest !== resultDigest) {
      return fail(
        `result.json changed after the run was gated: the manifest records sha256 ${manifest.resultDigest} and the file on disk hashes to ${resultDigest}. testChanges waive a weakened test, so they have to be the entries the gate read; re-run complete-run to re-review the document finalize would ship`,
      );
    }
    if (manifest.roundLogsDigest !== roundLogsDigest) {
      return fail(
        `the round build/test logs changed after the run was gated: the manifest records sha256 ${manifest.roundLogsDigest} and the logs on disk hash to ${roundLogsDigest}; re-run complete-run to re-review the evidence finalize would rely on`,
      );
    }
    note(`evidence verified: result ${resultDigest.slice(0, 12)} logs ${roundLogsDigest.slice(0, 12)} round ${result.rounds}`);

    if (manifest.dirty.length || manifest.untracked.length) {
      return fail(
        "Stage 0 recorded pre-existing dirty or untracked work; finalize cannot separate the loop's change from the operator's. Commit or stash that work, then re-run the loop on a clean tree",
      );
    }

    requireIdentity(repoDir, runGit);

    const head = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim();
    if (head === "HEAD") return fail("refusing to finalize a detached HEAD");

    const headSha = runGit(["rev-parse", "HEAD"], repoDir).trim();
    if (!isBaseCommit(headSha, manifest.baseSha)) {
      return fail(
        `refusing to finalize: HEAD is at ${headSha} but the run manifest records baseSha ${manifest.baseSha}, so the writer loop committed on the branch. The loop must leave its work uncommitted`,
      );
    }

    originalBranch = head;
    let pushBranch = head;
    if (head === manifest.defaultBranch) {
      createdBranch = loopBranchName();
      runGit(["switch", "-c", createdBranch], repoDir);
      pushBranch = createdBranch;
      note(`created branch ${createdBranch} from ${manifest.defaultBranch}`);
    }

    const loopRel = loopDirInsideRepo(loopDir, repoDir);
    const extraExclude = loopRel ? [loopRel.replace(/\\/g, "/")] : [];
    excludeFromCommit(repoDir, ["bin/", "obj/", "TestResults/", "node_modules/", "coverage/", "dist/", "*.binlog", ...extraExclude]);

    runGit(["add", "-A"], repoDir);
    restoreIndex = () => {
      try {
        runGit(["reset", "-q"], repoDir);
      } catch {
        // best effort
      }
    };

    const staged = runGit(["diff", "--cached", "--name-only"], repoDir)
      .split("\n")
      .map((l) => unquoteGitPath(l.trim()))
      .filter(Boolean);
    if (!staged.some((p) => !isArtifactPath(p))) {
      return fail("loop reported success but left no non-artifact changes");
    }
    const forbidden = staged.filter((p) => isForbiddenPath(p));
    if (forbidden.length) {
      return fail(`refusing to open a PR touching protected paths: ${forbidden.slice(0, 5).join(", ")}`);
    }

    const diff = runGit(["diff", "--cached", "-U0"], repoDir);
    const weakened = unjustifiedTestWeakening(findTestWeakening(diff, isArtifactPath), result.testChanges ?? []);
    if (weakened.length) {
      const where = weakened.slice(0, 5).map((w) => `${w.file} (${w.token}): ${w.line}`).join("; ");
      return fail(`refusing to open a PR, weakens tests with no recorded reason: ${where}`);
    }

    const message = commitMessage(result.implementationSummary);
    note(`gates passed on ${staged.length} staged path(s); committing and pushing ${pushBranch}`);
    runGit(["commit", "--no-verify", "-m", message], repoDir);
    restoreIndex = undefined;
    runGit(["push", "--no-verify", "--", "origin", `${pushBranch}:${pushBranch}`], repoDir);

    const bodyFile = path.join(os.tmpdir(), `loop-pr-body.${process.pid}.${process.hrtime.bigint()}.md`);
    fs.writeFileSync(bodyFile, prBody(result), { mode: 0o600 });
    try {
      const created = runGhCreate(
        ["pr", "create", "--title", message, "--body-file", bodyFile, "--base", manifest.defaultBranch, "--head", pushBranch],
        repoDir,
      );
      let prUrl = parsePrUrl(created.stdout) ?? created.stdout.trim();
      if (created.status !== 0) {
        const combined = `${created.stderr}\n${created.stdout}`;
        const already = /already exists|Validation Failed|422|A pull request already exists/i.test(combined);
        if (!already) {
          try {
            runGit(["push", "--delete", "--", "origin", pushBranch], repoDir);
            note(`rolled back the pushed branch ${pushBranch} after the pull request failed`);
          } catch {
            // best effort
          }
          return fail(`gh pr create failed: ${redact(combined.trim())}`);
        }
        const existing = adoptExistingPr(repoDir, pushBranch, runGh);
        if (!existing) {
          return fail(`gh pr create reported an existing PR but none is open for ${pushBranch}`);
        }
        note(`adopted the pull request already open for ${pushBranch}: ${existing}`);
        prUrl = existing;
      }
      if (!prUrl.startsWith("http")) {
        return fail(`gh pr create did not print a pull request URL (got ${JSON.stringify(prUrl)})`);
      }
      try {
        transitionPhase(loopDir, manifest, "finalized");
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        note(`WARNING: the pull request is open but the run phase could not be advanced: ${why}`);
        return finish({ ok: true, prUrl, loopDir, reason: redact(`pull request opened, but the run phase could not be advanced: ${why}`) });
      }
      return finish({ ok: true, prUrl, loopDir });
    } finally {
      try {
        fs.rmSync(bodyFile, { force: true });
      } catch {
        // best effort
      }
    }
  } catch (e) {
    if (e instanceof OperatorError) return fail(e.message);
    const message = e instanceof Error ? e.message : String(e);
    return fail(message);
  }
}
