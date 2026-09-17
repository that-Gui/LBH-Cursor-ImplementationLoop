import { completeRun, finalizeRepo, prepareRun } from "./finalize.ts";
import { OperatorError, redact } from "./git.ts";

const USAGE = [
  "usage: tsx src/cli.ts <prepare|complete|finalize> --loop-dir DIR [--repo-dir DIR]",
  "",
  "  prepare   write manifest.json from git (baseSha, branch, dirty snapshot)",
  "  complete  advance prepared → loop-complete after result.json and round logs pass",
  "  finalize  apply the gates, commit, push, and open or adopt the pull request",
  "",
  "  --loop-dir DIR   required: the parent scratchpad for this run",
  "  --repo-dir DIR   optional: the application repository (default: cwd)",
  "",
  "Never pass tokens on argv. `gh` uses its own login. Git identity is the",
  "repository's user.name / user.email. Agents must not run git commit or git push;",
  "this helper owns those via spawnSync.",
].join("\n");

type Command = "prepare" | "complete" | "finalize";

function argv(): string[] {
  return process.argv.slice(3);
}

function hasFlag(name: string): boolean {
  return argv().includes(name);
}

function flagValue(name: string): string | undefined {
  const args = argv();
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, help?: string): never {
  console.error(redact(message));
  if (help) console.error(help);
  process.exit(1);
}

function die(e: unknown): never {
  if (e instanceof OperatorError) fail(e.message);
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(redact(message));
  process.exit(1);
}
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

function requiredLoopDir(command: Command): string {
  const value = flagValue("--loop-dir");
  if (!value) fail(`${command} requires --loop-dir DIR`, USAGE);
  return value;
}

function repoDir(): string {
  return flagValue("--repo-dir") ?? process.cwd();
}

async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(USAGE);
    return 0;
  }
  if (sub !== "prepare" && sub !== "complete" && sub !== "finalize") {
    fail(sub ? `unknown command ${JSON.stringify(sub)}` : "no command given", USAGE);
  }
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(USAGE);
    return 0;
  }
  const command: Command = sub;
  if (command === "prepare") {
    printJson(prepareRun(requiredLoopDir(command), repoDir()));
    return 0;
  }
  if (command === "complete") {
    printJson(completeRun(requiredLoopDir(command)));
    return 0;
  }
  const outcome = await finalizeRepo(requiredLoopDir(command), flagValue("--repo-dir") ?? repoDir());
  printJson(outcome);
  return outcome.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch(die);
