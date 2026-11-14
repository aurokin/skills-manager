// Regression: `skm apply --plan` with no operand must be a usage error (exit 1),
// never a silent fall-through to the fresh-plan path — otherwise `apply --plan`
// runs an UNreviewed plan against disk (finding 3).

import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli";
import { UsageError } from "../src/errors";

test("apply --plan with no operand is a usage error, not a silent fresh plan", () => {
  expect(() => parseArgs(["apply", "--plan"])).toThrow(UsageError);
  expect(() => parseArgs(["apply", "--plan"])).toThrow(/--plan requires/);
});

test("apply --plan= (empty value) is a usage error", () => {
  expect(() => parseArgs(["apply", "--plan="])).toThrow(/--plan requires/);
});

test("apply --plan immediately followed by another flag does not consume the flag", () => {
  // Without the guard, `--plan --json` would set planFile="--json" and silently
  // take a bogus path (or the fresh path). It must be rejected.
  expect(() => parseArgs(["apply", "--plan", "--json"])).toThrow(/--plan requires/);
});

test("apply --plan <file> still parses a real path", () => {
  const { verb, opts } = parseArgs(["apply", "--plan", "/tmp/reviewed.json"]);
  expect(verb).toBe("apply");
  expect(opts.planFile).toBe("/tmp/reviewed.json");
});

test("apply --plan=<file> parses the inline form", () => {
  const { opts } = parseArgs(["apply", "--plan=/tmp/reviewed.json"]);
  expect(opts.planFile).toBe("/tmp/reviewed.json");
});

test("adopt custom-agents --agents-home <dir> parses the verb, subcommand, and flag", () => {
  const { verb, opts } = parseArgs(["adopt", "custom-agents", "--agents-home", "/repo/agents"]);
  expect(verb).toBe("adopt");
  expect(opts.args).toEqual(["custom-agents"]);
  expect(opts.agentsHome).toBe("/repo/agents");
});

test("adopt --agents-home=<dir> parses the inline form", () => {
  const { opts } = parseArgs(["adopt", "custom-agents", "--agents-home=/repo/agents"]);
  expect(opts.agentsHome).toBe("/repo/agents");
});

test("--agents-home with no operand is a usage error", () => {
  expect(() => parseArgs(["adopt", "custom-agents", "--agents-home"])).toThrow(/--agents-home requires/);
  expect(() => parseArgs(["adopt", "custom-agents", "--agents-home", "--json"])).toThrow(/--agents-home requires/);
});

test("deploy parses its repeatable and value flags", () => {
  const { verb, opts } = parseArgs([
    "deploy",
    "/proj",
    "--family",
    "expo",
    "--family",
    "convex",
    "--agents",
    "claude-code codex",
    "--dry-run",
  ]);
  expect(verb).toBe("deploy");
  expect(opts.args).toEqual(["/proj"]);
  expect(opts.families).toEqual(["expo", "convex"]);
  expect(opts.agentsList).toBe("claude-code codex");
  expect(opts.dryRun).toBe(true);
});

test("deploy-only flags are rejected on other verbs (no silent dry-run on apply)", () => {
  // Regression: --dry-run must not leak to mutating verbs. It is a deploy-only flag,
  // so on any other verb it falls through to the unknown-flag guard.
  expect(() => parseArgs(["apply", "--dry-run"])).toThrow(/unknown flag: --dry-run/);
  expect(() => parseArgs(["plan", "--family", "expo"])).toThrow(/unknown flag: --family/);
  expect(() => parseArgs(["apply", "--all-families"])).toThrow(/unknown flag: --all-families/);
});

test("--no-pull is accepted on plan and apply only", () => {
  expect(parseArgs(["plan", "--no-pull"]).opts.noPull).toBe(true);
  expect(parseArgs(["apply", "--no-pull"]).opts.noPull).toBe(true);
  expect(() => parseArgs(["status", "--no-pull"])).toThrow(/unknown flag: --no-pull/);
});
