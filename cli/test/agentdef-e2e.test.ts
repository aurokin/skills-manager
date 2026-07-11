// AUR-616 deliverables 2-6: agent definitions through resolve → plan → apply,
// derived skills (render-only), export modes, cross-type collision, apply safety,
// and type-qualified state keys. Sandboxed; never touches the real machine.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentDefFileHash, renderAgentDefFile } from "../src/agentdef/artifact";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { buildPlan, runPlan } from "../src/plan";
import { computeDrift } from "../src/status";
import { loadState } from "../src/state";
import type { VerbOptions } from "../src/types";
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

function homePath(...parts: string[]): string {
  return path.join(sb.home, ...parts);
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function ctx() {
  return loadContext(sb.env);
}
function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

// ── export: agent — one rendered file per enabled+supported harness ────────────

describe("export: agent", () => {
  test("materializes rendered-file agent defs into each harness agentDefDir (created on demand)", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "plan-reviewer", {
      agentYaml: { description: "Reviews plans.", export: "agent" },
      instructions: "Review the plan.\n",
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex", "opencode"] });

    // agentDefDirs do not pre-exist in the sandbox — apply must create them.
    expect(exists(homePath(".claude/agents"))).toBe(false);

    const outcome = await runApply(sb.env, opts());
    expect(outcome.exitCode).toBe(0);

    const claudeFile = homePath(".claude/agents/plan-reviewer.md");
    const codexFile = homePath(".codex/agents/plan-reviewer.toml");
    const opencodeFile = homePath(".config/opencode/agent/plan-reviewer.md");
    expect(fs.lstatSync(claudeFile).isFile()).toBe(true);
    expect(fs.lstatSync(codexFile).isFile()).toBe(true);
    expect(fs.lstatSync(opencodeFile).isFile()).toBe(true);

    // Byte-for-byte the AUR-615 dialect render.
    expect(fs.readFileSync(claudeFile, "utf8")).toBe(renderAgentDefFile(src, "claude"));
    expect(fs.readFileSync(codexFile, "utf8")).toBe(renderAgentDefFile(src, "codex"));

    // Type-qualified state key, rendered-file placements.
    const state = loadState(sb.env);
    expect(Object.keys(state.artifacts)).toEqual(["agent-def:plan-reviewer"]);
    const placements = state.artifacts["agent-def:plan-reviewer"]!.placements;
    expect(placements.every((p) => p.kind === "rendered-file")).toBe(true);
    expect(state.artifacts["agent-def:plan-reviewer"]!.type).toBe("agent-def");
  });

  test("re-apply is idempotent (all noop)", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sb.env, opts());

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
  });

  test("plan tags agent-def actions with artifactType and rendered-file kind", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const action = plan.actions.find((a) => a.skill === "rev");
    expect(action?.placement.artifactType).toBe("agent-def");
    expect(action?.placement.kind).toBe("rendered-file");
  });
});

// ── harness scoping (deny is a hard guarantee) ────────────────────────────────

test("harness.exclude keeps the agent def out of the denied harness's dir", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "no-codex", {
    agentYaml: { export: "agent", harness: { exclude: ["codex"] } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex", "opencode"] });
  await runApply(sb.env, opts());

  expect(exists(homePath(".codex/agents/no-codex.toml"))).toBe(false);
  expect(exists(homePath(".claude/agents/no-codex.md"))).toBe(true);
  expect(exists(homePath(".config/opencode/agent/no-codex.md"))).toBe(true);
});

// Oracle parity: an agent export whose harness.include is a skill-surface keyword
// (claude-skills) must place NOTHING — the keyword is stripped for agent exports.
test("export: agent with a skill-surface include keyword places no agent-def file", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "surface", {
    agentYaml: { export: "agent", harness: { include: ["claude-skills"] } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  expect(exists(homePath(".claude/agents/surface.md"))).toBe(false);
  expect(exists(homePath(".codex/agents/surface.toml"))).toBe(false);
  expect(loadState(sb.env).artifacts["agent-def:surface"]).toBeUndefined();
});

// $COPILOT_HOME relocates the copilot agent-def dir (oracle parity); the
// hardcoded ~/.copilot dir must NOT be written.
test("copilot agent-def dir relocates with $COPILOT_HOME", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["github-copilot"] });

  const copilotHome = path.join(sb.base, "opt-copilot");
  const env = { ...sb.env, copilotHome };
  await runApply(env, opts());

  expect(exists(path.join(copilotHome, "agents", "rev.agent.md"))).toBe(true);
  expect(exists(homePath(".copilot/agents/rev.agent.md"))).toBe(false);
});

// ── export: skill — derived skills are render-only everywhere ──────────────────

