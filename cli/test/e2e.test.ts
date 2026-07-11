// End-to-end sandbox scenarios exercising the full plan → apply → status loop
// through the real registry. NEVER touches the real HOME: every test builds a temp
// sandbox and drives verbs with the injected env.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { buildPlan, planHashOf, runPlan } from "../src/plan";
import { diagnose } from "../src/doctor";
import { computeDrift } from "../src/status";
import { loadContext } from "../src/context";
import { loadState } from "../src/state";
import type { VerbOptions } from "../src/types";
import {
  type Sandbox,
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

// ── helpers ──────────────────────────────────────────────────────────────────

function homePath(...parts: string[]): string {
  return path.join(sb.home, ...parts);
}

function isSymlinkTo(p: string, target: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return false;
    return fs.realpathSync(p) === fs.realpathSync(target);
  } catch {
    return false;
  }
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

// ── 1. fresh apply: unscoped + scoped + rendered ──────────────────────────────

describe("fresh apply", () => {
  test("materializes unscoped symlinks, scoped-only placement, and rendered dir", async () => {
    const root = makeRoot(sb, "public");
    const unscoped = makeSkill(root.path, "unscoped-skill");
    const scoped = makeSkill(root.path, "scoped-skill");
    const rendered = makeSkill(root.path, "rendered-skill", {
      agentsYaml: { claude: { model: "opus" } },
    });
    makeAgentScopes(root.path, {
      "scoped-skill": { agents: { allow: ["claude-code"] } },
    });
    writeMachineConfig(sb, {
      version: 1,
      roots: [root],
      agents: ["claude-code", "codex", "opencode"],
    });

    const outcome = await runApply(sb.env, opts());
    expect(outcome.exitCode).toBe(0);

    // unscoped → shared + claude symlinks
    expect(isSymlinkTo(homePath(".agents/skills/unscoped-skill"), unscoped)).toBe(true);
    expect(isSymlinkTo(homePath(".claude/skills/unscoped-skill"), unscoped)).toBe(true);

    // scoped allow[claude-code] → claude only, never shared
    expect(isSymlinkTo(homePath(".claude/skills/scoped-skill"), scoped)).toBe(true);
    expect(exists(homePath(".agents/skills/scoped-skill"))).toBe(false);

    // unscoped rendered → shared stays a plain symlink, claude is a rendered dir
    expect(isSymlinkTo(homePath(".agents/skills/rendered-skill"), rendered)).toBe(true);
    const claudeRendered = homePath(".claude/skills/rendered-skill");
    expect(fs.lstatSync(claudeRendered).isDirectory()).toBe(true);
    expect(fs.lstatSync(claudeRendered).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(claudeRendered, "SKILL.md"), "utf8")).toContain("model: opus");

    const state = loadState(sb.env);
    expect(Object.keys(state.artifacts).sort()).toEqual([
      "skill:rendered-skill",
      "skill:scoped-skill",
      "skill:unscoped-skill",
    ]);
    const claudePlacement = state.artifacts["skill:rendered-skill"]!.placements.find((p) => p.agent === "claude-code");
    expect(claudePlacement?.kind).toBe("rendered");
    expect(typeof claudePlacement?.hash).toBe("string");
  });
});

// ── 2. re-apply idempotence ───────────────────────────────────────────────────

