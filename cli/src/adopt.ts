// `skm adopt custom-agents` — an EXPLICIT, one-time reconcile that reads the
// custom_agents manifest (v2) and takes ownership of the agent-definition files
// the Python tool generated, so future skm plans manage/prune them. Reads BOTH
// manifest locations the Python `load_manifest` still reads:
//   1. $XDG_STATE_HOME/custom_agents/.shared-agents-manifest.json (the primary)
//   2. <agents_home>/.shared-agents-manifest.json (the legacy in-repo location)
// Both manifests are left UNTOUCHED (archived with the repo). Adoption writes ONLY
// skm ownership state, never a target file. Delete-only-what-we-own holds: an
// entry is adopted only when the file exists AND matches skm's CURRENT render of
// that agent-def for that harness; a missing/mismatched file is reported `stale`
// and never owned. Ghost entries (agent: "") are ignored. v1 manifests are
// UNSUPPORTED (hard error → upgrade via the Python tool first). Owned by the
// apply/state team.

import * as fs from "node:fs";
import * as path from "node:path";
import { agentDefFileHash, renderAgentDefFile } from "./agentdef/artifact";
import { agentIdForHarness } from "./agentdef/scoping";
import { agentDefFilePath } from "./placements";
import { registryPath } from "./context";
import { UsageError } from "./errors";
import { type SkmEnv, expandTilde, stateHome } from "./env";
import { loadMachineConfig } from "./machine-config";
import { loadRegistry } from "./registry";
import { resolveDesiredState } from "./resolve";
import { hashContent } from "./render";
import { artifactKey, loadState, saveState, upsertPlacement } from "./state";
import type { DesiredAgentDef, Registry, VerbOptions, VerbOutcome, Visibility } from "./types";
import { ExitCode } from "./types";

/** Filename the Python tool writes at both manifest locations. */
const MANIFEST_FILENAME = ".shared-agents-manifest.json";

/** One `{agent, path}` attribution under a harness key in manifest v2. */
interface ManifestEntry {
  agent: string;
  path: string;
}

/** A resolved adoption outcome for one manifest entry. */
interface AdoptedRow {
  harness: string;
  agent: string;
  path: string;
}
interface StaleRow {
  harness: string;
  agent: string;
  path: string;
  reason: string;
}
interface GhostRow {
  harness: string;
  path: string;
}

/** Verb entry: `skm adopt custom-agents [--agents-home <path>]`. */
export async function runAdopt(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const sub = opts.args[0];
  if (sub !== "custom-agents") {
    throw new UsageError("adopt requires a target: skm adopt custom-agents [--agents-home <path>]");
  }

  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);
  const desired = resolveDesiredState(env, config, registry);
  const state = loadState(env);
  const defByName = new Map(desired.agentDefs.map((d) => [d.name, d]));

  const adopted: AdoptedRow[] = [];
  const stale: StaleRow[] = [];
  const ghost: GhostRow[] = [];

  const seenManifest = new Set<string>();
  const manifests: { path: string; present: boolean }[] = [];
  for (const manifestPath of manifestLocations(env, opts)) {
    const resolved = path.resolve(manifestPath);
    if (seenManifest.has(resolved)) continue; // XDG === legacy when agents_home is the state dir
    seenManifest.add(resolved);
    const present = fs.existsSync(resolved);
    manifests.push({ path: resolved, present });
    if (!present) continue;

    const generated = readManifest(resolved);
    for (const [harness, entries] of Object.entries(generated)) {
      for (const entry of entries) {
        if (entry.agent === "") {
          ghost.push({ harness, path: entry.path });
          continue;
        }
        const outcome = classifyEntry(env, registry, defByName, harness, entry);
        if (outcome.kind === "adopt") {
          upsertPlacement(state, artifactKey("agent-def", entry.agent), outcome.source, {
            agent: outcome.agentId,
            path: outcome.abs,
            kind: "rendered-file",
            hash: outcome.hash,
          });
          adopted.push({ harness, agent: entry.agent, path: outcome.abs });
        } else {
          stale.push({ harness, agent: entry.agent, path: entry.path, reason: outcome.reason });
        }
      }
    }
  }

  saveState(env, state);

  const byHarness = tallyByHarness(adopted, stale, ghost);
  const json = {
    manifests,
    adopted,
    stale,
    ghostSkipped: ghost,
    byHarness,
    summary: { adopted: adopted.length, stale: stale.length, ghostSkipped: ghost.length },
  };
  return { exitCode: ExitCode.CLEAN, json, human: renderHuman(json) };
}

/** The two manifest paths, in read order (primary XDG, then legacy in-repo). */
function manifestLocations(env: SkmEnv, opts: VerbOptions): string[] {
  const xdg = path.join(stateHome(env), "custom_agents", MANIFEST_FILENAME);
  const agentsHome = opts.agentsHome
    ? path.resolve(expandTilde(env, opts.agentsHome))
    : path.join(env.home, ".agents");
  const legacy = path.join(agentsHome, MANIFEST_FILENAME);
  return [xdg, legacy];
}

