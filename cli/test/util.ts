// Sandbox harness for tests. makeSandbox() builds a temp dir with a fake HOME
// (agent dirs), fake XDG config/state, and a fixed clock, returning a SkmEnv that
// NEVER touches the real machine. Fixture builders create skills, overlays, and
// machine configs inside that sandbox.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { configPath, type Clock, type SkmEnv } from "../src/env";
import type { AgentScope, MachineConfig, Root, Visibility } from "../src/types";

/** The real repo root (…/custom_skills), for locating registry/agents.json in tests. */
export function repoRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // cli/test
  return path.resolve(here, "..", "..");
}

/** Absolute path to the authoritative registry file (read-only in tests). */
export function realRegistryPath(): string {
  return path.join(repoRootDir(), "registry", "agents.json");
}

/** Agent skill dirs (relative to fake home) pre-created in each sandbox. */
const AGENT_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".copilot/skills",
  ".gemini/skills",
  ".gemini/config/skills",
  ".config/opencode/skills",
  ".pi/agent/skills",
  ".cursor/skills",
  ".grok/skills",
  ".factory/skills",
  ".hermes/skills",
];

export interface Sandbox {
  /** Injected env pointing entirely inside the sandbox. */
  env: SkmEnv;
  /** Fake HOME. */
  home: string;
  /** Sandbox base dir (everything lives under here). */
  base: string;
  /** Fixed clock used by env (for asserting deterministic timestamps). */
  clock: Clock;
  /** Recursively remove the sandbox. */
  cleanup(): void;
}

const FIXED_TIME = "2026-07-10T00:00:00.000Z";

export function makeSandbox(opts: { machineName?: string } = {}): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skm-test-"));
  const home = path.join(base, "home");
  const xdgConfigHome = path.join(base, "xdg-config");
  const xdgStateHome = path.join(base, "xdg-state");

  for (const rel of AGENT_DIRS) {
    fs.mkdirSync(path.join(home, rel), { recursive: true });
  }
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });

  const clock: Clock = { now: () => FIXED_TIME };
  const env: SkmEnv = {
    home,
    xdgConfigHome,
    xdgStateHome,
    machineName: opts.machineName ?? "sandbox",
    clock,
  };

  return {
    env,
    home,
    base,
    clock,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** Create a registered root directory (with an empty skills/ dir) inside the sandbox. */
export function makeRoot(
  sandbox: Sandbox,
  name: string,
  visibility: Visibility = "public",
): Root {
  const rootPath = path.join(sandbox.base, "roots", name);
  fs.mkdirSync(path.join(rootPath, "skills"), { recursive: true });
  return { name, path: rootPath, visibility };
}

/** Create skills/<name>/SKILL.md (+ optional agents/*.yaml) under a root path. */
export function makeSkill(
  rootPath: string,
  name: string,
  opts: {
    frontmatter?: Record<string, unknown>;
    body?: string;
    /** Map of agents/<key>.yaml → object contents, e.g. { claude: {...} }. */
    agentsYaml?: Record<string, Record<string, unknown>>;
  } = {},
): string {
  const dir = path.join(rootPath, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = { name, description: `${name} skill`, ...(opts.frontmatter ?? {}) };
  const content = `---\n${stringify(frontmatter)}---\n\n${opts.body ?? name}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);

  if (opts.agentsYaml) {
    const agentsDir = path.join(dir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const [key, data] of Object.entries(opts.agentsYaml)) {
      fs.writeFileSync(path.join(agentsDir, `${key}.yaml`), stringify(data));
    }
  }
  return dir;
}

/**
 * Create agents/<name>/{agent.yaml, instructions.md} under a root path (AUR-616).
 * `agentYaml` is stringified as YAML; `rawAgentYaml` writes verbatim text (used to
 * exercise YAML 1.1 boolean/float parsing). Returns the agent-def source dir.
 */
export function makeAgentDef(
  rootPath: string,
  name: string,
  opts: {
    agentYaml?: Record<string, unknown>;
    rawAgentYaml?: string;
    instructions?: string;
  },
): string {
  const dir = path.join(rootPath, "agents", name);
  fs.mkdirSync(dir, { recursive: true });
  const yamlText =
    opts.rawAgentYaml ??
    stringify({ name, description: `${name} agent`, ...(opts.agentYaml ?? {}) });
  fs.writeFileSync(path.join(dir, "agent.yaml"), yamlText);
  fs.writeFileSync(path.join(dir, "instructions.md"), opts.instructions ?? `Do ${name}.\n`);
  return dir;
}

/** Write an overlay.json at a root path. */
export function makeOverlay(
  rootPath: string,
  manifest: {
    name: string;
    skills?: Record<string, { agents?: AgentScope }>;
    requiresPublic?: string;
    upstream?: string[];
  },
): string {
  const file = path.join(rootPath, "overlay.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, skills: {}, ...manifest }, null, 2),
  );
  return file;
}

/** Write the public catalog scoping map at <publicRoot>/catalog/agent-scopes.json. */
export function makeAgentScopes(
  publicRootPath: string,
  skills: Record<string, { agents?: AgentScope }>,
): string {
  const dir = path.join(publicRootPath, "catalog");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "agent-scopes.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, skills }, null, 2));
  return file;
}

/** Write a machine config to the sandbox config path. */
export function writeMachineConfig(sandbox: Sandbox, config: MachineConfig): string {
  const file = configPath(sandbox.env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
