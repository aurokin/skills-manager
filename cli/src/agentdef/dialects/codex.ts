// agentdef-codex-toml dialect (ADR 0009).
//
// Pure function AgentDefinition → Document, a 1:1 port of
// custom_agents/src/shared_agents/generators/codex.py `build_codex_document`
// (+ its `_merge_skills_config`). It owns field selection, ordering, resolved
// defaults, and the skills-config merge; it never builds bytes. The Document is
// serialized by the toml-codex-compat emitter, which reproduces the Python
// serializer's scalars→tables→arrays-of-tables partition and quoting.
//
// The document is built in the SAME insertion order as the Python dict so the
// emitter's group-by-type pass yields byte-identical TOML (e.g. a `codex.config`
// scalar like `approval_policy` inserted after the `mcp_servers`/`skills` tables
// floats up above their `[header]`s — a quirk owned by the emitter, not here).

import type { AgentDefinition } from "../schema";
import {
  doc,
  list,
  tableArray,
  textBlock,
  type DocValue,
  type Document,
} from "../../render/doc";

/** Build the codex-TOML Document (port of `build_codex_document`). */
export function buildCodexDocument(def: AgentDefinition): Document {
  const emitDefaults = def.shouldEmitModelDefaults();
  const b = doc();
  b.set("name", def.name);
  b.set("description", def.description);
  b.set("developer_instructions", textBlock(def.instructions));

  const model = emitDefaults ? def.resolvedCodexModel() : def.codex.model;
  if (model) b.set("model", model);
  const reasoningEffort = emitDefaults
    ? def.resolvedCodexReasoningEffort()
    : def.codex.modelReasoningEffort;
  if (reasoningEffort) b.set("model_reasoning_effort", reasoningEffort);

  b.set("sandbox_mode", def.resolvedCodexSandboxMode());

  const nicknames = def.codex.nicknameCandidates;
  if (nicknames && nicknames.length > 0) {
    b.set("nickname_candidates", list(nicknames.map((item) => item.trim())));
  }
  if (def.codex.mcpServers) {
    b.set("mcp_servers", plainToDocValue(def.codex.mcpServers));
  }

  const skillsConfig = mergeSkillsConfig(def);
  if (skillsConfig.length > 0) {
    b.set("skills", doc().set("config", tableArray(skillsConfig.map(plainToDocument))).build());
  }

  for (const [key, value] of Object.entries(def.codex.config)) {
    if (b.has(key)) {
      throw new Error(`codex.config key collides with reserved field: ${key}`);
    }
    b.set(key, plainToDocValue(value));
  }

  return b.build();
}

/**
 * Port of codex.py `_merge_skills_config`: `defaults.skills` become
 * `{name, enabled: true}` entries, then `codex.skills_config` entries are
 * appended, deduped by path (if present) else name, merging (dict.update) into
 * an existing entry on collision.
 */
function mergeSkillsConfig(def: AgentDefinition): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const skillName of def.skills) {
    merged.push({ name: skillName, enabled: true });
    seen.add(entryKey("name", skillName));
  }
  for (const entry of def.codex.skillsConfig) {
    const copied = { ...entry };
    const key =
      "path" in copied ? entryKey("path", copied.path) : entryKey("name", copied.name);
    if (seen.has(key)) {
      for (const existing of merged) {
        const existingKey =
          "path" in existing ? entryKey("path", existing.path) : entryKey("name", existing.name);
        if (existingKey === key) {
          Object.assign(existing, copied);
          break;
        }
      }
      continue;
    }
    merged.push(copied);
    seen.add(key);
  }
  return merged;
}

// A NUL join keeps ("name", x) and ("path", x) distinct as in the Python tuple key.
function entryKey(kind: "name" | "path", value: unknown): string {
  return `${kind}\u0000${String(value)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain (parsed-YAML) value → Document AST
//
// Shared by all three dialects in this batch (imported from here). Mirrors the
// Python serializers' structural view of a parsed mapping: a mapping → Document,
// a non-empty list whose items are all mappings → TableArray (TOML array-of-
// tables; a YAML sequence-of-mappings), any other list → DocList, scalars pass
// through. `null` passes through as a scalar (valid in YAML; the TOML emitter
// raises on it, matching Python's `_format_value(None)` TypeError).
// ─────────────────────────────────────────────────────────────────────────────

export function plainToDocument(record: Record<string, unknown>): Document {
  const b = doc();
  for (const [key, value] of Object.entries(record)) {
    b.set(key, plainToDocValue(value));
  }
  return b.build();
}

export function plainToDocValue(value: unknown): DocValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isMapping)) {
      return tableArray(value.map((item) => plainToDocument(item as Record<string, unknown>)));
    }
    return list(value.map(plainToDocValue));
  }
  if (isMapping(value)) return plainToDocument(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Unsupported dialect value: ${JSON.stringify(value)}`);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
