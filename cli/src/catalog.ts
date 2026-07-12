// Public-catalog scoping: reads <publicRoot>/catalog/agent-scopes.json. Owned by
// the resolve team. Also exposes the shared scoping-source validator (reused by
// overlay.ts) and the .skills.local.json `preserveGlobalSkillNames` reader.

import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError } from "./errors";
import type { AgentScope, Registry, Root, ScopingSource, SkillGating, SkillScopeEntry } from "./types";

/** Path to the public scoping map for a given public root. */
export function publicScopingPath(publicRoot: string): string {
  return path.join(publicRoot, "catalog", "agent-scopes.json");
}

/**
 * Parse + validate a scoping source (public catalog or overlay manifest).
 * Enforces `allow` XOR `deny` per skill and, when `reg` is supplied, that every
 * referenced agent id exists in the registry. Throws ConfigError on any
 * violation. Caller is responsible for checking existence first when absence
 * should be tolerated (see loadOverlay / resolve).
 */
export function loadScopingSource(filePath: string, reg?: Registry): ScopingSource {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new ConfigError(`scoping source not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`invalid scoping JSON at ${filePath}: ${(e as Error).message}`);
  }
  return validateScopingSource(parsed, filePath, reg);
}

/** Validate an already-parsed scoping object. Shared by catalog + overlay. */
export function validateScopingSource(
  parsed: unknown,
  srcLabel: string,
  reg?: Registry,
): ScopingSource {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${srcLabel}: scoping must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    throw new ConfigError(`${srcLabel}: missing numeric 'version'`);
  }

  const skillsRaw = obj.skills ?? {};
  if (typeof skillsRaw !== "object" || skillsRaw === null || Array.isArray(skillsRaw)) {
    throw new ConfigError(`${srcLabel}: 'skills' must be an object`);
  }

  const validAgents = reg ? new Set(Object.keys(reg.agents)) : undefined;
  const skills: Record<string, SkillScopeEntry> = {};

  for (const [name, entryRaw] of Object.entries(skillsRaw as Record<string, unknown>)) {
    if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) {
      throw new ConfigError(`${srcLabel}: skill '${name}' entry must be an object`);
    }
    const entry = entryRaw as Record<string, unknown>;
    const out: SkillScopeEntry = {};
    const agentsRaw = entry.agents;
    if (agentsRaw !== undefined) {
      if (typeof agentsRaw !== "object" || agentsRaw === null || Array.isArray(agentsRaw)) {
        throw new ConfigError(`${srcLabel}: skill '${name}' 'agents' must be an object`);
      }
      const a = agentsRaw as Record<string, unknown>;
      const hasAllow = a.allow !== undefined;
      const hasDeny = a.deny !== undefined;
      if (hasAllow === hasDeny) {
        throw new ConfigError(
          `${srcLabel}: skill '${name}' must set exactly one of 'allow' or 'deny'`,
        );
      }
      const key = hasAllow ? "allow" : "deny";
      const list = a[key];
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || x.length === 0)) {
        throw new ConfigError(
          `${srcLabel}: skill '${name}' '${key}' must be an array of non-empty strings`,
        );
      }
      const ids = list as string[];
      if (validAgents) {
        for (const id of ids) {
          if (!validAgents.has(id)) {
            throw new ConfigError(
              `${srcLabel}: skill '${name}' '${key}' references unknown agent '${id}'`,
            );
          }
        }
      }
      out.agents = hasAllow ? { allow: ids } : { deny: ids };
    }
    const gating = parseGating(entry.gating, name, srcLabel, reg);
    if (gating) out.gating = gating;
    skills[name] = out;
  }

  const out: ScopingSource = { version: obj.version as number, skills };
  if (typeof obj.name === "string") out.name = obj.name;
  if (typeof obj.note === "string") out.note = obj.note;
  if (typeof obj.requiresPublic === "string") out.requiresPublic = obj.requiresPublic;
  if (Array.isArray(obj.upstream)) out.upstream = obj.upstream as string[];
  return out;
}

/**
 * Parse + validate a per-skill `gating` block (ADR 0011). `permissive` opts named
 * no-gate agents in to a gated skill. When `reg` is supplied, each id must exist AND
 * have no real gate (frontmatter/companion) — opting a real-gate agent in is
 * meaningless (it already enforces the gate) and rejected. Returns undefined when
 * absent.
 */
function parseGating(
  raw: unknown,
  name: string,
  srcLabel: string,
  reg?: Registry,
): SkillGating | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${srcLabel}: skill '${name}' 'gating' must be an object`);
  }
  const permissiveRaw = (raw as Record<string, unknown>).permissive;
  if (
    !Array.isArray(permissiveRaw) ||
    permissiveRaw.some((x) => typeof x !== "string" || x.length === 0)
  ) {
    throw new ConfigError(
      `${srcLabel}: skill '${name}' gating.permissive must be an array of non-empty agent ids`,
    );
  }
  const permissive = permissiveRaw as string[];
  if (reg) {
    for (const id of permissive) {
      const agent = reg.agents[id];
      if (!agent) {
        throw new ConfigError(
          `${srcLabel}: skill '${name}' gating.permissive references unknown agent '${id}'`,
        );
      }
      const gate = agent.skillInvocation?.gate;
      if (gate !== undefined && gate !== "none" && gate !== "unknown") {
        throw new ConfigError(
          `${srcLabel}: skill '${name}' gating.permissive names '${id}', which already enforces a real gate ('${gate}'); permissive is only for no-gate agents`,
        );
      }
    }
  }
  return { permissive };
}

/** Resolve one skill's scope from a source, or undefined when unscoped. */
export function scopingForSkill(
  source: ScopingSource | undefined,
  name: string,
): AgentScope | undefined {
  return source?.skills?.[name]?.agents;
}

/** Resolve one skill's gated-placement override from a source, or undefined when absent. */
export function gatingForSkill(
  source: ScopingSource | undefined,
  name: string,
): SkillGating | undefined {
  return source?.skills?.[name]?.gating;
}

/**
 * Read `preserveGlobalSkillNames` from a public root's gitignored
 * `.skills.local.json`. status/doctor use these to classify a preserved handmade
 * skill as "foreign-preserved" rather than plain foreign. Non-public roots and a
 * missing file yield []. Validates the same shape the bash tooling enforces.
 */
export function preservedNames(root: Root): string[] {
  if (root.visibility !== "public") return [];
  const file = path.join(root.path, ".skills.local.json");
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`invalid .skills.local.json at ${file}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${file}: .skills.local.json must be a JSON object`);
  }
  const names = (parsed as Record<string, unknown>).preserveGlobalSkillNames;
  if (names === undefined) return [];
  if (
    !Array.isArray(names) ||
    names.some((n) => typeof n !== "string" || n.length === 0 || /[\s/@]/.test(n))
  ) {
    throw new ConfigError(
      `${file}: preserveGlobalSkillNames must be an array of names without whitespace, '/', or '@'`,
    );
  }
  return names as string[];
}
