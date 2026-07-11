// Cursor agent-def dialect (ADR 0009).
//
// Pure AgentDefinition → Document. A 1:1 port of the Python oracle
// `generators/cursor.build_cursor_frontmatter`: key order name, description
// (with cursor.description overriding the shared description), model?, and the
// resolved readonly flag (cursor.readonly, else true when sandbox is read-only).

import type { AgentDefinition } from "../schema";
import { doc, type Document } from "../../render/doc";

export function buildCursorDocument(agent: AgentDefinition): Document {
  const builder = doc();
  builder.set("name", agent.name);
  builder.set("description", agent.cursor.description || agent.description);
  if (agent.cursor.model) builder.set("model", agent.cursor.model);
  const readonly = agent.resolvedCursorReadonly();
  if (readonly !== undefined) builder.set("readonly", readonly);
  return builder.build();
}
