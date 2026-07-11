// AUR-616 deliverable 7: explain surfaces the artifact type for both artifact types.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadContext } from "../src/context";
import { explainSkill } from "../src/explain";
import {
  type Sandbox,
  makeAgentDef,
  makeRoot,
  makeSandbox,
  makeSkill,
  writeMachineConfig,
} from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

test("explain resolves an agent definition and reports artifactType agent-def", () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  const c = loadContext(sb.env);
  const e = explainSkill(sb.env, c.config, c.registry, c.desired, c.state, "rev");
  expect(e.artifactType).toBe("agent-def");
  expect(e.placements.every((p) => p.artifactType === "agent-def" && p.kind === "rendered-file")).toBe(true);
  expect(e.placements.map((p) => p.agent).sort()).toEqual(["claude-code", "codex"]);
});

test("explain resolves an export:skill definition by its DERIVED skill name", () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "helper-src", {
    agentYaml: { export: "skill", skill: { name: "helper" } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  const c = loadContext(sb.env);
  // The managed artifact lives under the DERIVED name 'helper', not the def name.
  const e = explainSkill(sb.env, c.config, c.registry, c.desired, c.state, "helper");
  expect(e.placements.length).toBeGreaterThan(0);
  expect(e.placements.every((p) => p.derived)).toBe(true);
});

test("explain reports a native skill as artifactType skill", () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "s");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  const c = loadContext(sb.env);
  const e = explainSkill(sb.env, c.config, c.registry, c.desired, c.state, "s");
  expect(e.artifactType).toBe("skill");
});
