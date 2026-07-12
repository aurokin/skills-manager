// `skm doctor` — health checks over the live registry, config, desired state and
// disk: broken owned symlinks, rendered-hash drift, deny-guarantee verification,
// private-content leaks, missing roots, and kill-switch suggestions. --fix repairs
// only owned artifacts. Owned by the doctor team.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadContext, registryPath } from "./context";
import { type SkmEnv, expandTilde } from "./env";
import { gatedExposureOf, gatedExposureRemedy, gateHonored } from "./gated";
import { loadMachineConfig } from "./machine-config";
import { computeDesiredPlacements, dialectForDir } from "./placements";
import { privacyViolation } from "./privacy";
import { dirPath, loadRegistry, readersOf } from "./registry";
import { renderComposedSkill } from "./composed/render";
import { hashContent, renderSkill, treeHashOf } from "./render";
import { resolveDesiredState } from "./resolve";
import { artifactKey, loadState, saveState, upsertPlacement } from "./state";
import { type ScanEntry, scanEntry, scanRegistryDirs } from "./scan";
import type {
  AgentScope,
  DesiredSkill,
  DesiredState,
  ExitCodeValue,
  Finding,
  MachineConfig,
  Registry,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry: exit 2 when actionable (error/warn) findings exist. */
export async function runDoctor(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);

  // Missing roots are reported (not aborted) so doctor can still diagnose the rest.
  const missing: Finding[] = [];
  const present = config.roots.filter((r) => {
    if (fs.existsSync(r.path)) return true;
    missing.push({
      category: "reconcile",
      severity: "error",
      message: `registered root '${r.name}' missing on disk: ${r.path}`,
      fixable: false,
    });
    return false;
  });
  const desired = resolveDesiredState(env, { ...config, roots: present }, registry);
  const state = loadState(env);

  let findings = [...missing, ...diagnose(env, config, registry, desired, state)];

  if (opts.fix) {
    const fixed = applyFixes(env, config, registry, desired, state);
    if (fixed > 0) {
      saveState(env, state);
      // Re-diagnose to reflect repairs.
      findings = [...missing, ...diagnose(env, config, registry, desired, state)];
      findings.push({ category: "reconcile", severity: "info", message: `applied ${fixed} fix(es)`, fixable: false });
    }
  }

  const actionable = findings.some((f) => f.severity !== "info");
  const exitCode: ExitCodeValue = actionable ? ExitCode.PENDING : ExitCode.CLEAN;
  return { exitCode, json: { findings }, human: renderHuman(findings) };
}

