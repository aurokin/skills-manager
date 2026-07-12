// ADR 0011: gated (user-invoked-only) skill placement + per-agent gate rendering.
// Covers the solver placement matrix (gate-honoring vs no-gate vs permissive), the
// companion emitter (exact bytes + author merge/conflict), the tree-hash content
// binding (drift on companion tamper/delete), the forced-shared-root hard error,
// overlay gating validation, and the three doctor findings.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { diagnose } from "../src/doctor";
import { GatingError } from "../src/errors";
import { gatingForSkill } from "../src/catalog";
import { gatedTreeHash, hashGatedTree, renderGatedTree, writeGatedTree } from "../src/gated";
import { loadOverlay, overlayPath } from "../src/overlay";
import { computeDesiredPlacements } from "../src/placements";
import { buildPlan } from "../src/plan";
import { loadRegistry } from "../src/registry";
import { renderSkill, treeHashOf } from "../src/render";
import { resolveDesiredState } from "../src/resolve";
import { solvePlacements } from "../src/solver";
import { loadState, saveState, upsertPlacement } from "../src/state";
import { computeDrift } from "../src/status";
import type { SkmEnv } from "../src/env";
import type { DesiredSkill, MachineConfig, Registry, VerbOptions } from "../src/types";
import {
  makeRoot,
  makeSandbox,
  makeSkill,
  realRegistryPath,
  writeMachineConfig,
  type Sandbox,
} from "./util";

const goldensDir = `${import.meta.dir}/goldens/gated`;

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

/** Build a gated DesiredSkill (the solver never touches the fs, so paths are inert). */
function gatedDesired(
  name: string,
  opts: { scoping?: DesiredSkill["scoping"]; permissive?: string[] } = {},
): DesiredSkill {
  return {
    name,
    source: { root: "public", visibility: "public", path: "/dummy" },
    scoping: opts.scoping,
    overrides: {},
    gated: true,
    ...(opts.permissive ? { gating: { permissive: opts.permissive } } : {}),
  };
}

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// Solver placement matrix
// ─────────────────────────────────────────────────────────────────────────────

const ALL_ENABLED: MachineConfig = { version: 1, roots: [] }; // default = supported-minus-hermes

