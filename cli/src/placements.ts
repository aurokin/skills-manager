// Bridge from desired state to concrete, absolute placements. Runs the read-graph
// solver per skill and expands the solver's tilde-form paths against the injected
// env. Shared by plan, status, doctor, and explain so they all agree on where a
// skill lands. Agent definitions (AUR-616) resolve here too: export "skill"
// reuses the skill solver (derived, render-only), export "agent" places one
// rendered file per enabled+allowed harness into its registry agentDefDir.

import * as path from "node:path";
import { agentDefExt } from "./agentdef/artifact";
import { composedTreeHash } from "./composed/render";
import { gatedTreeHash } from "./gated";
import { type SkmEnv, expandTilde, resolveCopilotHome } from "./env";
import { enabledAgents, readersOf } from "./registry";
import { solvePlacements } from "./solver";
import { computeTpromptPlacements } from "./tprompt/channel";
import type {
  AgentCapability,
  AgentDefDialect,
  AgentScope,
  BleedEntry,
  DesiredAgentDef,
  DesiredComposedSkill,
  DesiredSkill,
  DesiredState,
  Dialect,
  MachineConfig,
  Placement,
  Registry,
  SkillSource,
  TpromptReport,
  UnreachableEntry,
} from "./types";

/** One solved placement with its source and owning artifact, path already absolute. */
export interface DesiredPlacement {
  skill: string;
  source: SkillSource;
  /** Present for skill artifacts (native or scoped). */
  desiredSkill?: DesiredSkill;
  /** Present for agent-def artifacts and derived skills. */
  desiredAgentDef?: DesiredAgentDef;
  /** Present for composed-skill artifacts (per-consumer rendered tree). */
  desiredComposed?: DesiredComposedSkill;
  placement: Placement;
}

export interface SolvedDesired {
  placements: DesiredPlacement[];
  unreachable: UnreachableEntry[];
  bleed: BleedEntry[];
  /** tprompt export-channel report (ADR 0008): availability + resolved namespace. */
  tprompt: TpromptReport;
}

/** First-party dir id → rendering dialect (only these dirs ever render). */
const DIR_DIALECT: Record<string, Dialect> = {
  claude: "claude",
  copilot: "copilot",
  codex: "codex",
};

export function dialectForDir(dir: string): Dialect | undefined {
  return DIR_DIALECT[dir];
}

/**
 * Absolute rendered-file path for one agent definition on one harness. Single
 * source of truth for `export: agent` placement paths, shared by the placement
 * solver (appendAgentDefFiles) and `adopt` so the two can never drift on where a
 * definition lands. Copilot's dir relocates with $COPILOT_HOME (oracle parity);
 * every other harness uses its fixed tilde-form registry agentDefDir.
 */
export function agentDefFilePath(
  env: SkmEnv,
  agentId: string,
  agent: AgentCapability,
  defName: string,
  dialect: AgentDefDialect,
): string {
  const dir =
    agentId === "github-copilot"
      ? path.join(resolveCopilotHome(env), "agents")
      : expandTilde(env, agent.agentDefDir!);
  return path.join(dir, `${defName}${agentDefExt(dialect)}`);
}

/** Solve every desired skill + agent def into absolute placements plus unreachable/bleed. */
export function computeDesiredPlacements(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
): SolvedDesired {
  const placements: DesiredPlacement[] = [];
  const unreachable: UnreachableEntry[] = [];
  const bleed: BleedEntry[] = [];

  for (const skill of desired.skills) {
    const solved = solvePlacements(skill, config, registry);
    for (const p of solved.placements) {
      const abs = expandTilde(env, p.path);
      const placement: Placement = { ...p, path: abs };
      // Gated placements bind the full rendered tree (SKILL.md + companion) as their
      // hash, like composed skills (ADR 0010/0011). The solver is fs-free, so the tree
      // hash is computed here where the source is readable.
      if (placement.gated) placement.hash = gatedTreeHash(skill, p.agent, p.dir, registry);
      placements.push({
        skill: skill.name,
        source: skill.source,
        desiredSkill: skill,
        placement,
      });
      if (p.bleed && p.bleed.length > 0) {
        bleed.push({ skill: skill.name, path: abs, agent: p.agent, readers: p.bleed });
      }
    }
    for (const agent of solved.unreachable) {
      unreachable.push({ skill: skill.name, agent });
    }
  }

  const enabled = enabledAgents(config, registry);
  for (const def of desired.agentDefs) {
    if (def.exportMode === "none") continue;
    if (def.exportMode === "skill") {
      appendDerivedSkill(env, config, registry, def, placements, unreachable, bleed);
    } else {
      appendAgentDefFiles(env, registry, enabled, def, placements, unreachable);
    }
  }

  // Composed skills (ADR 0010): one rendered tree per declared consumer, fanned out
  // to that consumer's ownDir, bypassing the read-graph solver.
  for (const composed of desired.composedSkills) {
    appendComposedSkills(env, registry, enabled, composed, placements, bleed);
  }

  // tprompt export channel (ADR 0008): one owned rendered-file prompt per eligible
  // skill / agent-def. Empty when the channel is unavailable; the report carries
  // availability + the resolved namespace for plan/status display.
  const tp = computeTpromptPlacements(env, desired.skills, desired.agentDefs);
  placements.push(...tp.placements);

  return { placements, unreachable, bleed, tprompt: tp.report };
}

/**
 * export "skill": run the definition's derived skill through the SAME skill solver
 * (shared + claude + hermes-add-only, scoping and all), then force every placement
 * to a render-only artifact — a derived skill has no source SKILL.md to symlink, so
 * the cheap-path never applies (ADR 0007). State keys stay in the skill namespace.
 */
