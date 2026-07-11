// agentdef-opencode-md dialect (ADR 0009).
//
// Pure function AgentDefinition → Document, a 1:1 port of
// custom_agents/src/shared_agents/generators/opencode.py
// `build_opencode_frontmatter`. Distinctive traits it owns: NO `name` key, a
// `description` with fallback to the shared description, resolved `mode`
// (default `subagent`) and `permission` (sandbox read-only → edit/bash deny),
// the `tools` bool-map, and trailing `**options` spread. The yaml-pyyaml-compat
// emitter owns bytes.

import type { AgentDefinition } from "../schema";
import { doc, float, type Document } from "../../render/doc";
import { plainToDocument, plainToDocValue } from "./codex";

/** Build the opencode frontmatter Document (port of `build_opencode_frontmatter`). */
export function buildOpencodeDocument(def: AgentDefinition): Document {
  const o = def.opencode;
  const b = doc();
  // `||` mirrors the oracle's truthiness fallback (opencode.py); the schema
  // rejects empty strings, so the two operators only differ defensively.
  b.set("description", o.description || def.description);
  b.set("mode", def.resolvedOpencodeMode());

  if (o.model) b.set("model", o.model);
  if (o.variant) b.set("variant", o.variant);
  if (o.temperature !== undefined) b.set("temperature", float(o.temperature));
  if (o.topP !== undefined) b.set("top_p", float(o.topP));
  if (o.disable !== undefined) b.set("disable", o.disable);
  if (o.hidden !== undefined) b.set("hidden", o.hidden);
  if (o.color) b.set("color", o.color);
  if (o.steps !== undefined) b.set("steps", o.steps);

  const permission = def.resolvedOpencodePermission();
  if (permission !== undefined) b.set("permission", plainToDocValue(permission));

  if (o.tools !== undefined) b.set("tools", plainToDocument(o.tools));

  for (const [key, value] of Object.entries(o.options)) {
    b.set(key, plainToDocValue(value));
  }

  return b.build();
}
