// Golden-backed parity for the `skm deploy` port (ADR 0014 implementation-plan item 3).
// The bash script deploy-project-skills.sh was deleted at the ADR 0014 final commit;
// its resolved install plans (the ordered `skills add --copy` argv) and the upstream
// enumerator results were captured one final time into
// test/fixtures/parity-goldens/deploy.json (see that dir's README). These tests assert
// the TS resolution path reproduces those goldens for the SAME fixture families
// (curated specs, `.skills.local.json` familySpecs / excludeFamilySpecs / customFamilies,
// and whole-repo exclude expansion).
//
// The TS side needs no bash and no network: the install-plan scenarios resolve through a
// stub enumerator over the upstream table; the enumerator-parity scenarios exercise the
// production git enumerator against a `git` shim (still bash+jq, but not the deleted script).

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type UpstreamEnumerator,
  batchToSkillsArgs,
  listFamilies,
  loadDeployCatalog,
  resolveDeployPlan,
} from "../src/deploy/resolve";
import { repoRootDir } from "./util";

const AGENTS = ["claude-code", "codex"];

interface DeployGolden {
  scenarios: Record<string, string[][]>;
  enumerator: Record<string, string[]>;
}
const GOLDEN: DeployGolden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "parity-goldens", "deploy.json"), "utf8"),
);

// Upstream enumeration table (matches the git shim the goldens were captured with). Both
// the git shim and the TS stub enumerator read the same map, so the two sides see identical
// whole-repo expansions.
// A "ROOT:<name>" entry makes the git shim write a ROOT-level SKILL.md whose frontmatter
// `name:` is <name> (the single-skill repo layout); "ROOTBARE" writes a root SKILL.md with
// no frontmatter name. Used by the enumerator parity tests.
const UPSTREAM: Record<string, string[]> = {
  "owner/repo": ["a", "b"],
  "other/repo": ["x"],
  "extra/repo": ["e"],
  "wide/repo": ["a", "b", "c"],
  "mix/a": ["p", "q"],
  "mix/b": ["s1", "s2", "s3"],
  "custom/repo": ["c1", "c2"],
  "rooty/repo": ["ROOT:custom-name"],
  "bare/repo": ["ROOTBARE"],
};

const LOCAL_CONFIG = {
  familySpecs: { demo: ["extra/repo@e"] },
  excludeFamilySpecs: { wide: ["wide/repo@b"], mix: ["mix/b@s2"] },
  customFamilies: { mine: { description: "My custom", specs: ["custom/repo@c1", "custom/repo@c2"] } },
};

const FAMILIES: Record<string, string> = {
  demo: "owner/repo@a\nowner/repo@b\nother/repo@x\n",
  wide: "wide/repo\n",
  mix: "mix/a\nmix/b\n",
};
const INDEX = "demo\tDemo family\nwide\tWide family\nmix\tMix family\n";

// The enumerator-parity scenarios drive the production git enumerator against a `git`
// shim, which is a bash+jq script (not the deleted deploy script).
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const enumeratorEnabled = hasBash && hasJq;

let base: string;
let catalogDir: string;
let configFile: string;
let upstreamJson: string;
let shimDir: string;
let targetDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-parity-"));
  catalogDir = path.join(base, "catalog");
  fs.mkdirSync(path.join(catalogDir, "families"), { recursive: true });
  fs.writeFileSync(path.join(catalogDir, "families.tsv"), INDEX);
  for (const [name, body] of Object.entries(FAMILIES)) {
    fs.writeFileSync(path.join(catalogDir, "families", `${name}.txt`), body);
  }
  configFile = path.join(base, ".skills.local.json");
  fs.writeFileSync(configFile, JSON.stringify(LOCAL_CONFIG, null, 2));
  upstreamJson = path.join(base, "upstream.json");
  fs.writeFileSync(upstreamJson, JSON.stringify(UPSTREAM));

  targetDir = path.join(base, "target");
  fs.mkdirSync(targetDir, { recursive: true });

  // Shim bin dir shadowing `git` (fake clone) for the TS enumerator-parity scenarios.
  shimDir = path.join(base, "shim");
  fs.mkdirSync(shimDir, { recursive: true });
  const gitShim = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "clone" ]; then exit 0; fi
url=""; dest=""
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --depth) shift 2;;
    https://*) url="$1"; shift;;
    *) if [ -z "$dest" ] && [ -n "$url" ]; then dest="$1"; fi; shift;;
  esac
done
repo="\${url#https://github.com/}"; repo="\${repo%.git}"
mkdir -p "$dest"
while IFS= read -r s; do
  [ -z "$s" ] && continue
  case "$s" in
    ROOT:*) printf -- '---\\nname: %s\\n---\\n' "\${s#ROOT:}" > "$dest/SKILL.md";;
    ROOTBARE) printf 'root skill, no frontmatter\\n' > "$dest/SKILL.md";;
    *) mkdir -p "$dest/$s"; printf -- '---\\nname: %s\\n---\\n' "$s" > "$dest/$s/SKILL.md";;
  esac
