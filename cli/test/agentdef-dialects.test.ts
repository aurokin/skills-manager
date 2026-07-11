import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { loadAgentDefinition, type AgentDefinition } from "../src/agentdef/schema";
import {
  buildClaudeDocument,
  buildCursorDocument,
  buildGeminiDocument,
  renderAgentDef,
} from "../src/agentdef/dialects/index";
import type { DialectName } from "../src/render/emit";
import { emitYamlPyyaml } from "../src/render/emit-yaml-pyyaml";

const fixturesDir = `${import.meta.dir}/goldens/fixtures`;
const goldensDir = `${import.meta.dir}/goldens/agent-defs`;

function loadFixture(name: string): AgentDefinition {
  const agentYaml = parseYaml(readFileSync(`${fixturesDir}/${name}/agent.yaml`, "utf8"));
  const instructionsMd = readFileSync(`${fixturesDir}/${name}/instructions.md`, "utf8");
  return loadAgentDefinition({ agentYaml, instructionsMd, sourceDir: name });
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden byte-match: renderAgentDef output equals the committed goldens for
// every agent fixture that has claude/cursor/gemini harness goldens.
// ─────────────────────────────────────────────────────────────────────────────

const DIALECTS: [DialectName, string][] = [
  ["agentdef-claude-md", "claude"],
  ["agentdef-cursor-md", "cursor"],
  ["agentdef-gemini-md", "gemini"],
];

const AGENT_FIXTURES = [
  "codexrabbit-code-reviewer",
  "plan-reviewer",
  "retrorabbit-code-reviewer",
  "kitchen-sink-pinned",
  "kitchen-sink-floating",
  "formatting-traps",
];

describe("golden byte-match", () => {
  for (const fixture of AGENT_FIXTURES) {
    const def = loadFixture(fixture);
    for (const [dialect, harness] of DIALECTS) {
      const goldenPath = `${goldensDir}/${fixture}/${harness}.golden`;
      if (!existsSync(goldenPath)) continue;
      test(`${fixture}/${harness}`, () => {
        expect(renderAgentDef(def, dialect)).toBe(readFileSync(goldenPath, "utf8"));
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude dialect: key order, emit_defaults gating, extra passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("claude dialect", () => {
  test("pinned strategy emits resolved model + effort defaults", () => {
    const def = loadFixture("formatting-traps"); // pinned, no explicit claude.model
    const d = buildClaudeDocument(def);
    const keys = d.entries.map((e) => e.key);
    expect(keys).toEqual(["name", "description", "tools", "model", "effort"]);
    const model = d.entries.find((e) => e.key === "model")!.value;
    const effort = d.entries.find((e) => e.key === "effort")!.value;
    expect(model).toBe("opus-4.7");
    expect(effort).toBe("high");
  });

  test("floating strategy omits model and effort when unset", () => {
    const def = loadFixture("kitchen-sink-floating"); // floating, no claude.model/effort
    const keys = buildClaudeDocument(def).entries.map((e) => e.key);
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("effort");
  });

  test("extra keys are appended in insertion order after mcpServers", () => {
    const def = loadFixture("kitchen-sink-pinned");
    const keys = buildClaudeDocument(def).entries.map((e) => e.key);
    // ...mcpServers, then the two extra keys in YAML order.
    expect(keys.slice(-3)).toEqual(["mcpServers", "background", "extraNested"]);
  });

  test("list-form mcp_servers is preserved as a list", () => {
    const def = loadFixture("kitchen-sink-floating");
    const mcp = buildClaudeDocument(def).entries.find((e) => e.key === "mcpServers")!.value;
    expect(emitYamlPyyaml(buildClaudeDocument(def))).toContain("mcpServers:\n- github");
    expect(mcp).toEqual({ kind: "list", items: ["github"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor dialect: description fallback + resolved readonly
// ─────────────────────────────────────────────────────────────────────────────

describe("cursor dialect", () => {
  test("cursor.description overrides the shared description", () => {
    const def = loadFixture("kitchen-sink-pinned"); // has cursor.description
    const desc = buildCursorDocument(def).entries.find((e) => e.key === "description")!.value;
    expect(desc).toBe("Cursor-specific kitchen-sink blurb");
  });

  test("falls back to the shared description and defaults readonly from sandbox", () => {
    const def = loadFixture("formatting-traps"); // no cursor block, sandbox read-only
    const d = buildCursorDocument(def);
    const desc = d.entries.find((e) => e.key === "description")!.value;
    const readonly = d.entries.find((e) => e.key === "readonly")!.value;
    expect(desc).toBe(def.description);
    expect(readonly).toBe(true);
  });

  test("explicit readonly:false is emitted (is-not-None, not truthy)", () => {
    const def = loadFixture("kitchen-sink-pinned"); // cursor.readonly: false
    const readonly = buildCursorDocument(def).entries.find((e) => e.key === "readonly")!.value;
    expect(readonly).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gemini dialect: empty tools list is emitted, snake_case keys
// ─────────────────────────────────────────────────────────────────────────────

describe("gemini dialect", () => {
  test("explicit empty tools list is emitted (is-not-None)", () => {
    const def = loadFixture("formatting-traps"); // gemini.tools: []
    const d = buildGeminiDocument(def);
    const tools = d.entries.find((e) => e.key === "tools")!.value;
    expect(tools).toEqual({ kind: "list", items: [] });
  });

  test("full field set uses snake_case scalar keys", () => {
    const def = loadFixture("kitchen-sink-pinned");
    const keys = buildGeminiDocument(def).entries.map((e) => e.key);
    expect(keys).toEqual([
      "name",
      "description",
      "tools",
      "model",
      "temperature",
      "max_turns",
      "timeout_mins",
      "mcpServers",
    ]);
  });

  // Regression: `_optional_number` coerces to float, so an integer temperature
  // must render as `0.0`, not `0` (gemini-temperature-float-coercion).
  test("integer temperature renders as a float", () => {
    const def = loadAgentDefinition({
      agentYaml: {
        name: "temp-agent",
        description: "d",
        gemini: { temperature: 0 },
      },
      instructionsMd: "body\n",
    });
    expect(emitYamlPyyaml(buildGeminiDocument(def))).toContain("temperature: 0.0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderAgentDef wrapping + registry
// ─────────────────────────────────────────────────────────────────────────────

describe("renderAgentDef", () => {
  test("wraps frontmatter with a blank line and a single trailing newline", () => {
    const def = loadFixture("plan-reviewer");
    const out = renderAgentDef(def, "agentdef-claude-md");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("\n---\n\n");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  test("throws for a dialect with no registered builder", () => {
    const def = loadFixture("plan-reviewer");
    // All six agent-def dialects are registered (AUR-616); a non-agent-def dialect
    // (e.g. the tprompt prompt surface) has no AgentDefinition→Document builder.
    expect(() => renderAgentDef(def, "prompt-tprompt")).toThrow(
      "No dialect builder registered for prompt-tprompt",
    );
  });
});
