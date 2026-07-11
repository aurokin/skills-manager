// Agent-definition rendering + placement helpers (AUR-616). Bridges the AUR-615
// dialect pipeline (renderAgentDef / renderDerivedSkill) to the plan/apply engine:
// per-dialect file extension + DialectName, plus content/hash producers that
// reload the definition from its source dir (so apply --plan re-renders from the
// current source and refuses tampered bytes, mirroring the skill rendered path).

import { hashContent } from "../render";
import type { AgentDefDialect } from "../types";
import { renderAgentDef } from "./dialects";
import { renderDerivedSkill } from "./dialects/derived-skill";
import type { DialectName } from "../render/emit";
import { loadAgentDefinitionFromDir } from "./source";

/** Per-dialect binding: which emitter dialect renders it, and the target extension. */
const DIALECT_INFO: Record<AgentDefDialect, { dialect: DialectName; ext: string }> = {
  claude: { dialect: "agentdef-claude-md", ext: ".md" },
  codex: { dialect: "agentdef-codex-toml", ext: ".toml" },
  copilot: { dialect: "agentdef-copilot-md", ext: ".agent.md" },
  cursor: { dialect: "agentdef-cursor-md", ext: ".md" },
  opencode: { dialect: "agentdef-opencode-md", ext: ".md" },
  gemini: { dialect: "agentdef-gemini-md", ext: ".md" },
};

/** File extension for a rendered agent-definition of the given dialect. */
export function agentDefExt(dialect: AgentDefDialect): string {
  return DIALECT_INFO[dialect].ext;
}

/** Render the native agent-definition file content for one harness dialect. */
export function renderAgentDefFile(sourceDir: string, dialect: AgentDefDialect): string {
  return renderAgentDef(loadAgentDefinitionFromDir(sourceDir), DIALECT_INFO[dialect].dialect);
}

/** sha256 of the rendered agent-definition file (deletion-safety ownership). */
export function agentDefFileHash(sourceDir: string, dialect: AgentDefDialect): string {
  return hashContent(renderAgentDefFile(sourceDir, dialect));
}

/** Render the derived-skill SKILL.md text from an agent definition (render-only). */
export function renderDerivedSkillMd(sourceDir: string, includeHermesMetadata: boolean): string {
  return renderDerivedSkill(loadAgentDefinitionFromDir(sourceDir), { includeHermesMetadata });
}

/** sha256 of the rendered derived-skill SKILL.md. */
export function derivedSkillHash(sourceDir: string, includeHermesMetadata: boolean): string {
  return hashContent(renderDerivedSkillMd(sourceDir, includeHermesMetadata));
}