describe("export: skill (derived skill)", () => {
  test("renders independent SKILL.md dirs (never symlinks) under the skill namespace", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "helper-agent", {
      agentYaml: {
        export: "skill",
        skill: { name: "review-helper", title: "Review Helper", description: "Use when reviewing." },
      },
      instructions: "Review the patch.\n",
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sb.env, opts());

    const shared = homePath(".agents/skills/review-helper");
    const claude = homePath(".claude/skills/review-helper");
    // Render-only: both are real directories, NOT symlinks (no source SKILL.md).
    for (const p of [shared, claude]) {
      expect(fs.lstatSync(p).isDirectory()).toBe(true);
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(p, "SKILL.md"), "utf8")).toContain("# Review Helper");
    }

    const state = loadState(sb.env);
    expect(Object.keys(state.artifacts)).toEqual(["skill:review-helper"]);
    expect(state.artifacts["skill:review-helper"]!.placements.every((p) => p.kind === "rendered")).toBe(true);
  });
});

// Oracle parity: an UNSCOPED export:skill def must NOT reach hermes on machine
// enablement alone — the per-def hermes-skills opt-in is also required.
test("unscoped export: skill does not reach hermes without the per-def opt-in", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "helper-agent", {
    agentYaml: { export: "skill", skill: { name: "review-helper" } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "hermes"] });
  await runApply(sb.env, opts());

  // shared + claude get the derived skill; hermes does NOT (no opt-in).
  expect(exists(homePath(".agents/skills/review-helper"))).toBe(true);
  expect(exists(homePath(".claude/skills/review-helper"))).toBe(true);
  expect(exists(homePath(".hermes/skills/review-helper"))).toBe(false);
  const placements = loadState(sb.env).artifacts["skill:review-helper"]!.placements;
  expect(placements.some((p) => p.agent === "hermes")).toBe(false);
});

// ── derived skill hermes opt-in (add-only, gated by enablement) ───────────────

test("hermes-skills opt-in places a derived skill into hermes (add-only, never pruned)", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "helper-agent", {
    agentYaml: {
      export: "skill",
      skill: { name: "review-helper" },
      harness: { include: ["claude", "hermes-skills"] },
    },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "hermes"] });
  await runApply(sb.env, opts());

  const hermesDir = homePath(".hermes/skills/review-helper");
  expect(fs.lstatSync(hermesDir).isDirectory()).toBe(true);

  // Drop the definition; hermes placement is add-only and survives --prune.
  fs.rmSync(path.join(root.path, "agents", "helper-agent"), { recursive: true });
  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.actions.filter((a) => a.type === "prune").map((a) => a.placement.agent)).not.toContain("hermes");
  await runApply(sb.env, opts({ prune: true }));
  expect(exists(hermesDir)).toBe(true);
  expect(exists(homePath(".claude/skills/review-helper"))).toBe(false);
});

// ── export: none — resolved but placed nowhere ────────────────────────────────

