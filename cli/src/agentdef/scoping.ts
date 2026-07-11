// Harness selection → skm scoping (AUR-616). An agent definition's
// `harness.include` / `harness.exclude` (mutually exclusive, validated by the
// schema) maps onto the same per-artifact allow/deny scoping skills use: `deny`
// stays a hard guarantee, `include` becomes best-effort allow. Owned by the
// resolve team.

import type { AgentDefinition } from "./schema";
import type { AgentScope } from "../types";

/**
 * Harness keyword → skm agent id. Only the six real harnesses plus the hermes
 * opt-in map onto an agent id. The skill-surface/channel selectors
 * (`agent-skills`, `claude-skills`, `tprompt`) do not name a harness agent and
 * are dropped from allow/deny scoping (`claude-skills` collapses to the claude
 * harness so a claude surface still resolves). `hermes-skills` is the per-def
 * hermes opt-in, gated separately by machine-config hermes enablement.
 */
const HARNESS_AGENT: Record<string, string | undefined> = {
  claude: "claude-code",
  "claude-skills": "claude-code",
  codex: "codex",
  copilot: "github-copilot",
  cursor: "cursor",
  opencode: "opencode",
  gemini: "gemini-cli",
  "hermes-skills": "hermes",
  "agent-skills": undefined,
  tprompt: undefined,
};

/** The skm agent id a harness keyword selects, or undefined for non-harness selectors. */
export function agentIdForHarness(keyword: string): string | undefined {
  return HARNESS_AGENT[keyword];
}

/**
 * Skill-surface keywords (mirror of the oracle's SKILL_HARNESS_KEYWORDS). For an
 * `export: agent` definition the oracle strips these from the harness set before
 * resolving — they name a skill surface, not an agent-def harness.
 */
const SKILL_SURFACE_KEYWORDS = new Set(["claude-skills", "agent-skills", "hermes-skills"]);

/** Map a keyword list to the distinct, defined agent ids it selects (order-stable). */
function toAgentIds(keywords: string[]): string[] {
  const out: string[] = [];
  for (const kw of keywords) {
    const id = HARNESS_AGENT[kw];
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Build the AgentScope for one definition, given the enabled agent set.
 *   - `harness.include` → allow-scope = mapped ids ∩ enabled (best-effort). The
 *     hermes opt-in (`include` contains `hermes-skills`) adds `hermes` only when
 *     hermes is enabled — both the per-def opt-in AND machine enablement required,
 *     matching skills semantics.
 *   - `harness.exclude` → deny-scope = mapped ids (a hard guarantee; unfiltered).
 *   - neither → undefined (unscoped): agent export reaches every enabled harness;
 *     a derived skill flows to shared + claude (+ hermes add-only) via the solver.
 */
export function scopingForAgentDef(def: AgentDefinition, enabled: string[]): AgentScope | undefined {
  const enabledSet = new Set(enabled);
  // Oracle parity (resolve_selection, export == "agent"): the skill-surface
  // keywords are subtracted from the harness set for an agent export, so they
  // must contribute to neither allow nor deny. Otherwise include:[claude-skills]
  // would wrongly emit a claude agent-def, and exclude:[claude-skills] would
  // wrongly deny the claude harness — both divergences from the oracle.
  const mapIds = (keywords: string[]): string[] =>
    toAgentIds(def.export === "agent" ? keywords.filter((k) => !SKILL_SURFACE_KEYWORDS.has(k)) : keywords);
  if (def.harness.include) {
    const allow = mapIds(def.harness.include).filter((id) => enabledSet.has(id));
    return { allow };
  }
  if (def.harness.exclude) {
    return { deny: mapIds(def.harness.exclude) };
  }
  return undefined;
}
