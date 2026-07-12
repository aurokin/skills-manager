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
import { readersOf } from "./registry";
import { plainToDocument, renderedSkillMd } from "./render";
import { emitYamlPyyaml } from "./render/emit-yaml-pyyaml";
import type { DesiredSkill, Registry, SkillGate } from "./types";

/** Relative path (posix, `/`-joined) → file bytes for one rendered gated tree. */
export type GatedTree = Record<string, Buffer>;

/** True for a gate skm can actually enforce (not none/unknown/absent). */
export function gateHonored(gate: SkillGate | undefined): boolean {
  return gate !== undefined && gate !== "none" && gate !== "unknown";
}

/**
 * Gated-exposure set for one placement dir: agents (≠ the target) that read OR
 * maybe-read `dirId`, whose gate is none/unknown/absent (they would model-invoke the
 * skill), and that are not permissive-acknowledged (a `gating.permissive` listing IS
 * the user accepting that agent seeing the skill). Readers that honor the gate (e.g.
 * cursor reading the claude dir) enforce the frontmatter themselves — not exposure.
 * Advisory by design: never a hard error, or claude-code would be unreachable for
 * gated skills whenever opencode is enabled. Shared by the solver (desired
 * placements) and doctor (live state placements).
 */
export function gatedExposureOf(
  registry: Registry,
  dirId: string,
  target: string,
  permissive: Set<string>,
): string[] {
  return readersOf(registry, dirId, { includeMaybe: true })
    .filter((r) => r !== target)
    .filter((r) => !gateHonored(registry.agents[r]?.skillInvocation?.gate))
    .filter((r) => !permissive.has(r))
    .sort();
}

/**
 * Mitigation clause for a gated-exposure message: per-agent kill switches where the
 * registry knows them (opencode: OPENCODE_DISABLE_CLAUDE_CODE_SKILLS /
 * OPENCODE_DISABLE_EXTERNAL_SKILLS), the skill's prose gate, or a permissive
 * acknowledgment. Shared by the plan warning and the doctor finding.
 */
export function gatedExposureRemedy(registry: Registry, exposed: string[]): string {
  const switches = exposed
    .filter((id) => (registry.agents[id]?.killSwitches?.length ?? 0) > 0)
    .map((id) => `set ${registry.agents[id]!.killSwitches!.join(" / ")} to hide it from ${id}`);
  return [...switches, "rely on the skill's prose gate", "or add the agent(s) to gating.permissive to acknowledge the exposure"].join("; ");
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
  for (const rel of listSourceFiles(skill.source.path, skill.name)) {
    tree[rel] = fs.readFileSync(path.join(skill.source.path, rel));
  }

  const dialect = FIRST_PARTY_DIR_DIALECT[dir];
  const overridePath = dialect ? skill.overrides[dialect] : undefined;
  if (dialect && overridePath) {
    // Same per-agent frontmatter merge a rendered native placement gets — but the
    // merge must never un-gate the skill (the frontmatter IS the gate here). Mirror
    // the companion rule: an override that explicitly sets disable-model-invocation
    // to anything but true contradicts the gated intent → hard error. With every
    // non-true value rejected, deepMerge preserves the source's
    // `disable-model-invocation: true` (base keys the override omits survive, and an
    // equal `true` is a no-op) — the rendered frontmatter always keeps the gate.
    assertOverrideKeepsGate(skill.name, overridePath, dialect);
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
 * Reject a per-agent frontmatter override that would un-gate a gated skill's
 * frontmatter-enforced placement: `disable-model-invocation` set to any value but
 * `true` (false, null, a string, ...) is conflicting intent, like an author companion
 * with allow_implicit_invocation: true. Omitting the key is fine — deepMerge keeps
 * the source's `true`.
 */
function assertOverrideKeepsGate(skillName: string, overridePath: string, dialect: string): void {
  const parsed = parseYaml(fs.readFileSync(overridePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const flag = (parsed as Record<string, unknown>)["disable-model-invocation"];
  if (flag !== undefined && flag !== true) {
    throw new GatingError(
      `gated skill '${skillName}' has an agents/${dialect}.yaml override setting disable-model-invocation to ` +
        `${JSON.stringify(flag)}, contradicting its gated intent; remove the key (the source's 'true' is preserved)`,
    );
  }
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

/**
 * sha256 over an in-memory gated tree, byte-compatibly with render.ts's treeHashOf.
 * Deliberately paths+bytes only, NOT file modes: treeHashOf's format is shared with
 * composed trees and recorded in live state, so folding modes in would invalidate
 * every deployed hash. A mode-only source change converges on the next content
 * update; writeGatedTree re-applies source modes on every materialization.
 */
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

/**
 * Write a rendered gated tree into `targetDir` (mkdir -p each file's parent),
 * replicating each source file's mode so executable helpers stay executable
 * (writeFileSync alone would land scripts as 0644; non-gated placements keep
 * modes via copyFileSync/symlink). skm-generated files with no source
 * counterpart (a generated companion) keep the default mode.
 */
export function writeGatedTree(tree: GatedTree, targetDir: string, sourceDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const rel of Object.keys(tree)) {
    const abs = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tree[rel]!);
    const srcAbs = path.join(sourceDir, rel);
    if (fs.existsSync(srcAbs)) fs.chmodSync(abs, fs.statSync(srcAbs).mode & 0o777);
  }
}

/**
 * Relative paths of every regular file under `dir` (recursively, sorted). Symlinks
 * inside a gated source are rejected outright (GatingError): a gated tree is a
 * rendered COPY, so a symlinked member would be silently materialized (file target),
 * crash the render with EISDIR (dir target), or ENOENT (dangling) — almost certainly
 * an authoring mistake, never something to paper over.
 */
function listSourceFiles(dir: string, skillName: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new GatingError(
        `gated skill '${skillName}' source contains a symlink at ${childRel}; ` +
          `gated trees are rendered copies — replace it with a real file`,
      );
    }
    if (entry.isDirectory()) out.push(...listSourceFiles(path.join(dir, entry.name), skillName, childRel));
    else out.push(childRel);
  }
  return out.sort();
}
