// `skm deploy <dir>` (ADR 0014 decision 3) — port of deploy-project-skills.sh on
// the copy path. Resolves curated / custom skill families (with `.skills.local.json`
// familySpecs / excludeFamilySpecs / customFamilies overrides) into per-repo
// `skills add --copy` batches and runs them into a target project directory. skm
// only orchestrates; the `skills` CLI fetches and places. The interactive prompt
// mode of the bash script is intentionally dropped (agent-first: `--list-families`
// plus flags are the human path).
//
// OWNERSHIP BOUNDARY (ADR 0014, load-bearing): deployed copies are NOT skm-owned —
// this verb never reads or writes state.json. It coexists with plan/apply, which
// own only skm's own placements.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { registryPath } from "../context";
import { UsageError } from "../errors";
import { type SkmEnv, expandTilde } from "../env";
import { loadMachineConfig } from "../machine-config";
import { loadRegistry } from "../registry";
import type { MachineConfig, VerbOptions, VerbOutcome } from "../types";
import { ExitCode } from "../types";
import {
  type DeployCatalog,
  type DeployPlan,
  type UpstreamEnumerator,
  UnknownFamilyError,
  batchToSkillsArgs,
  familyExists,
  listFamilies,
  loadDeployCatalog,
  resolveDeployPlan,
} from "./resolve";
import { auditRepoSkillCoverage, loadCoverageManifest, makeGitEnumerator } from "./upstream";

/** compute_skills_agents (ported from the retired lib/agents.sh): $SKILLS_AGENTS split on
 *  whitespace, else the standard agent set. Exported: the upstream-sync verb shares it,
 *  exactly as the two retired bash scripts shared lib/agents.sh. */
export const STANDARD_AGENTS = ["codex", "opencode", "gemini-cli", "github-copilot", "claude-code"];
export const HERMES_AGENT_ID = "hermes-agent";
export function computeSkillsAgents(): string[] {
  const env = process.env.SKILLS_AGENTS;
  if (env && env.trim() !== "") return env.trim().split(/\s+/);
  return [...STANDARD_AGENTS];
}

/** The public root's catalog dir, `.skills.local.json`, and coverage manifest. */
function deployPaths(config: MachineConfig): { catalogDir: string; configFile: string; coverageFile: string } {
  const pub = config.roots.find((r) => r.visibility === "public");
  if (!pub) throw new UsageError("deploy requires a public root (catalog/ lives there)");
  return {
    catalogDir: path.join(pub.path, "catalog"),
    configFile: path.join(pub.path, ".skills.local.json"),
    coverageFile: path.join(pub.path, "catalog", "family-coverage.json"),
  };
}

/** resolve_target_repo + expand_target_path: expand ~, require it exists, realpath it. */
function resolveInstallRoot(env: SkmEnv, dir: string): string {
  const expanded = expandTilde(env, dir);
  if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
    throw new UsageError(`Target directory does not exist: ${expanded}`);
  }
  return fs.realpathSync(expanded);
}

/**
 * collect_effective_family_excluded_specs: excludeFamilySpecs entries whose repo is
 * not install-all in the final specs and which are not already an explicit final
 * spec. Feeds the coverage audit's ignore list.
 */
