import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/resolve";

const repoRoot = path.resolve(import.meta.dir, "../..");

function localSkillFrontmatter(name: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
  const parsed = parseFrontmatter(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`skills/${name}/SKILL.md has no object frontmatter`);
  }
  return parsed as Record<string, unknown>;
}

describe("repository local skills", () => {
  test("bro remains user-invoked-only", () => {
    expect(localSkillFrontmatter("bro")).toMatchObject({
      name: "bro",
      "disable-model-invocation": true,
    });
  });

  test("unslop remains user-invoked-only", () => {
    expect(localSkillFrontmatter("unslop")).toMatchObject({
      name: "unslop",
      "disable-model-invocation": true,
    });
  });

  test("humanizer remains user-invoked-only", () => {
    expect(localSkillFrontmatter("humanizer")).toMatchObject({
      name: "humanizer",
      "disable-model-invocation": true,
    });
  });

  test("ponytail remains user-invoked-only", () => {
    expect(localSkillFrontmatter("ponytail")).toMatchObject({
      name: "ponytail",
      "disable-model-invocation": true,
    });
  });
});
