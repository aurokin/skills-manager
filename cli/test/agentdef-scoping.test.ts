// AUR-616 deliverable 2: harness include/exclude → allow/deny scoping + hermes opt-in.

import { describe, expect, test } from "bun:test";
import { loadAgentDefinition } from "../src/agentdef/schema";
import { scopingForAgentDef } from "../src/agentdef/scoping";

function def(agentYaml: Record<string, unknown>) {
  return loadAgentDefinition({
    agentYaml: { name: "a", description: "d", ...agentYaml },
    instructionsMd: "body\n",
  });
}

const ENABLED = ["claude-code", "codex", "github-copilot", "opencode", "gemini-cli"];

describe("scopingForAgentDef", () => {
  test("no harness block → unscoped (undefined)", () => {
    expect(scopingForAgentDef(def({}), ENABLED)).toBeUndefined();
  });

  test("harness.include maps keywords to agent ids as an allow list (∩ enabled)", () => {
    const scope = scopingForAgentDef(def({ harness: { include: ["claude", "codex", "copilot"] } }), ENABLED);
    expect(scope).toEqual({ allow: ["claude-code", "codex", "github-copilot"] });
  });

  test("harness.exclude maps to a deny list (hard guarantee, unfiltered)", () => {
    const scope = scopingForAgentDef(def({ harness: { exclude: ["opencode"] } }), ENABLED);
    expect(scope).toEqual({ deny: ["opencode"] });
  });

  test("include ∩ enabled drops a harness not enabled on this machine", () => {
    const scope = scopingForAgentDef(def({ harness: { include: ["claude", "codex"] } }), ["claude-code"]);
    expect(scope).toEqual({ allow: ["claude-code"] });
  });

  test("hermes-skills opt-in adds hermes to allow when hermes is enabled (skill export)", () => {
    const scope = scopingForAgentDef(
      def({ export: "skill", harness: { include: ["claude", "hermes-skills"] } }),
      [...ENABLED, "hermes"],
    );
    expect(scope).toEqual({ allow: ["claude-code", "hermes"] });
  });

  test("hermes-skills opt-in is gated off when hermes is NOT enabled (both required)", () => {
    const scope = scopingForAgentDef(
      def({ export: "skill", harness: { include: ["claude", "hermes-skills"] } }),
      ENABLED,
    );
    expect(scope).toEqual({ allow: ["claude-code"] });
  });

  test("skill-surface/channel keywords do not name a harness agent", () => {
    const scope = scopingForAgentDef(def({ harness: { include: ["agent-skills", "tprompt"] } }), ENABLED);
    expect(scope).toEqual({ allow: [] });
  });

  // Oracle parity: an export:agent definition subtracts the skill-surface keywords
  // before resolving, so they contribute to neither allow nor deny.
  test("export: agent strips skill-surface keywords from an include list", () => {
    const scope = scopingForAgentDef(
      def({ export: "agent", harness: { include: ["claude-skills", "codex"] } }),
      ENABLED,
    );
    // claude-skills is stripped (skill surface); only the codex agent harness remains.
    expect(scope).toEqual({ allow: ["codex"] });
  });

  test("export: agent with only skill-surface keywords in include resolves to an empty allow", () => {
    const scope = scopingForAgentDef(
      def({ export: "agent", harness: { include: ["claude-skills"] } }),
      ENABLED,
    );
    expect(scope).toEqual({ allow: [] });
  });

  test("export: agent does NOT deny the claude harness when excluding claude-skills", () => {
    const scope = scopingForAgentDef(
      def({ export: "agent", harness: { exclude: ["claude-skills"] } }),
      ENABLED,
    );
    // claude-skills is stripped, so the deny list is empty (claude harness survives).
    expect(scope).toEqual({ deny: [] });
  });
});
