// Regression: the §9 privacy guard is enforced at WRITE time, not only during a
// fresh plan. A reviewed `apply --plan` must re-check the origin allowlist so a
// private artifact is never materialized into a git worktree that has become
// non-allowlisted since the plan was created (privacy-apply-plan-bypasses-guard).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { buildPlan } from "../src/plan";
import { loadRegistry } from "../src/registry";
import { resolveDesiredState } from "../src/resolve";
import { loadState } from "../src/state";
import { computeDrift } from "../src/status";
import type { MachineConfig, VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, realRegistryPath, writeMachineConfig } from "./util";

function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}
function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

test("apply --plan re-runs the privacy guard when the allowlist changes after planning", async () => {
  const registry = loadRegistry(realRegistryPath());

  // Home is a git worktree (dotfiles-style). Origin is initially allowlisted.
  const ORIGIN = "https://example.com/dotfiles.git";
  git(sb.home, ["init", "-q"]);
  git(sb.home, ["remote", "add", "origin", ORIGIN]);

  // Private overlay root with an unscoped skill that renders into claude's dir.
  const priv = makeRoot(sb, "private", "private");
  makeSkill(priv.path, "fleet-secret", {
    body: "TOP SECRET fleet host inventory",
    agentsYaml: { claude: { metadata: { classified: true } } },
  });

  const baseConfig: MachineConfig = {
    version: 1,
    roots: [priv],
    agents: ["claude-code", "codex"],
    privateOriginAllowlist: [ORIGIN], // allowlisted at plan time
  };
  writeMachineConfig(sb, baseConfig);

  // 1) Plan while allowlisted → guard passes → a real create action is recorded.
  const desired = resolveDesiredState(sb.env, baseConfig, registry);
  const plan = buildPlan(sb.env, baseConfig, registry, desired, loadState(sb.env));
  expect(
    plan.actions.some(
      (a) => a.type === "create" && a.placement.kind === "rendered" && a.skill === "fleet-secret",
    ),
  ).toBe(true);
  expect(plan.unsafe.length).toBe(0);

  const planFile = path.join(sb.base, "reviewed.plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  // 2) Empty the allowlist AFTER planning. The allowlist is not part of the
  //    desired-state hash, so the --plan precondition still holds.
  writeMachineConfig(sb, { ...baseConfig, privateOriginAllowlist: [] });
  const desiredAfter = resolveDesiredState(sb.env, { ...baseConfig, privateOriginAllowlist: [] }, registry);
  expect(desiredAfter.hash).toBe(plan.desiredStateHash);

  // 3) apply --plan must refuse to materialize the private content.
  const outcome = await runApply(sb.env, opts({ planFile }));
  const claudeDir = path.join(sb.home, ".claude", "skills", "fleet-secret");
  expect(fs.existsSync(path.join(claudeDir, "SKILL.md"))).toBe(false); // nothing leaked
  expect(loadState(sb.env).artifacts["skill:fleet-secret"]).toBeUndefined(); // nothing recorded

  const summary = outcome.json as { refused: { drift: string; skill?: string }[] };
  expect(summary.refused.some((r) => r.drift === "unsafe" && r.skill === "fleet-secret")).toBe(true);
  expect(outcome.exitCode).toBe(2); // refusal → non-convergence
});

test("status's unsafe-private finding uses the bare artifact name and stamps artifactType", async () => {
  const registry = loadRegistry(realRegistryPath());
  const ORIGIN = "https://example.com/dotfiles.git";
  git(sb.home, ["init", "-q"]);
  git(sb.home, ["remote", "add", "origin", ORIGIN]);

  const priv = makeRoot(sb, "private", "private");
  makeSkill(priv.path, "fleet-secret", { body: "TOP SECRET" });
  const config: MachineConfig = {
    version: 1,
    roots: [priv],
    agents: ["claude-code"],
    privateOriginAllowlist: [ORIGIN], // allowlisted at placement time
  };
  writeMachineConfig(sb, config);
  await runApply(sb.env, opts());

  // Origin becomes non-allowlisted → the owned private placement is now unsafe.
  const disallowed: MachineConfig = { ...config, privateOriginAllowlist: [] };
  const desired = resolveDesiredState(sb.env, disallowed, registry);
  const drift = computeDrift(sb.env, disallowed, registry, desired, loadState(sb.env));
  const unsafe = drift.find((d) => d.drift === "unsafe");
  expect(unsafe).toBeDefined();
  // Bare name (not the type-qualified state key `skill:fleet-secret`), typed.
  expect(unsafe!.skill).toBe("fleet-secret");
  expect(unsafe!.artifactType).toBe("skill");
});