function appendDerivedSkill(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  def: DesiredAgentDef,
  placements: DesiredPlacement[],
  unreachable: UnreachableEntry[],
  bleed: BleedEntry[],
): void {
  const name = def.derivedSkillName ?? def.name;
  const synthetic: DesiredSkill = { name, source: def.source, scoping: def.scoping, overrides: {} };
  const solved = solvePlacements(synthetic, config, registry);
  // Oracle parity (resolve_selection, export == "skill"): hermes-skills is a
  // per-def opt-in — the solver's unscoped/deny paths add hermes on machine
  // enablement alone, but a derived skill reaches hermes ONLY when the definition
  // explicitly opted in (harness.include → allow contains "hermes"). Both the
  // per-def opt-in AND machine enablement are required.
  const hermesOptIn = def.scoping?.allow?.includes("hermes") ?? false;
  for (const p of solved.placements) {
    if (p.agent === "hermes" && !hermesOptIn) continue;
    const abs = expandTilde(env, p.path);
    const placement: Placement = {
      ...p,
      path: abs,
      kind: "rendered", // render-only: independent hashed copies per target dir
      artifactType: "skill",
      derived: true,
    };
    placements.push({ skill: name, source: def.source, desiredAgentDef: def, placement });
    if (p.bleed && p.bleed.length > 0) {
      bleed.push({ skill: name, path: abs, agent: p.agent, readers: p.bleed });
    }
  }
  for (const agent of solved.unreachable) unreachable.push({ skill: name, agent });
}

/**
 * export "agent": one rendered file per enabled harness that supports agent
 * definitions, into its registry agentDefDir, rendered via its agentDefDialect.
 * Scoping filters the enabled set — `deny` removes a harness (hard guarantee, its
 * own dir never gets the file), `allow` keeps only listed harnesses; an explicitly
 * allowed harness without agent-def support is reported unreachable.
 *
 * Bleed note: agent-def dirs are modeled as own-dir (each harness reads only its
 * own agentDefDir), so no incidental readers are reported. The one documented
 * cross-harness read (cursor reading ~/.claude|.codex agents) is an evidence gap
 * tracked for a later registry pass; deny stays exact because a denied harness's
 * OWN dir never receives the file.
 */
function appendAgentDefFiles(
  env: SkmEnv,
  registry: Registry,
  enabled: string[],
  def: DesiredAgentDef,
  placements: DesiredPlacement[],
  unreachable: UnreachableEntry[],
): void {
  const targets = filterByScope(enabled, def.scoping);
  for (const agentId of targets.agents) {
    const agent = registry.agents[agentId];
    const dialect = agent?.agentDefDialect;
    if (!agent || agent.agentDefSupport !== "supported" || !agent.agentDefDir || !dialect) {
      if (targets.explicit) unreachable.push({ skill: def.name, agent: agentId });
      continue;
    }
    const abs = agentDefFilePath(env, agentId, agent, def.name, dialect);
    const placement: Placement = {
      agent: agentId,
      dir: agentId,
      path: abs,
      kind: "rendered-file",
      artifactType: "agent-def",
      renderDialect: dialect,
    };
    if (agent.addOnly) placement.addOnly = true;
    placements.push({ skill: def.name, source: def.source, desiredAgentDef: def, placement });
  }
}

/**
 * export composed-skill: one `kind: "rendered"` placement per declared consumer,
 * fanned out to the consumer's registry ownDir, bypassing the read-graph solver
 * (ADR 0010). The placement `hash` IS the full rendered-tree hash (the composed
 * content binding). `deprecated` is read from the registry directory entry itself
 * (the solver's lookup does not run for us); bleed uses a readers-INCLUDING-
 * maybeReads variant (the solver's bleedFor excludes maybeReads and would hide,
 * e.g., grok's read of the claude dir).
 */
function appendComposedSkills(
  env: SkmEnv,
  registry: Registry,
  enabled: string[],
  composed: DesiredComposedSkill,
  placements: DesiredPlacement[],
  bleed: BleedEntry[],
): void {
  for (const consumer of Object.keys(composed.consumers).sort()) {
    // Declared consumers are intersected with the machine's enabled agents, like
    // every other placement type — a machine configured without claude-code must
    // not receive claude-code's composed tree.
    if (!enabled.includes(consumer)) continue;
    const ownDir = registry.agents[consumer]?.ownDir;
    if (!ownDir) continue; // load-time guards ensure supported consumers have an ownDir
    const dir = registry.directories[ownDir];
    if (!dir) continue;
    const abs = path.join(expandTilde(env, dir.path), composed.name);
    const placement: Placement = {
      agent: consumer,
      dir: ownDir,
      path: abs,
      kind: "rendered",
      artifactType: "composed-skill",
      hash: composedTreeHash(composed, consumer, registry),
    };
    if (dir.deprecated) placement.deprecated = true;
    const readers = readersOf(registry, ownDir, { includeMaybe: true })
      .filter((r) => r !== consumer)
      .sort();
    if (readers.length > 0) placement.bleed = readers;
    placements.push({ skill: composed.name, source: composed.source, desiredComposed: composed, placement });
    if (readers.length > 0) bleed.push({ skill: composed.name, path: abs, agent: consumer, readers });
  }
}

/** Apply allow/deny scoping to the enabled set; `explicit` marks an allow list. */
function filterByScope(
  enabled: string[],
  scope: AgentScope | undefined,
): { agents: string[]; explicit: boolean } {
  if (scope?.allow !== undefined) return { agents: [...scope.allow], explicit: true };
  if (scope?.deny !== undefined) {
    const deny = new Set(scope.deny);
    return { agents: enabled.filter((a) => !deny.has(a)), explicit: false };
  }
  return { agents: [...enabled], explicit: false };
}
