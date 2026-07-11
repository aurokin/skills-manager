// `skm explain <skill>` — source root, scoping, computed placements, bleed, and
// visibility for one skill. Owned by the explain team.

import * as path from "node:path";
import { loadContext } from "./context";
import { UsageError } from "./errors";
import { type SkmEnv, expandTilde } from "./env";
import { computeDesiredPlacements } from "./placements";
import { solvePlacements } from "./solver";
import type {
  ArtifactType,
  DesiredState,
  MachineConfig,
  Placement,
  Registry,
  SkillExplanation,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry. Requires one positional skill name. */
export async function runExplain(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const name = opts.args[0];
  if (!name) throw new UsageError("explain requires an artifact name: skm explain <name>");
  const ctx = loadContext(env);
  const explanation = explainSkill(env, ctx.config, ctx.registry, ctx.desired, ctx.state, name);
  return { exitCode: ExitCode.CLEAN, json: explanation, human: renderHuman(explanation) };
}

/** Build the explanation record for a single skill or agent definition. */
export function explainSkill(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  _state: StateFile,
  name: string,
): SkillExplanation {
  const skill = desired.skills.find((s) => s.name === name);
  if (skill) {
    const solved = solvePlacements(skill, config, registry);
    const placements: Placement[] = solved.placements.map((p) => ({ ...p, path: expandTilde(env, p.path) }));
    return assemble("skill", skill.name, skill.source, skill.scoping, placements, solved.unreachable);
  }

  // Agent definitions resolve through the shared placement engine; filter its
  // output to this definition by source directory (unique per artifact). Match by
  // the definition name OR its derivedSkillName, so `explain <derived-name>`
  // resolves the export: skill artifact skm actually manages under that name.
  const def = desired.agentDefs.find((d) => d.name === name || d.derivedSkillName === name);
  if (!def) throw new UsageError(`unknown artifact: ${name}`);
  const solved = computeDesiredPlacements(env, config, registry, desired);
  const wantSource = path.resolve(def.source.path);
  const placements = solved.placements
    .filter((dp) => path.resolve(dp.source.path) === wantSource)
    .map((dp) => dp.placement);
  const derivedName = def.derivedSkillName ?? def.name;
  const unreachable = solved.unreachable
    .filter((u) => u.skill === def.name || u.skill === derivedName)
    .map((u) => u.agent);
  return assemble("agent-def", def.name, def.source, def.scoping, placements, unreachable);
}

function assemble(
  artifactType: ArtifactType,
  name: string,
  source: SkillExplanation["source"],
  scoping: SkillExplanation["scoping"],
  placements: Placement[],
  unreachable: string[],
): SkillExplanation {
  const bleed: Record<string, string[]> = {};
  for (const p of placements) {
    if (p.bleed && p.bleed.length > 0) bleed[p.path] = p.bleed;
  }
  const explanation: SkillExplanation = { name, artifactType, source, placements, unreachable, bleed };
  if (scoping) explanation.scoping = scoping;
  return explanation;
}

function renderHuman(e: SkillExplanation): string {
  const lines: string[] = [];
  lines.push(`${e.name}  [${e.artifactType}]  (${e.source.visibility}, root '${e.source.root}')`);
  lines.push(`  source: ${e.source.path}`);
  if (e.scoping?.allow) lines.push(`  scoping: allow ${e.scoping.allow.join(", ")}`);
  else if (e.scoping?.deny) lines.push(`  scoping: deny ${e.scoping.deny.join(", ")}`);
  else lines.push("  scoping: unscoped (shared)");
  lines.push("  placements:");
  for (const p of e.placements) {
    const bleed = e.bleed[p.path]?.length ? `  bleed→ ${e.bleed[p.path]!.join(", ")}` : "";
    lines.push(`    ${p.agent.padEnd(16)} ${p.kind.padEnd(8)} ${p.path}${bleed}`);
  }
  if (e.unreachable.length) lines.push(`  unreachable: ${e.unreachable.join(", ")}`);
  return lines.join("\n");
}
