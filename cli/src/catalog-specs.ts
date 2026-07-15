// Read-only loader for the upstream-skill catalogs (ADR 0013). Attribution
// only: a parsed spec is DESIRED state — "matches curated entry
// <owner>/<repo>" — never evidence of how a directory on disk was actually
// installed. Upstream sync is owned by `skm upstream sync` (ADR 0014); scoped
// upstream vendoring stays deferred to the phase-7 path.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Root } from "./types";

export interface CatalogSpec {
  /** owner/repo */
  repo: string;
  /** Skill name after `@`; absent = whole-repo spec (names not enumerable here). */
  skill?: string;
  /** Root the spec was declared in. */
  root: string;
}

export interface CatalogFamily {
  name: string;
  description: string;
  specs: CatalogSpec[];
  root: string;
}

export interface CatalogSpecs {
  specs: CatalogSpec[];
  families: CatalogFamily[];
  /** skill name → owner/repo for @-form global specs (expectation lookup). */
  bySkillName: Record<string, string>;
}

// Mirrors lib/catalog.sh validate_spec_line: the repo portion may include a
// GitHub subdirectory after owner/name, e.g. cursor/plugins/thermos@thermos.
export const SPEC_LINE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+(@[A-Za-z0-9_.-]+)?$/;

function parseSpecsFile(file: string, root: string): CatalogSpec[] {
  if (!fs.existsSync(file)) return [];
  const specs: CatalogSpec[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!SPEC_LINE.test(line)) continue; // malformed lines are the bash validator's problem
    const at = line.lastIndexOf("@");
    specs.push(
      at === -1
        ? { repo: line, root }
        : { repo: line.slice(0, at), skill: line.slice(at + 1), root },
    );
  }
  return specs;
}

/** Load global specs and families from every registered root's catalog/ dir. */
export function loadCatalogSpecs(roots: Root[]): CatalogSpecs {
  const specs: CatalogSpec[] = [];
  const families: CatalogFamily[] = [];
  for (const root of roots) {
    const catalogDir = path.join(root.path, "catalog");
    specs.push(...parseSpecsFile(path.join(catalogDir, "global-specs.txt"), root.name));

    const familiesTsv = path.join(catalogDir, "families.tsv");
    if (fs.existsSync(familiesTsv)) {
      for (const raw of fs.readFileSync(familiesTsv, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        const name = line.slice(0, tab).trim();
        const description = line.slice(tab + 1).trim();
        const familySpecs = parseSpecsFile(
          path.join(catalogDir, "families", `${name}.txt`),
          root.name,
        );
        families.push({ name, description, specs: familySpecs, root: root.name });
      }
    }
  }
  // Null prototype: queried with arbitrary inventory dir names, so inherited
  // keys ("constructor", "toString") must not read as catalog entries.
  const bySkillName: Record<string, string> = Object.create(null);
  for (const s of specs) {
    if (s.skill) bySkillName[s.skill] = s.repo;
  }
  return { specs, families, bySkillName };
}
