// Resolver: composes every registered root into one desired state (union of
// skills/<name>/ dirs containing SKILL.md), applies scoping, detects name
// collisions (later root wins), and hashes the result. Owned by the resolve team.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { deriveSkillName } from "./agentdef/dialects/derived-skill";
import { scopingForAgentDef } from "./agentdef/scoping";
import { isAgentDefDir, loadAgentDefinitionFromDir } from "./agentdef/source";
import { isComposedDir, loadComposedSkillFromDir } from "./composed/source";
import { loadScopingSource, publicScopingPath, scopingForSkill } from "./catalog";
import { CollisionError } from "./errors";
import type { SkmEnv } from "./env";
import { assertNoTpromptStemCollisions } from "./tprompt/channel";
import { parseSkillTpromptBlock } from "./tprompt/spec";
import { loadOverlay } from "./overlay";
import { enabledAgents } from "./registry";
import type {
  AgentOverrides,
  AgentScope,
  DesiredAgentDef,
  DesiredComposedSkill,
  DesiredSkill,
  DesiredState,
  MachineConfig,
  Registry,
  Root,
  ScopingSource,
  Warning,
} from "./types";

/**
 * A registered root is absent on disk. Hard abort — never interpret a missing
 * root as "delete its skills" (design §7, ADR 0006). Defined here pending a hoist
 * into errors.ts by the integrator.
 */
export class RootMissingError extends Error {
  constructor(root: Root) {
    super(`registered root '${root.name}' missing on disk: ${root.path}`);
    this.name = "RootMissingError";
  }
}

/** agents/<dialect>.yaml override files the resolver advertises per skill. */
const OVERRIDE_DIALECTS = ["claude", "copilot", "codex", "openai"] as const;

/** Build the desired state from config roots + registry + scoping sources. */
export function resolveDesiredState(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
): DesiredState {
  const warnings: Warning[] = [];
  const byName = new Map<string, DesiredSkill>();
  const ownerRoot = new Map<string, string>();
  const defByName = new Map<string, DesiredAgentDef>();
  const defOwnerRoot = new Map<string, string>();
  const composedByName = new Map<string, DesiredComposedSkill>();
  const composedWarnings = new Map<string, Warning[]>();
  const composedOwnerRoot = new Map<string, string>();
  const enabled = enabledAgents(config, registry);

  for (const root of config.roots) {
    if (!fs.existsSync(root.path)) throw new RootMissingError(root);
    const scoping = scopingForRoot(root, registry);

    const skillsDir = path.join(root.path, "skills");
    if (fs.existsSync(skillsDir)) {
      const names = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const name of names) {
        const skillDir = path.join(skillsDir, name);
        const skillMd = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue; // a dir without SKILL.md is not a skill

        const fm = parseFrontmatter(fs.readFileSync(skillMd, "utf8"));
        checkFrontmatter(fm, name, warnings);

        const desired: DesiredSkill = {
          name,
          source: { root: root.name, visibility: root.visibility, path: skillDir },
          overrides: detectOverrides(skillDir),
        };
        const scope = scopingForSkill(scoping, name);
        if (scope) desired.scoping = scope;
        // Optional `tprompt:` export block (ADR 0008); invalid blocks throw here.
        const tp = parseSkillTpromptBlock(fm, skillMd);
        if (tp.enabled) desired.tprompt = tp;

        if (byName.has(name)) {
          warnings.push({
            kind: "collision",
            skill: name,
            message: `skill '${name}' defined in roots '${ownerRoot.get(name)}' and '${root.name}'; '${root.name}' wins`,
          });
        }
        byName.set(name, desired);
        ownerRoot.set(name, root.name);
      }
    }

    // Agent definitions: <root>/agents/<name>/{agent.yaml, instructions.md},
    // parallel to skills/. Later root wins on a name collision, like skills.
    const agentsDir = path.join(root.path, "agents");
    if (fs.existsSync(agentsDir)) {
      const names = fs
        .readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const name of names) {
        const defDir = path.join(agentsDir, name);
        if (!isAgentDefDir(defDir)) continue; // a dir without agent.yaml is not a def

        const def = loadAgentDefinitionFromDir(defDir);
        const desired: DesiredAgentDef = {
          name,
          source: { root: root.name, visibility: root.visibility, path: defDir },
          exportMode: def.export,
          scoping: scopingForAgentDef(def, enabled),
          def,
        };
        if (def.export === "skill") desired.derivedSkillName = deriveSkillName(def);

        if (defByName.has(name)) {
          warnings.push({
            kind: "collision",
            skill: name,
            message: `agent definition '${name}' defined in roots '${defOwnerRoot.get(name)}' and '${root.name}'; '${root.name}' wins`,
          });
        }
        defByName.set(name, desired);
        defOwnerRoot.set(name, root.name);
      }
    }

    // Composed skills: <root>/composed/<name>/ (skill.yaml marker), parallel to
    // skills/ and agents/. Later root wins on a name collision, like skills. A dir
    // without skill.yaml is skipped silently (footgun avoidance, ADR 0010).
    const composedDir = path.join(root.path, "composed");
    if (fs.existsSync(composedDir)) {
      const names = fs
        .readdirSync(composedDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const name of names) {
        const srcDir = path.join(composedDir, name);
        if (!isComposedDir(srcDir)) continue; // a dir without skill.yaml is not composed

        const source = { root: root.name, visibility: root.visibility, path: srcDir };
        const { skill, warnings: skillWarnings } = loadComposedSkillFromDir(srcDir, name, source, registry);

        if (composedByName.has(name)) {
          warnings.push({
            kind: "collision",
            skill: name,
            message: `composed skill '${name}' defined in roots '${composedOwnerRoot.get(name)}' and '${root.name}'; '${root.name}' wins`,
          });
        }
        composedByName.set(name, skill);
        composedWarnings.set(name, skillWarnings);
        composedOwnerRoot.set(name, root.name);
      }
    }
  }

  const skills = [...byName.values()].sort(byNameAsc);
  const agentDefs = [...defByName.values()].sort(byNameAsc);
  const composedSkills = [...composedByName.values()].sort(byNameAsc);
  // Composed-skill warnings from the winning root only (later root wins).
  for (const composed of composedSkills) {
    warnings.push(...(composedWarnings.get(composed.name) ?? []));
  }
  assertNoDerivedSkillCollisions(skills, agentDefs, composedSkills);
  // tprompt flat-namespace guard: two skm artifacts resolving to the same prompt
  // stem is an authoring error, caught before any mutation (ADR 0008), regardless
  // of channel availability.
  assertNoTpromptStemCollisions(skills, agentDefs);
  return {
    skills,
    agentDefs,
    composedSkills,
    warnings,
    hash: hashDesiredState(skills, agentDefs, composedSkills),
  };
}

