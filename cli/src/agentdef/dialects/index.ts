// Agent-def dialect registry + `renderAgentDef` composition helper (ADR 0009).
//
// A dialect is a pure `AgentDefinition → Document` builder. `renderAgentDef`
// composes it with the emitter bound to that dialect (see render/emit.ts) and
// wraps the result with the instructions body. Two wrap shapes exist:
//   - frontmatter (claude/cursor/copilot/opencode/gemini): the emitted YAML is
//     fenced and the body follows — `---\n{yaml}\n---\n\n{body}\n`, mirroring the
//     Python generators' `f"---\n{yaml.strip()}\n---\n\n{body}\n"`.
//   - full-document (codex): the dialect embeds the body inside the Document
//     (e.g. `developer_instructions`), so the emitted bytes are the whole file.
//
// Only the dialects implemented here are registered. Sibling dialects
// (codex/copilot/opencode) register their builder in this map as they land;
// `renderAgentDef` already knows codex is full-document so no edit to the
// wrapping is needed when its builder is added.

import type { AgentDefinition } from "../schema";
import type { Document } from "../../render/doc";
import { emitterFor, type DialectName } from "../../render/emit";
import { buildClaudeDocument } from "./claude";
import { buildCodexDocument } from "./codex";
import { buildCopilotDocument } from "./copilot";
import { buildCursorDocument } from "./cursor";
import { buildGeminiDocument } from "./gemini";
import { buildOpencodeDocument } from "./opencode";

export { buildClaudeDocument } from "./claude";
export { buildCodexDocument } from "./codex";
export { buildCopilotDocument } from "./copilot";
export { buildCursorDocument } from "./cursor";
export { buildGeminiDocument } from "./gemini";
export { buildOpencodeDocument } from "./opencode";

/** A pure dialect builder. */
export type DialectBuilder = (agent: AgentDefinition) => Document;

/** Dialects whose emitted document IS the whole file (body embedded, no fence). */
const FULL_DOCUMENT_DIALECTS = new Set<DialectName>(["agentdef-codex-toml"]);

/** Registered `AgentDefinition → Document` builders, keyed by dialect. */
export const DIALECT_BUILDERS: Partial<Record<DialectName, DialectBuilder>> = {
  "agentdef-claude-md": buildClaudeDocument,
  "agentdef-codex-toml": buildCodexDocument,
  "agentdef-copilot-md": buildCopilotDocument,
  "agentdef-cursor-md": buildCursorDocument,
  "agentdef-gemini-md": buildGeminiDocument,
  "agentdef-opencode-md": buildOpencodeDocument,
};

/** Render an agent definition for one dialect: build → emit → wrap. */
export function renderAgentDef(agent: AgentDefinition, dialect: DialectName): string {
  const builder = DIALECT_BUILDERS[dialect];
  if (!builder) {
    throw new Error(`No dialect builder registered for ${dialect}`);
  }
  const document = builder(agent);
  const emitted = emitterFor(dialect).emit(document);
  if (FULL_DOCUMENT_DIALECTS.has(dialect)) {
    return emitted;
  }
  const yamlBlock = emitted.replace(/\n+$/, "");
  const body = agent.instructions.replace(/\n+$/, "");
  return `---\n${yamlBlock}\n---\n\n${body}\n`;
}
