// Loads the machine config (~/.config/skills-manager/config.json) and applies
// the spec defaults. Missing file => single public root at the repo containing
// this CLI, standard agents (supported minus hermes).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./errors";
import { type SkmEnv, configPath, expandTilde } from "./env";
import { defaultEnabledAgents } from "./registry";
import type { MachineConfig, Registry, Root } from "./types";

/** The repo containing this CLI: two levels up from cli/src (→ /…/skills-manager). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // cli/src
  return path.resolve(here, "..", "..");
}

/** Default config when no file exists: one public root = repo root, standard agents. */
export function defaultConfig(reg: Registry): MachineConfig {
  return {
    version: 1,
    roots: [{ name: "public", path: repoRoot(), visibility: "public" }],
    agents: defaultEnabledAgents(reg),
    privateOriginAllowlist: [],
  };
}

/** Normalize a parsed config: expand tilde in root paths, fill agent/allowlist defaults. */
export function normalizeConfig(env: SkmEnv, raw: MachineConfig, reg: Registry): MachineConfig {
  if (!Array.isArray(raw.roots)) {
    throw new ConfigError("machine config missing `roots` array");
  }
  const roots: Root[] = raw.roots.map((r) => ({ ...r, path: expandTilde(env, r.path) }));
  return {
    version: raw.version,
    roots,
    agents: raw.agents ?? defaultEnabledAgents(reg),
    privateOriginAllowlist: raw.privateOriginAllowlist ?? [],
  };
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
