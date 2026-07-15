// Pure resolution path for `skm deploy` (ADR 0014 decision 3), ported from
// deploy-project-skills.sh + lib/catalog.sh. Given the curated catalog, the
// validated `.skills.local.json`, a family selection, an agent list, and a
// target install root, resolveDeployPlan produces the RESOLVED INSTALL PLAN:
// the ordered per-repo `skills add --copy` batches the deploy would run. It is a
// pure function — the only impurity, upstream skill-name enumeration (bash's
// `git clone` of a whole-repo spec), is an injected `enumerate` callback, so the
// resolver is testable without git, the network, or the `skills` CLI present.
//
// NOTHING here writes skm's state.json: deploy output is not skm-owned (ADR 0014
// ownership boundary). This module only computes the plan.

import * as fs from "node:fs";
import * as path from "node:path";
import { SPEC_LINE } from "../catalog-specs";
import { type CuratedFamilyLookup, type LocalSkillsConfig, loadLocalSkillsConfig } from "./local-config";

// ── spec helpers (ports of the retired lib/catalog.sh spec_has_explicit_skill / spec_repo
// / spec_skill). Exported: the upstream-sync port (src/upstream/) shares them, exactly as
// the two retired bash scripts shared lib/catalog.sh. ──

export function specHasExplicitSkill(spec: string): boolean {
  return spec.includes("@");
}
export function specRepo(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}
export function specSkill(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at === -1 ? "" : spec.slice(at + 1);
}

/** dedupe_array: drop empties + later duplicates, preserving first-seen order. */
export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ── curated catalog + local config ───────────────────────────────────────────

interface CuratedFamily {
  name: string;
  description: string;
  specs: string[];
}

/** The full deploy input surface for one repo: curated families + validated overrides. */
export interface DeployCatalog {
  /** Curated families that exist (file + index + valid specs), in families.tsv order. */
  curatedOrder: string[];
  curated: Map<string, CuratedFamily>;
  /** Every family name declared in families.tsv column 1 (curated_family_declared_in_index). */
  indexNames: Set<string>;
  local: LocalSkillsConfig;
}

/** Parse a families.tsv into ordered {name, description} rows (skips blank / '#' rows). */
function parseFamilyIndex(indexFile: string): { name: string; description: string }[] {
  if (!fs.existsSync(indexFile)) return [];
  const rows: { name: string; description: string }[] = [];
  for (const raw of fs.readFileSync(indexFile, "utf8").split("\n")) {
    if (raw === "") continue;
    const tab = raw.indexOf("\t");
    const name = tab === -1 ? raw : raw.slice(0, tab);
    const description = tab === -1 ? "" : raw.slice(tab + 1);
    if (name === "" || name.startsWith("#")) continue;
    rows.push({ name, description });
  }
  return rows;
}

/** read_specs_file_into_array with validation; returns undefined when a line is invalid. */
function readSpecsFile(file: string): string[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  const specs: string[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (raw === "" || raw.startsWith("#")) continue;
    if (!SPEC_LINE.test(raw)) return undefined; // invalid → family "does not exist"
    specs.push(raw);
  }
  return specs;
}

/**
 * Load the curated catalog from `catalogDir` and the validated `.skills.local.json`
 * at `configFile`. Curated families are resolved first (the local-config validator
 * needs to know which families exist / are index-declared).
 */
export function loadDeployCatalog(catalogDir: string, configFile: string): DeployCatalog {
  const indexFile = path.join(catalogDir, "families.tsv");
  const familiesDir = path.join(catalogDir, "families");
  const rows = parseFamilyIndex(indexFile);

  const indexNames = new Set<string>(rows.map((r) => r.name));
  const curated = new Map<string, CuratedFamily>();
  const curatedOrder: string[] = [];
  for (const { name, description } of rows) {
    if (curated.has(name)) continue;
    const specs = readSpecsFile(path.join(familiesDir, `${name}.txt`));
    if (specs === undefined) continue; // missing file or invalid specs → not an existing family
    curated.set(name, { name, description, specs });
    curatedOrder.push(name);
  }

  const lookup: CuratedFamilyLookup = {
    exists: (name) => curated.has(name),
    declaredInIndex: (name) => indexNames.has(name),
  };
  const local = loadLocalSkillsConfig(configFile, lookup);

  return { curatedOrder, curated, indexNames, local };
}

// ── family accessors (ports of the lib/catalog.sh family_* functions) ────────

function curatedFamilyExists(cat: DeployCatalog, name: string): boolean {
  return cat.curated.has(name);
}

