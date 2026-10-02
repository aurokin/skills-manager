// `skm upstream sync` (ADR 0014 decision 4) — the cutover port of
// install-repro-skills.sh. skm owns the desired-state diff of
// catalog/global-specs.txt (+ `.skills.local.json` globalSpecs /
// excludeGlobalSpecs / preserveGlobalSkillNames) against `skills list -g --json`,
// and shells out to the `skills` CLI as the fetch/place engine: remove stale
// (narrowed with `-a` to non-Hermes agents — NEVER deletes from ~/.hermes/skills),
// update existing, add missing (with the OpenClaw risk flag and diffwarden
// --full-depth), plus the owned-dir and Hermes broken-symlink sweeps and the
// full-coverage repo audit. $SKILLS_AGENTS / $SKILLS_BIN /
// $SKILLS_AUDIT_REPO_COVERAGE / $UPSTREAM_COVERAGE_FILE keep their bash semantics.
//
// OWNERSHIP BOUNDARY (ADR 0014, load-bearing): upstream installs are NEVER adopted
// into state.json — this verb bootstraps from the machine config alone and never
// reads or writes skm's ownership state.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { registryPath } from "../context";
import { UsageError } from "../errors";
import type { SkmEnv } from "../env";
import { loadMachineConfig } from "../machine-config";
import { loadRegistry } from "../registry";
import type { MachineConfig, VerbOptions, VerbOutcome } from "../types";
import { ExitCode } from "../types";
import { loadDeployCatalog } from "../deploy/resolve";
import { HERMES_AGENT_ID, computeSkillsAgents } from "../deploy/verb";
import { auditRepoSkillCoverage, loadCoverageManifest, makeGitEnumerator } from "../deploy/upstream";
import type { UpstreamEnumerator } from "../deploy/resolve";
import {
  type SyncPlan,
  addBatchToSkillsArgs,
  buildRepoSkillSummary,
  buildSyncPlan,
  removalToSkillsArgs,
  resolveDesiredGlobalSpecs,
  sweepBrokenSymlinks,
  sweepHermesBrokenSymlinks,
} from "./sync";

/** The public root's global-specs file, `.skills.local.json`, and coverage manifest. */
function syncPaths(config: MachineConfig): {
  publicRoot: string;
  catalogDir: string;
  configFile: string;
  coverageFile: string;
} {
  const pub = config.roots.find((r) => r.visibility === "public");
  if (!pub) throw new UsageError("upstream sync requires a public root (catalog/ lives there)");
  return {
    publicRoot: pub.path,
    catalogDir: path.join(pub.path, "catalog"),
    configFile: path.join(pub.path, ".skills.local.json"),
    // $UPSTREAM_COVERAGE_FILE keeps its bash override semantics; the default is the
    // repo-root manifest (not catalog/ — that one belongs to family deploys).
    coverageFile: process.env.UPSTREAM_COVERAGE_FILE || path.join(pub.path, "upstream-coverage.json"),
  };
}

/**
 * Classify `skills list -g --json` output. Some skills CLI versions report
 * skm's local symlinks: they count as present so sync does not install over
 * them, but only non-links may enter upstream stale removal.
 */
export function classifyInstalledGlobalNames(
  env: SkmEnv,
  entries: unknown[],
): { presentNames: string[]; removableNames: string[] } {
  const prefix = `${path.join(env.home, ".agents", "skills")}${path.sep}`;
  const presentNames: string[] = [];
  const removableNames: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, path: p } = entry as { name?: unknown; path?: unknown };
    if (typeof name !== "string" || typeof p !== "string") continue;
    if (!p.startsWith(prefix)) continue;
    presentNames.push(name);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) continue;
    } catch {
      // Preserve the existing CLI-authoritative behavior for stale list entries.
    }
    removableNames.push(name);
  }
  return { presentNames, removableNames };
}