describe("solveGated — placement matrix", () => {
  test("unscoped: only gate-honoring agents, each a rendered tree in its own dir", () => {
    const r = solvePlacements(gatedDesired("fleet-update"), ALL_ENABLED, reg());
    // Gate-honoring agents in the real registry (frontmatter or companion); no-gate
    // (gemini-cli, opencode) and unknown (antigravity) are excluded.
    expect(r.placements.map((p) => p.dir).sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
      "factory",
      "grok",
      "pi",
    ]);
    expect(r.placements.every((p) => p.kind === "rendered" && p.gated === true)).toBe(true);
    // Never the shared root, never a symlink.
    expect(r.placements.some((p) => p.dir === "shared")).toBe(false);
    expect(r.placements.some((p) => p.kind === "symlink")).toBe(false);
  });

  test("no-gate agents are excluded silently (not unreachable)", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "opencode"] };
    const r = solvePlacements(gatedDesired("fleet-update"), config, reg());
    expect(r.placements.map((p) => p.agent)).toEqual(["claude-code"]);
    expect(r.unreachable).toEqual([]); // opencode has no gate → dropped, not reported unreachable
  });

  test("companion-gate agent (codex) lands in its own dir as a rendered tree", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["codex"] };
    const r = solvePlacements(gatedDesired("fleet-update"), config, reg());
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.dir).toBe("codex");
    expect(r.placements[0]!.gated).toBe(true);
  });

  test("permissive override opts a no-gate agent in (its own dir)", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "gemini-cli"] };
    const r = solvePlacements(gatedDesired("fleet-update", { permissive: ["gemini-cli"] }), config, reg());
    expect(r.placements.map((p) => p.dir).sort()).toEqual(["claude", "gemini"]);
  });

  test("allow scoping intersects with gate-honoring (no-gate allowed agent dropped)", () => {
    const r = solvePlacements(
      gatedDesired("fleet-update", { scoping: { allow: ["claude-code", "opencode"] } }),
      ALL_ENABLED,
      reg(),
    );
    expect(r.placements.map((p) => p.agent)).toEqual(["claude-code"]);
  });

  test("a gate-honoring agent with no ownDir is skipped/unreachable, not a shared error", () => {
    const mutated: Registry = JSON.parse(JSON.stringify(reg()));
    delete mutated.agents["claude-code"]!.ownDir; // invalid registry shape, but no shared placement is requested
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "codex"] };
    const unscoped = solvePlacements(gatedDesired("fleet-update"), config, mutated);
    expect(unscoped.placements.map((p) => p.agent)).toEqual(["codex"]); // others still place
    expect(unscoped.unreachable).toEqual([]);
    const allowed = solvePlacements(
      gatedDesired("fleet-update", { scoping: { allow: ["claude-code", "codex"] } }),
      config,
      mutated,
    );
    expect(allowed.placements.map((p) => p.agent)).toEqual(["codex"]);
    expect(allowed.unreachable).toEqual(["claude-code"]);
  });

  test("forced shared root is a hard error (ownDir resolves to the shared dir)", () => {
    const mutated: Registry = JSON.parse(JSON.stringify(reg()));
    mutated.agents["claude-code"]!.ownDir = "shared"; // config forcing a shared root
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    expect(() => solvePlacements(gatedDesired("fleet-update"), config, mutated)).toThrow(GatingError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Companion emitter: exact bytes, author merge, conflict
// ─────────────────────────────────────────────────────────────────────────────

describe("companion (agents/openai.yaml) emission", () => {
  test("codex tree carries the forced-false companion; SKILL.md keeps disable-model-invocation", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    const tree = renderGatedTree(skill, "codex", "codex", reg());
    const golden = fs.readFileSync(`${goldensDir}/openai-companion.golden`, "utf8");
    expect(tree["agents/openai.yaml"]!.toString("utf8")).toBe(golden);
    expect(tree["SKILL.md"]!.toString("utf8")).toContain("disable-model-invocation: true");
  });

  test("frontmatter-gate agent (claude) gets NO companion, SKILL.md verbatim", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    const tree = renderGatedTree(skill, "claude-code", "claude", reg());
    expect(tree["agents/openai.yaml"]).toBeUndefined();
    expect(Object.keys(tree)).toEqual(["SKILL.md"]);
  });

  test("author-supplied openai.yaml is merged (keys preserved, flag forced false)", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { openai: { interface: { color: "blue" }, policy: { some_other: "keep" } } },
    });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: { openai: path.join(src, "agents", "openai.yaml") },
      gated: true,
    };
    const tree = renderGatedTree(skill, "codex", "codex", reg());
    const golden = fs.readFileSync(`${goldensDir}/openai-companion-merged.golden`, "utf8");
    expect(tree["agents/openai.yaml"]!.toString("utf8")).toBe(golden);
  });

  test("frontmatter override that omits the flag keeps disable-model-invocation in rendered bytes", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { model: "opus" } },
    });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: { claude: path.join(src, "agents", "claude.yaml") },
      gated: true,
    };
    const rendered = renderGatedTree(skill, "claude-code", "claude", reg())["SKILL.md"]!.toString("utf8");
    expect(rendered).toContain("disable-model-invocation: true");
    expect(rendered).toContain("model: opus"); // the merge still applied
  });

  test("frontmatter override setting disable-model-invocation: false is a hard error", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { "disable-model-invocation": false } },
    });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: { claude: path.join(src, "agents", "claude.yaml") },
      gated: true,
    };
    expect(() => renderGatedTree(skill, "claude-code", "claude", reg())).toThrow(GatingError);
  });

  test("author openai.yaml with allow_implicit_invocation: true is a hard error", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { openai: { policy: { allow_implicit_invocation: true } } },
    });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: { openai: path.join(src, "agents", "openai.yaml") },
      gated: true,
    };
    expect(() => renderGatedTree(skill, "codex", "codex", reg())).toThrow(GatingError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gated source validation
// ─────────────────────────────────────────────────────────────────────────────

describe("gated source validation", () => {
  test("a symlink inside a gated skill source is a hard error, not silent materialization", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    // A file symlink would previously be read-through and written back as a real
    // file (silently materialized); a dir/dangling one would crash the render.
    fs.symlinkSync(path.join(src, "SKILL.md"), path.join(src, "alias.md"));
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    expect(() => renderGatedTree(skill, "claude-code", "claude", reg())).toThrow(GatingError);
    expect(() => renderGatedTree(skill, "claude-code", "claude", reg())).toThrow(/symlink/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content binding: tree hash covers all files (byte-compat + drift)
// ─────────────────────────────────────────────────────────────────────────────

describe("tree-hash content binding", () => {
  test("in-memory gated tree hash equals on-disk treeHashOf", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    const tree = renderGatedTree(skill, "codex", "codex", reg());
    const target = path.join(sandbox.base, "out");
    writeGatedTree(tree, target, src);
    expect(treeHashOf(target)).toBe(hashGatedTree(tree));
    expect(gatedTreeHash(skill, "codex", "codex", reg())).toBe(hashGatedTree(tree));
  });

  test("writeGatedTree preserves source executable bits", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    fs.mkdirSync(path.join(src, "scripts"));
    fs.writeFileSync(path.join(src, "scripts", "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(src, "scripts", "run.sh"), 0o755);
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    const target = path.join(sandbox.base, "out");
    writeGatedTree(renderGatedTree(skill, "codex", "codex", reg()), target, src);
    expect(fs.statSync(path.join(target, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    // The generated companion has no source counterpart; default mode, not executable.
    expect(fs.statSync(path.join(target, "agents", "openai.yaml")).mode & 0o111).toBe(0);
  });

  test("computeDesiredPlacements binds the full-tree hash on gated placements", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    const c = loadContext(sandbox.env);
    const gated = computeDesiredPlacements(sandbox.env, c.config, c.registry, c.desired).placements
      .filter((dp) => dp.skill === "fleet-update");
    expect(gated).toHaveLength(2);
    expect(gated.every((dp) => dp.placement.gated && dp.placement.kind === "rendered" && dp.placement.hash?.startsWith("sha256:"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end apply + drift
// ─────────────────────────────────────────────────────────────────────────────

describe("apply + drift", () => {
  test("apply materializes rendered trees + companion; re-plan is a noop; status clean", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    await runApply(sandbox.env, opts());

    const codexSkill = path.join(sandbox.home, ".codex/skills/fleet-update");
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");
    expect(fs.existsSync(path.join(codexSkill, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexSkill, "agents", "openai.yaml"))).toBe(true);
    // Both placements are real dirs (rendered), never symlinks.
    expect(fs.lstatSync(codexSkill).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(claudeSkill).isSymbolicLink()).toBe(false);
    // claude (frontmatter gate) gets no companion.
    expect(fs.existsSync(path.join(claudeSkill, "agents", "openai.yaml"))).toBe(false);

    // State records gated + full-tree hash.
    const state = loadState(sandbox.env);
    const artifact = state.artifacts["skill:fleet-update"]!;
    expect(artifact.placements.every((p) => p.gated && p.tree?.startsWith("sha256:"))).toBe(true);

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("a tampered companion shows as modified drift", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });
    await runApply(sandbox.env, opts());

    const companion = path.join(sandbox.home, ".codex/skills/fleet-update/agents/openai.yaml");
    fs.writeFileSync(companion, "policy:\n  allow_implicit_invocation: true\n"); // tamper

    const c = loadContext(sandbox.env);
    const drift = computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(drift.some((d) => d.drift === "modified" && d.detail.includes("gated skill hand-edited"))).toBe(true);
    // doctor reports it non-fixable (remove-then-re-apply).
    const finding = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state)
      .find((f) => f.message.includes("gated skill hand-edited"));
    expect(finding?.fixable).toBe(false);
  });

  test("a deleted companion shows as tree drift", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });
    await runApply(sandbox.env, opts());

    fs.unlinkSync(path.join(sandbox.home, ".codex/skills/fleet-update/agents/openai.yaml"));

    const c = loadContext(sandbox.env);
    const drift = computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(drift.some((d) => d.drift === "modified")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gated ↔ ungated transitions (state records tree hashes; the desired side flips)
// ─────────────────────────────────────────────────────────────────────────────

describe("gated ↔ ungated transitions", () => {
  test("gated → ungated converges: owned gated trees become symlinks, own-dir extras prune", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sandbox.env, opts());

    // Author removes the gate: rewrite the source SKILL.md without the flag.
    const src = makeSkill(root.path, "fleet-update");
    await runApply(sandbox.env, opts({ prune: true }));

    // The claude own-dir gated tree was replaced by a plain symlink to source...
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");
    expect(fs.lstatSync(claudeSkill).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(claudeSkill)).toBe(fs.realpathSync(src));
    // ...the shared symlink was created, and the codex own-dir tree was pruned.
    expect(fs.lstatSync(path.join(sandbox.home, ".agents/skills/fleet-update")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(sandbox.home, ".codex/skills/fleet-update"))).toBe(false);

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
    expect(plan.foreign).toEqual([]);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("gated → ungated with a claude override converges to an ungated render (no false hand-edit)", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { model: "opus" } },
    });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // Remove the gate; keep the override → desired claude placement stays rendered.
    makeSkill(root.path, "fleet-update", { agentsYaml: { claude: { model: "opus" } } });
    const mid = loadContext(sandbox.env);
    const midPlan = buildPlan(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    // Must be an update, not a "hand-edited" warning stranding the old gated tree.
    expect(midPlan.warnings.some((w) => w.kind === "modified")).toBe(false);
    expect(midPlan.actions.some((a) => a.type === "update")).toBe(true);

    await runApply(sandbox.env, opts({ prune: true }));
    const skillMd = fs.readFileSync(path.join(sandbox.home, ".claude/skills/fleet-update/SKILL.md"), "utf8");
    expect(skillMd).not.toContain("disable-model-invocation");
    expect(skillMd).toContain("model: opus");

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
    // The gated marker was cleared from state.
    expect(loadState(sandbox.env).artifacts["skill:fleet-update"]!.placements.some((p) => p.gated)).toBe(false);
  });

  test("gated → ungated leaves a genuinely hand-edited gated tree untouched (warn, not clobber)", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // Hand-edit the deployed gated tree, THEN remove the gate from the source.
    fs.appendFileSync(path.join(sandbox.home, ".claude/skills/fleet-update/SKILL.md"), "\nuser edit\n");
    makeSkill(root.path, "fleet-update");

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    // Diverged tree → the claude path is never replaced by the symlink repair (the
    // shared-dir create is unrelated); it stays reported as foreign.
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");
    expect(plan.actions.some((a) => a.type === "create" && a.placement.path === claudeSkill)).toBe(false);
    expect(plan.foreign.some((f) => f.path === claudeSkill && f.detail.includes("owned symlink replaced by dir"))).toBe(true);
    expect(fs.readFileSync(path.join(claudeSkill, "SKILL.md"), "utf8")).toContain("user edit");
  });

  test("narrowing a gated skill's agents keeps the orphaned gated tree behind --prune", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sandbox.env, opts());

    // Disable codex: its own-dir tree goes stale, but it is still a GATED render —
    // no exposure, so removal stays an ordinary --prune-gated cleanup.
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    const codexPrune = plan.actions.find((a) => a.type === "prune" && a.placement.agent === "codex");
    expect(codexPrune?.reason).toBeUndefined();
    expect(plan.requiresPrune).toBe(true);

    await runApply(sandbox.env, opts()); // no --prune → tree must survive
    expect(fs.existsSync(path.join(sandbox.home, ".codex/skills/fleet-update"))).toBe(true);
    await runApply(sandbox.env, opts({ prune: true }));
    expect(fs.existsSync(path.join(sandbox.home, ".codex/skills/fleet-update"))).toBe(false);
  });

  test("revoking a permissive opt-in removes the no-gate placement without --prune", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    fs.writeFileSync(
      overlayPath(root),
      JSON.stringify({ version: 1, name: "o", skills: { "fleet-update": { gating: { permissive: ["gemini-cli"] } } } }),
    );
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "gemini-cli"] });
    await runApply(sandbox.env, opts());
    const geminiSkill = path.join(sandbox.home, ".gemini/skills/fleet-update");
    expect(fs.existsSync(geminiSkill)).toBe(true);

    // Revoke the opt-in: gemini cannot enforce the gate, so the tree is
    // model-invocable there — a required removal, not an optional prune.
    fs.writeFileSync(overlayPath(root), JSON.stringify({ version: 1, name: "o", skills: {} }));
    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    const geminiPrune = plan.actions.find((a) => a.type === "prune" && a.placement.agent === "gemini-cli");
    expect(geminiPrune?.reason).toBe("gated-transition");

    await runApply(sandbox.env, opts()); // no --prune
    expect(fs.existsSync(geminiSkill)).toBe(false);
    // The claude placement (gate enforced) is untouched.
    expect(fs.existsSync(path.join(sandbox.home, ".claude/skills/fleet-update"))).toBe(true);
  });

  test("a stale tprompt export of a gated skill stays behind --prune", async () => {
    sandbox = makeSandbox({ tprompt: true });
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true, tprompt: {} },
    });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // Drop the tprompt block (skill stays gated): the stale prompt export is a
    // channel file with no exposure — ordinary --prune cleanup, never forced.
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    const promptPrune = plan.actions.find((a) => a.type === "prune" && a.placement.agent === "tprompt");
    expect(promptPrune).toBeDefined();
    expect(promptPrune?.reason).toBeUndefined();
    expect(plan.requiresPrune).toBe(true);

    const promptPath = path.resolve(promptPrune!.placement.path);
    await runApply(sandbox.env, opts()); // no --prune → export must survive
    expect(fs.existsSync(promptPath)).toBe(true);
  });

  test("gated → ungated with the tree replaced by a regular file: foreign, not a crash", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // The user replaces the deployed gated tree with a plain file, then the gate drops.
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");
    fs.rmSync(claudeSkill, { recursive: true });
    fs.writeFileSync(claudeSkill, "user file\n");
    makeSkill(root.path, "fleet-update");

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state); // must not throw EISDIR/ENOTDIR
    expect(plan.actions.some((a) => a.type === "create" && a.placement.path === claudeSkill)).toBe(false);
    expect(plan.foreign.some((f) => f.path === claudeSkill)).toBe(true);
    expect(fs.readFileSync(claudeSkill, "utf8")).toBe("user file\n");
  });

  test("status reports the gated → ungated-with-override transition stale (plan/status parity)", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { model: "opus" } },
    });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // Remove the gate; keep the override → desired kind stays "rendered" at the same
    // path, but the desired placement is no longer gated (hash unset for plain
    // renders), so ONLY the no-longer-gated check can catch it.
    makeSkill(root.path, "fleet-update", { agentsYaml: { claude: { model: "opus" } } });
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");

    const mid = loadContext(sandbox.env);
    // plan emits update for the claude path...
    const midPlan = buildPlan(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    expect(midPlan.actions.some((a) => a.type === "update" && a.placement.path === claudeSkill)).toBe(true);
    // ...and status must say so too (three-way contract), not read the untouched tree as clean.
    const drift = computeDrift(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    expect(drift.some((d) => d.drift === "stale" && d.path === claudeSkill && d.detail.includes("no longer gated"))).toBe(true);

    await runApply(sandbox.env, opts());
    const c = loadContext(sandbox.env);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("status reports the gated → ungated-to-symlink transition stale (kind changed)", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    makeSkill(root.path, "fleet-update"); // remove the gate; no override → desired symlink
    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");

    const mid = loadContext(sandbox.env);
    const drift = computeDrift(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    expect(drift.some((d) => d.drift === "stale" && d.path === claudeSkill && d.detail.includes("desired kind changed"))).toBe(true);

    await runApply(sandbox.env, opts());
    const c = loadContext(sandbox.env);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("ungated → gated: the stale shared symlink is removed by a normal apply without --prune", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update");
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sandbox.env, opts());
    const sharedPath = path.join(sandbox.home, ".agents/skills/fleet-update");
    expect(fs.lstatSync(sharedPath).isSymbolicLink()).toBe(true);

    // Author gates the skill: the stale shared symlink is a REQUIRED removal (the
    // skill would stay model-invocable through the shared root), not an optional prune.
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    const mid = loadContext(sandbox.env);
    const midPlan = buildPlan(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    const pruneAction = midPlan.actions.find((a) => a.type === "prune");
    expect(pruneAction?.placement.path).toBe(sharedPath);
    expect(pruneAction?.reason).toBe("gated-transition");
    expect(midPlan.requiresPrune).toBe(false); // required removals do not demand --prune

    await runApply(sandbox.env, opts()); // NO --prune
    expect(fs.existsSync(sharedPath)).toBe(false);
    expect(fs.lstatSync(path.join(sandbox.home, ".claude/skills/fleet-update")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(sandbox.home, ".codex/skills/fleet-update/agents/openai.yaml"))).toBe(true);

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("upgrade path: a pre-gated identical non-gated render converges to a gated record", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { model: "opus" } },
    });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });

    // Simulate a PRE-gated skm apply: a normal first-party render + a non-gated
    // state record (hash = SKILL.md sha, no `gated` marker).
    const c0 = loadContext(sandbox.env);
    const desiredSkill = c0.desired.skills[0]!;
    const target = path.join(sandbox.home, ".claude/skills/fleet-update");
    const res = renderSkill(sandbox.env, desiredSkill, "claude", target);
    const st = loadState(sandbox.env);
    upsertPlacement(st, "skill:fleet-update", { root: "public", visibility: "public" }, {
      agent: "claude-code",
      path: target,
      kind: "rendered",
      hash: res.hash,
      ...(res.tree ? { tree: res.tree } : {}),
    });
    saveState(sandbox.env, st);
    // The finding's premise: for a no-companion agent the bytes are IDENTICAL, so
    // only the record's gatedness distinguishes old from new.
    expect(res.tree).toBe(gatedTreeHash(desiredSkill, "claude-code", "claude", reg()));

    // plan must refresh the record (update), not noop it into a permanent stale
    // record; status must agree (three-way contract).
    const mid = loadContext(sandbox.env);
    const midPlan = buildPlan(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    expect(midPlan.actions.find((a) => a.placement.path === target)?.type).toBe("update");
    const drift = computeDrift(sandbox.env, mid.config, mid.registry, mid.desired, mid.state);
    expect(drift.some((d) => d.path === target && d.drift === "stale" && d.detail.includes("now gated"))).toBe(true);

    await runApply(sandbox.env, opts());
    const sp = loadState(sandbox.env).artifacts["skill:fleet-update"]!.placements.find((p) => p.path === target)!;
    expect(sp.gated).toBe(true);
    // With the record converged, doctor's live-exposure advisory now fires
    // (opencode reads the claude dir and ignores the gate).
    const c = loadContext(sandbox.env);
    expect(diagnose(sandbox.env, c.config, c.registry, c.desired, c.state)
      .some((f) => f.category === "gated-leak" && f.severity === "warn")).toBe(true);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("a still-gated unmodified placement stays clean in status", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", {
      frontmatter: { "disable-model-invocation": true },
      agentsYaml: { claude: { model: "opus" } },
    });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    const c = loadContext(sandbox.env);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });

  test("ungated → gated converges: owned symlinks become gated trees, shared prunes", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update");
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sandbox.env, opts());
    expect(fs.lstatSync(path.join(sandbox.home, ".claude/skills/fleet-update")).isSymbolicLink()).toBe(true);

    // Author gates the skill.
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    await runApply(sandbox.env, opts({ prune: true }));

    const claudeSkill = path.join(sandbox.home, ".claude/skills/fleet-update");
    expect(fs.lstatSync(claudeSkill).isSymbolicLink()).toBe(false); // real rendered dir now
    expect(fs.readFileSync(path.join(claudeSkill, "SKILL.md"), "utf8")).toContain("disable-model-invocation: true");
    expect(fs.existsSync(path.join(sandbox.home, ".codex/skills/fleet-update/agents/openai.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(sandbox.home, ".agents/skills/fleet-update"))).toBe(false); // shared pruned

    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State recording: adopt + repeated no-op applies keep the tree baseline
// ─────────────────────────────────────────────────────────────────────────────

describe("gated state recording (adopt / no-op)", () => {
  test("adopting a pre-existing matching gated tree records the full-tree hash; status stays clean", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const src = makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });

    // Pre-place the exact tree skm would render (unowned), so plan adopts it.
    const skill: DesiredSkill = {
      name: "fleet-update",
      source: { root: "public", visibility: "public", path: src },
      overrides: {},
      gated: true,
    };
    const target = path.join(sandbox.home, ".codex/skills/fleet-update");
    writeGatedTree(renderGatedTree(skill, "codex", "codex", reg()), target, src);

    const pre = loadContext(sandbox.env);
    const prePlan = buildPlan(sandbox.env, pre.config, pre.registry, pre.desired, pre.state);
    expect(prePlan.actions.map((a) => a.type)).toEqual(["adopt"]);

    await runApply(sandbox.env, opts());
    const sp = loadState(sandbox.env).artifacts["skill:fleet-update"]!.placements[0]!;
    expect(sp.gated).toBe(true);
    expect(sp.tree).toBe(treeHashOf(target)!); // full-tree baseline recorded on adopt

    const c = loadContext(sandbox.env);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
    expect(diagnose(sandbox.env, c.config, c.registry, c.desired, c.state).filter((f) => f.severity !== "info")).toEqual([]);
  });

  test("apply → no-op re-apply keeps the tree baseline; status and doctor stay clean", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sandbox.env, opts());
    await runApply(sandbox.env, opts()); // pure no-op pass

    for (const sp of loadState(sandbox.env).artifacts["skill:fleet-update"]!.placements) {
      expect(sp.gated).toBe(true);
      expect(sp.tree?.startsWith("sha256:")).toBe(true);
    }
    const c = loadContext(sandbox.env);
    expect(computeDrift(sandbox.env, c.config, c.registry, c.desired, c.state)).toEqual([]);
    // The only actionable finding is the advisory opencode exposure on the claude
    // placement (opencode reads the claude dir and ignores the gate) — no drift.
    const actionable = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state).filter((f) => f.severity !== "info");
    expect(actionable.length).toBeGreaterThan(0);
    expect(actionable.every((f) => f.category === "gated-leak" && f.severity === "warn")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gated exposure: no-gate readers of a chosen dir (advisory, never a hard error)
// ─────────────────────────────────────────────────────────────────────────────

describe("gated exposure", () => {
  test("claude placement records opencode exposure; honored readers (cursor/grok) excluded", () => {
    const r = solvePlacements(gatedDesired("fleet-update"), ALL_ENABLED, reg());
    const claude = r.placements.find((p) => p.dir === "claude")!;
    // opencode (gate none) reads the claude dir → exposure; cursor (hard read) and
    // grok (maybe-read) both honor the frontmatter gate themselves → not exposure.
    expect(claude.gatedExposure).toEqual(["opencode"]);
    // cursor reads the codex dir but honors the gate → no exposure there.
    const codex = r.placements.find((p) => p.dir === "codex")!;
    expect(codex.gatedExposure).toBeUndefined();
  });

  test("a permissive listing is an acknowledgment, not exposure", () => {
    const r = solvePlacements(gatedDesired("fleet-update", { permissive: ["opencode"] }), ALL_ENABLED, reg());
    const claude = r.placements.find((p) => p.dir === "claude")!;
    expect(claude.gatedExposure).toBeUndefined();
  });

  test("plan warns about the opencode exposure, naming kill switches and permissive", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    const w = plan.warnings.find((x) => x.kind === "gated-exposure");
    expect(w?.skill).toBe("fleet-update");
    expect(w?.message).toContain("opencode");
    expect(w?.message).toContain("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
    expect(w?.message).toContain("prose gate");
    expect(w?.message).toContain("gating.permissive");
  });

  test("plan exposure warning is silenced by a permissive acknowledgment", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    fs.writeFileSync(
      overlayPath(root),
      JSON.stringify({ version: 1, name: "o", skills: { "fleet-update": { gating: { permissive: ["opencode"] } } } }),
    );
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code", "opencode"] });
    const c = loadContext(sandbox.env);
    const plan = buildPlan(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(plan.warnings.some((x) => x.kind === "gated-exposure")).toBe(false);
    // opencode itself is opted in and placed in its own dir.
    expect(plan.actions.some((a) => a.placement.agent === "opencode" && a.placement.gated)).toBe(true);
  });

  test("doctor warns for a live gated placement with an uncovered no-gate reader", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    const c = loadContext(sandbox.env);
    const f = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state)
      .find((x) => x.category === "gated-leak" && x.severity === "warn");
    expect(f?.skill).toBe("fleet-update");
    expect(f?.message).toContain("opencode");
    expect(f?.message).toContain("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
    expect(f?.fixable).toBe(false);
  });

  test("doctor exposure is silent for a deleted gated placement (no false leak)", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    // The user deletes the deployed tree: nothing is exposed anymore; the missing
    // placement is its own drift finding, not a leak.
    fs.rmSync(path.join(sandbox.home, ".claude/skills/fleet-update"), { recursive: true });
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((x) => x.category === "gated-leak" && x.severity === "warn")).toBe(false);
  });

  test("doctor exposure warn is silent when permissive covers the reader", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    fs.writeFileSync(
      overlayPath(root),
      JSON.stringify({ version: 1, name: "o", skills: { "fleet-update": { gating: { permissive: ["opencode"] } } } }),
    );
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sandbox.env, opts());

    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((x) => x.category === "gated-leak" && x.severity === "warn")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overlay gating validation
// ─────────────────────────────────────────────────────────────────────────────

describe("overlay gating validation", () => {
  function writeOverlay(root: { path: string }, skills: Record<string, unknown>): void {
    fs.writeFileSync(overlayPath(root as never), JSON.stringify({ version: 1, name: "o", skills }));
  }

  test("permissive naming a no-gate agent parses and is retrievable", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    writeOverlay(root, { "fleet-update": { gating: { permissive: ["gemini-cli"] } } });
    const src = loadOverlay(root, reg());
    expect(gatingForSkill(src, "fleet-update")).toEqual({ permissive: ["gemini-cli"] });
  });

  test("permissive naming a real-gate agent is rejected", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    writeOverlay(root, { "fleet-update": { gating: { permissive: ["claude-code"] } } });
    expect(() => loadOverlay(root, reg())).toThrow(/already enforces a real gate/);
  });

  test("permissive naming an unknown agent is rejected", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    writeOverlay(root, { "fleet-update": { gating: { permissive: ["ghost"] } } });
    expect(() => loadOverlay(root, reg())).toThrow(/unknown agent 'ghost'/);
  });

  test("a non-array permissive is rejected", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    writeOverlay(root, { "fleet-update": { gating: { permissive: "gemini-cli" } } });
    expect(() => loadOverlay(root, reg())).toThrow(/gating.permissive must be an array/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Doctor findings (a) shared root, (b) no-gate dir, (c) version drift
// ─────────────────────────────────────────────────────────────────────────────

/** Drop a gated skill dir (SKILL.md with disable-model-invocation:true) at an abs path. */
function placeGatedDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: fleet-update\ndescription: x\ndisable-model-invocation: true\n---\n\nbody\n",
  );
}

