import path from "node:path";
import { OperatorError } from "./git.ts";
import type { TestChange } from "./result.ts";

export const ARTIFACT_DIRS = ["bin", "obj", "TestResults", "node_modules", "coverage", "dist"] as const;
export const ARTIFACT_PATH = new RegExp(`(^|/)(${ARTIFACT_DIRS.join("|")})/|\\.binlog$`, "i");
export const FORBIDDEN_PATH =
  /(^|\/)(\.github|\.claude|\.cursor|\.ssh)\/|(^|\/)(\.gitattributes|\.gitmodules|\.npmrc|\.netrc|\.envrc)$|(^|\/)\.env(\.|$)/;

export function isArtifactPath(p: string): boolean {
  return ARTIFACT_PATH.test(p);
}

export function isForbiddenPath(p: string): boolean {
  return FORBIDDEN_PATH.test(p);
}

const TEST_FILE_NAME = /^(test_|.*_test\.|.*\.test\.|.*\.spec\.|.*Tests\.)/i;
const TEST_FILE_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_SEGMENT = /^(tests?|specs?|__tests__)$/i;
const TEST_SOURCE = /\.([cm]?[jt]sx?|py|cs|java|go|rb|php)$/i;

export function isTestPath(file: string): boolean {
  const segments = file.split(/[\\/]/);
  const name = segments.pop() ?? "";
  if (TEST_FILE_SUFFIX.test(name) || TEST_FILE_NAME.test(name)) return true;
  return segments.some((seg) => TEST_SEGMENT.test(seg));
}

function isTestSource(file: string): boolean {
  return isTestPath(file) && TEST_SOURCE.test(file);
}

const GIT_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/** Git quotes a path with non-ASCII bytes; a quoted path matches no gate until unquoted. */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const rest = body.slice(i + 1);
    if (rest === "") break;
    const octal = /^[0-7]{1,3}/.exec(rest)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const escaped = rest[0] as string;
    bytes.push(...Buffer.from(GIT_ESCAPES[escaped] ?? escaped, "utf8"));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

type LinePattern = { token: string; pattern: RegExp };

export const TEST_WEAKENING_ADDED_PATTERNS: readonly LinePattern[] = [
  { token: "Skip =", pattern: /\bSkip\s*=(?![=>])/i },
  { token: "[Ignore]", pattern: /\[\s*Ignore\s*[\](,]/i },
  { token: "Assert.Inconclusive", pattern: /\bAssert\s*\.\s*Inconclusive\b/i },
  { token: "xit", pattern: /\bxit\s*\(/ },
  { token: "xdescribe", pattern: /\bxdescribe\s*\(/ },
  { token: "it.skip", pattern: /\bit\.skip\b/ },
  { token: "test.skip", pattern: /\btest\.skip\b/ },
  { token: "describe.skip", pattern: /\bdescribe\.skip\b/ },
  { token: "pytest.mark.skip", pattern: /\bpytest\.mark\.skip\b/ },
];

type DiffSection = {
  source?: string;
  target?: string;
  deleted?: string;
  renamed: boolean;
  added: string[];
  removed: string[];
};

function diffPath(header: string): string | undefined {
  const raw = unquoteGitPath(header.slice(4).split("\t")[0]?.trim() ?? "");
  if (!raw || raw === "/dev/null") return undefined;
  return /^[ab]\//.test(raw) ? raw.slice(2) : raw;
}

function renamePath(raw: string): string | undefined {
  const file = unquoteGitPath(raw.trim());
  return file === "" ? undefined : file;
}

export function parseDiffSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | undefined;
  let preamble = false;
  let header = false;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      current = { renamed: false, added: [], removed: [] };
      sections.push(current);
      preamble = true;
      header = false;
      continue;
    }
    if (!current) continue;
    if (preamble && raw.startsWith("rename from ")) {
      current.source = renamePath(raw.slice("rename from ".length));
      current.renamed = true;
      continue;
    }
    if (preamble && raw.startsWith("rename to ")) {
      current.target = renamePath(raw.slice("rename to ".length));
      current.renamed = true;
      continue;
    }
    if (preamble && raw.startsWith("deleted file mode")) {
      current.deleted = raw;
      continue;
    }
    if (preamble && raw.startsWith("--- ")) {
      current.source = diffPath(raw);
      header = true;
      continue;
    }
    if (header && raw.startsWith("+++ ")) {
      current.target = diffPath(raw);
      preamble = false;
      header = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      preamble = false;
      header = false;
      continue;
    }
    if (preamble) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) current.added.push(raw.slice(1));
    else if (raw.startsWith("-") && !raw.startsWith("---")) current.removed.push(raw.slice(1));
  }
  return sections;
}

export type TestWeakening = { file: string; line: string; token: string };

const MAX_TEST_WEAKENINGS = 50;
const MAX_TEST_WEAKENING_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function introduced(added: string[], removed: string[], patterns: readonly LinePattern[]): { token: string; line: string }[] {
  const hits: { token: string; line: string }[] = [];
  for (const p of patterns) {
    const addedHits = added.filter((l) => p.pattern.test(l));
    const removedHits = removed.filter((l) => p.pattern.test(l));
    if (addedHits.length > removedHits.length) {
      hits.push({ token: p.token, line: addedHits[0] ?? "" });
    }
  }
  return hits;
}

export function findTestWeakening(
  diff: string,
  ignoreFile: (file: string) => boolean = () => false,
): TestWeakening[] {
  const found: TestWeakening[] = [];
  const report = (file: string, content: string, token: string): void => {
    found.push({ file, line: clip(content, MAX_TEST_WEAKENING_CHARS), token });
  };
  const gated = (file: string | undefined): string | undefined =>
    file !== undefined && isTestPath(file) && !ignoreFile(file) ? file : undefined;

  for (const section of parseDiffSections(diff)) {
    const { source, target } = section;
    const file = target ?? source;
    if (file === undefined) continue;

    const base = gated(source);
    if (base !== undefined) {
      if (section.deleted !== undefined) {
        report(base, section.deleted, "deleted test file");
        continue;
      }
      if (section.renamed && target !== undefined && target !== base && !isTestPath(target)) {
        report(base, `${base} -> ${target}`, "test file moved out of the test suite");
        continue;
      }
    }

    const added = gated(target);
    if (added !== undefined && isTestSource(added)) {
      for (const hit of introduced(section.added, section.removed, TEST_WEAKENING_ADDED_PATTERNS)) {
        report(added, hit.line, hit.token);
      }
    }
  }
  return found.slice(0, MAX_TEST_WEAKENINGS);
}

function testChangePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function unjustifiedTestWeakening(weakenings: TestWeakening[], changes: TestChange[]): TestWeakening[] {
  const justified = new Set(changes.filter((c) => c.reason.trim() !== "").map((c) => testChangePath(c.file)));
  return weakenings.filter((w) => !justified.has(testChangePath(w.file)));
}

export function resolveExistingDir(dir: string, flag: string): string {
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) throw new OperatorError(`${flag} must resolve to an absolute path`);
  return resolved;
}