function collectEffectiveFamilyExcludedSpecs(cat: DeployCatalog, families: string[], finalSpecs: string[]): string[] {
  const explicitFinal = new Set<string>();
  const installAllRepos = new Set<string>();
  for (const spec of finalSpecs) {
    const at = spec.lastIndexOf("@");
    if (at === -1) installAllRepos.add(spec);
    else explicitFinal.add(spec);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    if (!cat.curated.has(family)) continue;
    for (const spec of cat.local.excludeFamilySpecs[family] ?? []) {
      const repo = spec.slice(0, spec.lastIndexOf("@"));
      if (installAllRepos.has(repo)) continue;
      if (explicitFinal.has(spec)) continue;
      if (seen.has(spec)) continue;
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** Run the coverage audit (best-effort): warnings to stderr, mirroring the bash audit. */
function runCoverageAudit(
  cat: DeployCatalog,
  families: string[],
  plan: DeployPlan,
  coverageFile: string,
  enumerate: UpstreamEnumerator,
): void {
  if ((process.env.SKILLS_AUDIT_REPO_COVERAGE ?? "1") !== "1") return;
  if (!fs.existsSync(coverageFile)) return;
  const manifest = loadCoverageManifest(coverageFile);
  if (!manifest) {
    process.stderr.write(`WARN: Skipping family repo coverage audit because manifest is invalid: ${coverageFile}\n`);
    return;
  }

  // declared_by_repo: whole-repo spec ⇒ "__ALL__"; else the explicit skill names.
  const declaredByRepo = new Map<string, string[] | "__ALL__">();
  const auditedRepos = new Set<string>();
  for (const spec of plan.specs) {
    const at = spec.lastIndexOf("@");
    const repo = at === -1 ? spec : spec.slice(0, at);
    auditedRepos.add(repo);
    if (at === -1) declaredByRepo.set(repo, "__ALL__");
    else if (declaredByRepo.get(repo) !== "__ALL__") {
      const cur = declaredByRepo.get(repo);
      declaredByRepo.set(repo, Array.isArray(cur) ? [...cur, spec.slice(at + 1)] : [spec.slice(at + 1)]);
    }
  }

  const excludedSpecs = collectEffectiveFamilyExcludedSpecs(cat, families, plan.specs);
  const ignoredByRepo = new Map<string, string[]>();
  for (const [repo, names] of manifest.ignored) ignoredByRepo.set(repo, [...names]);
  for (const spec of excludedSpecs) {
    const at = spec.lastIndexOf("@");
    if (at === -1) continue;
    const repo = spec.slice(0, at);
    auditedRepos.add(repo);
    const list = ignoredByRepo.get(repo) ?? [];
    list.push(spec.slice(at + 1));
    ignoredByRepo.set(repo, list);
  }

  // Mirror the bash audit's two counters: a failed enumeration (audit_failures) and
  // detected drift (audit_warnings) BOTH suppress the "no drift" line, so an audit
  // that could not complete never reports clean.
  let drift = false;
  let failed = false;
  for (const repo of manifest.repos) {
    if (!auditedRepos.has(repo)) continue;
    if (declaredByRepo.get(repo) === "__ALL__") continue;
    const declared = declaredByRepo.get(repo);
    let warnings: string[];
    try {
      warnings = auditRepoSkillCoverage(
        repo,
        Array.isArray(declared) ? declared : [],
        ignoredByRepo.get(repo) ?? [],
        enumerate,
      );
    } catch {
      failed = true;
      process.stderr.write(`WARN: Skipping family repo coverage audit for ${repo}\n`);
      continue;
    }
    for (const w of warnings) {
      drift = true;
      process.stderr.write(`WARN: ${w}\n`);
    }
  }
  if (!drift && !failed) process.stderr.write("  No family coverage drift found.\n");
}

/** Render the planned installs (repo → skills, or `(all)` for a whole-repo batch). */
function renderPlan(plan: DeployPlan, families: string[]): string {
  const lines: string[] = [];
  lines.push(`Deploying skills to target directory: ${plan.installRoot}`);
  lines.push(`Agents: ${plan.agents.join(" ")}`);
  lines.push(`Families: ${families.join(" ")}`);
  lines.push("");
  lines.push("Planned installs:");
  if (plan.batches.length === 0) lines.push("  (none)");
  for (const b of plan.batches) lines.push(`  ${b.repo}: ${b.skills.length === 0 ? "(all)" : b.skills.join(" ")}`);
  return lines.join("\n");
}

export async function runDeploy(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  // deploy only needs the machine config to locate the public root's catalog and
  // `.skills.local.json`. It deliberately does NOT go through loadContext (which
  // also reads state.json and resolves the whole desired state): the ownership
  // boundary says deploy never touches state.json, and an unrelated corrupt state,
  // desired-state collision, or missing overlay root must not block a healthy deploy.
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);
  const { catalogDir, configFile, coverageFile } = deployPaths(config);
  const cat = loadDeployCatalog(catalogDir, configFile);

  // --list-families: print available families and exit (no target required).
  if (opts.listFamilies) {
    const rows = listFamilies(cat);
    const human = rows.map((r) => `${r.name}\t${r.description}`).join("\n");
    return { exitCode: ExitCode.CLEAN, json: { families: rows }, human };
  }

  const dir = opts.args[0];
  if (!dir) throw new UsageError("deploy requires a target directory: skm deploy <dir>");
  if (opts.args.length > 1) {
    // A second positional is a malformed command (e.g. two target dirs) — reject it
    // rather than silently deploying into args[0] and ignoring the rest.
    throw new UsageError(`deploy takes a single target directory; unexpected: ${opts.args.slice(1).join(" ")}`);
  }
  const installRoot = resolveInstallRoot(env, dir);

  // Family selection: --all-families expands to every configured family; otherwise
  // the repeated --family flags. De-duplication + validation mirror main().
  let families = opts.allFamilies ? listFamilies(cat).map((r) => r.name) : [...(opts.families ?? [])];
  families = [...new Set(families)];
  if (families.length === 0) {
    throw new UsageError("Select at least one family with --family or --all-families");
  }
  for (const family of families) {
    if (!familyExists(cat, family)) throw new UsageError(`Unknown family: ${family}`);
  }

  // Test presence with `!== undefined`, not truthiness: an explicit empty `--agents ""`
  // must reach the empty-list error, not silently fall back to the default agent set.
  const agents =
    opts.agentsList !== undefined
      ? opts.agentsList.trim().split(/\s+/).filter((a) => a.length > 0)
      : computeSkillsAgents();
  if (agents.length === 0) throw new UsageError("No agents configured");
  // Every token is passed verbatim after `skills add -a`; a token starting with `-`
  // would be parsed as a skills-CLI option (e.g. `--agents "codex -s foo"` silently
  // turning an install-all into a single-skill install). Reject rather than forward.
  for (const agent of agents) {
    if (agent.startsWith("-")) throw new UsageError(`Invalid agent name: ${agent}`);
  }

  const enumerate = makeGitEnumerator();
  let plan: DeployPlan;
  try {
    plan = resolveDeployPlan({ cat, families, agents, installRoot }, enumerate);
  } catch (e) {
    if (e instanceof UnknownFamilyError) throw new UsageError(e.message);
    throw e;
  }

  const human = renderPlan(plan, families);
  const json = {
    installRoot: plan.installRoot,
    agents: plan.agents,
    families,
    dryRun: !!opts.dryRun,
    batches: plan.batches,
  };

  if (opts.dryRun) {
    return { exitCode: ExitCode.CLEAN, json: { ...json, executed: false }, human };
  }

  // Real deploy: coverage audit (advisory), then one `skills add --copy` per repo
  // batch, cwd'd into the target. No state.json is touched (ownership boundary).
  runCoverageAudit(cat, families, plan, coverageFile, enumerate);
  const skillsBin = process.env.SKILLS_BIN || "skills";
  for (const batch of plan.batches) {
    // Route the child's stdout to OUR stderr (fd 2): the CLI shell's emit() writes
    // the verb's JSON payload to stdout for --json / non-TTY callers, so any `skills`
    // progress on stdout would corrupt that stable-JSON contract. Progress stays
    // visible (on stderr); stdout is reserved for the machine-readable result.
    execFileSync(skillsBin, batchToSkillsArgs(batch, agents), {
      cwd: installRoot,
      stdio: ["inherit", 2, "inherit"],
    });
  }

  return {
    exitCode: ExitCode.CLEAN,
    json: { ...json, executed: true },
    human: `${human}\n\nDone.`,
  };
}