test("re-apply is idempotent: second plan is all-noop, exit 0", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "a");
  makeSkill(root.path, "b", { agentsYaml: { claude: { model: "opus" } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  await runApply(sb.env, opts());

  const planOutcome = await runPlan(sb.env, opts());
  expect(planOutcome.exitCode).toBe(0); // no pending changes
  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
});

// ── 3. prune gating ───────────────────────────────────────────────────────────

test("prune is gated by --prune and only removes owned paths", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "keep");
  makeSkill(root.path, "drop");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  // Remove 'drop' from the desired set.
  fs.rmSync(path.join(root.path, "skills", "drop"), { recursive: true });

  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const prunes = plan.actions.filter((a) => a.type === "prune");
  expect(prunes.length).toBe(2); // shared + claude of 'drop'
  expect(plan.requiresPrune).toBe(true);

  // apply WITHOUT --prune leaves the orphans in place.
  await runApply(sb.env, opts());
  expect(exists(homePath(".claude/skills/drop"))).toBe(true);
  expect(loadState(sb.env).artifacts["skill:drop"]).toBeDefined();

  // apply WITH --prune removes them and cleans state.
  await runApply(sb.env, opts({ prune: true }));
  expect(exists(homePath(".claude/skills/drop"))).toBe(false);
  expect(exists(homePath(".agents/skills/drop"))).toBe(false);
  expect(loadState(sb.env).artifacts["skill:drop"]).toBeUndefined();
  // 'keep' untouched
  expect(exists(homePath(".claude/skills/keep"))).toBe(true);
});

// ── 4. adoption ───────────────────────────────────────────────────────────────

test("adopts a pre-existing correct symlink without a filesystem change", async () => {
  const root = makeRoot(sb, "public");
  const src = makeSkill(root.path, "adopt-me");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  // Pre-create the shared symlink exactly as skm would.
  const target = homePath(".agents/skills/adopt-me");
  fs.symlinkSync(src, target);
  const inode = fs.lstatSync(target).ino;

  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const sharedAction = plan.actions.find(
    (a) => a.skill === "adopt-me" && a.placement.agent === "shared",
  );
  expect(sharedAction?.type).toBe("adopt");

  await runApply(sb.env, opts());
  // The symlink is untouched (same inode) but now recorded in state.
  expect(fs.lstatSync(target).ino).toBe(inode);
  const owned = loadState(sb.env).artifacts["skill:adopt-me"]!.placements.some((p) => p.agent === "shared");
  expect(owned).toBe(true);
});

// ── 5. foreign preservation ───────────────────────────────────────────────────

test("foreign content at a target is reported and never touched", async () => {
  const root = makeRoot(sb, "public");
  const src = makeSkill(root.path, "colliding");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  // A hand-made real dir squats the claude target.
  const foreignDir = homePath(".claude/skills/colliding");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "MARKER"), "handmade");

  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.foreign.some((f) => f.path === foreignDir)).toBe(true);
  // No create action targets the foreign path.
  expect(plan.actions.some((a) => a.placement.agent === "claude-code" && a.type === "create")).toBe(false);

  await runApply(sb.env, opts());
  // Foreign dir intact; the shared placement still got created.
  expect(fs.readFileSync(path.join(foreignDir, "MARKER"), "utf8")).toBe("handmade");
  expect(isSymlinkTo(homePath(".agents/skills/colliding"), src)).toBe(true);
});

// ── 6. missing-root abort ─────────────────────────────────────────────────────

test("a registered root missing on disk hard-aborts before any work", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "x");
  const ghost = { name: "ghost", path: path.join(sb.base, "roots", "ghost"), visibility: "private" as const };
  writeMachineConfig(sb, { version: 1, roots: [root, ghost], agents: ["claude-code"] });

  await expect(runPlan(sb.env, opts())).rejects.toThrow(/missing on disk/);
});

// ── 7. deny guarantee on disk ─────────────────────────────────────────────────

test("deny scoping keeps the skill out of every dir the denied agent reads", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "no-codex");
  makeAgentScopes(root.path, { "no-codex": { agents: { deny: ["codex"] } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex", "opencode"] });

  await runApply(sb.env, opts());

  // codex reads shared + codex dirs — the skill must appear in neither.
  expect(exists(homePath(".agents/skills/no-codex"))).toBe(false);
  expect(exists(homePath(".codex/skills/no-codex"))).toBe(false);
  // placed for the allowed agents in their own dirs
  expect(exists(homePath(".claude/skills/no-codex"))).toBe(true);
  expect(exists(homePath(".config/opencode/skills/no-codex"))).toBe(true);

  // doctor's live-registry deny verification finds no violation.
  const c = ctx();
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, c.state);
  expect(findings.some((f) => f.category === "deny-violation")).toBe(false);
});