/** `skills list -g --json` classified for presence and stale-removal eligibility. */
function listInstalledGlobalNames(
  env: SkmEnv,
  skillsBin: string,
): { presentNames: string[]; removableNames: string[] } {
  const out = execFileSync(skillsBin, ["list", "-g", "--json"], { encoding: "utf8" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`skills list -g --json returned invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("skills list -g --json did not return an array");
  return classifyInstalledGlobalNames(env, parsed);
}

/** The upstream full-coverage audit (bash phase between update and add). */
function runCoverageAudit(
  coverageFile: string,
  desiredSpecs: string[],
  resolvedExcludedSpecs: string[],
  enumerate: UpstreamEnumerator,
  lines: string[],
): void {
  if ((process.env.SKILLS_AUDIT_REPO_COVERAGE ?? "1") !== "1") return;
  lines.push("", "Auditing full-coverage upstream repos...");
  if (!fs.existsSync(coverageFile)) {
    process.stderr.write(
      `WARN: Skipping upstream repo coverage audit because manifest is missing: ${coverageFile}\n`,
    );
    return;
  }
  const manifest = loadCoverageManifest(coverageFile);
  if (!manifest) {
    process.stderr.write(
      `WARN: Skipping upstream repo coverage audit because manifest is invalid: ${coverageFile}\n`,
    );
    return;
  }
  if (manifest.repos.length === 0) {
    process.stderr.write("WARN: Skipping upstream repo coverage audit because no coverage repos are configured\n");
    return;
  }

  // declared_by_repo from the desired specs; ignored_by_repo = manifest + excludes.
  const declaredByRepo = new Map<string, string[]>();
  for (const spec of desiredSpecs) {
    const at = spec.lastIndexOf("@");
    if (at === -1) continue;
    const repo = spec.slice(0, at);
    const list = declaredByRepo.get(repo) ?? [];
    list.push(spec.slice(at + 1));
    declaredByRepo.set(repo, list);
  }
  const ignoredByRepo = new Map<string, string[]>();
  for (const [repo, names] of manifest.ignored) ignoredByRepo.set(repo, [...names]);
  for (const spec of resolvedExcludedSpecs) {
    const at = spec.lastIndexOf("@");
    if (at === -1) continue;
    const repo = spec.slice(0, at);
    const list = ignoredByRepo.get(repo) ?? [];
    list.push(spec.slice(at + 1));
    ignoredByRepo.set(repo, list);
  }

  // Mirror bash's audit_warnings/audit_failures: EITHER suppresses the clean line.
  let drift = false;
  let failed = false;
  for (const repo of manifest.repos) {
    let warnings: string[];
    try {
      warnings = auditRepoSkillCoverage(repo, declaredByRepo.get(repo) ?? [], ignoredByRepo.get(repo) ?? [], enumerate);
    } catch {
      failed = true;
      process.stderr.write(`WARN: Skipping upstream repo coverage audit for ${repo}\n`);
      continue;
    }
    for (const w of warnings) {
      drift = true;
      process.stderr.write(`WARN: ${w}\n`);
    }
  }
  if (!drift && !failed) lines.push("  No upstream coverage drift found.");
}

export async function runUpstream(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  if (opts.args[0] !== "sync" || opts.args.length > 1) {
    throw new UsageError("usage: skm upstream sync");
  }

  // Machine-config-only bootstrap (ownership boundary): never loadContext — a
  // corrupt state.json or desired-state collision must not block upstream sync.
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);
  const { publicRoot, catalogDir, configFile, coverageFile } = syncPaths(config);
  // loadDeployCatalog validates the WHOLE `.skills.local.json` (sync + deploy keys).
  const cat = loadDeployCatalog(catalogDir, configFile);

  const agents = computeSkillsAgents();
  if (agents.length === 0) throw new UsageError("No SKILLS_AGENTS configured");
  for (const agent of agents) {
    if (agent.startsWith("-")) throw new UsageError(`Invalid agent name: ${agent}`);
  }
  const nonHermesAgents = agents.filter((a) => a !== HERMES_AGENT_ID);
  const includesHermes = agents.length !== nonHermesAgents.length;

  const skillsBin = process.env.SKILLS_BIN || "skills";
  const enumerate = makeGitEnumerator();

  const { desiredSpecs, resolvedExcludedSpecs } = resolveDesiredGlobalSpecs(
    path.join(catalogDir, "global-specs.txt"),
    cat.local,
    enumerate,
  );
  const preservedNames = [...new Set(cat.local.preserveGlobalSkillNames)];

  const lines: string[] = [];
  lines.push(`Syncing global skills for agents: ${agents.join(" ")}`);

  // Resolve the exact summary before mutating global installs so any enumeration
  // failure happens before stale removals or new installs (bash comment, verbatim).
  const summary = buildRepoSkillSummary(desiredSpecs, enumerate);
  lines.push("", "Resolved global skill summary:");
  if (summary.length === 0) lines.push("  (none)");
  for (const s of summary) lines.push(`  ${s.repo}${s.fullCoverage ? "^" : ""}: ${s.skills.join(" ")}`);
  lines.push("  ^ full upstream coverage for this repo");

  const installed = listInstalledGlobalNames(env, skillsBin);
  const plan: SyncPlan = buildSyncPlan({
    desiredSpecs,
    preservedNames,
    installedNames: installed.presentNames,
    removableNames: installed.removableNames,
    nonHermesAgents,
  });

  // ── Phase 1: remove stale ──
  lines.push("", "Checking for stale skills...");
  const removed: string[] = [];
  if (plan.skipStaleRemoval) {
    lines.push("  Skipping stale-skill removal (Hermes-only mode; Hermes installs are add-only).");
  } else {
    for (const name of plan.preservedInstalled) lines.push(`  Preserving manual skill: ${name}`);
    const runRemoval = (args: string[]): void => {
      try {
        execFileSync(skillsBin, args, { stdio: ["inherit", 2, "inherit"] });
      } catch {
        // bash: `|| true` — a failed single removal never aborts the sync.
      }
    };
    const canonicalDir = path.join(env.home, ".agents", "skills");
    // The skills CLI resolves Hermes' dir from $HERMES_HOME; check the dir it would delete from.
    const hermesSkillsDir = path.join(process.env.HERMES_HOME?.trim() || path.join(env.home, ".hermes"), "skills");
    for (const name of plan.removals) {
      lines.push(`  Removing: ${name}`);
      runRemoval(removalToSkillsArgs(name, nonHermesAgents));
      // A narrowed `-a` removal keeps the canonical dir and its lock entry while any
      // detected agent outside `-a` still resolves the name (a universal agent's
      // install path IS the canonical dir), and `skills update` below would then
      // re-place it everywhere. When Hermes holds nothing under this name, an
      // all-agent removal cannot touch Hermes and clears the canonical dir + lock.
      const lingering = fs.lstatSync(path.join(canonicalDir, name), { throwIfNoEntry: false });
      const hermesHolds = fs.lstatSync(path.join(hermesSkillsDir, name), { throwIfNoEntry: false });
      if (lingering && !hermesHolds) runRemoval(["remove", "-g", name, "-y"]);
      removed.push(name);
    }
    lines.push(removed.length === 0 ? "  No stale skills to remove." : `  Removed ${removed.length} skill(s).`);
  }

  // Owned-dir broken-symlink cleanup runs regardless of mode: these dirs are
  // always ours and the cleanup has zero Hermes interaction.
  const sweptOwned: Record<string, string[]> = {};
  for (const dir of [path.join(env.home, ".agents", "skills"), path.join(env.home, ".claude", "skills")]) {
    const swept = sweepBrokenSymlinks(dir);
    if (swept.length > 0) sweptOwned[dir] = swept;
    for (const name of swept) lines.push(`  Cleaned broken symlink: ${name} (in ${dir})`);
  }

  // Hermes is append-only: only remove broken symlinks resolving into paths we
  // own (repo skills/, ~/.agents/skills/ absolute, or its relative CLI form).
  let sweptHermes: string[] = [];
  if (includesHermes) {
    const hermesDir = path.join(env.home, ".hermes", "skills");
    sweptHermes = sweepHermesBrokenSymlinks(hermesDir, [
      `${path.join(publicRoot, "skills")}${path.sep}`,
      `${path.join(env.home, ".agents", "skills")}${path.sep}`,
      "../../.agents/skills/",
    ]);
    for (const name of sweptHermes) lines.push(`  Cleaned broken symlink: ${name} (in ${hermesDir})`);
  }

  // ── Phase 2: update existing ──
  lines.push("", "Updating existing skills...");
  execFileSync(skillsBin, ["update"], { stdio: ["inherit", 2, "inherit"] });

  // ── Coverage audit: full-coverage repos should not gain silent skills ──
  runCoverageAudit(coverageFile, desiredSpecs, resolvedExcludedSpecs, enumerate, lines);

  // ── Phase 3: add missing ──
  lines.push("", "Adding skills...");
  if (plan.addBatches.length === 0) {
    lines.push("  No skills to add.");
  } else {
    for (const batch of plan.addBatches) {
      lines.push(`  Adding from ${batch.repo}: ${batch.skills.join(" ")}`);
      execFileSync(skillsBin, addBatchToSkillsArgs(batch, agents), { stdio: ["inherit", 2, "inherit"] });
    }
  }

  lines.push("", "Done. (Local skills are placed by skm: skm apply)");

  return {
    exitCode: ExitCode.CLEAN,
    json: {
      agents,
      summary,
      removed,
      preserved: plan.preservedInstalled,
      staleRemovalSkipped: plan.skipStaleRemoval,
      sweptOwned,
      sweptHermes,
      added: plan.addBatches.map((b) => ({ repo: b.repo, skills: b.skills })),
    },
    human: lines.join("\n"),
  };
}