/** family_exists: curated, or a custom family with ≥1 spec. */
export function familyExists(cat: DeployCatalog, name: string): boolean {
  if (curatedFamilyExists(cat, name)) return true;
  const custom = cat.local.customFamilies[name];
  return !!custom && custom.specs.length > 0;
}

/** get_family_description: custom override wins, else the families.tsv description. */
export function familyDescription(cat: DeployCatalog, name: string): string {
  const custom = cat.local.customFamilies[name];
  if (custom && custom.description) return custom.description;
  return cat.curated.get(name)?.description ?? "";
}

/** list_family_names + get_family_description: curated (index order) then custom (insertion order). */
export function listFamilies(cat: DeployCatalog): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const name of cat.curatedOrder) out.push({ name, description: familyDescription(cat, name) });
  for (const name of Object.keys(cat.local.customFamilies)) {
    out.push({ name, description: familyDescription(cat, name) });
  }
  return out;
}

/** load_family_specs: curated file specs + familySpecs override (deduped), or a custom family's specs. */
function loadFamilySpecs(cat: DeployCatalog, name: string): string[] {
  if (curatedFamilyExists(cat, name)) {
    const base = cat.curated.get(name)!.specs;
    const appended = cat.local.familySpecs[name] ?? [];
    return dedupe([...base, ...appended]);
  }
  const custom = cat.local.customFamilies[name];
  if (!custom || custom.specs.length === 0) throw new UnknownFamilyError(name);
  return dedupe([...custom.specs]);
}

/** load_local_family_exclude_specs: excludeFamilySpecs[family] (deduped). */
function localFamilyExcludeSpecs(cat: DeployCatalog, name: string): string[] {
  return dedupe([...(cat.local.excludeFamilySpecs[name] ?? [])]);
}

/** Raised when a requested family is neither curated nor a custom family. */
export class UnknownFamilyError extends Error {
  constructor(name: string) {
    super(`Unknown family: ${name}`);
    this.name = "UnknownFamilyError";
  }
}

// ── curated-family exclude resolution (deploy-project-skills.sh) ─────────────

/** Enumerate a whole-repo spec's upstream skill names (bash: git clone the repo). */
export type UpstreamEnumerator = (repo: string) => string[];

/** expand_full_repo_specs: whole-repo specs → one `<repo>@<skill>` per enumerated skill. */
export function expandFullRepoSpecs(specs: string[], enumerate: UpstreamEnumerator): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    if (specHasExplicitSkill(spec)) {
      out.push(spec);
      continue;
    }
    const repo = specRepo(spec);
    for (const name of enumerate(repo)) out.push(`${repo}@${name}`);
  }
  return out;
}

/** resolve_excluded_specs: expand whole-repo excludes to the available specs of that repo. */
export function resolveExcludedSpecs(excludes: string[], available: string[]): string[] {
  const availableByRepo = new Map<string, string[]>();
  for (const spec of available) {
    const repo = specRepo(spec);
    const list = availableByRepo.get(repo);
    if (list) list.push(spec);
    else availableByRepo.set(repo, [spec]);
  }
  const out: string[] = [];
  for (const spec of excludes) {
    if (specHasExplicitSkill(spec)) {
      out.push(spec);
      continue;
    }
    const repo = specRepo(spec);
    const list = availableByRepo.get(repo);
    if (!list) continue;
    out.push(...list);
  }
  return dedupe(out);
}

/** filter_excluded_specs: specs minus the resolved-excluded set. */
export function filterExcludedSpecs(specs: string[], excludes: string[]): string[] {
  const ex = new Set(excludes);
  return specs.filter((s) => !ex.has(s));
}

/**
 * resolve_curated_family_specs: the whole-repo preserve-vs-explicit expansion. With
 * no excludes the family's specs pass through unchanged. Otherwise every whole-repo
 * spec is enumerated; a repo with nothing excluded is preserved as its whole-repo
 * spec, while a repo with a partial exclusion collapses to its surviving explicit
 * specs. The output is rebuilt in the family file's declaration order.
 */