/** Parse a manifest file into its `generated_files` map. v1 is a hard error. */
function readManifest(file: string): Record<string, ManifestEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read manifest ${file}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`manifest ${file} is not a JSON object`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (version === 1) {
    throw new UsageError(
      `manifest ${file} is v1 (unsupported); upgrade it with the custom_agents Python tool first, then re-run adopt`,
    );
  }
  if (version !== 2) {
    throw new UsageError(`manifest ${file} has unsupported version ${JSON.stringify(version)} (expected 2)`);
  }
  const raw = (parsed as { generated_files?: unknown }).generated_files;
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new UsageError(`manifest ${file} has a malformed 'generated_files'`);
  }
  const out: Record<string, ManifestEntry[]> = {};
  for (const [harness, list] of Object.entries((raw as Record<string, unknown>) ?? {})) {
    if (!Array.isArray(list)) continue;
    out[harness] = list
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e))
      .filter((e) => typeof e.path === "string" && e.path !== "")
      .map((e) => ({ agent: typeof e.agent === "string" ? e.agent : "", path: e.path as string }));
  }
  return out;
}

type EntryOutcome =
  | { kind: "adopt"; agentId: string; abs: string; hash: string; source: { root: string; visibility: Visibility } }
  | { kind: "stale"; reason: string };

/**
 * Decide whether one attributed entry can be adopted. Adoptable iff the harness
 * maps to a registry agent with agent-definition support, skm currently sources an
 * agent-def by that name, and the on-disk file matches skm's render of it for that
 * harness's dialect. Any gap → `stale` (never owned), preserving DEL-1.
 */
function classifyEntry(
  env: SkmEnv,
  registry: Registry,
  defByName: Map<string, DesiredAgentDef>,
  harness: string,
  entry: ManifestEntry,
): EntryOutcome {
  const agentId = agentIdForHarness(harness);
  const agent = agentId ? registry.agents[agentId] : undefined;
  const dialect = agent?.agentDefDialect;
  if (!agentId || !agent || agent.agentDefSupport !== "supported" || !agent.agentDefDir || !dialect) {
    return { kind: "stale", reason: `harness '${harness}' has no skm agent-def support` };
  }
  const def = defByName.get(entry.agent);
  if (!def) {
    return { kind: "stale", reason: `no agent definition '${entry.agent}' in skm sources` };
  }
  const abs = path.resolve(expandTilde(env, entry.path));
  // DEL-1 hardening: adopt ONLY the definition's own computed destination for this
  // harness. A manifest path pointing at a matching-content file elsewhere on disk
  // must NOT be owned — else a later `apply --prune` could delete an unrelated file.
  const expectedPath = path.resolve(agentDefFilePath(env, agentId, agent, def.name, dialect));
  if (abs !== expectedPath) {
    return { kind: "stale", reason: `manifest path is not this definition's placement for '${harness}' (expected ${expectedPath})` };
  }
  let contents: string;
  try {
    contents = fs.readFileSync(abs, "utf8");
  } catch {
    return { kind: "stale", reason: "generated file missing on disk" };
  }
  const expected = renderAgentDefFile(def.source.path, dialect);
  if (hashContent(contents) !== hashContent(expected)) {
    return { kind: "stale", reason: "file content differs from skm's current render" };
  }
  return {
    kind: "adopt",
    agentId,
    abs,
    hash: agentDefFileHash(def.source.path, dialect),
    source: { root: def.source.root, visibility: def.source.visibility },
  };
}

function tallyByHarness(
  adopted: AdoptedRow[],
  stale: StaleRow[],
  ghost: GhostRow[],
): Record<string, { adopted: number; stale: number; ghostSkipped: number }> {
  const by: Record<string, { adopted: number; stale: number; ghostSkipped: number }> = {};
  const bump = (harness: string, key: "adopted" | "stale" | "ghostSkipped") => {
    const row = (by[harness] ??= { adopted: 0, stale: 0, ghostSkipped: 0 });
    row[key]++;
  };
  for (const r of adopted) bump(r.harness, "adopted");
  for (const r of stale) bump(r.harness, "stale");
  for (const r of ghost) bump(r.harness, "ghostSkipped");
  return by;
}

function renderHuman(json: {
  manifests: { path: string; present: boolean }[];
  adopted: AdoptedRow[];
  stale: StaleRow[];
  ghostSkipped: GhostRow[];
  summary: { adopted: number; stale: number; ghostSkipped: number };
}): string {
  const lines: string[] = [];
  const read = json.manifests.filter((m) => m.present).map((m) => m.path);
  lines.push(read.length ? `Read manifest(s): ${read.join(", ")}` : "No custom_agents manifest found.");
  lines.push(
    `Adopted ${json.summary.adopted}, stale ${json.summary.stale}, ghost-skipped ${json.summary.ghostSkipped}.`,
  );
  for (const r of json.adopted) lines.push(`  ✓ adopt   ${r.harness.padEnd(10)} ${r.agent}  →  ${r.path}`);
  for (const r of json.stale) lines.push(`  · stale   ${r.harness.padEnd(10)} ${r.agent}  (${r.reason})`);
  return lines.join("\n");
}