/**
 * Derived skills (export "skill") and composed skills both share the skill output
 * namespace and placement paths with native skills, so a name clash across any two
 * of the three is an authoring error that must hard-fail deterministically before
 * any mutation (naming both artifacts).
 */
function assertNoDerivedSkillCollisions(
  skills: DesiredSkill[],
  agentDefs: DesiredAgentDef[],
  composedSkills: DesiredComposedSkill[] = [],
): void {
  const nativeNames = new Set(skills.map((s) => s.name));
  const derivedOwner = new Map<string, string>();
  for (const def of agentDefs) {
    if (def.exportMode !== "skill" || !def.derivedSkillName) continue;
    const derived = def.derivedSkillName;
    if (nativeNames.has(derived)) {
      throw new CollisionError(
        `derived skill '${derived}' from agent definition '${def.name}' collides with native skill '${derived}'`,
      );
    }
    const prior = derivedOwner.get(derived);
    if (prior !== undefined) {
      throw new CollisionError(
        `derived skill '${derived}' is produced by both agent definitions '${prior}' and '${def.name}'`,
      );
    }
    derivedOwner.set(derived, def.name);
  }
  for (const composed of composedSkills) {
    if (nativeNames.has(composed.name)) {
      throw new CollisionError(
        `composed skill '${composed.name}' collides with native skill '${composed.name}'`,
      );
    }
    const derivedFrom = derivedOwner.get(composed.name);
    if (derivedFrom !== undefined) {
      throw new CollisionError(
        `composed skill '${composed.name}' collides with derived skill '${composed.name}' from agent definition '${derivedFrom}'`,
      );
    }
  }
}

