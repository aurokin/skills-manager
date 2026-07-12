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
import { treeHashOf } from "../src/render";
import { resolveDesiredState } from "../src/resolve";
import { solvePlacements } from "../src/solver";
import { loadState } from "../src/state";
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
    writeGatedTree(tree, target);
    expect(treeHashOf(target)).toBe(hashGatedTree(tree));
    expect(gatedTreeHash(skill, "codex", "codex", reg())).toBe(hashGatedTree(tree));
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
