// Regression: the deletion invariant ("apply only ever deletes paths recorded in
// state") must hold at CONTENT granularity — skm never recursive-deletes a real
// directory or file it did not itself create. Covers DEL-1 and apply-plan-deletes-
// foreign.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { buildPlan } from "../src/plan";
import { loadContext } from "../src/context";
import { loadState } from "../src/state";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";
import type { VerbOptions } from "../src/types";

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
function homePath(...parts: string[]): string {
  return path.join(sb.home, ...parts);
}

// DEL-1: a user detaches an owned symlink and turns it into a real editable dir
// with their own files. A subsequent plain `apply` (no --prune) must NOT touch it.
test("apply preserves a real dir that replaced an owned symlink (no --prune)", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "foo");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

  // First apply: records ~/.claude/skills/foo as an owned symlink.
  await runApply(sb.env, opts());
  const claudeTarget = homePath(".claude/skills/foo");
  expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(true);
  expect(loadState(sb.env).artifacts["skill:foo"]!.placements.find((p) => p.agent === "claude-code")!.kind).toBe("symlink");

  // User detaches: replace the symlink with a real dir holding their own work.
  fs.unlinkSync(claudeTarget);
  fs.mkdirSync(claudeTarget, { recursive: true });
  fs.writeFileSync(path.join(claudeTarget, "SKILL.md"), "# my hand-edited copy\n");
  fs.writeFileSync(path.join(claudeTarget, "IMPORTANT_USER_DATA.txt"), "do not delete me\n");

  // The plan must classify the divergence as foreign — no destructive create.
  const c = loadContext(sb.env);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  expect(plan.foreign.some((f) => path.resolve(f.path) === path.resolve(claudeTarget))).toBe(true);
  expect(plan.actions.some((a) => a.type === "create" && a.placement.agent === "claude-code")).toBe(false);

  // A plain re-sync (no --prune) leaves the user's directory and file intact, and
  // signals non-convergence (exit 2) because foreign content was skipped.
  const outcome = await runApply(sb.env, opts());
  expect(fs.existsSync(path.join(claudeTarget, "IMPORTANT_USER_DATA.txt"))).toBe(true);
  expect(fs.readFileSync(path.join(claudeTarget, "IMPORTANT_USER_DATA.txt"), "utf8")).toBe("do not delete me\n");
  expect(outcome.exitCode).toBe(2);
});

// DEL-1 (prune path): dropping the skill, then `apply --prune`, must not rm -rf the
// user's replacement directory either.
test("apply --prune preserves a real dir that replaced an owned symlink", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "foo");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  await runApply(sb.env, opts());

  const claudeTarget = homePath(".claude/skills/foo");
  fs.unlinkSync(claudeTarget);
  fs.mkdirSync(claudeTarget, { recursive: true });
  fs.writeFileSync(path.join(claudeTarget, "USER.txt"), "mine\n");

  // Drop the skill from the desired set so its placements become prune candidates.
  fs.rmSync(path.join(root.path, "skills", "foo"), { recursive: true });

  await runApply(sb.env, opts({ prune: true }));
  expect(fs.existsSync(path.join(claudeTarget, "USER.txt"))).toBe(true);
  // skm forgot the detached placement (no longer manages it).
  expect(loadState(sb.env).artifacts["skill:foo"]).toBeUndefined();
});

// Finding 2: ownership of a rendered artifact must cover the WHOLE tree, not just
// SKILL.md. A user file dropped inside an owned rendered dir (SKILL.md untouched)
// must block recursive deletion — the old SKILL.md-only hash check read it "safe".
test("apply --prune preserves a user file added inside an owned rendered dir", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "rendered-skill", { agentsYaml: { claude: { model: "opus" } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  const claudeDir = homePath(".claude/skills/rendered-skill");
  expect(fs.lstatSync(claudeDir).isDirectory()).toBe(true);
  // The full-tree hash is recorded in state (schema v2), enabling the check.
  const claudePlacement = loadState(sb.env).artifacts["skill:rendered-skill"]!.placements.find(
    (p) => p.agent === "claude-code",
  );
  expect(typeof claudePlacement?.tree).toBe("string");

  // User adds a file alongside SKILL.md, leaving SKILL.md itself untouched.
  fs.writeFileSync(path.join(claudeDir, "USER_NOTES.txt"), "my private notes\n");

  // Drop the skill so its placements become prune candidates.
  fs.rmSync(path.join(root.path, "skills", "rendered-skill"), { recursive: true });

  const outcome = await runApply(sb.env, opts({ prune: true }));

  // The rendered dir's tree changed → classified foreign → never recursive-deleted.
  expect(fs.existsSync(path.join(claudeDir, "USER_NOTES.txt"))).toBe(true);
  expect(fs.readFileSync(path.join(claudeDir, "USER_NOTES.txt"), "utf8")).toBe("my private notes\n");
  expect(outcome.exitCode).toBe(2); // foreign refusal → non-convergence
  // skm stopped managing the detached placement.
  expect(loadState(sb.env).artifacts["skill:rendered-skill"]).toBeUndefined();
});

// apply-plan-deletes-foreign: a reviewed `--plan` create replay must not destroy
// non-owned content that appeared at the target during the plan→apply gap.
test("apply --plan does not delete foreign content at a create target", async () => {
  const root = makeRoot(sb, "public", "public");
  makeSkill(root.path, "foo");
  writeMachineConfig(sb, { version: 1, roots: [root] });

  // Plan while the claude target is absent → a create action for it.
  const c = loadContext(sb.env);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const claudeTarget = path.join(sb.home, ".claude", "skills", "foo");
  expect(
    plan.actions.some(
      (a) => a.type === "create" && path.resolve(a.placement.path) === path.resolve(claudeTarget),
    ),
  ).toBe(true);

  const planFile = path.join(sb.base, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  // Between plan and apply, a different tool drops a real, non-owned dir there.
  fs.mkdirSync(claudeTarget, { recursive: true });
  fs.writeFileSync(path.join(claudeTarget, "IMPORTANT.txt"), "not skm's to delete");

  const outcome = await runApply(sb.env, opts({ planFile }));

  // The foreign dir's content survives; it was never owned in state.
  expect(fs.existsSync(path.join(claudeTarget, "IMPORTANT.txt"))).toBe(true);
  expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(false);
  // apply refused the foreign target → non-convergence exit code.
  expect(outcome.exitCode).toBe(2);
});