/** Stable content hash of the desired skill + agent-def + composed set (apply --plan precondition). */
export function hashDesiredState(
  skills: DesiredSkill[],
  agentDefs: DesiredAgentDef[] = [],
  composedSkills: DesiredComposedSkill[] = [],
): string {
  const canonicalSkills = [...skills].sort(byNameAsc).map((s) => ({
    name: s.name,
    root: s.source.root,
    visibility: s.source.visibility,
    path: s.source.path,
    scoping: normalizeScopeForHash(s.scoping),
    overrides: Object.keys(s.overrides).sort(),
    // tprompt SELECTION fields (enabled + stem-determining filename) so a plan is
    // refused when a block is added/removed/renamed; render-content edits are
    // caught by the apply-time hash re-check, like skills.
    tprompt: normalizeTpromptForHash(s.tprompt),
  }));
  // Agent-def source-content edits are caught by the apply-time render-hash
  // re-check (like skills); the desired-state hash tracks only the stable
  // selection fields (name/root/path/export/scoping) so a plan is refused when
  // WHICH definitions exist or where they land changes.
  const canonicalDefs = [...agentDefs].sort(byNameAsc).map((d) => ({
    name: d.name,
    root: d.source.root,
    visibility: d.source.visibility,
    path: d.source.path,
    export: d.exportMode,
    derived: d.derivedSkillName ?? null,
    scoping: normalizeScopeForHash(d.scoping),
    tprompt: normalizeTpromptForHash(d.def.tprompt),
  }));
  // Composed skills track SELECTION identity only ({name, root, visibility, path,
  // posture, consumers}); provider/dimension/template CONTENT edits are caught by
  // the apply-time render-hash re-check (like skills/agent-defs), so a plan is
  // refused when WHICH composed skills exist, their posture, or their consumer set
  // (names + descriptions + selfProvider acks) changes.
  const canonicalComposed = [...composedSkills].sort(byNameAsc).map((c) => ({
    name: c.name,
    root: c.source.root,
    visibility: c.source.visibility,
    path: c.source.path,
    posture: c.posture,
    consumers: Object.keys(c.consumers)
      .sort()
      .map((id) => ({
        name: id,
        description: c.consumers[id]!.description,
        selfProvider: c.consumers[id]!.selfProvider ?? null,
      })),
  }));
  const payload = JSON.stringify({
    skills: canonicalSkills,
    agentDefs: canonicalDefs,
    composedSkills: canonicalComposed,
  });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

// ── internals ────────────────────────────────────────────────────────────────

/** Public-visibility roots scope via catalog/agent-scopes.json; others via overlay.json. */
function scopingForRoot(root: Root, reg: Registry): ScopingSource | undefined {
  if (root.visibility === "public") {
    const p = publicScopingPath(root.path);
    return fs.existsSync(p) ? loadScopingSource(p, reg) : undefined;
  }
  return loadOverlay(root, reg);
}

function detectOverrides(skillDir: string): AgentOverrides {
  const agentsDir = path.join(skillDir, "agents");
  const out: AgentOverrides = {};
  for (const dialect of OVERRIDE_DIALECTS) {
    const f = path.join(agentsDir, `${dialect}.yaml`);
    if (fs.existsSync(f)) out[dialect] = f;
  }
  return out;
}

function checkFrontmatter(fm: unknown, name: string, warnings: Warning[]): void {
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    warnings.push(frontmatterWarn(name, "SKILL.md has no readable YAML frontmatter"));
    return;
  }
  const o = fm as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) {
    warnings.push(frontmatterWarn(name, "frontmatter missing 'name'"));
  }
  if (typeof o.description !== "string" || o.description.length === 0) {
    warnings.push(frontmatterWarn(name, "frontmatter missing 'description'"));
  }
}

function parseFrontmatter(content: string): unknown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return undefined;
  try {
    return parseYaml(m[1] ?? "");
  } catch {
    return undefined;
  }
}

function frontmatterWarn(skill: string, message: string): Warning {
  return { kind: "frontmatter", skill, message };
}

/** Selection-relevant view of a tprompt block for the desired-state hash. */
function normalizeTpromptForHash(block?: { enabled: boolean; filename?: string }): unknown {
  if (!block || !block.enabled) return null;
  return { filename: block.filename ?? null };
}

function normalizeScopeForHash(scope?: AgentScope): unknown {
  if (!scope) return null;
  if (scope.allow) return { allow: [...scope.allow].sort() };
  return { deny: [...(scope.deny ?? [])].sort() };
}

function byNameAsc(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