/** Collect findings across the live registry, config, desired state, and disk. */
export function diagnose(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const findings: Finding[] = [];

  // Derived-skill rendered placements are NOT repairable by --fix: applyFixes
  // skips them (re-render needs the derived-skill path, not renderSkill), so their
  // drift must be reported non-fixable — else doctor promises a fix it won't apply.
  const derivedRenderedPaths = new Set<string>();
  for (const dp of computeDesiredPlacements(env, config, registry, desired).placements) {
    if (dp.placement.derived) derivedRenderedPaths.add(path.resolve(dp.placement.path));
  }

  // 1. Broken owned symlinks + 2. rendered-hash drift (dirs and single files).
  for (const artifact of Object.values(state.artifacts)) {
    const skill = artifact.name;
    for (const sp of artifact.placements) {
      const entry = scanEntry(env, expandTilde(env, sp.path));
      // Tree-hashed rendered placement: a composed-skill consumer tree (ADR 0010) or a
      // gated-skill tree (ADR 0011). MUST precede the `rendered` branch: its hash is the
      // full-tree hash, so the SKILL.md-sha compare there would false-positive. Neither
      // is --fix repairable (applyFixes skips them); a hand-edit is remedied by
      // remove-then-re-apply → fixable: false. Gatedness is per-placement (a gated
      // skill's artifact type stays "skill"), so key off sp.gated too.
      if (artifact.type === "composed-skill" || sp.gated) {
        const treeNoun = sp.gated ? "gated skill tree" : "composed tree";
        const editNoun = sp.gated ? "gated skill" : "composed skill";
        if (sp.kind === "rendered") {
          if (entry.kind === "absent") {
            findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `owned ${treeNoun} missing`, fixable: false });
          } else if (entry.kind !== "dir") {
            findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `owned ${treeNoun} replaced by ${entry.kind}`, fixable: false });
          } else if (treeHashOf(expandTilde(env, sp.path)) !== sp.tree) {
            findings.push({ category: "reconcile", severity: "warn", skill, path: sp.path, message: `${editNoun} hand-edited (tree hash mismatch)`, fixable: false });
          }
        }
        continue;
      }
      if (sp.kind === "symlink") {
        if (entry.kind === "symlink" && entry.broken) {
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `broken owned symlink -> ${entry.linkTarget ?? "?"}`, fixable: true });
        } else if (entry.kind === "absent") {
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: "owned symlink missing", fixable: true });
        }
      } else if (sp.kind === "rendered" && entry.kind === "dir" && entry.sha256OfSkillMd !== sp.hash) {
        const fixable = !derivedRenderedPaths.has(path.resolve(expandTilde(env, sp.path)));
        findings.push({ category: "reconcile", severity: "warn", skill, path: sp.path, message: "rendered artifact hand-edited (hash mismatch)", fixable });
      } else if (sp.kind === "rendered-file") {
        const noun = sp.agent === "tprompt" ? "tprompt prompt" : "agent-def file";
        if (entry.kind === "absent") {
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `owned ${noun} missing`, fixable: false });
        } else if (entry.kind !== "file") {
          // A dir or symlink replaced the rendered file → not skm's render, and the
          // file-hash branch below would silently skip it; flag it like a missing file.
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `owned ${noun} replaced by ${entry.kind}`, fixable: false });
        } else if (hashContent(fs.readFileSync(expandTilde(env, sp.path), "utf8")) !== sp.hash) {
          findings.push({ category: "reconcile", severity: "warn", skill, path: sp.path, message: `${noun} hand-edited (hash mismatch)`, fixable: false });
        }
      }
    }
  }

  // 3. Deny-guarantee verification against the live registry.
  findings.push(...verifyDenyGuarantee(env, config, registry, desired, state));

  // 4a. Private-content leaks: owned private placements in disallowed worktrees.
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.source.visibility !== "private") continue;
    for (const sp of artifact.placements) {
      const reason = privacyViolation(config, expandTilde(env, sp.path));
      if (reason) findings.push({ category: "private-leak", severity: "error", skill: artifact.name, path: sp.path, message: reason, fixable: false });
    }
  }

  // 4b. Private content in UNEXPECTED locations (design §9): scan agent dirs for
  // entries skm does not own whose SKILL.md matches a private source's hash, or
  // symlinks resolving into a private root. Catches stale layouts, manual copies,
  // and the --plan-then-drop-from-state case.
  findings.push(...scanUnmanagedPrivateLeaks(env, config, registry, desired, state));

  // 5. Kill-switch suggestions for bleed onto agents with a suppression env var.
  findings.push(...killSwitchSuggestions(env, config, registry, desired));

  // 6. Agent-def default-skills cross-reference: a definition naming a default
  //    skill that is hidden from (or absent for) the harness it is placed on.
  findings.push(...agentDefSkillReferences(env, config, registry, desired));

  // 7. Gated (user-invoked-only) skill placement leaks (ADR 0011): a gated skill found
  //    on disk in a shared root (finding a), or in a no-gate agent's own dir without a
  //    permissive override (finding b) — either exposes it to the model invocation the
  //    gate exists to prevent.
  findings.push(...gatedPlacementLeaks(env, registry, desired));

  // 7b. Gated-exposure advisory: a LIVE gated placement whose dir currently has
  //     readers that do not enforce the gate and are not permissive-acknowledged.
  //     Warn-level — the placement itself is correct (the target's gate holds); the
  //     exposure is through incidental readers (e.g. opencode reading the claude dir).
  findings.push(...gatedLiveExposure(env, registry, desired, state));

  // 8. Gate-version drift (ADR 0011, finding c): the installed CLI drifted from the
  //    probed gate version for an agent actually receiving gated skills.
  findings.push(...gateVersionDrift(env, config, registry, desired));

  return findings;
}

