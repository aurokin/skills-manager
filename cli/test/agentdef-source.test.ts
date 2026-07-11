// AUR-616 deliverable 1: agent-definition source discovery + YAML 1.1 loading.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadAgentDefinitionFromDir, parseAgentYaml } from "../src/agentdef/source";
import { makeAgentDef, makeRoot, makeSandbox, type Sandbox } from "./util";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

describe("parseAgentYaml — YAML 1.1 semantics for PyYAML parity", () => {
  test("yes/no/on/off load as booleans, not strings", () => {
    const parsed = parseAgentYaml("a: yes\nb: no\nc: on\nd: off\n") as Record<string, unknown>;
    expect(parsed).toEqual({ a: true, b: false, c: true, d: false });
  });

  test("a definition using yes/no booleans validates as booleans", () => {
    // cursor.readonly is a boolean field; `yes` must reach the schema AS a boolean.
    const def = loadDefFrom(
      "name: yn\ndescription: yes/no booleans\ncursor:\n  readonly: yes\n",
    );
    expect(def.cursor.readonly).toBe(true);
  });
});

describe("known accepted divergence — float-valued ints", () => {
  test("12.0 is accepted in an int field where PyYAML would reject it", () => {
    // JS has no int/float distinction: `12.0` parses to the number 12, so the int
    // validator accepts it. PyYAML's int resolver rejects `12.0`. Documented at the
    // loader; skm's TS behavior is asserted here.
    const def = loadDefFrom(
      "name: fl\ndescription: float-valued int\nclaude:\n  max_turns: 12.0\n",
    );
    expect(def.claude.maxTurns).toBe(12);
  });
});

describe("loadAgentDefinitionFromDir", () => {
  test("reads agent.yaml + instructions.md and validates", () => {
    sb = makeSandbox();
    const root = makeRoot(sb, "public");
    const dir = makeAgentDef(root.path, "reviewer", {
      agentYaml: { description: "A reviewer.", export: "agent" },
      instructions: "Review carefully.\n",
    });
    const def = loadAgentDefinitionFromDir(dir);
    expect(def.name).toBe("reviewer");
    expect(def.export).toBe("agent");
    expect(def.instructions).toBe("Review carefully.\n");
  });
});

/** Write a raw agent.yaml (+ trivial instructions) into a temp dir and load it. */
function loadDefFrom(rawYaml: string) {
  sb = makeSandbox();
  const dir = path.join(sb.base, "def");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), rawYaml);
  fs.writeFileSync(path.join(dir, "instructions.md"), "body\n");
  return loadAgentDefinitionFromDir(dir);
}
