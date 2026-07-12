// Loads + validates the agent capability registry (registry/agents.json) and
// exposes the read-graph helpers placement is computed from.

import * as fs from "node:fs";
import { RegistryError } from "./errors";
import { type SkmEnv, expandTilde } from "./env";
import type { AgentCapability, MachineConfig, Registry } from "./types";

/** Parse + validate a registry file. */
export function loadRegistry(filePath: string): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new RegistryError(`registry not found: ${filePath}`);
  }
  const parsed = JSON.parse(raw) as Registry;
  validateRegistry(parsed);
  return parsed;
}

/**
 * Schema-check a parsed registry:
 * - every reads/maybeReads/ownDir id must exist in `directories`
 * - every `supported` agent must declare an ownDir
 * Throws RegistryError on the first violation.
 */
export function validateRegistry(reg: Registry): void {
  if (!reg.directories || !reg.agents) {
    throw new RegistryError("registry missing `directories` or `agents`");
  }
  const dirIds = new Set(Object.keys(reg.directories));

  for (const [agentId, agent] of Object.entries(reg.agents)) {
    for (const d of agent.reads) {
      if (!dirIds.has(d)) {
        throw new RegistryError(`agent '${agentId}' reads unknown directory '${d}'`);
      }
    }
    for (const d of agent.maybeReads) {
      if (!dirIds.has(d)) {
        throw new RegistryError(`agent '${agentId}' maybeReads unknown directory '${d}'`);
      }
    }
    if (agent.ownDir !== undefined && !dirIds.has(agent.ownDir)) {
      throw new RegistryError(`agent '${agentId}' ownDir '${agent.ownDir}' not in directories`);
    }
    if (agent.skillsSupport === "supported" && agent.ownDir === undefined) {
      throw new RegistryError(`supported agent '${agentId}' has no ownDir`);
    }
    validateAgentDef(agentId, agent);
    validateSkillInvocation(agentId, agent);
  }
}

const AGENT_DEF_SUPPORT_VALUES = new Set(["supported", "none", "unknown"]);
const AGENT_DEF_DIALECT_VALUES = new Set(["claude", "codex", "copilot", "cursor", "opencode", "gemini"]);

/**
 * Validate the optional agent-definition (subagent) directory fields on one agent:
 * - a declared dir/dialect implies support and requires the matching companions;
 * - `none`/`unknown` support must not declare a dir or dialect;
 * - any agentDef field requires an evidence citation.
 */
function validateAgentDef(agentId: string, agent: AgentCapability): void {
  const support = agent.agentDefSupport;
  const hasDir = agent.agentDefDir !== undefined;
  const hasDialect = agent.agentDefDialect !== undefined;
  const hasEvidence = agent.agentDefEvidence !== undefined;
  const anyField = support !== undefined || hasDir || hasDialect || hasEvidence;
  if (!anyField) return;

  if (support !== undefined && !AGENT_DEF_SUPPORT_VALUES.has(support)) {
    throw new RegistryError(`agent '${agentId}' has invalid agentDefSupport '${support}'`);
  }
  if (hasDialect && !AGENT_DEF_DIALECT_VALUES.has(agent.agentDefDialect as string)) {
    throw new RegistryError(`agent '${agentId}' has invalid agentDefDialect '${agent.agentDefDialect}'`);
  }
  if (hasDir && (typeof agent.agentDefDir !== "string" || agent.agentDefDir.trim() === "")) {
    throw new RegistryError(`agent '${agentId}' agentDefDir must be a non-empty string`);
  }
  if (support === "none" || support === "unknown") {
    if (hasDir || hasDialect) {
      throw new RegistryError(
        `agent '${agentId}' agentDefSupport '${support}' must not declare agentDefDir or agentDefDialect`,
      );
    }
  } else {
    // supported (explicit or implied by a declared dir/dialect)
    if (!hasDir) {
      throw new RegistryError(`agent '${agentId}' agent-definition support requires agentDefDir`);
    }
    if (!hasDialect) {
      throw new RegistryError(`agent '${agentId}' agent-definition support requires agentDefDialect`);
    }
  }
  if (typeof agent.agentDefEvidence !== "string" || agent.agentDefEvidence.trim() === "") {
    throw new RegistryError(`agent '${agentId}' agentDef fields require agentDefEvidence`);
  }
}

