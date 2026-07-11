// Ownership state I/O (~/.local/state/skills-manager/state.json). The state file
// is the ONLY authority for what skm may delete: apply prunes exactly the
// placements recorded here. Writes are atomic (tmp + rename). Owned by the
// apply/state team.

import * as fs from "node:fs";
import * as path from "node:path";
import { type SkmEnv, statePath } from "./env";
import type { Artifact, ArtifactType, StateFile, StatePlacement } from "./types";

// v2 added `tree` (full-artifact hash) to rendered placements for deletion safety
// (finding 2). v3 (AUR-616) type-qualifies artifact keys (`skill:<name>` /
// `agent-def:<name>`) and adds `type`/`name` to each Artifact so a derived skill
// can never silently collide with a native skill. v4 (AUR-645) is a pure
// forward-compatibility fence for the composed-skill artifact type: NO transform
// body (v3 states are valid v4), the bump only makes an OLDER skm hard-fail instead
// of mis-pruning composed rendered trees it would misread as generic rendered
// artifacts. Older versions load fine and are migrated forward in memory (see
// migrateState); only a NEWER-than-supported version hard-fails.
const STATE_VERSION = 4;

/** Type-qualified state key for an artifact. */
export function artifactKey(type: ArtifactType, name: string): string {
  return `${type}:${name}`;
}

/** Split a state key back into its type + bare name (defensive on unqualified keys). */
export function parseArtifactKey(key: string): { type: ArtifactType; name: string } {
  const i = key.indexOf(":");
  if (i < 0) return { type: "skill", name: key };
  return { type: key.slice(0, i) as ArtifactType, name: key.slice(i + 1) };
}

/** A fresh, empty state for a machine (first run). */
export function emptyState(machine: string): StateFile {
  return { version: STATE_VERSION, machine, artifacts: {} };
}

/** Read state from disk, or an empty state when the file is absent. */
export function loadState(env: SkmEnv): StateFile {
  const file = statePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState(env.machineName);
    }
    throw err;
  }
  return parseState(raw, file);
}

/** Parse + structurally validate state JSON. Throws a clear error on corruption. */
function parseState(raw: string, file: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`corrupt state file at ${file}: invalid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt state file at ${file}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    throw new Error(`corrupt state file at ${file}: missing numeric 'version'`);
  }
  // Forward-incompatible state (written by a newer skm) must fail loudly rather
  // than have this build silently misread a shape it does not understand. Older
  // versions load fine (missing fields degrade gracefully — see StatePlacement.tree).
  if (obj.version > STATE_VERSION) {
    throw new Error(
      `state file at ${file} is version ${obj.version}, newer than this skm supports (${STATE_VERSION}); upgrade skm`,
    );
  }
  if (typeof obj.machine !== "string") {
    throw new Error(`corrupt state file at ${file}: missing string 'machine'`);
  }
  if (typeof obj.artifacts !== "object" || obj.artifacts === null || Array.isArray(obj.artifacts)) {
    throw new Error(`corrupt state file at ${file}: 'artifacts' must be an object`);
  }
  return migrateState(parsed as StateFile);
}

/**
 * Forward-migrate an older supported state file in memory (never on disk until the
 * next save). v1/v2 keyed artifacts by bare skill name and carried no type/name; v3
 * type-qualifies keys and stamps `type`/`name`. Every pre-v3 entry is a skill, so it
 * gets the `skill:` prefix and `type: "skill"`. v3→v4 is a pure version bump (no
 * shape change) — a v3 file's already-qualified entries pass through untouched and
 * are re-stamped with version 4. Newer-than-supported was already rejected above, so
 * this only ever upgrades.
 */
function migrateState(state: StateFile): StateFile {
  if (state.version >= STATE_VERSION) return state;
  const artifacts: Record<string, Artifact> = {};
  for (const [key, artifact] of Object.entries(state.artifacts)) {
    const { type, name } = parseArtifactKey(key);
    const qualified = key.includes(":") ? key : artifactKey("skill", name);
    artifacts[qualified] = { ...artifact, type: artifact.type ?? type, name: artifact.name ?? name };
  }
  return { ...state, version: STATE_VERSION, artifacts };
}

/** Persist state atomically: write a sibling tmp file then rename over the target. */
export function saveState(env: SkmEnv, state: StateFile): void {
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Upsert one artifact (source + full placement set), keyed by its type-qualified
 * `key` (e.g. `skill:foo`). Mutates and returns state.
 */
export function recordArtifact(
  state: StateFile,
  key: string,
  source: Artifact["source"],
  placements: StatePlacement[],
): StateFile {
  const { type, name } = parseArtifactKey(key);
  state.artifacts[key] = { type, name, source, placements };
  return state;
}

/**
 * Insert or replace a single placement of a skill, preserving the skill's other
 * placements. Used by apply to record one materialized placement at a time.
 * Mutates and returns state.
 */
export function upsertPlacement(
  state: StateFile,
  key: string,
  source: Artifact["source"],
  placement: StatePlacement,
): StateFile {
  const { type, name } = parseArtifactKey(key);
  const artifact = state.artifacts[key] ?? { type, name, source, placements: [] };
  artifact.source = source;
  const want = normalize(placement.path);
  artifact.placements = artifact.placements.filter((p) => normalize(p.path) !== want);
  artifact.placements.push(placement);
  state.artifacts[key] = artifact;
  return state;
}

/**
 * Remove the placement at `targetPath` from a skill's artifact. Drops the
 * artifact entirely once its last placement is gone. Mutates and returns state.
 */
export function removePlacement(state: StateFile, name: string, targetPath: string): StateFile {
  const artifact = state.artifacts[name];
  if (!artifact) return state;
  const want = normalize(targetPath);
  artifact.placements = artifact.placements.filter((p) => normalize(p.path) !== want);
  if (artifact.placements.length === 0) delete state.artifacts[name];
  return state;
}

/** Find which skill (and placement record) owns `targetPath`, if any. */
export function findOwner(
  state: StateFile,
  targetPath: string,
): { skill: string; placement: StatePlacement } | undefined {
  const want = normalize(targetPath);
  for (const [skill, artifact] of Object.entries(state.artifacts)) {
    for (const placement of artifact.placements) {
      if (normalize(placement.path) === want) return { skill, placement };
    }
  }
  return undefined;
}

/**
 * Normalize a placement path for comparison. skm records absolute placement
 * paths (apply resolves dir ids to absolute paths before recording), so a plain
 * resolve is sufficient and no injected env/home is needed here.
 */
function normalize(p: string): string {
  return path.resolve(p);
}
