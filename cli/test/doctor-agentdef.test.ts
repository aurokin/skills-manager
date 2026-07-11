// AUR-616 doctor cross-reference: an agent definition's `defaults.skills` entry
// that names a skill hidden from (deny/allow-scoped away) or absent for the harness
// the definition is placed on → a `skill-reference` warning naming agent, skill, and
// harness. Sandboxed; never touches the real machine.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { diagnose, runDoctor } from "../src/doctor";
import type { Finding, VerbOptions } from "../src/types";
import {
  type Sandbox,
  makeAgentDef,
  makeAgentScopes,
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

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}
function homePath(...p: string[]): string {
  return path.join(sb.home, ...p);
}
function diagnoseNow(): Finding[] {
  const c = loadContext(sb.env);
  return diagnose(sb.env, c.config, c.registry, c.desired, c.state);
}
function refFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.category === "skill-reference");
}

describe("doctor default-skills cross-reference", () => {
  test("warns when a default skill is absent from skm entirely", () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", {
      agentYaml: { export: "agent", defaults: { skills: ["nonexistent-skill"] } },
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const refs = refFindings(diagnoseNow());
    expect(refs).toHaveLength(1);
    expect(refs[0]!.severity).toBe("warn");
    expect(refs[0]!.skill).toBe("rev");
    expect(refs[0]!.message).toContain("nonexistent-skill");
    expect(refs[0]!.message).toContain("claude-code");
    expect(refs[0]!.message).toContain("does not manage");
  });

  test("warns when a default skill exists but is scoped away from the placed harness", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "codex-only");
    // Scope the skill to codex only → claude-code cannot see it.
    makeAgentScopes(root.path, { "codex-only": { agents: { allow: ["codex"] } } });
    makeAgentDef(root.path, "rev", {
      agentYaml: { export: "agent", defaults: { skills: ["codex-only"] } },
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const refs = refFindings(diagnoseNow());
    // Exactly one finding: hidden from claude-code (codex sees it fine).
    expect(refs).toHaveLength(1);
    expect(refs[0]!.message).toContain("codex-only");
    expect(refs[0]!.message).toContain("claude-code");
    expect(refs[0]!.message).toContain("hidden");
  });

  test("no warning when the default skill is visible to every placed harness", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "shared-skill"); // unscoped → shared, visible to all
    makeAgentDef(root.path, "rev", {
      agentYaml: { export: "agent", defaults: { skills: ["shared-skill"] } },
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    expect(refFindings(diagnoseNow())).toHaveLength(0);
  });

  test("a derived skill counts as a known skill (no absent warning)", () => {
    const root = makeRoot(sb, "public");
    // An export:skill def producing the derived skill 'helper'.
    makeAgentDef(root.path, "helper-src", {
      agentYaml: { export: "skill", skill: { name: "helper" } },
    });
    // An export:agent def that wants that derived skill by name.
    makeAgentDef(root.path, "rev", {
      agentYaml: { export: "agent", defaults: { skills: ["helper"] } },
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // 'helper' is unscoped (shared+claude) → visible to claude-code → no warning.
    expect(refFindings(diagnoseNow())).toHaveLength(0);
  });
});

// ── rendered-file (agent-def) drift branches ──────────────────────────────────

describe("doctor agent-def rendered-file drift", () => {
  test("reports a broken-link error when an owned agent-def file is missing", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    fs.unlinkSync(homePath(".claude/agents/rev.md"));

    const f = diagnoseNow().find((x) => x.category === "broken-link" && x.skill === "rev");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toContain("missing");
    expect(f!.fixable).toBe(false);
  });

  test("reports a broken-link error when a DIR replaces an owned agent-def file", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    const file = homePath(".claude/agents/rev.md");
    fs.unlinkSync(file);
    fs.mkdirSync(file); // a directory now squats the rendered-file path

    const f = diagnoseNow().find((x) => x.category === "broken-link" && x.skill === "rev");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toContain("replaced by dir");
  });

  test("reports a broken-link error when a SYMLINK replaces an owned agent-def file", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    const file = homePath(".claude/agents/rev.md");
    fs.unlinkSync(file);
    fs.symlinkSync(homePath("somewhere-else"), file); // symlink squats the path

    const f = diagnoseNow().find((x) => x.category === "broken-link" && x.skill === "rev");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toContain("replaced by symlink");
  });

  test("reports a reconcile warn when an owned agent-def file is hand-edited", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    fs.writeFileSync(homePath(".claude/agents/rev.md"), "hand edited\n");

    const f = diagnoseNow().find((x) => x.category === "reconcile" && x.skill === "rev");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.message).toContain("hand-edited");
    expect(f!.fixable).toBe(false);
  });
});

// ── derived-skill drift is reported but NOT fixable by --fix ───────────────────

test("a hand-edited derived skill is reported non-fixable and --fix does not repair it", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "helper-agent", {
    agentYaml: {
      export: "skill",
      skill: { name: "review-helper", title: "Review Helper", description: "Use when reviewing." },
    },
    instructions: "Review the patch.\n",
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  await runApply(sb.env, opts());

  const md = homePath(".claude/skills/review-helper/SKILL.md");
  fs.writeFileSync(md, "hand edited garbage\n");

  // Reported as a reconcile warn that is NOT fixable — applyFixes skips derived.
  const before = diagnoseNow().find((f) => f.category === "reconcile" && f.skill === "review-helper");
  expect(before).toBeDefined();
  expect(before!.severity).toBe("warn");
  expect(before!.fixable).toBe(false);

  // --fix leaves the derived skill untouched; the warning persists.
  await runDoctor(sb.env, opts({ fix: true }));
  expect(fs.readFileSync(md, "utf8")).toBe("hand edited garbage\n");
  const after = diagnoseNow().find((f) => f.category === "reconcile" && f.skill === "review-helper");
  expect(after).toBeDefined();
});