/**
 * Warn for each state-owned gated placement whose dir has an uncovered no-gate
 * reader (gatedExposureOf against the CURRENT registry, so a registry edit adding a
 * reader after apply is caught). Permissive-acknowledged agents are covered; readers
 * that honor the gate enforce the frontmatter themselves and are never exposure.
 */
function gatedLiveExposure(
  env: SkmEnv,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const permissiveByName = new Map<string, Set<string>>();
  for (const s of desired.skills) {
    if (s.gated) permissiveByName.set(s.name, new Set(s.gating?.permissive ?? []));
  }
  const dirByPath = registryDirByPath(env, registry);

  const findings: Finding[] = [];
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.type !== "skill") continue;
    for (const sp of artifact.placements) {
      if (!sp.gated) continue;
      // A deleted/replaced placement is already a missing/drift finding; exposure
      // is only real while the rendered tree actually sits on disk.
      const abs = expandTilde(env, sp.path);
      let isDir = false;
      try {
        isDir = fs.lstatSync(abs).isDirectory();
      } catch {
        /* missing → not exposed */
      }
      if (!isDir) continue;
      const dirId = dirByPath.get(path.resolve(path.dirname(abs)));
      if (!dirId) continue;
      const permissive = permissiveByName.get(artifact.name) ?? new Set<string>();
      const exposed = gatedExposureOf(registry, dirId, sp.agent, permissive);
      if (exposed.length === 0) continue;
      findings.push({
        category: "gated-leak",
        severity: "warn",
        skill: artifact.name,
        path: sp.path,
        message:
          `gated skill '${artifact.name}' in dir '${dirId}' is readable by no-gate agent(s) ` +
          `${exposed.join(", ")}, which ignore disable-model-invocation; ` +
          gatedExposureRemedy(registry, exposed),
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * Scan every registry dir for a gated skill (SKILL.md frontmatter
 * `disable-model-invocation: true`) sitting where its gate is not enforced: the shared
 * root (readable by every agent — finding a), or a no-gate agent's OWN dir with no
 * permissive opt-in (finding b). Both are errors: the skill the user marked
 * user-invoked-only is model-exposed there. Owned, correctly-gated placements (an
 * agent whose own gate honors the frontmatter) are fine and pass silently.
 */
function gatedPlacementLeaks(env: SkmEnv, registry: Registry, desired: DesiredState): Finding[] {
  const permissiveByName = new Map<string, Set<string>>();
  for (const s of desired.skills) {
    if (s.gated) permissiveByName.set(s.name, new Set(s.gating?.permissive ?? []));
  }
  const ownerByDir = new Map<string, string>();
  for (const [id, a] of Object.entries(registry.agents)) {
    if (a.ownDir) ownerByDir.set(a.ownDir, id);
  }

  const findings: Finding[] = [];
  for (const [dirId, entries] of Object.entries(scanRegistryDirs(env, registry))) {
    for (const entry of entries) {
      if (!isGatedOnDisk(entry)) continue;
      if (dirId === "shared") {
        findings.push({
          category: "gated-leak",
          severity: "error",
          skill: entry.name,
          path: entry.path,
          message: `gated skill '${entry.name}' is placed in the shared root '${dirId}', where every agent reads it and the gate is not enforced`,
          fixable: false,
        });
        continue;
      }
      const owner = ownerByDir.get(dirId);
      if (!owner) continue;
      const gate = registry.agents[owner]?.skillInvocation?.gate;
      if (gateHonored(gate)) {
        // A companion-gated owner (codex) ignores the frontmatter — the gate only
        // holds if the companion file itself sits next to SKILL.md and pins the
        // flag. Catches unowned/state-lost trees that were never rendered by skm.
        if (gate!.startsWith("companion:") && !companionEnforced(entry, gate!)) {
          findings.push({
            category: "gated-leak",
            severity: "error",
            skill: entry.name,
            path: entry.path,
            message:
              `gated skill '${entry.name}' in companion-gated agent '${owner}' dir '${dirId}' is missing an ` +
              `enforcing '${gate!.slice("companion:".length)}' (frontmatter alone is ignored there); re-apply with skm`,
            fixable: false,
          });
        }
        continue;
      }
      if (permissiveByName.get(entry.name)?.has(owner)) continue; // explicit prose-gated opt-in
      findings.push({
        category: "gated-leak",
        severity: "error",
        skill: entry.name,
        path: entry.path,
        message: `gated skill '${entry.name}' is placed in no-gate agent '${owner}' dir '${dirId}', which cannot enforce the gate and has no permissive override`,
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * Warn when the installed CLI version has drifted from the registry's probed gate
 * version for any agent actually receiving gated skills (ADR 0011). Gate behavior is
 * version-behavior (copilot's is undocumented), so a drift means the gate may no longer
 * hold. Best-effort: the version probe is injected; a missing binary or unparseable
 * output skips silently. Only runs for agents with gated placements, keeping it cheap.
 */
function gateVersionDrift(env: SkmEnv, config: MachineConfig, registry: Registry, desired: DesiredState): Finding[] {
  if (!env.agentVersionProbe) return [];
  const agents = new Set<string>();
  for (const dp of computeDesiredPlacements(env, config, registry, desired).placements) {
    if (dp.placement.gated) agents.add(dp.placement.agent);
  }
  const findings: Finding[] = [];
  for (const agentId of [...agents].sort()) {
    const si = registry.agents[agentId]?.skillInvocation;
    if (!si?.probedVersion) continue;
    const installed = env.agentVersionProbe(agentId);
    if (installed === undefined || installed === si.probedVersion) continue;
    findings.push({
      category: "gate-version-drift",
      severity: "warn",
      message: `${agentId} CLI is ${installed}, but its gate was probed against ${si.probedVersion} — re-verify disable-model-invocation still holds before relying on it`,
      fixable: false,
    });
  }
  return findings;
}

/**
 * True when a companion-gated entry actually carries its enforcing companion:
 * the file named by the gate mechanism string exists in the skill dir and pins
 * `policy.allow_implicit_invocation: false`. Missing/unparseable → not enforced.
 */
function companionEnforced(entry: ScanEntry, gate: string): boolean {
  const dir =
    entry.kind === "dir" ? entry.path : entry.kind === "symlink" ? entry.resolvedTarget : undefined;
  if (!dir) return false;
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(path.join(dir, gate.slice("companion:".length)), "utf8"));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const policy = (parsed as Record<string, unknown>).policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  return (policy as Record<string, unknown>).allow_implicit_invocation === false;
}

/** True when the entry's SKILL.md frontmatter declares `disable-model-invocation: true`. */
function isGatedOnDisk(entry: ScanEntry): boolean {
  const dir =
    entry.kind === "dir" ? entry.path : entry.kind === "symlink" ? entry.resolvedTarget : undefined;
  if (!dir) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return false;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return false;
  let fm: unknown;
  try {
    fm = parseYaml(m[1] ?? "");
  } catch {
    return false;
  }
  return (
    typeof fm === "object" &&
    fm !== null &&
    !Array.isArray(fm) &&
    (fm as Record<string, unknown>)["disable-model-invocation"] === true
  );
}

/**
 * Cross-reference each placed agent definition's `defaults.skills` list against the
 * skills actually visible to the harness the definition lands on. A default-skills
 * entry that names a skill skm does not manage (absent), or one that is deny-scoped
 * away from / never placed on that harness (hidden), is a configuration mismatch —
 * the subagent asks for a skill it will not have. Reported as a warning naming the
 * agent, skill, and harness. Scoped to `export: agent` placements (rendered-file),
 * where "the harness the definition is placed on" is well defined per harness.
 */
function agentDefSkillReferences(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
): Finding[] {
  const solved = computeDesiredPlacements(env, config, registry, desired);

  // Which agents can actually see each skill (its placement dirs' readers, incl.
  // maybe-reads and shared). Derived skills count too — they share the namespace.
  const skillReaders = new Map<string, Set<string>>();
  for (const dp of solved.placements) {
    if (dp.placement.artifactType === "agent-def") continue;
    if (dp.placement.channel === "tprompt") continue; // tprompt is a human channel, not a harness reader
    const set = skillReaders.get(dp.skill) ?? new Set<string>();
    for (const reader of readersOf(registry, dp.placement.dir, { includeMaybe: true })) set.add(reader);
    skillReaders.set(dp.skill, set);
  }
  // Names skm sources at all (a skill with no reachable placement is still "known").
  const knownSkills = new Set<string>([
    ...desired.skills.map((s) => s.name),
    ...desired.agentDefs.filter((d) => d.exportMode === "skill").map((d) => d.derivedSkillName ?? d.name),
  ]);

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const dp of solved.placements) {
    const def = dp.desiredAgentDef;
    if (dp.placement.artifactType !== "agent-def" || !def) continue;
    if (dp.placement.channel === "tprompt") continue; // prompt export targets no harness
    const harness = dp.placement.agent;
    for (const wanted of def.def.skills) {
      const key = `${def.name}:${wanted}:${harness}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!knownSkills.has(wanted)) {
        findings.push({
          category: "skill-reference",
          severity: "warn",
          skill: def.name,
          message: `agent definition '${def.name}' names default skill '${wanted}', which skm does not manage; it will be absent for harness '${harness}'`,
          fixable: false,
        });
      } else if (!skillReaders.get(wanted)?.has(harness)) {
        findings.push({
          category: "skill-reference",
          severity: "warn",
          skill: def.name,
          message: `agent definition '${def.name}' names default skill '${wanted}', hidden from harness '${harness}' (skill scoping excludes it)`,
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/** For each deny-scoped skill, ensure no owned placement sits in a denied agent's read set. */
function verifyDenyGuarantee(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const findings: Finding[] = [];
  const dirByPath = registryDirByPath(env, registry);

  // Derived skills (export: skill) share the skill namespace and carry their own
  // deny scoping (from harness.exclude); their owned placements must be swept too,
  // else a deny guarantee on a derived skill goes unverified.
  const scoped: { name: string; scoping?: AgentScope }[] = [
    ...desired.skills.map((s) => ({ name: s.name, scoping: s.scoping })),
    ...desired.agentDefs
      .filter((d) => d.exportMode === "skill")
      .map((d) => ({ name: d.derivedSkillName ?? d.name, scoping: d.scoping })),
  ];

  for (const skill of scoped) {
    const scope = skill.scoping;
    // Only `deny` is a HARD guarantee (design §5). `allow` is best-effort: the
    // non-allowed agents are soft bleed ("reported, not blocked"), so an
    // allow-scoped skill correctly placed in a bled-onto dir must NOT be flagged
    // as a deny-guarantee violation (deny-solver-1).
    if (!scope?.deny) continue;
    const denied = scope.deny.filter((a) => registry.agents[a] !== undefined);
    const deniedSet = new Set(denied);
    if (deniedSet.size === 0) continue;

    const artifact = state.artifacts[artifactKey("skill", skill.name)];
    if (!artifact) continue;
    for (const sp of artifact.placements) {
      const parent = path.resolve(path.dirname(expandTilde(env, sp.path)));
      const dirId = dirByPath.get(parent);
      if (!dirId) continue;
      const readers = readersOf(registry, dirId, { includeMaybe: true });
      const violators = readers.filter((r) => deniedSet.has(r));
      if (violators.length > 0) {
        findings.push({
          category: "deny-violation",
          severity: "error",
          skill: skill.name,
          path: sp.path,
          message: `denied agent(s) ${violators.join(", ")} read dir '${dirId}' where '${skill.name}' is placed`,
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/**
 * Scan every registry dir for content skm does not own that is (a) a copy whose
 * SKILL.md hashes to a private source's SKILL.md, or (b) a symlink resolving into a
 * private root. Either is private material sitting somewhere skm did not sanction.
 */
function scanUnmanagedPrivateLeaks(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const privateSourceHash = new Map<string, string>(); // hash → skill name
  for (const skill of desired.skills) {
    if (skill.source.visibility !== "private") continue;
    const hash = scanEntry(env, skill.source.path).sha256OfSkillMd;
    if (hash) privateSourceHash.set(hash, skill.name);
  }
  // Composed skills render a distinct SKILL.md per consumer (never a source file on
  // disk), so index every consumer's EXPECTED rendered SKILL.md content hash — else a
  // manual copy of a deployed private orchestrate tree in a foreign agent dir is
  // invisible to exactly the scan that exists to catch it (ADR 0010).
  for (const composed of desired.composedSkills) {
    if (composed.source.visibility !== "private") continue;
    for (const consumer of Object.keys(composed.consumers)) {
      const skillMd = renderComposedSkill(composed, consumer, registry)["SKILL.md"];
      if (skillMd) privateSourceHash.set(hashContent(skillMd), composed.name);
    }
  }
  const privateRoots = config.roots
    .filter((r) => r.visibility === "private")
    .map((r) => path.resolve(expandTilde(env, r.path)));

  if (privateSourceHash.size === 0 && privateRoots.length === 0) return [];

  const owned = new Set<string>();
  for (const artifact of Object.values(state.artifacts)) {
    for (const sp of artifact.placements) owned.add(path.resolve(expandTilde(env, sp.path)));
  }

  const findings: Finding[] = [];
  for (const entries of Object.values(scanRegistryDirs(env, registry))) {
    for (const entry of entries) {
      if (owned.has(path.resolve(entry.path))) continue; // owned placements handled above

      const matchedSkill = entry.sha256OfSkillMd
        ? privateSourceHash.get(entry.sha256OfSkillMd)
        : undefined;
      if (matchedSkill) {
        findings.push({
          category: "private-leak",
          severity: "error",
          skill: matchedSkill,
          path: entry.path,
          message: `unmanaged copy of private skill '${matchedSkill}' found in an agent dir`,
          fixable: false,
        });
        continue;
      }

      if (
        entry.kind === "symlink" &&
        entry.resolvedTarget &&
        privateRoots.some((root) => isInside(entry.resolvedTarget!, root))
      ) {
        findings.push({
          category: "private-leak",
          severity: "error",
          path: entry.path,
          message: `unmanaged symlink resolves into a private root -> ${entry.resolvedTarget}`,
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/** True when `child` is `parent` or nested under it (path-segment aware). */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Suggest an agent's kill switch when a scoped skill bleeds onto it. */
function killSwitchSuggestions(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
): Finding[] {
  const findings: Finding[] = [];
  const { bleed } = computeDesiredPlacements(env, config, registry, desired);
  const seen = new Set<string>();
  for (const b of bleed) {
    for (const reader of b.readers) {
      const agent = registry.agents[reader];
      if (!agent?.killSwitches?.length) continue;
      const sw = agent.killSwitches[0]!;
      const key = `${b.skill}:${reader}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        category: "env-suggestion",
        severity: "info",
        skill: b.skill,
        message: `set ${sw}=1 to hide '${b.skill}' from ${reader} (incidental reader of ${b.path})`,
        fixable: false,
      });
    }
  }
  return findings;
}

// ── --fix ────────────────────────────────────────────────────────────────────

/** Re-link broken owned symlinks and re-render hand-edited rendered artifacts. */
function applyFixes(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): number {
  const byPath = new Map(
    computeDesiredPlacements(env, config, registry, desired).placements.map((dp) => [
      path.resolve(dp.placement.path),
      dp,
    ]),
  );

  let fixed = 0;
  for (const [key, artifact] of Object.entries(state.artifacts)) {
    // Composed rendered trees are not --fix repairable (re-render needs the composed
    // path, not renderSkill); diagnose reports them fixable:false, so skip here to
    // avoid corrupting the tree via the native renderer.
    if (artifact.type === "composed-skill") continue;
    for (const sp of artifact.placements) {
      // Gated skill trees are not --fix repairable either (re-render needs the gated
      // path, not renderSkill); diagnose reports them fixable:false, so skip here.
      if (sp.gated) continue;
      const abs = path.resolve(expandTilde(env, sp.path));
      const dp = byPath.get(abs);
      if (!dp) continue; // only repair owned + still-desired placements

      // Never re-materialize private content into a worktree that has become
      // non-allowlisted since the artifact was first placed (privacy-doctor-fix-
      // bypasses-guard). diagnose already reported it as a private-leak.
      if (artifact.source.visibility === "private" && privacyViolation(config, abs)) continue;

      const entry = scanEntry(env, abs);

      if (sp.kind === "symlink" && (entry.kind === "absent" || (entry.kind === "symlink" && entry.broken))) {
        removeExisting(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.symlinkSync(dp.source.path, abs);
        fixed++;
      } else if (
        sp.kind === "rendered" &&
        !dp.placement.derived && // derived-skill re-render is not a doctor --fix path
        entry.kind === "dir" &&
        entry.sha256OfSkillMd !== sp.hash
      ) {
        const dialect = dialectForDir(dp.placement.dir);
        if (!dialect || !dp.desiredSkill) continue;
        removeExisting(abs);
        const skillDef: DesiredSkill = { name: artifact.name, source: dp.source, overrides: dp.desiredSkill.overrides };
        const res = renderSkill(env, skillDef, dialect, abs);
        // Record the full-tree hash too (as apply does) — dropping it re-opens the
        // deletion-safety hole where a user file added alongside SKILL.md would be
        // recursive-deleted because ownership only covered SKILL.md (finding 2).
        upsertPlacement(state, key, artifact.source, {
          agent: sp.agent,
          path: abs,
          kind: "rendered",
          hash: res.hash,
          ...(res.tree ? { tree: res.tree } : {}),
        });
        fixed++;
      }
    }
  }
  return fixed;
}

function removeExisting(abs: string): void {
  try {
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
  } catch {
    /* absent */
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Map each registry directory's absolute path → its dir id (for reverse lookup). */
function registryDirByPath(env: SkmEnv, registry: Registry): Map<string, string> {
  const out = new Map<string, string>();
  for (const dirId of Object.keys(registry.directories)) {
    out.set(path.resolve(dirPath(env, registry, dirId)), dirId);
  }
  return out;
}

function renderHuman(findings: Finding[]): string {
  if (findings.length === 0) return "doctor: healthy.";
  const glyph: Record<string, string> = { error: "×", warn: "!", info: "·" };
  return findings.map((f) => `  ${glyph[f.severity] ?? "?"} ${f.category}: ${f.message}${f.path ? `  (${f.path})` : ""}`).join("\n");
}
