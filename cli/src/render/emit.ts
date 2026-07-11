// Emitter interface + (dialect → emitter) bindings (ADR 0009).
//
// An Emitter is a pure `Document → string` serializer. Emitters are the ONLY
// place byte-format quirks live. Dialects never pick bytes; instead each
// (artifact type × harness surface) dialect is bound to exactly one emitter
// here. Swapping a binding (e.g. pyyaml-compat → canonical after cutover) is a
// one-line change plus a deliberate golden regeneration — never a dialect edit.

import type { Document } from "./doc";
import { yamlCanonicalEmitter } from "./emit-yaml-canonical";
import { yamlPyyamlEmitter } from "./emit-yaml-pyyaml";
import { tomlCodexEmitter } from "./emit-toml-codex";

/** Stable identifier for each concrete emitter. */
export type EmitterName = "yaml-canonical" | "yaml-pyyaml-compat" | "toml-codex-compat";

/** A pure Document → string serializer. */
export interface Emitter {
  readonly name: EmitterName;
  emit(document: Document): string;
}

/** Every dialect surface (artifact type × harness), per ADR 0009 §Decision. */
export type DialectName =
  | "skill-spec"
  | "skill-claude"
  | "agentdef-claude-md"
  | "agentdef-codex-toml"
  | "agentdef-copilot-md"
  | "agentdef-cursor-md"
  | "agentdef-opencode-md"
  | "agentdef-gemini-md"
  | "prompt-tprompt";

/** All concrete emitters, keyed by name. */
export const EMITTERS: Record<EmitterName, Emitter> = {
  "yaml-canonical": yamlCanonicalEmitter,
  "yaml-pyyaml-compat": yamlPyyamlEmitter,
  "toml-codex-compat": tomlCodexEmitter,
};

/**
 * Explicit (dialect → emitter) bindings, pinned by golden tests. During
 * migration the byte-compat emitters back the ported dialects; skm-native
 * formats (skill rendering, tprompt) use the canonical emitter.
 */
export const DIALECT_EMITTER: Record<DialectName, EmitterName> = {
  "skill-spec": "yaml-canonical",
  "skill-claude": "yaml-canonical",
  "agentdef-claude-md": "yaml-pyyaml-compat",
  "agentdef-codex-toml": "toml-codex-compat",
  "agentdef-copilot-md": "yaml-pyyaml-compat",
  "agentdef-cursor-md": "yaml-pyyaml-compat",
  "agentdef-opencode-md": "yaml-pyyaml-compat",
  "agentdef-gemini-md": "yaml-pyyaml-compat",
  "prompt-tprompt": "yaml-canonical",
};

/** Resolve the Emitter bound to a dialect. */
export function emitterFor(dialect: DialectName): Emitter {
  return EMITTERS[DIALECT_EMITTER[dialect]];
}