const SKILL_USER_INVOCATION_VALUES = new Set(["slash", "mention", "none", "unknown"]);
const SKILL_GATE_VALUES = new Set([
  "frontmatter",
  "companion:agents/openai.yaml",
  "none",
  "unknown",
]);

/**
 * Validate the optional `skillInvocation` capability block on one agent (ADR 0011):
 * - `userInvocation` and `gate` must be known enum values;
 * - `evidence` is always required;
 * - `probedVersion` + `probedOn` (YYYY-MM-DD) are required whenever anything
 *   was probed, and forbidden on a fully `unknown` entry (nothing was probed).
 */
function validateSkillInvocation(agentId: string, agent: AgentCapability): void {
  const si = agent.skillInvocation;
  if (si === undefined) return;

  if (!SKILL_USER_INVOCATION_VALUES.has(si.userInvocation)) {
    throw new RegistryError(
      `agent '${agentId}' has invalid skillInvocation.userInvocation '${si.userInvocation}'`,
    );
  }
  if (!SKILL_GATE_VALUES.has(si.gate)) {
    throw new RegistryError(`agent '${agentId}' has invalid skillInvocation.gate '${si.gate}'`);
  }
  if (typeof si.evidence !== "string" || si.evidence.trim() === "") {
    throw new RegistryError(`agent '${agentId}' skillInvocation requires evidence`);
  }
  const fullyUnknown = si.userInvocation === "unknown" && si.gate === "unknown";
  if (fullyUnknown) {
    if (si.probedVersion !== undefined || si.probedOn !== undefined) {
      throw new RegistryError(
        `agent '${agentId}' skillInvocation is fully unknown; must not declare probedVersion or probedOn`,
      );
    }
    return;
  }
  if (typeof si.probedVersion !== "string" || si.probedVersion.trim() === "") {
    throw new RegistryError(`agent '${agentId}' skillInvocation requires probedVersion`);
  }
  if (typeof si.probedOn !== "string" || !isIsoDate(si.probedOn)) {
    throw new RegistryError(
      `agent '${agentId}' skillInvocation requires probedOn as a real YYYY-MM-DD date`,
    );
  }
}

/** True iff `s` is a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-02-30). */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Agent ids that read `dirId`. With `includeMaybe`, unconfirmed reads count too
 * (the deny-guarantee view: an agent that *might* read the dir is a reader).
 */
export function readersOf(
  reg: Registry,
  dirId: string,
  opts: { includeMaybe?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const [agentId, agent] of Object.entries(reg.agents)) {
    if (agent.reads.includes(dirId) || (opts.includeMaybe && agent.maybeReads.includes(dirId))) {
      out.push(agentId);
    }
  }
  return out;
}

/** Default enabled set: every `supported` agent except hermes (hermes is opt-in). */
export function defaultEnabledAgents(reg: Registry): string[] {
  return Object.entries(reg.agents)
    .filter(([id, a]) => a.skillsSupport === "supported" && id !== "hermes")
    .map(([id]) => id);
}

/** Enabled agents for a config: explicit `agents` if present, else the default set. */
export function enabledAgents(config: MachineConfig, reg: Registry): string[] {
  if (config.agents !== undefined) return config.agents;
  return defaultEnabledAgents(reg);
}

/** Resolve a directory id to an absolute path (tilde expanded against env.home). */
export function dirPath(env: SkmEnv, reg: Registry, dirId: string): string {
  const dir = reg.directories[dirId];
  if (!dir) throw new RegistryError(`unknown directory '${dirId}'`);
  return expandTilde(env, dir.path);
}