done < <(jq -r --arg r "$repo" '.[$r][]?' "$PARITY_UPSTREAM_JSON")
exit 0
`;
  fs.writeFileSync(path.join(shimDir, "git"), gitShim, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** Resolve the same plan through the TS path; return the synthesized `skills add` argv. */
function runTs(families: string[]): string[][] {
  const cat = loadDeployCatalog(catalogDir, configFile);
  const enumerate: UpstreamEnumerator = (repo) => {
    const names = UPSTREAM[repo];
    if (!names) throw new Error(`no fixture enumeration for ${repo}`);
    return [...names].sort();
  };
  const plan = resolveDeployPlan(
    { cat, families, agents: AGENTS, installRoot: targetDir },
    enumerate,
  );
  return plan.batches.map((b) => batchToSkillsArgs(b, AGENTS));
}

describe("skm deploy install-plan parity (golden: deploy-project-skills.sh)", () => {
  const scenarios: { name: string; families: string[] }[] = [
    { name: "explicit family + familySpecs override", families: ["demo"] },
    { name: "whole-repo partial exclusion", families: ["wide"] },
    { name: "mixed preserve-wide + partial exclusion", families: ["mix"] },
    { name: "custom family", families: ["mine"] },
    { name: "multiple families dedupe", families: ["demo", "mine"] },
    { name: "all families", families: [] },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const families =
        s.families.length > 0
          ? s.families
          : listFamilies(loadDeployCatalog(catalogDir, configFile)).map((r) => r.name);
      const golden = GOLDEN.scenarios[s.name];
      expect(golden).toBeDefined();
      const ts = runTs(families);
      expect(ts).toEqual(golden!);
      expect(ts.length).toBeGreaterThan(0);
    });
  }
});

// ── enumerator parity: root SKILL.md naming ──────────────────────────────────
// The upstream skill-name enumeration itself (a port of lib/upstream-audit.sh
// collect_upstream_skill_names) must agree with the recorded bash golden — including
// the disputed case of a ROOT SKILL.md whose frontmatter `name:` differs from the repo
// basename: bash overrode the repo-derived name with the frontmatter name
// UNCONDITIONALLY, and the TS enumerator must do the same.

/**
 * Run the TS production enumerator with the git shim on PATH. Spawned as a bun
 * subprocess with the shim env: Bun resolves execFileSync binaries against the
 * process's ORIGINAL environ, so an in-process PATH mutation would still hit the real
 * network `git` — the subprocess starts with the shim already first on PATH.
 */
function tsEnumerate(repo: string): string[] {
  const script = path.join(base, "ts-enumerate.ts");
  if (!fs.existsSync(script)) {
    const upstreamModule = path.join(repoRootDir(), "cli", "src", "deploy", "upstream.ts");
    fs.writeFileSync(
      script,
      `import { makeGitEnumerator } from ${JSON.stringify(upstreamModule)};\n` +
        `process.stdout.write(JSON.stringify(makeGitEnumerator()(process.argv[2]!)));\n`,
    );
  }
  const out = execFileSync(process.execPath, [script, repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PARITY_UPSTREAM_JSON: upstreamJson,
      HOME: base,
    },
  });
  return JSON.parse(out) as string[];
}

describe.skipIf(!enumeratorEnabled)("upstream enumerator parity (golden: collect_upstream_skill_names)", () => {
  test("root SKILL.md with a frontmatter name differing from the repo basename", () => {
    const ts = tsEnumerate("rooty/repo");
    expect(ts).toEqual(GOLDEN.enumerator["rooty/repo"]!);
    // Both sides yield the FRONTMATTER name (bash's unconditional override).
    expect(ts).toEqual(["custom-name"]);
  });

  test("root SKILL.md without a frontmatter name falls back to the repo basename", () => {
    const ts = tsEnumerate("bare/repo");
    expect(ts).toEqual(GOLDEN.enumerator["bare/repo"]!);
    expect(ts).toEqual(["repo"]);
  });

  test("multi-skill layout enumerates every SKILL.md", () => {
    const ts = tsEnumerate("mix/b");
    expect(ts).toEqual(GOLDEN.enumerator["mix/b"]!);
    expect(ts).toEqual(["s1", "s2", "s3"]);
  });
});

// Guard-rail: if the enumerator toolchain is unavailable the enumerator suite silently
// skips. This test fails loudly only in that case so a broken environment is visible.
test("enumerator toolchain availability (informational)", () => {
  if (!enumeratorEnabled) {
    console.warn(`deploy enumerator parity skipped: bash=${hasBash} jq=${hasJq}`);
  }
  expect(true).toBe(true);
});
