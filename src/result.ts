import fs from "node:fs";
import path from "node:path";
import { OperatorError, sha256 } from "./git.ts";

export const RESULT_SCHEMA_VERSION = 1;
export const MAX_ROUNDS = 50;

export type Finding = {
  severity: "critical" | "warning" | "suggestion";
  title: string;
  file?: string;
  line?: string;
  evidence?: string;
  impact?: string;
  recommendation?: string;
};

export type TestChange = {
  file: string;
  change: string;
  reason: string;
};

export type LoopStatus = "completed" | "blocked" | "partially_completed";

export type LoopResult = {
  schemaVersion: 1;
  repo: string;
  branch: string;
  baseSha: string;
  baselineFailures: number;
  baselineFailureNames: string[];
  buildPassed: boolean;
  testsRegressed: boolean;
  reviewers: "PASS" | "FAIL";
  status: LoopStatus;
  rounds: number;
  unresolvedCriticals: Finding[];
  warnings: Finding[];
  implementationSummary: string;
  testsRun: string[];
  filesChanged: string[];
  residualRisks: string[];
  originalRequest: string;
  testChanges?: TestChange[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new OperatorError(`invalid loop result: ${key} must be a string`);
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") throw new OperatorError(`invalid loop result: ${key} must be a string`);
  return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new OperatorError(`invalid loop result: ${key} must be a boolean`);
  return v;
}

function reqInt(obj: Record<string, unknown>, key: string, min = 0): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new OperatorError(`invalid loop result: ${key} must be an integer >= ${min}`);
  }
  return v;
}

function reqStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new OperatorError(`invalid loop result: ${key} must be an array of strings`);
  }
  return v;
}

function parseFinding(value: unknown, findingPath: string): Finding {
  if (!isRecord(value)) throw new OperatorError(`invalid loop result: ${findingPath} must be an object`);
  const severity = value.severity;
  if (severity !== "critical" && severity !== "warning" && severity !== "suggestion") {
    throw new OperatorError(`invalid loop result: ${findingPath}.severity is invalid`);
  }
  const finding: Finding = { severity, title: reqString(value, "title") };
  const file = optString(value, "file");
  const line = optString(value, "line");
  const evidence = optString(value, "evidence");
  const impact = optString(value, "impact");
  const recommendation = optString(value, "recommendation");
  if (file !== undefined) finding.file = file;
  if (line !== undefined) finding.line = line;
  if (evidence !== undefined) finding.evidence = evidence;
  if (impact !== undefined) finding.impact = impact;
  if (recommendation !== undefined) finding.recommendation = recommendation;
  return finding;
}

function reqFindingArray(obj: Record<string, unknown>, key: string): Finding[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new OperatorError(`invalid loop result: ${key} must be an array`);
  return v.map((item, i) => parseFinding(item, `${key}[${i}]`));
}

function reqNonBlank(obj: Record<string, unknown>, key: string, itemPath: string): string {
  const v = reqString(obj, key);
  if (!v.trim()) throw new OperatorError(`invalid loop result: ${itemPath}.${key} must not be empty`);
  return v;
}

function parseTestChange(value: unknown, changePath: string): TestChange {
  if (!isRecord(value)) throw new OperatorError(`invalid loop result: ${changePath} must be an object`);
  return {
    file: reqNonBlank(value, "file", changePath),
    change: reqNonBlank(value, "change", changePath),
    reason: reqNonBlank(value, "reason", changePath),
  };
}

function optTestChanges(obj: Record<string, unknown>, key: string): TestChange[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new OperatorError(`invalid loop result: ${key} must be an array`);
  return v.map((item, i) => parseTestChange(item, `${key}[${i}]`));
}

export function parseLoopResult(value: unknown): LoopResult {
  if (!isRecord(value)) throw new OperatorError("invalid loop result: expected an object");
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new OperatorError(`invalid loop result: schemaVersion must be ${RESULT_SCHEMA_VERSION}`);
  }
  const reviewers = value.reviewers;
  if (reviewers !== "PASS" && reviewers !== "FAIL") {
    throw new OperatorError("invalid loop result: reviewers must be PASS or FAIL");
  }
  const status = value.status;
  if (status !== "completed" && status !== "blocked" && status !== "partially_completed") {
    throw new OperatorError("invalid loop result: status must be completed, blocked, or partially_completed");
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    repo: reqString(value, "repo"),
    branch: reqString(value, "branch"),
    baseSha: reqString(value, "baseSha"),
    baselineFailures: reqInt(value, "baselineFailures"),
    baselineFailureNames: reqStringArray(value, "baselineFailureNames"),
    buildPassed: reqBoolean(value, "buildPassed"),
    testsRegressed: reqBoolean(value, "testsRegressed"),
    reviewers,
    status,
    rounds: reqInt(value, "rounds"),
    unresolvedCriticals: reqFindingArray(value, "unresolvedCriticals"),
    warnings: reqFindingArray(value, "warnings"),
    implementationSummary: reqString(value, "implementationSummary"),
    testsRun: reqStringArray(value, "testsRun"),
    filesChanged: reqStringArray(value, "filesChanged"),
    residualRisks: reqStringArray(value, "residualRisks"),
    originalRequest: reqString(value, "originalRequest"),
    testChanges: optTestChanges(value, "testChanges"),
  };
}

