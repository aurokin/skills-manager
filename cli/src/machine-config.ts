// Loads the machine config (~/.config/skills-manager/config.json) and applies
// the spec defaults. Missing file => single public root at the repo containing
// this CLI. Agent enablement defaulting happens in enabledAgents() (registry.ts),
// never here: the raw presence/absence of `agents`/`optInAgents` is preserved so
// their mutual exclusion and registry-id validation stay checkable.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./errors";
import { type SkmEnv, configPath, expandTilde } from "./env";
import type { MachineConfig, Registry, Root } from "./types";

/** The repo containing this CLI: two levels up from cli/src (→ /…/skills-manager). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // cli/src
  return path.resolve(here, "..", "..");
}

/** Default config when no file exists: one public root = repo root. */
export function defaultConfig(_reg: Registry): MachineConfig {
  return {
    version: 1,
    roots: [{ name: "public", path: repoRoot(), visibility: "public" }],
    privateOriginAllowlist: [],
  };
}

/**
 * Normalize a parsed config: expand tilde in root paths, fill the allowlist
 * default, validate agent lists. `agents` (exact set) and `optInAgents`
 * (additive) are mutually exclusive and both must name registry agents;
 * defaulting itself lives in enabledAgents().
 */
export function normalizeConfig(env: SkmEnv, raw: MachineConfig, reg: Registry): MachineConfig {
  if (!Array.isArray(raw.roots)) {
    throw new ConfigError("machine config missing `roots` array");
  }
  // JSON `null` reads as absent (the pre-ADR-0016 `??` behavior); a present list
  // must be an array of known agent ids.
  const agentsRaw = raw.agents ?? undefined;
  const optInRaw = raw.optInAgents ?? undefined;
  if (agentsRaw !== undefined && optInRaw !== undefined) {
    throw new ConfigError(
      "machine config declares both `agents` and `optInAgents`; they are mutually exclusive " +
        "(`agents` is the exact enabled set, `optInAgents` adds to the default set)",
    );
  }
  for (const [field, list] of [
    ["agents", agentsRaw],
    ["optInAgents", optInRaw],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ConfigError(`machine config \`${field}\` must be a list of agent ids`);
    }
    for (const id of list) {
      if (!Object.hasOwn(reg.agents, id)) {
        throw new ConfigError(`machine config \`${field}\` names unknown agent '${id}'`);
      }
    }
  }
  const acceptedRaw = raw.acceptedGatedExposures ?? undefined;
  if (acceptedRaw !== undefined) {
    if (!Array.isArray(acceptedRaw)) {
      throw new ConfigError("machine config `acceptedGatedExposures` must be a list of skill names");
    }
    const seen = new Set<string>();
    for (const name of acceptedRaw) {
      if (typeof name !== "string" || name.trim() === "") {
        throw new ConfigError("machine config `acceptedGatedExposures` entries must be non-empty strings");
      }
      if (seen.has(name)) {
        throw new ConfigError(`machine config \`acceptedGatedExposures\` lists '${name}' twice`);
      }
      seen.add(name);
    }
  }
  const excludedSkillsRaw = raw.excludeLocalSkills ?? undefined;
  const excludedAgentsRaw = raw.excludeLocalAgents ?? undefined;
  validateExcludedNames("excludeLocalSkills", "skill", excludedSkillsRaw);
  validateExcludedNames("excludeLocalAgents", "agent-definition", excludedAgentsRaw);
  const roots: Root[] = raw.roots.map((r) => ({ ...r, path: expandTilde(env, r.path) }));
  const config: MachineConfig = {
    version: raw.version,
    roots,
    privateOriginAllowlist: raw.privateOriginAllowlist ?? [],
  };
  if (agentsRaw !== undefined) config.agents = agentsRaw;
  if (optInRaw !== undefined) config.optInAgents = optInRaw;
  if (acceptedRaw !== undefined) config.acceptedGatedExposures = acceptedRaw;
  if (excludedSkillsRaw !== undefined) config.excludeLocalSkills = excludedSkillsRaw;
  if (excludedAgentsRaw !== undefined) config.excludeLocalAgents = excludedAgentsRaw;
  return config;
}

function validateExcludedNames(field: string, noun: string, value: unknown): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new ConfigError(`machine config \`${field}\` must be a list of ${noun} names`);
  }
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || name.length === 0 || /[\s/@]/.test(name)) {
      throw new ConfigError(`machine config \`${field}\` entries must be valid ${noun} names`);
    }
    if (seen.has(name)) {
      throw new ConfigError(`machine config \`${field}\` lists '${name}' twice`);
    }
    seen.add(name);
  }
}

/** Load + normalize config, or synthesize defaults when the file is absent. */
export function loadMachineConfig(env: SkmEnv, reg: Registry): MachineConfig {
  const p = configPath(env);
  if (!fs.existsSync(p)) return defaultConfig(reg);
  let raw: MachineConfig;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as MachineConfig;
  } catch (e) {
    throw new ConfigError(`invalid machine config at ${p}: ${(e as Error).message}`);
  }
  return normalizeConfig(env, raw, reg);
}

/**
 * Just the registered roots, without registry validation: root pulling runs
 * before the registry is loaded because a pull may update the registry itself.
 * An unreadable config yields [] so the full load reports the real error.
 */
export function loadConfiguredRoots(env: SkmEnv): Root[] {
  const p = configPath(env);
  if (!fs.existsSync(p)) return [{ name: "public", path: repoRoot(), visibility: "public" }];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as MachineConfig;
    if (!Array.isArray(raw.roots)) return [];
    return raw.roots.map((r) => ({ ...r, path: expandTilde(env, r.path) }));
  } catch {
    return [];
  }
}

/** A registered root missing on disk is a hard abort (never "delete its skills"). */
export function assertRootsExist(config: MachineConfig): void {
  for (const r of config.roots) {
    if (!fs.existsSync(r.path)) {
      throw new ConfigError(`registered root '${r.name}' missing on disk: ${r.path}`);
    }
  }
}
