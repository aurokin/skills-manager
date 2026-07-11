// Claude agent-def dialect (ADR 0009).
//
// Pure AgentDefinition → Document. A 1:1 port of the Python oracle
// `generators/claude.build_claude_frontmatter`: same key order (name,
// description, tools, disallowedTools, model?, permissionMode, maxTurns,
// effort?, skills, mcpServers, **extra) and the same `emit_defaults` gating on
// model/effort. Bytes (PyYAML wrapping/escaping) belong to the bound emitter.

import type { AgentDefinition } from "../schema";
import { doc, type Document } from "../../render/doc";
import { isTruthy, plainToDocValue } from "./plain";

export function buildClaudeDocument(agent: AgentDefinition): Document {
  const emitDefaults = agent.shouldEmitModelDefaults();
  const builder = doc();
  builder.set("name", agent.name);
  builder.set("description", agent.description);
  if (agent.claude.tools && agent.claude.tools.length > 0) {
    builder.set("tools", plainToDocValue(agent.claude.tools));
  }
  if (agent.claude.disallowedTools && agent.claude.disallowedTools.length > 0) {
    builder.set("disallowedTools", plainToDocValue(agent.claude.disallowedTools));
  }
  const model = emitDefaults ? agent.resolvedClaudeModel() : agent.claude.model;
  if (model) builder.set("model", model);
  if (agent.claude.permissionMode) builder.set("permissionMode", agent.claude.permissionMode);
  if (agent.claude.maxTurns !== undefined) builder.set("maxTurns", agent.claude.maxTurns);
  const effort = emitDefaults ? agent.resolvedClaudeEffort() : agent.claude.effort;
  if (effort) builder.set("effort", effort);
  if (agent.skills.length > 0) builder.set("skills", plainToDocValue(agent.skills));
  if (isTruthy(agent.claude.mcpServers)) {
    builder.set("mcpServers", plainToDocValue(agent.claude.mcpServers));
  }
  for (const [key, value] of Object.entries(agent.claude.extra)) {
    builder.set(key, plainToDocValue(value));
  }
  return builder.build();
}
