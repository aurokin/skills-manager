// tprompt export channel (ADR 0008): desired-placement computation, availability
// probe, and the flat-namespace collision guard. tprompt placements are ordinary
// owned rendered-file placements (agent sentinel "tprompt", kind "rendered-file",
// channel "tprompt") so plan/apply/status/doctor treat them like any other owned
// artifact — with two channel-specific rules the callers apply:
//   - availability: when the probe is false, no tprompt placements are produced,
//     and callers must NOT prune existing owned tprompt placements.
//   - collision: the guard scans the ENTIRE resolved namespace (prompts_dir +
//     additional_prompts_dirs, flat). skm-vs-skm stem clashes hard-fail the plan
//     (assertNoTpromptStemCollisions, called from the resolver); clashes with a
//     foreign prompt are reported + skip that one placement (ADR 0006).

import * as fs from "node:fs";
import * as path from "node:path";
import { CollisionError } from "../errors";
import type { SkmEnv } from "../env";
import type { DesiredPlacement } from "../placements";
import type {
  DesiredAgentDef,
  DesiredSkill,
  DriftFinding,
  Placement,
  StateFile,
  TpromptReport,
} from "../types";
import { resolveTpromptDirs } from "./config";
import { tpromptStem } from "./spec";

/** tprompt binary on PATH — the channel probe. Absent probe → unavailable (safe). */
export function tpromptAvailable(env: SkmEnv): boolean {
  return env.tpromptProbe ? env.tpromptProbe() : false;
}

/** True when a skill declares a tprompt block (any managed skill may export). */
function skillEligible(skill: DesiredSkill): boolean {
  return skill.tprompt?.enabled === true;
}

/**
 * Eligibility for an agent definition: it must declare a tprompt block AND export
 * as `agent`. Matching the oracle (resolve_selection strips `tprompt` from the
 * harness set for non-`agent` exports, then the sync loop drops them): export
 * `skill` flows to the derived-skill channel and export `none` is placed nowhere,
 * so neither reaches tprompt.
 */
function agentDefEligible(def: DesiredAgentDef): boolean {
  return def.exportMode === "agent" && def.def.tprompt.enabled === true;
}

/**
 * Compute the desired tprompt placements for the eligible skills + agent defs, plus
 * the channel report. When the channel is unavailable, `placements` is empty (no
 * writes this run) but the report still resolves the namespace for display.
 */
export function computeTpromptPlacements(
  env: SkmEnv,
  skills: DesiredSkill[],
  agentDefs: DesiredAgentDef[],
): { placements: DesiredPlacement[]; report: TpromptReport } {
  const dirs = resolveTpromptDirs(env);
  const available = tpromptAvailable(env);
  const report: TpromptReport = {
    available,
    promptsDir: dirs.promptsDir,
    additionalDirs: dirs.additionalDirs,
    ...(dirs.configPath ? { configPath: dirs.configPath } : {}),
  };
  if (!available) return { placements: [], report };

  const placements: DesiredPlacement[] = [];
  for (const skill of skills) {
    if (!skillEligible(skill)) continue;
    const stem = tpromptStem(skill.tprompt!, skill.name);
    placements.push({
      skill: skill.name,
      source: skill.source,
      desiredSkill: skill,
      placement: promptPlacement(dirs.promptsDir, stem, "skill"),
    });
  }
  for (const def of agentDefs) {
    if (!agentDefEligible(def)) continue;
    const stem = tpromptStem(def.def.tprompt, def.name);
    placements.push({
      skill: def.name,
      source: def.source,
      desiredAgentDef: def,
      placement: promptPlacement(dirs.promptsDir, stem, "agent-def"),
    });
  }
  return { placements, report };
}

function promptPlacement(promptsDir: string, stem: string, artifactType: "skill" | "agent-def"): Placement {
  return {
    agent: "tprompt",
    dir: "tprompt",
    path: path.join(promptsDir, `${stem}.md`),
    kind: "rendered-file",
    artifactType,
    channel: "tprompt",
  };
}

/**
 * Hard-fail when two skm tprompt-enabled artifacts resolve to the same prompt stem
 * (an authoring error — tprompt's flat namespace forbids duplicate stems). Pure
 * over the desired set and independent of the probe, so it fires before any
 * mutation regardless of availability. Callers name both artifacts to fix it.
 */
