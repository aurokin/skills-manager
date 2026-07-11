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
