// Roots are fast-forwarded before plan/apply (ff-only; every unsafe case skips
// with a reason and leaves the checkout untouched). Real temp git repos: a bare
// "origin", a publisher clone that pushes, and the root clone skm pulls.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runApply } from "../src/apply";
import { runGit } from "../src/env";
import { runPlan } from "../src/plan";
import { pullRoots } from "../src/root-pull";
import type { Root, VerbOptions } from "../src/types";
import { makeSandbox, makeSkill, type Sandbox, writeMachineConfig } from "./util";

let sb: Sandbox;
let origin: string;
let publisher: string;
let rootDir: string;
let root: Root;

const GIT_CFG = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_CFG, "-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function commitSkill(dir: string, name: string): void {
  makeSkill(dir, name);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `add ${name}`);
}

function publish(name: string): void {
  commitSkill(publisher, name);
  git(publisher, "push", "-q", "origin", "main");
}

const opts = (extra: Partial<VerbOptions> = {}): VerbOptions => ({
  json: true,
  prune: false,
  yes: false,
  fix: false,
  args: [],
  ...extra,
});

beforeEach(() => {
  sb = makeSandbox();
  sb.env.git = runGit;
  origin = path.join(sb.base, "origin.git");
  publisher = path.join(sb.base, "publisher");
  rootDir = path.join(sb.base, "roots", "work");
  execFileSync("git", [...GIT_CFG, "init", "-q", "--bare", origin]);
  execFileSync("git", [...GIT_CFG, "clone", "-q", origin, publisher], { stdio: "ignore" });
  publish("alpha");
  execFileSync("git", [...GIT_CFG, "clone", "-q", origin, rootDir], { stdio: "ignore" });
  root = { name: "work", path: rootDir, visibility: "public" };
});

afterEach(() => sb.cleanup());

test("fast-forwards a clean default-branch root that is behind", () => {
  const before = git(rootDir, "rev-parse", "--short", "HEAD");
  publish("beta");
  const [pull] = pullRoots(sb.env, [root]);
  expect(pull).toMatchObject({ root: "work", status: "updated", from: before, commits: 1 });
  expect(pull!.to).toBe(git(rootDir, "rev-parse", "--short", "HEAD"));
  expect(fs.existsSync(path.join(rootDir, "skills", "beta", "SKILL.md"))).toBe(true);
});

test("reports an up-to-date root as current", () => {
  expect(pullRoots(sb.env, [root])).toEqual([{ root: "work", path: rootDir, status: "current" }]);
});

test("skips without touching the checkout when it is unsafe to fast-forward", () => {
  publish("beta");
  const head = () => git(rootDir, "rev-parse", "HEAD");
  const cases: [string, () => void, RegExp][] = [
    ["dirty", () => fs.appendFileSync(path.join(rootDir, "skills", "alpha", "SKILL.md"), "edit\n"), /uncommitted changes/],
    ["ahead", () => commitSkill(rootDir, "local"), /1 local commit\(s\) not on upstream/],
    ["detached", () => git(rootDir, "checkout", "-q", "--detach"), /detached HEAD/],
    ["branch", () => git(rootDir, "checkout", "-q", "-b", "feature", "--track", "origin/main"), /on branch 'feature', not default 'main'/],
    ["no upstream", () => git(rootDir, "branch", "--unset-upstream"), /has no upstream/],
  ];
  for (const [label, setup, reason] of cases) {
    const fresh = path.join(sb.base, "roots", label.replace(" ", "-"));
    execFileSync("git", [...GIT_CFG, "clone", "-q", origin, fresh], { stdio: "ignore" });
    git(fresh, "reset", "-q", "--hard", "HEAD~1");
    rootDir = fresh;
    setup();
    const before = head();
    const [pull] = pullRoots(sb.env, [{ ...root, path: fresh }]);
    expect(pull!.status, label).toBe("skipped");
    expect(pull!.reason, label).toMatch(reason);
    expect(head(), label).toBe(before);
  }
});

test("a failed fetch warns and continues with local contents", () => {
  git(rootDir, "remote", "set-url", "origin", path.join(sb.base, "gone.git"));
  const [pull] = pullRoots(sb.env, [root]);
  expect(pull!.status).toBe("skipped");
  expect(pull!.reason).toMatch(/fetch from 'origin' failed; using local contents/);
});

test("a plain-folder root is read as-is; roots sharing a checkout pull once", () => {
  const plain = path.join(sb.base, "plain");
  fs.mkdirSync(plain);
  publish("beta");
  const sub = { name: "sub", path: path.join(rootDir, "skills"), visibility: "public" as const };
  const pulls = pullRoots(sb.env, [{ name: "plain", path: plain, visibility: "public" }, root, sub]);
  expect(pulls.map((p) => p.status)).toEqual(["skipped", "updated", "updated"]);
  expect(pulls[0]!.reason).toBe("not a git checkout");
  expect(pulls[2]!.commits).toBe(1);
});

test("plan and apply pull first; --no-pull and apply --plan read the checkout as-is", async () => {
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  publish("beta");
  const placed = () => fs.existsSync(path.join(sb.home, ".claude", "skills", "beta"));
  const skills = (json: unknown) =>
    (json as { actions: { skill: string }[] }).actions.map((a) => a.skill);

  const offline = await runPlan(sb.env, opts({ noPull: true }));
  expect(skills(offline.json)).not.toContain("beta");
  expect((offline.json as { rootPulls: unknown[] }).rootPulls).toEqual([]);

  const planFile = path.join(sb.base, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(offline.json));
  const reviewed = await runApply(sb.env, opts({ planFile }));
  expect((reviewed.json as { rootPulls: unknown[] }).rootPulls).toEqual([]);
  expect(fs.existsSync(path.join(rootDir, "skills", "beta"))).toBe(false);

  const plan = await runPlan(sb.env, opts());
  expect(skills(plan.json)).toContain("beta");
  expect((plan.json as { rootPulls: { status: string }[] }).rootPulls[0]!.status).toBe("updated");
  expect(plan.human).toMatch(/root work\s+updated .*\(1 commit\(s\)\)/);

  const applied = await runApply(sb.env, opts());
  expect((applied.json as { rootPulls: { status: string }[] }).rootPulls[0]!.status).toBe("current");
  expect(placed()).toBe(true);
});