export function assertNoTpromptStemCollisions(skills: DesiredSkill[], agentDefs: DesiredAgentDef[]): void {
  const owner = new Map<string, string>();
  const claim = (stem: string, who: string): void => {
    const prior = owner.get(stem);
    if (prior !== undefined) {
      throw new CollisionError(
        `tprompt prompt stem '${stem}' is produced by both '${prior}' and '${who}'; set a unique tprompt.filename`,
      );
    }
    owner.set(stem, who);
  };
  for (const skill of skills) {
    if (skillEligible(skill)) claim(tpromptStem(skill.tprompt!, skill.name), skill.name);
  }
  for (const def of agentDefs) {
    if (agentDefEligible(def)) claim(tpromptStem(def.def.tprompt, def.name), def.name);
  }
}

/**
 * Collision guard against any OTHER prompt sharing a desired stem in the resolved
 * flat namespace (prompts_dir + additional_prompts_dirs — directories do not
 * namespace, per tprompt DECISIONS.md). The ONLY path exempt from the scan is the
 * placement's own desired target: that path is the per-file diff's job
 * (diffTpromptFile — byte-match adopt vs foreign refusal). Every other same-stem
 * path collides regardless of ownership — a foreign prompt, or a stale owned export
 * left in another dir (e.g. after prompts_dir moved) — because tprompt hard-errors
 * on a duplicate stem across the flat namespace. Returns the target paths to skip
 * and a foreign finding per skipped placement.
 */
export function resolveTpromptCollisions(
  report: TpromptReport,
  placements: DesiredPlacement[],
  state: StateFile,
): { skip: Set<string>; foreign: DriftFinding[] } {
  const skip = new Set<string>();
  const foreign: DriftFinding[] = [];
  if (placements.length === 0) return { skip, foreign };

  const owned = ownedTpromptPaths(state);
  const namespace = scanNamespace([report.promptsDir, ...report.additionalDirs]);

  for (const dp of placements) {
    const target = path.resolve(dp.placement.path);
    const stem = path.basename(target).replace(/\.md$/, "");
    const hits = (namespace.get(stem) ?? []).filter((f) => f !== target);
    if (hits.length > 0) {
      skip.add(target);
      const stale = hits.some((f) => owned.has(f));
      const hint = stale ? "; re-run apply with --prune to remove the stale export first" : "";
      foreign.push({
        drift: "foreign",
        skill: dp.skill,
        artifactType: dp.placement.artifactType,
        path: target,
        detail: `tprompt stem '${stem}' already used at: ${hits.join(", ")}; placement skipped${hint}`,
      });
    }
  }
  return { skip, foreign };
}

/** Resolved absolute paths of every owned tprompt-channel placement in state. */
function ownedTpromptPaths(state: StateFile): Set<string> {
  const out = new Set<string>();
  for (const artifact of Object.values(state.artifacts)) {
    for (const sp of artifact.placements) {
      if (sp.agent === "tprompt") out.add(path.resolve(sp.path));
    }
  }
  return out;
}

/** Map prompt stem → resolved paths of every `.md` file under the given dirs (recursive). */
function scanNamespace(dirs: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const dir of dirs) {
    for (const file of listMdFiles(dir)) {
      const stem = path.basename(file).replace(/\.md$/, "");
      const arr = map.get(stem) ?? [];
      arr.push(path.resolve(file));
      map.set(stem, arr);
    }
  }
  return map;
}

function listMdFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable dir — no namespace members
  }
  const out: string[] = [];
  for (const entry of entries) {
    // Mirror tprompt's discovery (store.go shouldSkipPath/isHidden): any path
    // whose basename starts with '.' is skipped, and hidden dirs are pruned
    // (SkipDir). Scanning them would invent foreign stems tprompt never loads,
    // falsely skipping a legitimate placement.
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMdFiles(full));
    } else if (entry.name.endsWith(".md")) {
      // Not a real directory + `.md` extension → a prompt tprompt would load,
      // including symlinked `.md` files (tprompt's WalkDir yields `!d.IsDir() &&
      // Ext == ".md"`; Dirent.isFile() is lstat-based and false for symlinks).
      out.push(full);
    }
  }
  return out;
}
