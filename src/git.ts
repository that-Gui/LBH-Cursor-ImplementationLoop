import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A failure the operator is the one to act on. The CLI prints the message alone
 * and must never print it with a stack.
 */
export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

export const GIT_TIMEOUT_MS = 10 * 60_000;
export const GH_TIMEOUT_MS = 2 * 60_000;
export const GIT_SHA = /^[0-9a-f]{7,64}$/i;
export const REPO_NAME = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
export const TOKEN_ENV_NAMES = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

export function isSafeName(name: string): boolean {
  return REPO_NAME.test(name) && name !== "." && name !== "..";
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const name of TOKEN_ENV_NAMES) {
    const v = env[name]?.trim();
    if (v) found.push(v);
  }
  return found;
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return secretsFromEnv(env).reduce((s, secret) => {
    if (!secret) return s;
    const encoded = [
      secret,
      Buffer.from(`x-access-token:${secret}`).toString("base64"),
      Buffer.from(secret).toString("base64"),
    ];
    return encoded.reduce((acc, token) => acc.replaceAll(token, "***"), s);
  }, clean);
}

function isInheritedGitEnv(key: string): boolean {
  return (
    key.startsWith("GIT_") ||
    key === "SSH_ASKPASS" ||
    key === "LD_PRELOAD" ||
    key === "LD_AUDIT" ||
    key === "DYLD_INSERT_LIBRARIES"
  );
}

/** Child env with token names stripped so they cannot leak through git traces. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (TOKEN_ENV_NAMES.has(k) || isInheritedGitEnv(k)) continue;
    next[k] = v;
  }
  return next;
}

/** Child env for `gh`: keep GH_TOKEN / GITHUB_TOKEN so developer auth still works. */
export function ghEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (isInheritedGitEnv(k)) continue;
    next[k] = v;
  }
  return next;
}

function assertDir(cwd: string): void {
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  let st: fs.Stats;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
}

export type GitRunner = (args: string[], cwd: string) => string;

export function git(args: string[], cwd: string): string {
  assertDir(cwd);
  const env: NodeJS.ProcessEnv = {
    ...childEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env,
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const verb = args[0] ?? "git";
  if (res.error) throw new Error(redact(`git ${verb}: ${res.error.message}`));
  if (res.status !== 0) throw new Error(redact(`git ${verb} failed: ${res.stderr}`));
  return res.stdout;
}

/** Like `git`, but a non-zero exit returns "" instead of throwing (for `config --get`). */
export function gitOptional(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

export type GhRunner = (args: string[], cwd: string) => string;

export function gh(args: string[], cwd: string): string {
  assertDir(cwd);
  const res = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    env: ghEnv(),
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const verb = args[0] ?? "gh";
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperatorError("gh is not installed or not on PATH; install the GitHub CLI and run `gh auth login`");
    }
    throw new Error(redact(`gh ${verb}: ${res.error.message}`));
  }
  if (res.status !== 0) {
    throw new OperatorError(redact(`gh ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`));
  }
  return res.stdout;
}

/**
 * Run `gh` and return stdout even when it exits non-zero, so the caller can
 * distinguish "PR already exists" from a hard failure.
 */
export function ghAllowFail(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  assertDir(cwd);
  const res = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    env: ghEnv(),
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperatorError("gh is not installed or not on PATH; install the GitHub CLI and run `gh auth login`");
    }
    throw new Error(redact(`gh ${args[0] ?? "gh"}: ${res.error.message}`));
  }
  return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
}

function configGet(runGit: GitRunner, key: string, repoDir: string): string {
  try {
    return runGit(["config", "--get", key], repoDir).trim();
  } catch {
    return "";
  }
}

export function requireIdentity(repoDir: string, runGit: GitRunner = git): { name: string; email: string } {
  const name = configGet(runGit, "user.name", repoDir);
  const email = configGet(runGit, "user.email", repoDir);
  if (!name || !email) {
    throw new OperatorError(
      "git user.name and user.email must be set on this repository before finalize can commit",
    );
  }
  return { name, email };
}

export function repoNameFromRemote(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, "");
  const parts = cleaned.split(/[:/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (!isSafeName(name)) {
    throw new OperatorError(`could not parse a repository name from origin URL ${JSON.stringify(url)}`);
  }
  return name;
}

export function defaultBranch(repoDir: string, runGit: GitRunner = git): string {
  let ref = "";
  try {
    ref = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir).trim();
  } catch {
    ref = "";
  }
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(ref);
  const name = m?.[1]?.trim() ?? "";
  if (name && DEFAULT_BRANCH.test(name) && !name.includes("..") && !name.startsWith("-") && !name.startsWith("/")) {
    return name;
  }
  return "main";
}

export function isBaseCommit(headSha: string, baseSha: string): boolean {
  const head = headSha.trim().toLowerCase();
  const base = baseSha.trim().toLowerCase();
  return head === base || (base.length >= 7 && head.startsWith(base));
}

export function loopDirInsideRepo(loopDir: string, repoDir: string): string | undefined {
  const rel = path.relative(path.resolve(repoDir), path.resolve(loopDir));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}