test("export: none resolves the def but places nothing", async () => {
  const root = makeRoot(sb, "public");
  makeAgentDef(root.path, "ghost", { agentYaml: { export: "none" } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  const c = ctx();
  // Resolved (present in desired state) …
  expect(c.desired.agentDefs.map((d) => d.name)).toEqual(["ghost"]);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  // … but no actions.
  expect(plan.actions.length).toBe(0);

  await runApply(sb.env, opts());
  expect(loadState(sb.env).artifacts).toEqual({});
});

// ── privacy guard applies to agents/ sources exactly as to skills ────────────

test("refuses to render a private agent def inside a non-allowlisted git worktree", async () => {
  execFileSync("git", ["-C", sb.home, "init", "-q"]);
  execFileSync("git", ["-C", sb.home, "remote", "add", "origin", "git@github.com:someone/secret.git"]);

  const priv = makeRoot(sb, "private-root", "private");
  makeAgentDef(priv.path, "secret-agent", { agentYaml: { export: "agent" } });
  writeMachineConfig(sb, {
    version: 1,
    roots: [priv],
    agents: ["claude-code", "codex"],
    privateOriginAllowlist: [],
  });

  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.unsafe.length).toBeGreaterThan(0);
  expect(plan.unsafe.every((u) => u.skill === "secret-agent")).toBe(true);
  expect(plan.actions.some((a) => a.type === "create")).toBe(false);

  await runApply(sb.env, opts());
  expect(exists(homePath(".claude/agents/secret-agent.md"))).toBe(false);
});

// ── cross-type collision — hard-fail before any mutation ──────────────────────

test("a derived skill colliding with a native skill hard-fails the plan", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "review-helper"); // native skill
  makeAgentDef(root.path, "dupe", {
    agentYaml: { export: "skill", skill: { name: "review-helper" } }, // same normalized name
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

  await expect(runPlan(sb.env, opts())).rejects.toThrow(
    /derived skill 'review-helper'.*collides with native skill 'review-helper'/,
  );
  // Deterministic: nothing was written.
  expect(loadState(sb.env).artifacts).toEqual({});
});

// ── apply safety: hand-edited + foreign agent-def files ───────────────────────

describe("apply safety (rendered-file)", () => {
  test("a hand-edited owned agent-def file is reported and never overwritten", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    const file = homePath(".claude/agents/rev.md");
    fs.writeFileSync(file, "hand edited\n");

    // status reports it modified …
    let c = ctx();
    const drift = computeDrift(sb.env, c.config, c.registry, c.desired, c.state);
    expect(drift.find((d) => d.skill === "rev")?.drift).toBe("modified");

    // … and plan refuses to overwrite it (warned, not a create).
    c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.warnings.some((w) => w.kind === "modified" && w.skill === "rev")).toBe(true);
    await runApply(sb.env, opts());
    expect(fs.readFileSync(file, "utf8")).toBe("hand edited\n");
  });

  test("a foreign file squatting the agent-def target is preserved", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const file = homePath(".claude/agents/rev.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not mine\n");

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.foreign.some((f) => f.path === file)).toBe(true);
    await runApply(sb.env, opts());
    expect(fs.readFileSync(file, "utf8")).toBe("not mine\n");
    expect(loadState(sb.env).artifacts["agent-def:rev"]).toBeUndefined();
  });

  test("a hand-edited owned agent-def file is preserved (not pruned) when its def is removed", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    // User hand-edits the owned rendered-file, then the def is dropped from source.
    const file = homePath(".claude/agents/rev.md");
    fs.writeFileSync(file, "hand edited\n");
    fs.rmSync(path.join(root.path, "agents", "rev"), { recursive: true });

    // Prune must classify the edited file as foreign (isFile branch) → preserve it.
    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const outcome = await runApply(sb.env, opts({ prune: true }));

    expect(fs.readFileSync(file, "utf8")).toBe("hand edited\n");
    expect(outcome.exitCode).toBe(2); // foreign refusal → non-convergence
    // skm stops managing the detached placement.
    expect(loadState(sb.env).artifacts["agent-def:rev"]).toBeUndefined();
    expect(plan.actions.some((a) => a.type === "prune" && a.skill === "rev")).toBe(true);
  });

  test("prunes an agent-def file when its definition is removed (with --prune)", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    const file = homePath(".claude/agents/rev.md");
    expect(exists(file)).toBe(true);

    fs.rmSync(path.join(root.path, "agents", "rev"), { recursive: true });
    await runApply(sb.env, opts({ prune: true }));
    expect(exists(file)).toBe(false);
    expect(loadState(sb.env).artifacts["agent-def:rev"]).toBeUndefined();
  });

  test("adopts a pre-existing correct agent-def file without a rewrite", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const file = homePath(".claude/agents/rev.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderAgentDefFile(src, "claude"));

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.find((a) => a.skill === "rev")?.type).toBe("adopt");

    await runApply(sb.env, opts());
    const owned = loadState(sb.env).artifacts["agent-def:rev"]!.placements[0]!;
    expect(owned.hash).toBe(agentDefFileHash(src, "claude"));
  });
});

// ── plan hand-edit remediation messages (accurate per artifact type) ───────────

describe("plan hand-edit warning remediation", () => {
  test("agent-def file: warning points to remove-and-reapply, NOT doctor --fix", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    fs.writeFileSync(homePath(".claude/agents/rev.md"), "hand edited\n");

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const w = plan.warnings.find((x) => x.kind === "modified" && x.skill === "rev");
    expect(w).toBeDefined();
    expect(w!.message).toContain("remove it and re-apply");
    expect(w!.message).not.toContain("doctor --fix"); // doctor cannot re-render agent-def files
  });

  test("derived skill: warning points to remove-and-reapply, NOT doctor --fix", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "helper-src", {
      agentYaml: { export: "skill", skill: { name: "review-helper" } },
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    fs.writeFileSync(homePath(".claude/skills/review-helper/SKILL.md"), "hand edited garbage\n");

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const w = plan.warnings.find((x) => x.kind === "modified" && x.skill === "review-helper");
    expect(w).toBeDefined();
    expect(w!.message).toContain("remove it and re-apply");
    expect(w!.message).not.toContain("doctor --fix"); // applyFixes skips derived skills
  });

  test("native rendered skill: warning still promises doctor --fix (accurate for natives)", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "r", { agentsYaml: { claude: { model: "opus" } } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    fs.writeFileSync(homePath(".claude/skills/r/SKILL.md"), "hand edited garbage\n");

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const w = plan.warnings.find((x) => x.kind === "modified" && x.skill === "r");
    expect(w).toBeDefined();
    expect(w!.message).toContain("doctor --fix re-renders");
  });
});