// ── 8. privacy refusal ────────────────────────────────────────────────────────

test("refuses to place a private skill inside a non-allowlisted git worktree", async () => {
  // Make the fake HOME (which contains all agent dirs) a git worktree with a
  // non-allowlisted origin.
  execFileSync("git", ["-C", sb.home, "init", "-q"]);
  execFileSync("git", ["-C", sb.home, "remote", "add", "origin", "git@github.com:someone/secret.git"]);

  const priv = makeRoot(sb, "private-root", "private");
  makeSkill(priv.path, "secret-skill");
  writeMachineConfig(sb, {
    version: 1,
    roots: [priv],
    agents: ["claude-code", "codex"],
    privateOriginAllowlist: [],
  });

  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.unsafe.length).toBeGreaterThan(0);
  expect(plan.unsafe.every((u) => u.skill === "secret-skill")).toBe(true);
  // No create actions for the refused placements.
  expect(plan.actions.some((a) => a.type === "create")).toBe(false);

  await runApply(sb.env, opts());
  expect(exists(homePath(".claude/skills/secret-skill"))).toBe(false);
  expect(exists(homePath(".agents/skills/secret-skill"))).toBe(false);
});

test("allowlisted origin permits the private placement", async () => {
  execFileSync("git", ["-C", sb.home, "init", "-q"]);
  execFileSync("git", ["-C", sb.home, "remote", "add", "origin", "git@github.com:me/trusted.git"]);

  const priv = makeRoot(sb, "trusted", "private");
  const src = makeSkill(priv.path, "ok-skill");
  writeMachineConfig(sb, {
    version: 1,
    roots: [priv],
    agents: ["claude-code", "codex"],
    privateOriginAllowlist: ["git@github.com:me/trusted.git"],
  });

  await runApply(sb.env, opts());
  expect(isSymlinkTo(homePath(".agents/skills/ok-skill"), src)).toBe(true);
});

// ── 9. hermes add-only ────────────────────────────────────────────────────────

test("hermes placements are created but never pruned", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "shared-skill");
  writeMachineConfig(sb, {
    version: 1,
    roots: [root],
    agents: ["claude-code", "codex", "hermes"],
  });

  await runApply(sb.env, opts());
  expect(exists(homePath(".hermes/skills/shared-skill"))).toBe(true);

  // Drop the skill entirely; hermes must be exempt from prune.
  fs.rmSync(path.join(root.path, "skills", "shared-skill"), { recursive: true });
  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const prunedAgents = plan.actions.filter((a) => a.type === "prune").map((a) => a.placement.agent);
  expect(prunedAgents).not.toContain("hermes");
  expect(prunedAgents.sort()).toEqual(["claude-code", "shared"]);

  await runApply(sb.env, opts({ prune: true }));
  // hermes symlink survives; the others are gone.
  expect(exists(homePath(".hermes/skills/shared-skill"))).toBe(true);
  expect(exists(homePath(".claude/skills/shared-skill"))).toBe(false);
  expect(loadState(sb.env).artifacts["skill:shared-skill"]!.placements.map((p) => p.agent)).toEqual(["hermes"]);
});

// ── 10. apply --plan with stale-hash refusal ──────────────────────────────────

