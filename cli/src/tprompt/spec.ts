// Shared tprompt-block helpers (ADR 0008). Both artifact types can declare a
// `tprompt:` block; agent definitions parse it via the schema loader, and skills
// parse their SKILL.md frontmatter block through the SAME validator so the field
// rules stay identical. This module owns the block→filename/stem mapping and the
// tprompt naming constants.

import { loadTpromptConfig, type TpromptConfig } from "../agentdef/schema";

/** Collision-guard suffix segregating skm-exported prompts from hand-authored ones. */
export const TPROMPT_SUFFIX = "-ca";

/** Footer appended to agent-definition-derived prompts only (ADR 0008 §4). */
export const SUBAGENT_FOOTER = "Do not use subagents for this specific request.";

const WORD_SPLIT_RE = /[-_]+/;

/**
 * Parse the optional `tprompt:` block from an already-parsed SKILL.md frontmatter
 * mapping, using the shared schema validator. Returns a config whose `enabled`
 * flag reports whether the block was present. Throws SchemaError on an invalid
 * block (unknown keys, wrong types, bad filename).
 */
export function parseSkillTpromptBlock(frontmatter: unknown, label: string): TpromptConfig {
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    return { enabled: false };
  }
  return loadTpromptConfig(frontmatter as Record<string, unknown>, label);
}

/** Prompt id / filename stem: `<tprompt.filename or artifact name>` + `-ca`. */
export function tpromptStem(cfg: TpromptConfig, artifactName: string): string {
  return `${cfg.filename ?? artifactName}${TPROMPT_SUFFIX}`;
}

/** Title-case a hyphen/underscore name: "code-review" → "Code Review" (oracle `_default_title`). */
export function defaultTitle(name: string): string {
  return name
    .split(WORD_SPLIT_RE)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