describe("doctor gated findings", () => {
  test("(a) a gated skill in the shared root is flagged", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    placeGatedDir(path.join(sandbox.home, ".agents/skills/fleet-update"));
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    const f = findings.find((x) => x.category === "gated-leak" && x.message.includes("shared root"));
    expect(f?.severity).toBe("error");
  });

  test("(b) a gated skill in a no-gate agent's dir without a permissive override is flagged", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["gemini-cli"] });
    placeGatedDir(path.join(sandbox.home, ".gemini/skills/fleet-update"));
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((x) => x.category === "gated-leak" && x.message.includes("gemini-cli"))).toBe(true);
  });

  test("(b) suppressed when the skill has a permissive override for that agent", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    fs.writeFileSync(
      overlayPath(root),
      JSON.stringify({ version: 1, name: "o", skills: { "fleet-update": { gating: { permissive: ["gemini-cli"] } } } }),
    );
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["gemini-cli"] });
    placeGatedDir(path.join(sandbox.home, ".gemini/skills/fleet-update"));
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((x) => x.category === "gated-leak")).toBe(false);
  });

  test("(b) a companion-gated agent's dir without the enforcing companion is flagged", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });
    // Frontmatter-only stray in codex's dir: codex ignores the frontmatter, so
    // without agents/openai.yaml the skill is model-invocable there.
    placeGatedDir(path.join(sandbox.home, ".codex/skills/fleet-update"));
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    const f = findings.find((x) => x.category === "gated-leak" && x.message.includes("agents/openai.yaml"));
    expect(f?.severity).toBe("error");
  });

  test("(b) silent when the codex companion is present and enforcing", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });
    await runApply(sandbox.env, opts()); // skm's own render ships the companion
    const c = loadContext(sandbox.env);
    const findings = diagnose(sandbox.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((x) => x.category === "gated-leak" && x.severity === "error")).toBe(false);
  });

  test("(c) gate-version drift warns for an agent receiving gated skills", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    const env: SkmEnv = { ...sandbox.env, agentVersionProbe: (id) => (id === "claude-code" ? "9.9.9" : undefined) };
    const c = loadContext(env);
    const findings = diagnose(env, c.config, c.registry, c.desired, c.state);
    const f = findings.find((x) => x.category === "gate-version-drift");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("2.1.207");
  });

  test("(c) no drift finding when the installed version matches the probed one", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    const env: SkmEnv = { ...sandbox.env, agentVersionProbe: () => "2.1.207" };
    const c = loadContext(env);
    expect(diagnose(env, c.config, c.registry, c.desired, c.state).some((x) => x.category === "gate-version-drift")).toBe(false);
  });

  test("(c) skips silently when the version probe returns undefined", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    makeSkill(root.path, "fleet-update", { frontmatter: { "disable-model-invocation": true } });
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["claude-code"] });
    const env: SkmEnv = { ...sandbox.env, agentVersionProbe: () => undefined };
    const c = loadContext(env);
    expect(diagnose(env, c.config, c.registry, c.desired, c.state).some((x) => x.category === "gate-version-drift")).toBe(false);
  });
});
