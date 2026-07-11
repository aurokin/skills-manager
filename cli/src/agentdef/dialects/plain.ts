// Shared helpers for the agent-def dialects.
//
// Dialects turn an AgentDefinition into a Document AST. A few AgentDefinition
// fields carry arbitrary parsed-YAML values (claude.mcp_servers, claude.extra,
// gemini.mcp_servers). `plainToDocValue` lifts those plain JS values into the
// AST so the emitter — not the dialect — owns their byte layout, matching how
// the Python generators drop raw dicts straight into the frontmatter mapping.

import { doc, list, type DocValue, type Scalar } from "../../render/doc";

/** Lift a plain parsed-YAML value (scalar / array / object) into a DocValue. */
export function plainToDocValue(value: unknown): DocValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return list(value.map(plainToDocValue));
  if (typeof value === "object") {
    const builder = doc();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      builder.set(key, plainToDocValue(item));
    }
    return builder.build();
  }
  return value as Scalar;
}

/**
 * Python truthiness for the `if agent.x:` gates the generators use on
 * dict/list fields: undefined/null and empty containers are falsy, non-empty
 * containers and truthy scalars are truthy.
 */
export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
