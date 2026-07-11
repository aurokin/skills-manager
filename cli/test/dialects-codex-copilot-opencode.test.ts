// Golden + structural tests for the codex/copilot/opencode agent-def dialects
// (ADR 0009). Each dialect is a pure AgentDefinition → Document; here we compose
// it with its bound emitter (+ the markdown envelope for the two YAML dialects)
// and assert byte-equality against the oracle-generated goldens under
// test/goldens/agent-defs/. Structural tests pin the specific quirks the port
// must preserve (codex scalar float-up ordering, copilot target gating + model
// default omission, opencode's absent name key + resolved permission).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadAgentDefinition, type AgentDefinition } from "../src/agentdef/schema";
import { buildCodexDocument } from "../src/agentdef/dialects/codex";
import { buildCopilotDocument } from "../src/agentdef/dialects/copilot";
import { buildOpencodeDocument } from "../src/agentdef/dialects/opencode";
import { emitTomlCodex } from "../src/render/emit-toml-codex";
import { emitYamlPyyaml } from "../src/render/emit-yaml-pyyaml";
import type { Document } from "../src/render/doc";

const GOLDENS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "goldens");

const FIXTURES = [
  "codexrabbit-code-reviewer",
  "plan-reviewer",
  "retrorabbit-code-reviewer",
  "kitchen-sink-pinned",
  "kitchen-sink-floating",
  "formatting-traps",
];

function loadFixture(name: string): AgentDefinition {
  const dir = path.join(GOLDENS, "fixtures", name);
  const agentYaml = parse(fs.readFileSync(path.join(dir, "agent.yaml"), "utf8"));
  const instructionsMd = fs.readFileSync(path.join(dir, "instructions.md"), "utf8");
  return loadAgentDefinition({ agentYaml, instructionsMd, sourceDir: dir });
}

function golden(name: string, harness: string): string {
  return fs.readFileSync(path.join(GOLDENS, "agent-defs", name, `${harness}.golden`), "utf8");
}

// codex: the whole artifact is the TOML emitter output, rstrip()+"\n"
// (render_codex_agent). No frontmatter fence — the body is embedded as the
// triple-quoted `developer_instructions` field.
function renderCodex(def: AgentDefinition): string {
  return emitTomlCodex(buildCodexDocument(def)).replace(/\s+$/, "") + "\n";
}

// copilot/opencode: `---\n{yaml}\n---\n\n{body}\n` with body = instructions
// rstripped of newlines (render_copilot_agent / render_opencode_agent). The
// pyyaml emitter already strips its block.
function renderMarkdown(def: AgentDefinition, document: Document): string {
  const yaml = emitYamlPyyaml(document);
  const body = def.instructions.replace(/\n+$/, "");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

function entries(document: Document): Array<[string, unknown]> {
  return document.entries.map((e) => [e.key, e.value]);
}
function keys(document: Document): string[] {
  return document.entries.map((e) => e.key);
}

describe("agentdef-codex-toml dialect goldens", () => {
  for (const name of FIXTURES) {
    test(name, () => {
      expect(renderCodex(loadFixture(name))).toBe(golden(name, "codex"));
    });
  }
});

describe("agentdef-copilot-md dialect goldens", () => {
  for (const name of FIXTURES) {
    test(name, () => {
      const def = loadFixture(name);
      expect(renderMarkdown(def, buildCopilotDocument(def))).toBe(golden(name, "copilot"));
    });
  }
});

describe("agentdef-opencode-md dialect goldens", () => {
  for (const name of FIXTURES) {
    test(name, () => {
      const def = loadFixture(name);
      expect(renderMarkdown(def, buildOpencodeDocument(def))).toBe(golden(name, "opencode"));
    });
  }
});

describe("codex dialect structure", () => {
  test("insertion order floats codex.config scalars above the mcp_servers/skills tables", () => {
    // The scalar `approval_policy` (from codex.config) is inserted AFTER the
    // mcp_servers/skills mappings, yet the emitter groups scalars first — the
    // quirk lives in the emitter, so the dialect must keep raw insertion order.
    expect(keys(buildCodexDocument(loadFixture("kitchen-sink-pinned")))).toEqual([
      "name",
      "description",
      "developer_instructions",
      "model",
      "model_reasoning_effort",
      "sandbox_mode",
      "nickname_candidates",
      "mcp_servers",
      "skills",
      "approval_policy",
      "extra_table",
    ]);
  });

  test("omits model/reasoning defaults under floating strategy", () => {
    const ks = keys(buildCodexDocument(loadFixture("kitchen-sink-floating")));
    expect(ks).not.toContain("model");
    expect(ks).not.toContain("model_reasoning_effort");
    expect(ks).toContain("sandbox_mode"); // always emitted
  });
});

describe("copilot dialect structure", () => {
  test("emits the resolved model default under pinned strategy", () => {
    const model = buildCopilotDocument(loadFixture("formatting-traps")).entries.find(
      (e) => e.key === "model",
    )?.value;
    expect(model).toBe("gpt-5.5-high");
  });

  test("omits the model default under floating strategy with no explicit model", () => {
    expect(keys(buildCopilotDocument(loadFixture("codexrabbit-code-reviewer")))).not.toContain("model");
  });

  test("target gating selects github vs vscode fields", () => {
    const gh = keys(buildCopilotDocument(loadFixture("kitchen-sink-pinned"))); // github-copilot
    expect(gh).toContain("metadata");
    expect(gh).not.toContain("argument-hint");

    const vs = keys(buildCopilotDocument(loadFixture("kitchen-sink-floating"))); // vscode
    expect(vs).toContain("argument-hint");
    expect(vs).toContain("handoffs");
    expect(vs).toContain("hooks");
    expect(vs).not.toContain("metadata");
  });
});

describe("opencode dialect structure", () => {
  test("never emits a name key", () => {
    for (const name of FIXTURES) {
      expect(keys(buildOpencodeDocument(loadFixture(name)))).not.toContain("name");
    }
  });

  test("description falls back to the shared description", () => {
    const desc = buildOpencodeDocument(loadFixture("codexrabbit-code-reviewer")).entries[0];
    expect(desc?.key).toBe("description");
    expect(desc?.value).toBe(
      "Lightweight code reviewer that emits prioritized, structured findings.",
    );
  });

  test("resolves permission deny for a read-only sandbox", () => {
    const perm = buildOpencodeDocument(loadFixture("formatting-traps")).entries.find(
      (e) => e.key === "permission",
    )?.value as Document;
    expect(entries(perm)).toEqual([
      ["edit", "deny"],
      ["bash", "deny"],
    ]);
  });

  // Regression: `_optional_number` coerces to float, so integer temperature/top_p
  // must render as `1.0`, not `1` (opencode-temperature-topp-float-coercion).
  test("integer temperature and top_p render as floats", () => {
    const def = loadAgentDefinition({
      agentYaml: {
        name: "temp-agent",
        description: "d",
        opencode: { temperature: 1, top_p: 1 },
      },
      instructionsMd: "body\n",
    });
    const yaml = emitYamlPyyaml(buildOpencodeDocument(def));
    expect(yaml).toContain("temperature: 1.0");
    expect(yaml).toContain("top_p: 1.0");
  });
});
