// First-party rendering: when a placement targets a first-party agent's dir and
// the skill ships an agents/<dialect>.yaml override, materialize a real dir copy
// with SKILL.md frontmatter deep-merged (override wins) and record the rendered
// SKILL.md sha256. Owned by the rendering team.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkmEnv } from "./env";
import type { Dialect, DesiredSkill, RenderResult } from "./types";
import { doc, list } from "./render/doc";
import type { Document, DocValue } from "./render/doc";
import { emitYamlCanonical } from "./render/emit-yaml-canonical";

/** Canonical top-level frontmatter order (design §6); remaining keys sort alphabetically. */
const CANONICAL_ORDER = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
];

/** Compute the rendered SKILL.md text for a skill+dialect without touching disk. */
export function renderedSkillMd(skill: DesiredSkill, dialect: Dialect): string {
  const overridePath = overridePathFor(skill, dialect);
  const override = overridePath
    ? ((parseYaml(fs.readFileSync(overridePath, "utf8")) as unknown) ?? {})
    : {};
  const raw = fs.readFileSync(path.join(skill.source.path, "SKILL.md"), "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const base = (parseYaml(frontmatter) as Record<string, unknown> | null) ?? {};
  const merged = deepMerge(base, override) as Record<string, unknown>;
  // Route through the ADR 0009 pipeline: build a Document mirroring the ordered
  // frontmatter and emit it with the canonical (library-default) YAML emitter —
  // byte-identical to the prior direct `stringify(orderFrontmatter(merged))`.
  const yaml = emitYamlCanonical(plainToDocument(orderFrontmatter(merged)));
  return `---\n${yaml}---\n${body}`;
}

/** Convert an ordered plain-object frontmatter into a Document AST. */
export function plainToDocument(record: Record<string, unknown>): Document {
  const builder = doc();
  for (const [key, value] of Object.entries(record)) {
    builder.set(key, plainToDocValue(value));
  }
  return builder.build();
}

/** Convert an arbitrary parsed-YAML value into a DocValue (scalars/lists/maps). */
function plainToDocValue(value: unknown): DocValue {
  if (Array.isArray(value)) return list(value.map(plainToDocValue));
  if (isPlainObject(value)) return plainToDocument(value);
  return value as DocValue;
}

/** sha256 of the rendered SKILL.md a placement would produce (no disk write). */
export function renderedHash(skill: DesiredSkill, dialect: Dialect): string {
  return hashContent(renderedSkillMd(skill, dialect));
}

/** Render `skill` for `dialect` into `targetPath`, returning the hash + file list. */
export function renderSkill(
  _env: SkmEnv,
  skill: DesiredSkill,
  dialect: Dialect,
  targetPath: string,
): RenderResult {
  const renderedMd = renderedSkillMd(skill, dialect);

  // Copy the whole skill dir, then overwrite SKILL.md with the rendered variant.
  const files = copyTree(skill.source.path, targetPath);
  fs.writeFileSync(path.join(targetPath, "SKILL.md"), renderedMd);

  return {
    path: targetPath,
    hash: hashContent(renderedMd),
    tree: treeHashOf(targetPath),
    files: files.sort(),
  };
}

/**
 * sha256 over the FULL contents of a rendered artifact directory (every file's
 * relative path + byte hash, in sorted order). Recorded in state so deletion
 * safety covers the whole tree, not just SKILL.md — a user file added alongside
 * SKILL.md must make the tree diverge so skm refuses to recursive-delete it
 * (deletion invariant, DEL / finding 2). Returns undefined if `dir` is unreadable.
 */
export function treeHashOf(dir: string): string | undefined {
  let files: string[];
  try {
    files = listFilesRecursive(dir).sort();
  } catch {
    return undefined;
  }
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel, "utf8");
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\n");
  }
  return `sha256:${h.digest("hex")}`;
}

/** Relative paths of every regular file under `dir` (recursively). */
function listFilesRecursive(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), childRel));
    } else {
      out.push(childRel);
    }
  }
  return out;
}

/** Deep-merge an override object onto a base (override wins on scalar/array leaves). */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) {
    // Scalars and arrays: override replaces wholesale (arrays are not concatenated).
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/** sha256 hex of rendered content (recorded in state for `modified` detection). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function overridePathFor(skill: DesiredSkill, dialect: Dialect): string | undefined {
  if (dialect === "claude") return skill.overrides.claude;
  if (dialect === "copilot") return skill.overrides.copilot;
  if (dialect === "codex") return skill.overrides.codex;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reorder top-level keys: canonical spec fields first, then dialect extras alphabetically. */
function orderFrontmatter(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CANONICAL_ORDER) {
    if (key in obj) out[key] = obj[key];
  }
  for (const key of Object.keys(obj).filter((k) => !CANONICAL_ORDER.includes(k)).sort()) {
    out[key] = obj[key];
  }
  return out;
}

/** Split a `---`-fenced frontmatter block from the body, preserving the body byte-for-byte. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1]!, body: content.slice(match[0].length) };
}

/** Recursively copy a directory tree; returns relative paths of copied files. */
function copyTree(src: string, dest: string, rel = ""): string[] {
  fs.mkdirSync(dest, { recursive: true });
  const out: string[] = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      out.push(...copyTree(from, to, childRel));
    } else {
      fs.copyFileSync(from, to);
      out.push(childRel);
    }
  }
  return out;
}
