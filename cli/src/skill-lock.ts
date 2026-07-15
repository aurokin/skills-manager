// Read-only loader for the `skills` CLI install ledger, ~/.agents/.skill-lock.json
// (ADR 0014, phase 1). The doctrinal opposite of catalog-specs.ts: that module
// parses DESIRED state (a name-match expectation), this one reads INSTALLATION
// EVIDENCE — what the `skills` CLI reports it actually placed. skm never writes
// the lock, and never throws on bad lock content: attribution degrades loudly
// (a reason string phase 2 surfaces as "lock unreadable; attribution degraded"),
// it does not crash the review model.

import * as fs from "node:fs";
import { type SkmEnv, skillLockPath } from "./env";

/** One per-skill install record from the v3 lock (keyed by skill name). */
export interface SkillLockEntry {
  /** owner/repo the skill was installed from. */
  source: string;
  /** e.g. "github". */
  sourceType: string;
  /** Clone URL the `skills` CLI recorded. */
  sourceUrl: string;
  /** Path to the skill's SKILL.md within the source repo. */
  skillPath: string;
  /** Folder hash at install time — phase 2's attested-origin gate compares against it. */
  skillFolderHash: string;
  /** ISO-8601 install timestamp. */
  installedAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * Loud three-state result:
 * - "loaded": lock parsed; `entries` holds every well-formed record. `skipped`
 *   lists records dropped for missing/ill-typed required fields (forward-compat:
 *   one bad record never fails the whole lock).
 * - "missing": no lock file. NOT an error — silence is expected (e.g. a
 *   `--full-depth` install has a skills dir but no lock record). `entries` empty.
 * - "degraded": lock present but unusable (unreadable / invalid or truncated
 *   JSON / not the expected v3 shape). `reason` explains; `entries` empty.
 *   Callers must fall back to catalog expectation for every skill.
 */
export interface SkillLock {
  status: "loaded" | "missing" | "degraded";
  /** Skill name → record. Empty unless status === "loaded". Null-prototype (see below). */
  entries: Record<string, SkillLockEntry>;
  /** Present only when status === "degraded": human-readable degradation reason. */
  reason?: string;
  /** Skill names skipped for missing/ill-typed required fields (status === "loaded"). */
  skipped?: string[];
}

const REQUIRED_FIELDS = [
  "source",
  "sourceType",
  "sourceUrl",
  "skillPath",
  "skillFolderHash",
  "installedAt",
  "updatedAt",
] as const;

const LOCK_VERSION = 3;

/**
 * Coerce one raw lock record into a SkillLockEntry, or undefined if any required
 * field is missing or not a string. Unknown extra fields are tolerated (only the
 * known fields are copied), keeping the loader forward-compatible with a v3 that
 * grows optional keys.
 */
function parseEntry(raw: unknown): SkillLockEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof rec[field] !== "string") return undefined;
  }
  return {
    source: rec.source as string,
    sourceType: rec.sourceType as string,
    sourceUrl: rec.sourceUrl as string,
    skillPath: rec.skillPath as string,
    skillFolderHash: rec.skillFolderHash as string,
    installedAt: rec.installedAt as string,
    updatedAt: rec.updatedAt as string,
  };
}

/** Read and parse ~/.agents/.skill-lock.json. Never throws; never writes. */
export function loadSkillLock(env: SkmEnv): SkillLock {
  // Null prototype: entries is queried with arbitrary inventory dir/skill names,
  // so inherited keys ("constructor", "toString") must not read as records.
  const entries: Record<string, SkillLockEntry> = Object.create(null);

  const file = skillLockPath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    // Missing file is the expected silent case; anything else is a read failure.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", entries };
    }
    return { status: "degraded", entries, reason: `lock unreadable: ${(err as Error).message}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { status: "degraded", entries, reason: `lock is invalid JSON: ${(err as Error).message}` };
  }

  if (typeof data !== "object" || data === null) {
    return { status: "degraded", entries, reason: "lock is not a JSON object" };
  }
  const root = data as Record<string, unknown>;
  if (root.version !== LOCK_VERSION) {
    return {
      status: "degraded",
      entries,
      reason: `unsupported lock version ${JSON.stringify(root.version)} (expected ${LOCK_VERSION})`,
    };
  }
  if (typeof root.skills !== "object" || root.skills === null || Array.isArray(root.skills)) {
    // An array passes typeof "object": reject it so a malformed ledger degrades
    // loudly instead of loading as a valid-but-empty lock.
    return { status: "degraded", entries, reason: "lock has no skills object" };
  }

  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(root.skills as Record<string, unknown>)) {
    const entry = parseEntry(raw);
    if (entry) entries[name] = entry;
    else skipped.push(name);
  }

  return skipped.length > 0 ? { status: "loaded", entries, skipped } : { status: "loaded", entries };
}
