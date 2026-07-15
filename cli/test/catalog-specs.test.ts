// catalog-specs loader (ADR 0013): read-only parsing of the bash-owned
// upstream catalogs. Attribution data only — desired state, not evidence.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadCatalogSpecs } from "../src/catalog-specs";
import type { Root } from "../src/types";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-specs-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function root(name: string): Root {
  const p = path.join(base, name);
  fs.mkdirSync(path.join(p, "catalog", "families"), { recursive: true });
  return { name, path: p, visibility: "public" };
}

describe("loadCatalogSpecs", () => {
  test("parses @-form and whole-repo specs, skipping comments and junk", () => {
    const r = root("pub");
    fs.writeFileSync(
      path.join(r.path, "catalog", "global-specs.txt"),
      "owner/repo@skill-a\nowner/repo2\n# comment\n\nnot a spec line at all\n",
    );
    const specs = loadCatalogSpecs([r]);
    expect(specs.specs).toHaveLength(2);
    expect(specs.bySkillName["skill-a"]).toBe("owner/repo");
    // Whole-repo specs enumerate no names — absent from the lookup by design.
    expect(Object.keys(specs.bySkillName)).toEqual(["skill-a"]);
  });

  test("accepts multi-segment repo paths like the bash validator", () => {
    const r = root("pub");
    fs.writeFileSync(
      path.join(r.path, "catalog", "global-specs.txt"),
      "cursor/plugins/thermos@thermos\nno-slash-at-all\n",
    );
    const specs = loadCatalogSpecs([r]);
    expect(specs.specs).toHaveLength(1);
    expect(specs.bySkillName["thermos"]).toBe("cursor/plugins/thermos");
  });

  test("loads families with their spec files", () => {
    const r = root("pub");
    fs.writeFileSync(path.join(r.path, "catalog", "families.tsv"), "demo\tDemo family\n");
    fs.writeFileSync(
      path.join(r.path, "catalog", "families", "demo.txt"),
      "owner/repo@fam-skill\n",
    );
    const specs = loadCatalogSpecs([r]);
    expect(specs.families).toHaveLength(1);
    expect(specs.families[0]?.description).toBe("Demo family");
    expect(specs.families[0]?.specs[0]?.skill).toBe("fam-skill");
  });

  test("missing catalog dirs load as empty, and multiple roots merge", () => {
    const a = root("with-catalog");
    fs.writeFileSync(path.join(a.path, "catalog", "global-specs.txt"), "o/r@x\n");
    const bare: Root = { name: "bare", path: path.join(base, "bare"), visibility: "private" };
    fs.mkdirSync(bare.path, { recursive: true });
    const specs = loadCatalogSpecs([a, bare]);
    expect(specs.specs).toHaveLength(1);
    expect(specs.specs[0]?.root).toBe("with-catalog");
  });
});
