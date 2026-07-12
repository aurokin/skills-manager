// Gated (user-invoked-only) skill rendering (ADR 0011). A skill whose source
// SKILL.md frontmatter carries `disable-model-invocation: true` must never be
// model-invoked. skm translates that one portable intent line into whatever each
// agent enforces and materializes the skill as a rendered tree in the agent's OWN
// dir (never a symlink, never a shared root — the solver owns dir selection). Per
// agent gate:
//   - frontmatter gate  → SKILL.md passes through with disable-model-invocation kept
//                         (plus any per-agent frontmatter merge that already applies);
//   - companion gate    → additionally emit/merge agents/openai.yaml (codex);
//   - permissive opt-in  → SKILL.md as-is (its frontmatter gate is ignored there).
// The placement hash covers ALL rendered files, byte-compatibly with render.ts's
// treeHashOf (the composed-skill tree-hash binding, ADR 0010), so a tampered or
// deleted companion shows as drift exactly like a tampered composed tree.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { GatingError } from "./errors";
import { plainToDocument, renderedSkillMd } from "./render";
import { emitYamlPyyaml } from "./render/emit-yaml-pyyaml";
import type { DesiredSkill, Registry, SkillGate } from "./types";

/** Relative path (posix, `/`-joined) → file bytes for one rendered gated tree. */
export type GatedTree = Record<string, Buffer>;

/** True for a gate skm can actually enforce (not none/unknown/absent). */
export function gateHonored(gate: SkillGate | undefined): boolean {
  return gate !== undefined && gate !== "none" && gate !== "unknown";
}

// First-party dirs whose SKILL.md gets a per-agent frontmatter merge when the skill
// ships the matching agents/<dialect>.yaml. Mirrors solver.ts's renderKind — a gated
// SKILL.md is otherwise copied verbatim (disable-model-invocation preserved as-is).
const FIRST_PARTY_DIR_DIALECT: Record<string, "claude" | "copilot" | "codex"> = {
  claude: "claude",
  copilot: "copilot",
  codex: "codex",
};

/**
 * Render one gated placement's full tree in memory for agent `agentId` into dir `dir`
 * (its ownDir). Copies the source skill dir, overlays the per-agent SKILL.md render
 * (only where a first-party override applies), and — for a companion-gate agent —
 * emits/merges the companion file keyed off the registry gate mechanism string.
 */
export function renderGatedTree(skill: DesiredSkill, agentId: string, dir: string, registry: Registry): GatedTree {
  const tree: GatedTree = {};
  for (const rel of listSourceFiles(skill.source.path)) {
    tree[rel] = fs.readFileSync(path.join(skill.source.path, rel));
  }

  const dialect = FIRST_PARTY_DIR_DIALECT[dir];
  const overridePath = dialect ? skill.overrides[dialect] : undefined;
  if (dialect && overridePath) {
    // Same per-agent frontmatter merge a rendered native placement gets; the source's
    // disable-model-invocation survives the merge unless the override drops it.
    tree["SKILL.md"] = Buffer.from(renderedSkillMd(skill, dialect), "utf8");
  }

  // Companion emitters are keyed off the registry gate mechanism string so a future
  // vendor companion slots in as a new case, not a schema change (ADR 0011).
  const gate = registry.agents[agentId]?.skillInvocation?.gate;
  if (gate === "companion:agents/openai.yaml") {
    tree["agents/openai.yaml"] = Buffer.from(renderOpenaiCompanion(skill.name, tree["agents/openai.yaml"]), "utf8");
  }
  return tree;
}

/**
 * The codex companion (agents/openai.yaml): force `policy.allow_implicit_invocation:
 * false` so the model cannot auto-invoke, while an explicit `$name` mention still
 * works. Merge rule when the source already ships agents/openai.yaml: PRESERVE the
 * author's keys (and key order) but force the flag false. If the author explicitly set
 * it TRUE that contradicts the skill's disable-model-invocation intent → hard error.
 */
function renderOpenaiCompanion(skillName: string, existing?: Buffer): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    const parsed = parseYaml(existing.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    }
  }
  const policyRaw = base.policy;
  const policy: Record<string, unknown> =
    policyRaw && typeof policyRaw === "object" && !Array.isArray(policyRaw)
      ? { ...(policyRaw as Record<string, unknown>) }
      : {};
  if (policy.allow_implicit_invocation === true) {
    throw new GatingError(
      `gated skill '${skillName}' ships agents/openai.yaml with policy.allow_implicit_invocation: true, ` +
        `contradicting its disable-model-invocation intent; remove the flag (skm forces it false)`,
    );
  }
  policy.allow_implicit_invocation = false;
  // Spread preserves the author's key order; reassigning an existing `policy` key keeps
  // its position, and a fresh one is appended (JS object semantics).
  const merged: Record<string, unknown> = { ...base, policy };
  return `${emitYamlPyyaml(plainToDocument(merged))}\n`;
}

/** sha256 over an in-memory gated tree, byte-compatibly with render.ts's treeHashOf. */
export function hashGatedTree(tree: GatedTree): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(tree).sort()) {
    h.update(rel, "utf8");
    h.update("\0");
    h.update(tree[rel]!);
    h.update("\n");
  }
  return `sha256:${h.digest("hex")}`;
}

/** Full-tree hash of a gated skill rendered for one agent (the placement hash). */
export function gatedTreeHash(skill: DesiredSkill, agentId: string, dir: string, registry: Registry): string {
  return hashGatedTree(renderGatedTree(skill, agentId, dir, registry));
}

/** Write a rendered gated tree into `targetDir` (mkdir -p each file's parent). */
export function writeGatedTree(tree: GatedTree, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const rel of Object.keys(tree)) {
    const abs = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tree[rel]!);
  }
}

/** Relative paths of every regular file under `dir` (recursively, sorted). */
function listSourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listSourceFiles(path.join(dir, entry.name), childRel));
    else out.push(childRel);
  }
  return out.sort();
}
