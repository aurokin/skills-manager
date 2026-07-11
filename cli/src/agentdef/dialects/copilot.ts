// agentdef-copilot-md dialect (ADR 0009).
//
// Pure function AgentDefinition → Document, a 1:1 port of
// custom_agents/src/shared_agents/generators/copilot.py `build_copilot_frontmatter`.
// It owns the hyphenated key renames (`disable-model-invocation`, `mcp-servers`,
// `argument-hint`), the target-gated field selection (vscode vs github-copilot),
// and the resolved-model default; the yaml-pyyaml-compat emitter owns bytes.

import type { AgentDefinition } from "../schema";
import { doc, list, type Document } from "../../render/doc";
import { plainToDocument, plainToDocValue } from "./codex";

const COPILOT_VSCODE_TARGET = "vscode";

/** Build the copilot frontmatter Document (port of `build_copilot_frontmatter`). */
export function buildCopilotDocument(def: AgentDefinition): Document {
  const emitDefaults = def.shouldEmitModelDefaults();
  const c = def.copilot;
  const b = doc();
  b.set("name", def.name);
  b.set("description", def.description);

  if (c.target) b.set("target", c.target);
  if (c.tools !== undefined) b.set("tools", list(c.tools));
  if (c.agents !== undefined) b.set("agents", plainToDocValue(c.agents));

  const model = emitDefaults ? def.resolvedCopilotModel() : c.model;
  if (model !== undefined) b.set("model", plainToDocValue(model));

  if (c.disableModelInvocation !== undefined) {
    b.set("disable-model-invocation", c.disableModelInvocation);
  }
  if (c.userInvocable !== undefined) b.set("user-invocable", c.userInvocable);
  if (c.infer !== undefined) b.set("infer", c.infer);
  if (c.mcpServers !== undefined) b.set("mcp-servers", plainToDocValue(c.mcpServers));

  if (c.target !== COPILOT_VSCODE_TARGET && Object.keys(c.metadata).length > 0) {
    b.set("metadata", plainToDocument(c.metadata));
  }
  if (c.target === COPILOT_VSCODE_TARGET && c.argumentHint) {
    b.set("argument-hint", c.argumentHint);
  }
  if (c.target === COPILOT_VSCODE_TARGET && c.handoffs.length > 0) {
    b.set("handoffs", plainToDocValue(c.handoffs));
  }
  // c.hooks is never `{}` here: the schema normalizes an empty mapping to
  // undefined (mirroring the oracle's `_optional_mapping(...) or None`), so
  // this truthiness gate matches Python for every valid AgentDefinition.
  if (c.target === COPILOT_VSCODE_TARGET && c.hooks) {
    b.set("hooks", plainToDocValue(c.hooks));
  }

  return b.build();
}