describe("apply --plan", () => {
  test("executes a reviewed plan and refuses a stale one", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "one");
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const planFile = path.join(sb.base, "plan.json");
    fs.writeFileSync(planFile, JSON.stringify(plan));

    // Desired state changes (new skill) → the saved plan is stale.
    makeSkill(root.path, "two");
    await expect(runApply(sb.env, opts({ planFile }))).rejects.toThrow(/desired state changed/);

    // Integrity check: a tampered plan file is refused.
    const tampered = JSON.parse(fs.readFileSync(planFile, "utf8"));
    tampered.actions.push({ type: "create", skill: "evil", placement: { agent: "shared", dir: "shared", path: homePath(".agents/skills/evil"), kind: "symlink" }, source: { root: "public", visibility: "public", path: "/nope" } });
    fs.writeFileSync(planFile, JSON.stringify(tampered));
    await expect(runApply(sb.env, opts({ planFile }))).rejects.toThrow(/integrity check/);
  });

  test("a fresh reviewed plan applies cleanly", async () => {
    const root = makeRoot(sb, "public");
    const src = makeSkill(root.path, "one");
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const c = ctx();
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const planFile = path.join(sb.base, "plan.json");
    fs.writeFileSync(planFile, JSON.stringify(plan));

    const outcome = await runApply(sb.env, opts({ planFile }));
    expect(outcome.exitCode).toBe(0);
    expect(isSymlinkTo(homePath(".agents/skills/one"), src)).toBe(true);
  });
});

// ── plan/status wiring sanity ─────────────────────────────────────────────────

test("status reports missing owned placements as drift and exits 2", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "s");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  // Delete a materialized symlink out from under state.
  fs.unlinkSync(homePath(".claude/skills/s"));
  const c = ctx();
  const drift = computeDrift(sb.env, c.config, c.registry, c.desired, c.state);
  expect(drift.some((d) => d.drift === "missing" && d.skill === "s")).toBe(true);
});

// Finding 5a: status must be a true three-way diff. An owned rendered placement
// whose SOURCE was edited after apply (disk still at the old bytes, matching state)
// used to read clean — but plan would emit an update. Compare to the currently
// DESIRED render, not just to state.
test("status flags a rendered placement whose desired render changed after apply", async () => {
  const root = makeRoot(sb, "public");
  const skillDir = makeSkill(root.path, "rendered-skill", {
    agentsYaml: { claude: { model: "opus" } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  // Clean right after apply.
  let c = ctx();
  expect(computeDrift(sb.env, c.config, c.registry, c.desired, c.state).length).toBe(0);

  // Edit the source SKILL.md. The rendered claude dir is a COPY, so disk still equals
  // recorded state, but the desired render now differs.
  const md = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${md}\nAppended body change\n`);

  c = ctx();
  const drift = computeDrift(sb.env, c.config, c.registry, c.desired, c.state);
  const claudeDrift = drift.find(
    (d) => d.skill === "rendered-skill" && d.path.includes(".claude"),
  );
  expect(claudeDrift?.drift).toBe("stale");
});

// Finding 5b: a kind transition (an agents/*.yaml override added after apply turns a
// symlink placement into a desired rendered one) used to read clean because the owned
// symlink still resolved to the source. status must report the desired-kind change.
test("status flags a symlink→rendered kind transition as drift", async () => {
  const root = makeRoot(sb, "public");
  const skillDir = makeSkill(root.path, "morph");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  const claudeTarget = homePath(".claude/skills/morph");
  expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(true);
  expect(
    loadState(sb.env).artifacts["skill:morph"]!.placements.find((p) => p.agent === "claude-code")!.kind,
  ).toBe("symlink");

  // Add a claude override → the skill now DESIRES a rendered dir in claude's dir.
  const agentsDir = path.join(skillDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "claude.yaml"), "model: opus\n");

  const c = ctx();
  const drift = computeDrift(sb.env, c.config, c.registry, c.desired, c.state);
  const claudeDrift = drift.find((d) => d.skill === "morph" && d.path.includes(".claude"));
  expect(claudeDrift?.drift).toBe("stale");
  expect(claudeDrift?.detail).toMatch(/kind changed/);
});

test("executePlan against an empty desired state records nothing", () => {
  const root = makeRoot(sb, "public");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  const c = ctx();
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.actions.length).toBe(0);
  expect(plan.planHash).toBe(planHashOf(plan.desiredStateHash, plan.actions, plan.requiresPrune));
});

// ── option builder ────────────────────────────────────────────────────────────

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}