function resolveCuratedFamilySpecs(
  familySpecs: string[],
  excludes: string[],
  enumerate: UpstreamEnumerator,
): string[] {
  if (excludes.length === 0) return [...familySpecs];

  const expanded = expandFullRepoSpecs(familySpecs, enumerate);
  const resolvedExcluded = resolveExcludedSpecs(excludes, expanded);
  const filtered = filterExcludedSpecs(expanded, resolvedExcluded);

  const expandedCounts = new Map<string, number>();
  for (const spec of expanded) expandedCounts.set(specRepo(spec), (expandedCounts.get(specRepo(spec)) ?? 0) + 1);

  const survivingLookup = new Set<string>();
  const filteredCounts = new Map<string, number>();
  const repoExplicitSpecs = new Map<string, string[]>();
  for (const spec of filtered) {
    const repo = specRepo(spec);
    survivingLookup.add(spec);
    filteredCounts.set(repo, (filteredCounts.get(repo) ?? 0) + 1);
    const list = repoExplicitSpecs.get(repo);
    if (list) list.push(spec);
    else repoExplicitSpecs.set(repo, [spec]);
  }

  const preserveWide = new Set<string>();
  for (const spec of familySpecs) {
    if (specHasExplicitSkill(spec)) continue;
    const repo = specRepo(spec);
    if ((filteredCounts.get(repo) ?? 0) === (expandedCounts.get(repo) ?? 0)) preserveWide.add(repo);
  }

  const out: string[] = [];
  const repoEmitted = new Set<string>();
  for (const spec of familySpecs) {
    const repo = specRepo(spec);
    if (!specHasExplicitSkill(spec)) {
      if (repoEmitted.has(repo)) continue;
      if (preserveWide.has(repo)) out.push(repo);
      else if (repoExplicitSpecs.has(repo)) out.push(...repoExplicitSpecs.get(repo)!);
      repoEmitted.add(repo);
      continue;
    }
    if (preserveWide.has(repo)) continue;
    if (survivingLookup.has(spec)) out.push(spec);
  }
  return dedupe(out);
}

/** load_deploy_specs_for_families: resolve each family's specs and concatenate (deduped). */
function loadDeploySpecsForFamilies(
  cat: DeployCatalog,
  families: string[],
  enumerate: UpstreamEnumerator,
): string[] {
  const out: string[] = [];
  for (const family of families) {
    const familySpecs = loadFamilySpecs(cat, family);
    if (curatedFamilyExists(cat, family)) {
      const excludes = localFamilyExcludeSpecs(cat, family);
      out.push(...resolveCuratedFamilySpecs(familySpecs, excludes, enumerate));
    } else {
      out.push(...familySpecs);
    }
  }
  return dedupe(out);
}

// ── install plan (build_repo_batches) ────────────────────────────────────────

/** One resolved `skills add --copy` batch. Empty `skills` = whole-repo install. */
export interface RepoBatch {
  repo: string;
  /** Explicit skill names for `-s`; empty means install the whole repo. */
  skills: string[];
}

/** build_repo_batches: per-repo batches in first-seen order; a whole-repo spec wins (install-all). */
function buildRepoBatches(specs: string[]): RepoBatch[] {
  const order: string[] = [];
  const byRepo = new Map<string, string[]>();
  const installAll = new Set<string>();
  for (const spec of specs) {
    const repo = specRepo(spec);
    if (!byRepo.has(repo)) {
      order.push(repo);
      byRepo.set(repo, []);
    }
    if (!specHasExplicitSkill(spec)) {
      installAll.add(repo);
      byRepo.set(repo, []); // reset to install-all
    } else if (!installAll.has(repo)) {
      byRepo.get(repo)!.push(specSkill(spec));
    }
  }
  return order.map((repo) => ({ repo, skills: byRepo.get(repo)! }));
}

/** The full resolved deploy plan: ordered batches + the agents / install root they apply to. */
export interface DeployPlan {
  installRoot: string;
  agents: string[];
  /** Flattened, resolved, deduped specs (declared_by_repo / audit source). */
  specs: string[];
  batches: RepoBatch[];
}

export interface DeployPlanInput {
  cat: DeployCatalog;
  families: string[];
  agents: string[];
  installRoot: string;
}

/**
 * Resolve the deploy plan. Families are deduped first (dedupe_families in main),
 * then each family's specs resolved and batched. Throws UnknownFamilyError /
 * LocalConfigError on bad input; propagates whatever `enumerate` throws (bash aborts
 * on a failed git enumeration).
 */
export function resolveDeployPlan(input: DeployPlanInput, enumerate: UpstreamEnumerator): DeployPlan {
  const families = dedupe(input.families);
  const specs = loadDeploySpecsForFamilies(input.cat, families, enumerate);
  const batches = buildRepoBatches(specs);
  return { installRoot: input.installRoot, agents: input.agents, specs, batches };
}

/** The `skills add … --copy -y` argv one batch resolves to (parity + execution shape). */
export function batchToSkillsArgs(batch: RepoBatch, agents: string[]): string[] {
  const args = ["add", batch.repo, "-a", ...agents];
  if (batch.skills.length > 0) args.push("-s", ...batch.skills);
  args.push("--copy", "-y");
  return args;
}
