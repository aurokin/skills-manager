// Derived-skill dialect (ADR 0009): AgentDefinition → skill SKILL.md.
//
// Pure port of custom_agents `shared_agents.generators.skills.render_skill`:
// the "export: skill" path that turns an agent definition into a standalone
// skill. Dialects own structure only — this builds a frontmatter Document plus
// the markdown body shape; the yaml-canonical emitter owns the bytes.
//
// Two declared substitutions vs the Python oracle (ADR 0007 renames the
// generator strings, so these are NOT byte-equal to the goldens — they are
// semantically equal after normalization):
//   - metadata.source and metadata.hermes.generated_by: "custom_agents" → "skm"
//   - Source Notes wording: "shared agent" → "agent definition"

import type { AgentDefinition } from "../schema";
import { normalizeSkillName } from "../schema";
import type { Document, DocValue } from "../../render/doc";
import { doc, list } from "../../render/doc";
import { frontmatterDocument } from "../../render/emit-yaml-canonical";

/** Generator identity string (was "custom_agents" in the oracle; ADR 0007). */
const SOURCE = "skm";

export interface DerivedSkillOptions {
  /** Add `metadata.hermes` (the hermes-skills surface). */
  includeHermesMetadata?: boolean;
}

/** Normalized skill name: `skill.name` when set, else the agent name. */
export function deriveSkillName(agent: AgentDefinition): string {
  return normalizeSkillName(agent.skill.name || agent.name);
}

/** Title-case a hyphenated name: "review-helper" → "Review Helper". */
function defaultTitle(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Build the skill frontmatter Document (mirrors `build_skill_frontmatter`). */
export function buildDerivedSkillFrontmatter(
  agent: AgentDefinition,
  options: DerivedSkillOptions = {},
): Document {
  const name = deriveSkillName(agent);
  const fm = doc();
  fm.set("name", name);
  fm.set("description", agent.skill.description || agent.description);
  fm.setIf("license", agent.skill.license);
  if (agent.skill.compatibility !== undefined) {
    fm.set("compatibility", toDocValue(agent.skill.compatibility));
  }
  if (agent.skill.tags && agent.skill.tags.length > 0) {
    fm.set("tags", list(agent.skill.tags));
  }

  const metadata = doc();
  metadata.set("source", SOURCE);
  metadata.set("original_name", agent.name);
  metadata.merge(agent.skill.metadata);
  if (options.includeHermesMetadata) {
    metadata.set(
      "hermes",
      doc().set("generated_by", SOURCE).set("source_agent", agent.name).build(),
    );
  }
  fm.set("metadata", metadata.build());

  return fm.build();
}

/** Build the markdown body (after the frontmatter fence). */
export function buildDerivedSkillBody(agent: AgentDefinition): string {
  const name = deriveSkillName(agent);
  const title = agent.skill.title || defaultTitle(name);
  const instructionsBody = agent.instructions.replace(/\n+$/, "");
  const sandboxNote =
    `This skill was generated from the \`${agent.name}\` agent definition. ` +
    `The source agent declares \`${agent.sandbox}\` sandbox expectations, ` +
    "but skill consumers must enforce permissions themselves.";
  return (
    `# ${title}\n\n` +
    "## Instructions\n\n" +
    `${instructionsBody}\n\n` +
    "## Source Notes\n\n" +
    sandboxNote
  );
}

/** Render the full SKILL.md for the skill-export surface (yaml-canonical). */
export function renderDerivedSkill(
  agent: AgentDefinition,
  options: DerivedSkillOptions = {},
): string {
  return frontmatterDocument(
    buildDerivedSkillFrontmatter(agent, options),
    buildDerivedSkillBody(agent),
  );
}

/** `compatibility` is a scalar string or a list of strings. */
function toDocValue(value: string | string[]): DocValue {
  return Array.isArray(value) ? list(value) : value;
}
