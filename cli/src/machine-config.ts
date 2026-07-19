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
  if (raw.agents !== undefined && raw.optInAgents !== undefined) {
    throw new ConfigError(
      "machine config declares both `agents` and `optInAgents`; they are mutually exclusive " +
        "(`agents` is the exact enabled set, `optInAgents` adds to the default set)",
    );
  }
  for (const [field, list] of [
    ["agents", raw.agents],
    ["optInAgents", raw.optInAgents],
  ] as const) {
    for (const id of list ?? []) {
      if (!reg.agents[id]) {
        throw new ConfigError(`machine config \`${field}\` names unknown agent '${id}'`);
      }
    }
  }
  const roots: Root[] = raw.roots.map((r) => ({ ...r, path: expandTilde(env, r.path) }));
  const config: MachineConfig = {
    version: raw.version,
    roots,
    privateOriginAllowlist: raw.privateOriginAllowlist ?? [],
  };
  if (raw.agents !== undefined) config.agents = raw.agents;
  if (raw.optInAgents !== undefined) config.optInAgents = raw.optInAgents;
  return config;
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

/** A registered root missing on disk is a hard abort (never "delete its skills"). */
export function assertRootsExist(config: MachineConfig): void {
  for (const r of config.roots) {
    if (!fs.existsSync(r.path)) {
      throw new ConfigError(`registered root '${r.name}' missing on disk: ${r.path}`);
    }
  }
}
