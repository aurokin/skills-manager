// `skm status` — three-way diff (desired vs state vs disk) reported as drift
// classes: missing | stale | modified | foreign | unsafe. Owned by the status team.

import * as fs from "node:fs";
import * as path from "node:path";
import { agentDefFileHash, derivedSkillHash } from "./agentdef/artifact";
import { loadContext } from "./context";
import { type SkmEnv, expandTilde } from "./env";
import { computeDesiredPlacements, dialectForDir } from "./placements";
import { privacyViolation } from "./privacy";
import { hashContent, renderedHash } from "./render";
import { classifyTarget, scanEntry, scanForForeign } from "./scan";
import { findOwner } from "./state";
import type {
  DesiredState,
  DriftFinding,
  ExitCodeValue,
  MachineConfig,
  Registry,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry: exit 0 clean, 2 when any drift is present. */
export async function runStatus(env: SkmEnv, _opts: VerbOptions): Promise<VerbOutcome> {
  const ctx = loadContext(env);
  const findings = computeDrift(env, ctx.config, ctx.registry, ctx.desired, ctx.state);
  const exitCode: ExitCodeValue = findings.length > 0 ? ExitCode.PENDING : ExitCode.CLEAN;
  return { exitCode, json: { drift: findings }, human: renderHuman(findings) };
}

/** Classify divergences as missing | stale | modified | foreign | unsafe. */
export function computeDrift(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const solved = computeDesiredPlacements(env, config, registry, desired);
  const desiredByPath = new Map(solved.placements.map((dp) => [path.resolve(dp.placement.path), dp]));

  // Owned placements: is each still present and correct on disk?
  for (const artifact of Object.values(state.artifacts)) {
    const skill = artifact.name;
    const stampFrom = findings.length; // stamp this artifact's findings with its type
    for (const sp of artifact.placements) {
      const abs = path.resolve(expandTilde(env, sp.path));
      const dp = desiredByPath.get(abs);
      const entry = scanEntry(env, expandTilde(env, sp.path));

      if (entry.kind === "absent") {
        findings.push({ drift: "missing", skill, path: sp.path, detail: "owned placement missing on disk" });
        continue;
      }

      // True three-way diff (desired vs state vs disk): the DESIRED placement kind
      // may differ from what we recorded — e.g. an agents/*.yaml override was added,
      // so the skill now wants a rendered dir where an owned symlink sits. plan would
      // act on that transition, so status must report it, not read the self-consistent
      // symlink as clean (finding 5b).
      if (dp && dp.placement.kind !== sp.kind) {
        findings.push({
          drift: "stale",
          skill,
          path: sp.path,
          detail: `desired kind changed (${sp.kind} → ${dp.placement.kind}); re-run plan`,
        });
        continue;
      }

      // Single rendered file (agent-def): compare file bytes to recorded + desired hash.
      if (sp.kind === "rendered-file") {
        if (entry.kind !== "file") {
          findings.push({ drift: "modified", skill, path: sp.path, detail: "agent-def file replaced on disk" });
          continue;
        }
        const diskHash = hashContent(fs.readFileSync(abs, "utf8"));
        if (diskHash !== sp.hash) {
          findings.push({ drift: "modified", skill, path: sp.path, detail: "agent-def file hand-edited" });
        } else if (!dp) {
          findings.push({ drift: "stale", skill, path: sp.path, detail: "owned placement no longer desired" });
        } else if (
          dp.placement.renderDialect &&
          agentDefFileHash(dp.source.path, dp.placement.renderDialect) !== sp.hash
        ) {
          findings.push({ drift: "stale", skill, path: sp.path, detail: "desired agent-def render changed since apply; re-run plan" });
        }
        continue;
      }

      if (sp.kind === "rendered") {
        if (entry.sha256OfSkillMd !== sp.hash) {
          findings.push({ drift: "modified", skill, path: sp.path, detail: "rendered artifact hand-edited" });
          continue;
        }
        if (!dp) {
          findings.push({ drift: "stale", skill, path: sp.path, detail: "owned placement no longer desired" });
          continue;
        }
        // Disk matches state — but does state still match what plan WOULD render? A
        // source/override edit after apply changes the desired render while disk stays
        // at the old bytes, so plan would emit an update. Compare to the currently
        // desired render, not just to state, or status falsely reads clean (finding 5a).
        const dialect = dialectForDir(dp.placement.dir);
        const expected = dp.placement.derived
          ? derivedSkillHash(dp.source.path, dp.placement.agent === "hermes")
          : dialect && dp.desiredSkill
            ? renderedHash(dp.desiredSkill, dialect)
            : undefined;
        if (expected !== undefined && expected !== sp.hash) {
          findings.push({
            drift: "stale",
            skill,
            path: sp.path,
            detail: "desired render changed since apply (source or override edited); re-run plan",
          });
        }
        continue;
      }

      // symlink placement
      const target = dp ? dp.source.path : artifactSourcePath(env, sp.path);
      const status = classifyTarget(env, sp.path, target);
      if (status !== "adopted") {
        findings.push({ drift: "stale", skill, path: sp.path, detail: `owned symlink ${status}` });
      } else if (!dp) {
        findings.push({ drift: "stale", skill, path: sp.path, detail: "owned placement no longer desired" });
      }
    }
    for (let i = stampFrom; i < findings.length; i++) findings[i]!.artifactType = artifact.type;
  }

  // Desired placements not yet applied (no owner, nothing on disk).
  for (const dp of solved.placements) {
    const abs = path.resolve(dp.placement.path);
    if (findOwner(state, abs)) continue;
    const entry = scanEntry(env, dp.placement.path);
    if (entry.kind === "absent") {
      findings.push({ drift: "missing", skill: dp.skill, artifactType: dp.placement.artifactType ?? "skill", path: dp.placement.path, detail: "desired placement not yet applied" });
    }
  }

  // Foreign entries in agent dirs, and private-content safety.
  findings.push(...scanForForeign(env, registry, state));
  findings.push(...unsafePrivate(env, config, state));

  return findings;
}

/** Private-visibility owned placements sitting in a disallowed git worktree. */
function unsafePrivate(env: SkmEnv, config: MachineConfig, state: StateFile): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.source.visibility !== "private") continue;
    for (const sp of artifact.placements) {
      const abs = expandTilde(env, sp.path);
      const reason = privacyViolation(config, abs);
      // Use the bare artifact name (not the type-qualified state key like `skill:x`)
      // and stamp artifactType, matching the other status findings.
      if (reason) out.push({ drift: "unsafe", skill: artifact.name, artifactType: artifact.type, path: sp.path, detail: reason });
    }
  }
  return out;
}

/** Fallback expected source for an owned symlink whose skill is no longer desired. */
function artifactSourcePath(env: SkmEnv, recordedPath: string): string {
  // Resolve what the link points at now; classifyTarget compares realpaths, so a
  // self-consistent link reads as adopted and the "no longer desired" branch fires.
  const entry = scanEntry(env, recordedPath);
  return entry.resolvedTarget ?? expandTilde(env, recordedPath);
}

function renderHuman(findings: DriftFinding[]): string {
  if (findings.length === 0) return "No drift. Desired, state, and disk agree.";
  return findings
    .map((f) => `  ${f.drift.padEnd(9)} ${(f.artifactType ?? "-").padEnd(9)} ${f.skill ?? "-"}  ${f.path}  (${f.detail})`)
    .join("\n");
}
