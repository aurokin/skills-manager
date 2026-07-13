// Composed-skill source discovery + loading (AUR-645, ADR 0010). Composed skills
// live at `<root>/composed/<name>/` (skill.yaml + SKILL.tmpl.md + providers/*.md +
// consumers/*.md), parallel to `skills/` and `agents/`, in the public repo root and
// in overlay roots. This module reads one from disk and hands the raw files to the
// schema validator. Owned by the resolve team.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DesiredComposedSkill, Registry, SkillSource, Warning } from "../types";
import { loadComposedSkill } from "./schema";

/** True when `<dir>/skill.yaml` exists (the marker that makes a dir a composed skill). */
export function isComposedDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "skill.yaml"));
}

/** The reserved shared-pool directory name under `composed/` (ADR 0012). */
export const PROVIDER_POOL_DIR = "_providers";

/**
 * Read the per-root shared provider pool (`<root>/composed/_providers/*.md`, ADR
 * 0012) keyed by provider id. Absent dir → empty pool. Pools are per-root and
 * never merge across roots.
 */
export function readProviderPool(composedDir: string): Record<string, string> {
  return readMarkdownDir(path.join(composedDir, PROVIDER_POOL_DIR));
}

/** Read every `<subdir>/*.md` file into a map keyed by basename (minus `.md`). */
function readMarkdownDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -".md".length);
    out[id] = fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return out;
}

/**
 * Load + validate one composed skill from its source directory. Reads skill.yaml,
 * SKILL.tmpl.md, providers/*.md, and consumers/*.md, then runs the schema loader.
 */
export function loadComposedSkillFromDir(
  dir: string,
  name: string,
  source: SkillSource,
  registry: Registry,
): { skill: DesiredComposedSkill; warnings: Warning[] } {
  const skillYamlPath = path.join(dir, "skill.yaml");
  const skillYaml = parseYaml(fs.readFileSync(skillYamlPath, "utf8"));
  const templatePath = path.join(dir, "SKILL.tmpl.md");
  const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, "utf8") : undefined;
  const providerFiles = readMarkdownDir(path.join(dir, "providers"));
  const poolProviderFiles = readProviderPool(path.dirname(dir));
  const consumerFiles = readMarkdownDir(path.join(dir, "consumers"));

  return loadComposedSkill({
    name,
    source,
    path: skillYamlPath,
    skillYaml,
    template,
    providerFiles,
    poolProviderFiles,
    consumerFiles,
    registry,
  });
}