export function finalizableProblems(result: LoopResult): string[] {
  const problems: string[] = [];
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION) {
    problems.push(`schemaVersion is ${result.schemaVersion}, expected ${RESULT_SCHEMA_VERSION}`);
  }
  if (result.reviewers !== "PASS") problems.push(`reviewers is ${result.reviewers}, expected PASS`);
  if (result.status !== "completed") problems.push(`status is ${result.status}, expected completed`);
  if (result.buildPassed !== true) problems.push("buildPassed is false");
  if (result.testsRegressed !== false) problems.push("testsRegressed is true");
  if (result.unresolvedCriticals.length !== 0) {
    problems.push(`unresolvedCriticals holds ${result.unresolvedCriticals.length} finding(s)`);
  }
  const misfiled = result.warnings.filter((w) => w.severity === "critical");
  if (misfiled.length) {
    problems.push(
      `warnings holds ${misfiled.length} finding(s) with severity "critical" (first: ${JSON.stringify(misfiled[0]?.title ?? "")}); a critical belongs in unresolvedCriticals, which this gate requires to be empty`,
    );
  }
  if (!Number.isInteger(result.baselineFailures) || result.baselineFailures < 0) {
    problems.push(`baselineFailures is ${result.baselineFailures}, expected an integer >= 0`);
  }
  if (!Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > MAX_ROUNDS) {
    problems.push(`rounds is ${result.rounds}, expected an integer between 1 and ${MAX_ROUNDS}`);
  }
  if (result.testsRun.length === 0) {
    problems.push("testsRun is empty; the build and test commands actually run must be recorded");
  }
  if (result.baselineFailures > 0 && result.baselineFailureNames.length === 0) {
    problems.push(
      `baselineFailures is ${result.baselineFailures} but baselineFailureNames is empty; a carried failure has to be named to be checkable on the base branch`,
    );
  }
  return problems;
}

export function resultPath(loopDir: string): string {
  return path.join(loopDir, "result.json");
}

export function roundBuildLogName(round: number): string {
  return `round-${round}-build.log`;
}

export function roundTestLogName(round: number): string {
  return `round-${round}-test.log`;
}

function logContract(round: number): string {
  return (
    `the loop directory must hold ${roundBuildLogName(round)} and ${roundTestLogName(round)} ` +
    "(round N is the `rounds` value in result.json), each a regular file with content"
  );
}

function readRoundLog(dir: string, name: string, round: number): Buffer {
  const file = path.join(dir, name);
  const refuse = (why: string): OperatorError =>
    new OperatorError(`loop dir has no persisted round build/test logs: ${name} ${why}. To finalize, ${logContract(round)}`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw refuse(`is missing from ${dir}`);
  }
  if (st.isSymbolicLink()) {
    throw refuse("is a symlink; the gate reads regular files only, so a log cannot be a pointer at one outside the loop directory");
  }
  if (!st.isFile()) throw refuse("is not a regular file");
  if (st.size === 0) throw refuse("is empty");
  return fs.readFileSync(file);
}

/**
 * Existence and integrity only — the parent owns `buildPassed` / `testsRegressed`
 * after reading these logs. Returns the digest binding the run to the logs it gated on.
 */
export function verifyRoundLogs(dir: string, result: LoopResult): string {
  const round = result.rounds;
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    throw new OperatorError(
      `result records rounds=${result.rounds}, which names no writer round whose logs could be read; expected an integer between 1 and ${MAX_ROUNDS}`,
    );
  }
  const buildName = roundBuildLogName(round);
  const testName = roundTestLogName(round);
  const build = readRoundLog(dir, buildName, round);
  const test = readRoundLog(dir, testName, round);
  return sha256([`${buildName} ${sha256(build)}`, `${testName} ${sha256(test)}`].join("\n"));
}

export function readResultBytes(dir: string): { bytes: Buffer; result: LoopResult } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resultPath(dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperatorError(
        `loop dir has no result.json in ${dir}; the parent must persist the Stage 4 result document there before the run can be completed or finalized`,
      );
    }
    throw e;
  }
  return { bytes, result: parseLoopResult(JSON.parse(bytes.toString("utf8"))) };
}

export function writeResult(dir: string, result: LoopResult): void {
  writeJsonAtomic(resultPath(dir), result);
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw e;
  }
}

export function commitMessage(summary: string): string {
  const line = summary.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const clipped = line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
  if (!clipped) throw new OperatorError("implementationSummary has no text to use as a commit message");
  return clipped;
}
