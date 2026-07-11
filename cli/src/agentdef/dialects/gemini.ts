// Gemini agent-def dialect (ADR 0009).
//
// Pure AgentDefinition → Document. A 1:1 port of the Python oracle
// `generators/gemini.build_gemini_frontmatter`: key order name, description,
// tools?, model?, temperature?, max_turns?, timeout_mins?, mcpServers?. Note the
// gates use `is not None` (not truthiness), so an explicit empty `tools: []`
// is emitted — matching the formatting-traps golden.

import type { AgentDefinition } from "../schema";
import { doc, float, type Document } from "../../render/doc";
import { plainToDocValue } from "./plain";

export function buildGeminiDocument(agent: AgentDefinition): Document {
  const builder = doc();
  builder.set("name", agent.name);
  builder.set("description", agent.description);
  if (agent.gemini.tools !== undefined) builder.set("tools", plainToDocValue(agent.gemini.tools));
  if (agent.gemini.model) builder.set("model", agent.gemini.model);
  if (agent.gemini.temperature !== undefined) builder.set("temperature", float(agent.gemini.temperature));
  if (agent.gemini.maxTurns !== undefined) builder.set("max_turns", agent.gemini.maxTurns);
  if (agent.gemini.timeoutMins !== undefined) builder.set("timeout_mins", agent.gemini.timeoutMins);
  if (agent.gemini.mcpServers !== undefined) {
    builder.set("mcpServers", plainToDocValue(agent.gemini.mcpServers));
  }
  return builder.build();
}
