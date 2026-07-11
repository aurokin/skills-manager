import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadRegistry } from "../src/registry";
import {
  classifyTarget,
  scanDir,
  scanEntry,
  scanForForeign,
  scanRegistryDirs,
  scanTargets,
} from "../src/scan";
import { emptyState, recordArtifact } from "../src/state";
import type { Registry } from "../src/types";
import { makeRoot, makeSandbox, makeSkill, realRegistryPath, type Sandbox } from "./util";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

/** Real (symlink-resolved) form, matching what scan records. */
function real(p: string): string {
  return fs.realpathSync(p);
}

describe("scanEntry", () => {
  test("classifies a symlink to a skill dir: kind, linkTarget, resolvedTarget, hash", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    fs.symlinkSync(source, target);

    const e = scanEntry(sandbox.env, target);
    expect(e.kind).toBe("symlink");
    expect(e.name).toBe("alpha");
    expect(e.linkTarget).toBe(source);
    expect(e.resolvedTarget).toBe(real(source));
    expect(e.broken).toBeUndefined();
    expect(e.sha256OfSkillMd).toMatch(/^[0-9a-f]{64}$/);
  });

  test("flags a broken symlink and records no hash", () => {
    sandbox = makeSandbox();
    const target = path.join(sandbox.home, ".claude", "skills", "dangling");
    fs.symlinkSync(path.join(sandbox.base, "does-not-exist"), target);

    const e = scanEntry(sandbox.env, target);
    expect(e.kind).toBe("symlink");
    expect(e.broken).toBe(true);
    expect(e.resolvedTarget).toBeUndefined();
    expect(e.sha256OfSkillMd).toBeUndefined();
  });

  test("hashes a real (rendered) directory's SKILL.md", () => {
    sandbox = makeSandbox();
    const dir = path.join(sandbox.home, ".claude", "skills", "beta");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: beta\n---\nbody\n");

    const e = scanEntry(sandbox.env, dir);
    expect(e.kind).toBe("dir");
    expect(e.sha256OfSkillMd).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns kind 'absent' for a missing path", () => {
    sandbox = makeSandbox();
    const e = scanEntry(sandbox.env, path.join(sandbox.home, ".claude", "skills", "nope"));
    expect(e.kind).toBe("absent");
  });

  test("expands a leading tilde against env.home", () => {
    sandbox = makeSandbox();
    const dir = path.join(sandbox.home, ".claude", "skills", "gamma");
    fs.mkdirSync(dir, { recursive: true });
    const e = scanEntry(sandbox.env, "~/.claude/skills/gamma");
    expect(e.kind).toBe("dir");
    expect(e.path).toBe(dir);
  });
});

describe("scanDir", () => {
  test("lists mixed symlink/real/broken entries, sorted, and skips a missing dir", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const skillsDir = path.join(sandbox.home, ".claude", "skills");
    fs.symlinkSync(source, path.join(skillsDir, "a-link"));
    fs.mkdirSync(path.join(skillsDir, "b-real"), { recursive: true });
    fs.symlinkSync(path.join(sandbox.base, "gone"), path.join(skillsDir, "c-broken"));

    const entries = scanDir(sandbox.env, skillsDir);
    expect(entries.map((e) => e.name)).toEqual(["a-link", "b-real", "c-broken"]);
    expect(entries.map((e) => e.kind)).toEqual(["symlink", "dir", "symlink"]);
    expect(entries[2]!.broken).toBe(true);

    expect(scanDir(sandbox.env, path.join(sandbox.home, ".nonexistent"))).toEqual([]);
  });
});

describe("scanRegistryDirs", () => {
  test("includes existing registry dirs and omits absent ones", () => {
    sandbox = makeSandbox();
    const result = scanRegistryDirs(sandbox.env, reg());
    // sandbox pre-creates ~/.claude/skills and ~/.agents/skills but not ~/.grok/skills? it does — remove one.
    fs.rmSync(path.join(sandbox.home, ".grok", "skills"), { recursive: true, force: true });
    const after = scanRegistryDirs(sandbox.env, reg());
    expect(Object.keys(result)).toContain("claude");
    expect(Object.keys(result)).toContain("shared");
    expect(Object.keys(after)).not.toContain("grok");
  });
});

describe("scanTargets", () => {
  test("point-looks-up each path in order, including absent", () => {
    sandbox = makeSandbox();
    const dir = path.join(sandbox.home, ".claude", "skills", "here");
    fs.mkdirSync(dir, { recursive: true });
    const results = scanTargets(sandbox.env, [
      { path: dir },
      { path: path.join(sandbox.home, ".claude", "skills", "gone") },
    ]);
    expect(results.map((e) => e.kind)).toEqual(["dir", "absent"]);
  });
});

describe("classifyTarget", () => {
  test("absent when nothing is at the target", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    expect(classifyTarget(sandbox.env, target, source)).toBe("absent");
  });

  test("adopted when a symlink already resolves to the expected source", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    fs.symlinkSync(source, target);
    expect(classifyTarget(sandbox.env, target, source)).toBe("adopted");
  });

  test("foreign when a symlink resolves elsewhere", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const other = makeSkill(root.path, "other");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    fs.symlinkSync(other, target);
    expect(classifyTarget(sandbox.env, target, source)).toBe("foreign");
  });

  test("foreign when a real directory sits at the target", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    fs.mkdirSync(target, { recursive: true });
    expect(classifyTarget(sandbox.env, target, source)).toBe("foreign");
  });

  test("foreign for a broken symlink at the target", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const target = path.join(sandbox.home, ".claude", "skills", "alpha");
    fs.symlinkSync(path.join(sandbox.base, "gone"), target);
    expect(classifyTarget(sandbox.env, target, source)).toBe("foreign");
  });
});

describe("scanForForeign", () => {
  test("reports unowned entries as foreign and skips state-owned placements", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public");
    const source = makeSkill(root.path, "alpha");
    const sharedDir = path.join(sandbox.home, ".agents", "skills");

    const ownedTarget = path.join(sharedDir, "alpha");
    fs.symlinkSync(source, ownedTarget);
    const foreignTarget = path.join(sharedDir, "stranger");
    fs.symlinkSync(makeSkill(root.path, "stranger"), foreignTarget);

    const state = emptyState("m");
    recordArtifact(state, "skill:alpha", { root: "public", visibility: "public" }, [
      { agent: "shared", path: ownedTarget, kind: "symlink" },
    ]);

    const findings = scanForForeign(sandbox.env, reg(), state);
    const paths = findings.map((f) => f.path);
    expect(paths).toContain(foreignTarget);
    expect(paths).not.toContain(ownedTarget);
    expect(findings.every((f) => f.drift === "foreign")).toBe(true);
  });

  test("flags a broken symlink as foreign with a descriptive detail", () => {
    sandbox = makeSandbox();
    const brokenTarget = path.join(sandbox.home, ".agents", "skills", "dangling");
    fs.symlinkSync(path.join(sandbox.base, "gone"), brokenTarget);

    const findings = scanForForeign(sandbox.env, reg(), emptyState("m"));
    const broken = findings.find((f) => f.path === brokenTarget);
    expect(broken?.detail).toMatch(/broken symlink/);
  });
});
