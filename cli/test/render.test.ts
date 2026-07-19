import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { deepMerge, hashContent, renderSkill } from "../src/render";
import type { DesiredSkill } from "../src/types";
import { makeRoot, makeSandbox, makeSkill } from "./util";

/** Wrap a skill dir + optional claude override into a DesiredSkill for rendering. */
function desiredFrom(skillDir: string): DesiredSkill {
  const claude = path.join(skillDir, "agents", "claude.yaml");
  return {
    name: path.basename(skillDir),
    source: { root: "public", visibility: "public", path: skillDir },
    overrides: fs.existsSync(claude) ? { claude } : {},
  };
}

describe("deepMerge", () => {
  test("override wins on scalars, replaces arrays, recurses into objects", () => {
    const merged = deepMerge(
      { a: { x: 1, y: 2 }, arr: [1, 2], keep: "yes" },
      { a: { y: 3 }, arr: [9] },
    );
    expect(merged).toEqual({ a: { x: 1, y: 3 }, arr: [9], keep: "yes" });
  });
});

describe("hashContent", () => {
  test("matches the known sha256 of 'hello'", () => {
    expect(hashContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("renderSkill", () => {
  test("deep-merges override into frontmatter with canonical key order", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const dir = makeSkill(root.path, "drive", {
        frontmatter: { model: "sonnet", metadata: { a: 1 } },
        agentsYaml: { claude: { model: "opus", "allowed-tools": ["Bash"], metadata: { b: 2 } } },
      });
      const target = path.join(sandbox.base, "out", "drive");
      const result = renderSkill(sandbox.env, desiredFrom(dir), "claude", target);

      const rendered = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
      const fm = parseYaml(rendered.split("---")[1]!) as Record<string, unknown>;
      expect(fm.model).toBe("opus");
      expect(fm["allowed-tools"]).toEqual(["Bash"]);
      expect(fm.metadata).toEqual({ a: 1, b: 2 });

      // Canonical order: name, then description, before any dialect extras.
      const keys = Object.keys(fm);
      expect(keys[0]).toBe("name");
      expect(keys[1]).toBe("description");

      expect(result.hash).toBe(hashContent(rendered));
      expect(result.files).toContain("SKILL.md");
      expect(result.files).toContain(path.join("agents", "claude.yaml"));
    } finally {
      sandbox.cleanup();
    }
  });

  test("is deterministic — two renders produce identical bytes and hash", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const dir = makeSkill(root.path, "drive", {
        frontmatter: { model: "sonnet" },
        agentsYaml: { claude: { model: "opus", effort: "high" } },
      });
      const skill = desiredFrom(dir);
      const a = renderSkill(sandbox.env, skill, "claude", path.join(sandbox.base, "a", "drive"));
      const b = renderSkill(sandbox.env, skill, "claude", path.join(sandbox.base, "b", "drive"));
      expect(a.hash).toBe(b.hash);
      expect(fs.readFileSync(path.join(a.path, "SKILL.md"), "utf8")).toBe(
        fs.readFileSync(path.join(b.path, "SKILL.md"), "utf8"),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("preserves the skill body byte-for-byte", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const body = "# Heading\n\nSome prose with a fence:\n\n```sh\necho hi --flag\n```\n";
      const dir = makeSkill(root.path, "drive", {
        body,
        agentsYaml: { claude: { model: "opus" } },
      });
      const target = path.join(sandbox.base, "out", "drive");
      renderSkill(sandbox.env, desiredFrom(dir), "claude", target);
      const rendered = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
      expect(rendered.endsWith(`${body}\n`)).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dialectForDir — registry-derived render channel (replaces the hardcoded maps)
// ─────────────────────────────────────────────────────────────────────────────

import { RENDERER_DIALECTS, dialectForDir } from "../src/render";
import type { Registry } from "../src/types";

function channelRegistry(): Registry {
  const agent = (dialect: "claude" | "spec", ownDir: string, firstParty?: boolean) => ({
    skillsSupport: "supported" as const,
    reads: [ownDir],
    maybeReads: [],
    ownDir,
    dialect,
    symlinks: "followed" as const,
    ...(firstParty ? { firstParty: true } : {}),
    evidence: "fixture",
  });
  return {
    version: 1,
    directories: {
      claude: { path: "~/.claude/skills" },
      variant: { path: "~/.variant/skills" },
      clone: { path: "~/.clone/skills" },
      spec: { path: "~/.spec/skills" },
    },
    agents: {
      "claude-code": agent("claude", "claude", true),
      "super-claude": agent("claude", "variant", true),
      // claude-dialect but NOT firstParty: deliberate symlink-only.
      clone: agent("claude", "clone"),
      // firstParty but a spec dialect: no renderer exists for it.
      speccy: { ...agent("spec", "spec", true) },
    },
  };
}

describe("dialectForDir derivation", () => {
  test("firstParty + renderer dialect owns the channel (including a second claude-dialect dir)", () => {
    const r = channelRegistry();
    expect(dialectForDir(r, "claude")).toBe("claude");
    expect(dialectForDir(r, "variant")).toBe("claude");
  });

  test("renderer dialect without firstParty is deliberate symlink-only", () => {
    expect(dialectForDir(channelRegistry(), "clone")).toBeUndefined();
  });

  test("firstParty with a non-renderer dialect has no channel", () => {
    expect(dialectForDir(channelRegistry(), "spec")).toBeUndefined();
  });

  test("an unowned dir (e.g. shared) has no channel", () => {
    expect(dialectForDir(channelRegistry(), "shared")).toBeUndefined();
  });

  test("the renderer set is exactly claude/copilot/codex", () => {
    expect([...RENDERER_DIALECTS].sort()).toEqual(["claude", "codex", "copilot"]);
  });
});
