import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { loadAgentDefinition, type AgentDefinition } from "../src/agentdef/schema";
import {
  buildDerivedSkillBody,
  buildDerivedSkillFrontmatter,
  deriveSkillName,
  renderDerivedSkill,
} from "../src/agentdef/dialects/derived-skill";

const GOLDENS = join(import.meta.dir, "goldens");

// ─────────────────────────────────────────────────────────────────────────────
// Fixture loading
// ─────────────────────────────────────────────────────────────────────────────

/** Load a golden fixture into an AgentDefinition (matches the oracle loader). */
function loadFixture(name: string): AgentDefinition {
  const dir = join(GOLDENS, "fixtures", name);
  const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf8"));
  const instructionsMd = readFileSync(join(dir, "instructions.md"), "utf8");
  return loadAgentDefinition({ agentYaml, instructionsMd, sourceDir: dir });
}

function golden(fixture: string, harness: string): string {
  return readFileSync(join(GOLDENS, "agent-defs", fixture, `${harness}.golden`), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic comparator (ADR 0009: skill export is semantic-equal, not byte-equal)
//
// The dialect binds to the yaml-canonical emitter, whose bytes differ from the
// PyYAML goldens (quoting/wrapping), and it applies the ADR 0007 renames. So we
// parse both sides and compare after normalizing the DECLARED substitutions:
//   metadata.source / metadata.hermes.generated_by: "custom_agents" -> "skm"
//   body wording: "shared agent" -> "agent definition"
// ─────────────────────────────────────────────────────────────────────────────

function splitSkillDoc(text: string): { fm: unknown; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`not a skill doc: ${JSON.stringify(text.slice(0, 40))}`);
  return { fm: parseYaml(match[1]!), body: match[2]! };
}

/** Rewrite a golden's frontmatter + body so it should equal our dialect output. */
function normalizeGolden(text: string): { fm: unknown; body: string } {
  const { fm, body } = splitSkillDoc(text);
  const meta = (fm as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
  if (meta) {
    if (meta.source === "custom_agents") meta.source = "skm";
    const hermes = meta.hermes as Record<string, unknown> | undefined;
    if (hermes && hermes.generated_by === "custom_agents") hermes.generated_by = "skm";
  }
  return { fm, body: body.replace("shared agent", "agent definition") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden semantic equality
// ─────────────────────────────────────────────────────────────────────────────

describe("renderDerivedSkill — semantic equality vs goldens", () => {
  const cases: Array<[string, boolean]> = [
    ["agent-skills", false],
    ["claude-skills", false],
    ["hermes-skills", true],
  ];

  for (const [harness, hermes] of cases) {
    test(`${harness} matches the normalized golden`, () => {
      const agent = loadFixture("skill-export-demo");
      const actual = splitSkillDoc(renderDerivedSkill(agent, { includeHermesMetadata: hermes }));
      const expected = normalizeGolden(golden("skill-export-demo", harness));
      expect(actual.fm).toEqual(expected.fm);
      expect(actual.body).toBe(expected.body);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter structure
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDerivedSkillFrontmatter", () => {
  test("skill-block fields, ordering, and skm-renamed metadata source", () => {
    const agent = loadFixture("skill-export-demo");
    const fm = buildDerivedSkillFrontmatter(agent);
    expect(fm.entries.map((e) => e.key)).toEqual([
      "name",
      "description",
      "license",
      "compatibility",
      "tags",
      "metadata",
    ]);
    const meta = fm.entries.find((e) => e.key === "metadata")!.value as unknown as {
      entries: { key: string; value: unknown }[];
    };
    // metadata: source, original_name, then skill.metadata (owner, tier) in order.
    expect(meta.entries.map((e) => e.key)).toEqual([
      "source",
      "original_name",
      "owner",
      "tier",
    ]);
    expect(meta.entries[0]!.value).toBe("skm");
    expect(meta.entries[1]!.value).toBe("skill-export-demo");
  });

  test("name and description fall back to the agent when skill block omits them", () => {
    const agent = loadAgentDefinition({
      agentYaml: {
        name: "my-agent",
        description: "Agent-level description.",
        export: "skill",
      },
      instructionsMd: "Do the thing.\n",
    });
    const fm = buildDerivedSkillFrontmatter(agent);
    expect(deriveSkillName(agent)).toBe("my-agent");
    const byKey = Object.fromEntries(fm.entries.map((e) => [e.key, e.value]));
    expect(byKey.name).toBe("my-agent");
    expect(byKey.description).toBe("Agent-level description.");
    // No license/compatibility/tags when the skill block omits them.
    expect(fm.entries.map((e) => e.key)).toEqual(["name", "description", "metadata"]);
  });

  test("hermes variant appends metadata.hermes with skm generated_by", () => {
    const agent = loadFixture("skill-export-demo");
    const fm = buildDerivedSkillFrontmatter(agent, { includeHermesMetadata: true });
    const meta = fm.entries.find((e) => e.key === "metadata")!.value as unknown as {
      entries: { key: string; value: { entries: { key: string; value: unknown }[] } }[];
    };
    const hermes = meta.entries.find((e) => e.key === "hermes")!.value;
    expect(hermes.entries.map((e) => e.key)).toEqual(["generated_by", "source_agent"]);
    expect(hermes.entries[0]!.value).toBe("skm");
    expect(hermes.entries[1]!.value).toBe("skill-export-demo");
    // hermes is the last metadata key.
    expect(meta.entries[meta.entries.length - 1]!.key).toBe("hermes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Body shape
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDerivedSkillBody", () => {
  test("title / Instructions / Source Notes with agent-definition wording", () => {
    const agent = loadFixture("skill-export-demo");
    const body = buildDerivedSkillBody(agent);
    expect(body).toBe(
      "# Review Helper\n\n" +
        "## Instructions\n\n" +
        "Review the patch carefully before it merges.\n\n" +
        "- Flag correctness, security, and maintainability risks.\n" +
        "- Keep findings prioritized and actionable.\n\n" +
        "## Source Notes\n\n" +
        "This skill was generated from the `skill-export-demo` agent definition. " +
        "The source agent declares `read-only` sandbox expectations, " +
        "but skill consumers must enforce permissions themselves.",
    );
  });

  test("default title title-cases a hyphenated skill name", () => {
    const agent = loadAgentDefinition({
      agentYaml: { name: "code-review-bot", description: "d", export: "skill" },
      instructionsMd: "body\n",
    });
    expect(buildDerivedSkillBody(agent).startsWith("# Code Review Bot\n")).toBe(true);
  });

  test("instructions trailing newlines are stripped before the Source Notes join", () => {
    const agent = loadAgentDefinition({
      agentYaml: { name: "a", description: "d", export: "skill" },
      instructionsMd: "line one\n\n\n",
    });
    expect(buildDerivedSkillBody(agent)).toContain("## Instructions\n\nline one\n\n## Source Notes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full render shape
// ─────────────────────────────────────────────────────────────────────────────

describe("renderDerivedSkill", () => {
  test("wraps frontmatter + body in the ---\\n{yaml}\\n---\\n\\n{body}\\n shape", () => {
    const agent = loadFixture("skill-export-demo");
    const out = renderDerivedSkill(agent);
    expect(out.startsWith("---\nname: review-helper\n")).toBe(true);
    expect(out.includes("\n---\n\n# Review Helper\n")).toBe(true);
    expect(out.endsWith("permissions themselves.\n")).toBe(true);
  });
});
