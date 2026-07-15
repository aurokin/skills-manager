// Golden-backed parity for the `skm upstream sync` cutover (ADR 0014 implementation-plan
// item 4). The bash script install-repro-skills.sh was deleted at the ADR 0014 final
// commit; its `skills` CLI argv stream and resulting filesystem state were captured one
// final time into test/fixtures/parity-goldens/sync.json (see that dir's README). These
// tests assert the TS verb reproduces those goldens for IDENTICAL fixtures — same
// catalog/global-specs.txt, `.skills.local.json` overrides, installed-set JSON, and fixture
// home tree. The assertions target the DESTRUCTIVE EDGES the ADR enumerates, not just
// converged sets:
//   (i)  Hermes add-only: stale removal narrowed with `-a` to non-Hermes agents
//        (and skipped entirely in Hermes-only mode); the ~/.hermes/skills sweep
//        removes ONLY our own dangling symlinks — real dirs, live links, and
//        foreign-target danglers survive byte-identically.
//   (ii) the OpenClaw --dangerously-accept-openclaw-risks add flag,
//   (iii) diffwarden --full-depth,
//   (iv) preserveGlobalSkillNames protecting an installed stale name,
//   (v)  excludeGlobalSpecs: an excluded skill is not added AND is removed when
//        installed (exclusion is not preservation).
//
// The TS side needs no bash script and no network: `git` is a shim that materializes a
// fixture SKILL.md layout, `skills` is a shim that records argv (and serves the installed
// list for `list -g --json`). Both shims are bash+jq, so the suite gates on those.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { repoRootDir } from "./util";

// Upstream enumeration table shared by the git shim (the TS verb resolves whole-repo
// specs and coverage audits through it — matches the table the goldens were captured with).
const UPSTREAM: Record<string, string[]> = {
  "keep/repo": ["keep-b"],
  "miss/repo": ["missing-c"],
  "openclaw/openclaw": ["github", "tmux"],
  "aurokin/diffwarden": ["diffwarden"],
  "wide/repo": ["w1", "w2", "w3"],
  "local/repo": ["local-extra"],
};

const GLOBAL_SPECS = [
  "keep/repo@keep-b",
  "miss/repo@missing-c",
  "openclaw/openclaw@github",
  "aurokin/diffwarden@diffwarden",
  "wide/repo",
].join("\n");

const LOCAL_CONFIG = {
  globalSpecs: ["local/repo@local-extra"],
  excludeGlobalSpecs: ["wide/repo@w2"],
  preserveGlobalSkillNames: ["handmade"],
};

const COVERAGE = {
  repos: [
    { repo: "wide/repo", ignored: [] },
    { repo: "keep/repo", ignored: [] },
  ],
};

interface SyncGolden {
  agents: string;
  argv: string[][];
  snapshot: string[];
}
const GOLDEN: Record<string, SyncGolden> = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "parity-goldens", "sync.json"), "utf8"),
);

// The TS verb shells to shimmed `git` / `skills` (bash+jq scripts); gate on those.
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const enabled = hasBash && hasJq;

let base: string;
let fixtureRoot: string;
let upstreamJson: string;
let shimDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sync-parity-"));

  // Shared fixture root: catalog + local config + coverage manifest.
  fixtureRoot = path.join(base, "root");
  fs.mkdirSync(path.join(fixtureRoot, "catalog", "families"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "catalog", "global-specs.txt"), `${GLOBAL_SPECS}\n`);
  fs.writeFileSync(path.join(fixtureRoot, ".skills.local.json"), JSON.stringify(LOCAL_CONFIG, null, 2));
  fs.writeFileSync(path.join(fixtureRoot, "upstream-coverage.json"), JSON.stringify(COVERAGE, null, 2));
  upstreamJson = path.join(base, "upstream.json");
  fs.writeFileSync(upstreamJson, JSON.stringify(UPSTREAM));

  // Shim bin dir shadowing `git` (fixture clone) and `skills` (argv recorder that
  // also serves the installed list for `list -g --json`).
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
  mkdir -p "$dest/$s"
  printf -- '---\\nname: %s\\n---\\n' "$s" > "$dest/$s/SKILL.md"
done < <(jq -r --arg r "$repo" '.[$r][]?' "$PARITY_UPSTREAM_JSON")
exit 0
`;
  const skillsShim = `#!/usr/bin/env bash
set -euo pipefail
line=""
for a in "$@"; do line="$line$a"$'\\x1f'; done
printf '%s\\n' "$line" >> "$PARITY_SKILLS_LOG"
if [ "\${1:-}" = "list" ]; then cat "$PARITY_INSTALLED_JSON"; fi
exit 0
`;
  fs.writeFileSync(path.join(shimDir, "git"), gitShim, { mode: 0o755 });
  fs.writeFileSync(path.join(shimDir, "skills"), skillsShim, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Build one fixture HOME with the sweep-edge content; returns its path. */
function buildHome(tag: string): string {
  const home = path.join(base, `home-${tag}`);
  const agentsSkills = path.join(home, ".agents", "skills");
  const claudeSkills = path.join(home, ".claude", "skills");
  const hermesSkills = path.join(home, ".hermes", "skills");
  fs.mkdirSync(agentsSkills, { recursive: true });
  fs.mkdirSync(claudeSkills, { recursive: true });
  fs.mkdirSync(hermesSkills, { recursive: true });

  // A live target for the hermes ours-valid link.
  fs.mkdirSync(path.join(agentsSkills, "alive"));
  // Owned-dir danglers (cleaned unconditionally on both sides).
  fs.symlinkSync(path.join(agentsSkills, "nonexistent"), path.join(agentsSkills, "dead-agents"));
  fs.symlinkSync(path.join(claudeSkills, "nonexistent"), path.join(claudeSkills, "dead-claude"));
  // Hermes edge content: OUR danglers (absolute + relative form), a foreign
  // dangler, a live our-link, and a real directory.
  fs.symlinkSync(path.join(agentsSkills, "gone"), path.join(hermesSkills, "ours-dangling-abs"));
  fs.symlinkSync("../../.agents/skills/gone2", path.join(hermesSkills, "ours-dangling-rel"));
  fs.symlinkSync("/nowhere/foreign-target", path.join(hermesSkills, "foreign-dangling"));
  fs.symlinkSync(path.join(agentsSkills, "alive"), path.join(hermesSkills, "ours-valid"));
  fs.mkdirSync(path.join(hermesSkills, "real-dir"));
  fs.writeFileSync(path.join(hermesSkills, "real-dir", "SKILL.md"), "hermes-owned\n");
  return home;
}

/** The installed-set JSON `skills list -g --json` serves for a given home. */
function writeInstalledJson(tag: string, home: string): string {
  const file = path.join(base, `installed-${tag}.json`);
  const inAgents = (n: string) => path.join(home, ".agents", "skills", n);
  fs.writeFileSync(
    file,
    JSON.stringify([
      { name: "stale-a", path: inAgents("stale-a") }, // stale → removed
      { name: "keep-b", path: inAgents("keep-b") }, // desired → kept
      { name: "handmade", path: inAgents("handmade") }, // preserved → kept
      { name: "w2", path: inAgents("w2") }, // excluded → removed
      { name: "elsewhere", path: path.join(home, "other", "skills", "elsewhere") }, // not global → invisible
    ]),
  );
  return file;
}

/** Snapshot a home tree: sorted "relpath type[ -> target]" lines, home-normalized. */
function snapshotHome(home: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(home, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(full).split(home).join("$HOME");
        lines.push(`${rel} link -> ${target}`);
      } else if (st.isDirectory()) {
        lines.push(`${rel} dir`);
        walk(full);
      } else {
        lines.push(`${rel} file`);
      }
    }
  };
  walk(home);
  return lines;
}

// ── runner ───────────────────────────────────────────────────────────────────

interface RunResult {
  argv: string[][];
  snapshot: string[];
}

function readArgvLog(log: string): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\x1f").filter((f) => f.length > 0));
}

function runTs(tag: string, skillsAgents: string): RunResult {
  const home = buildHome(`ts-${tag}`);
  const xdgConfigHome = path.join(base, `xdg-config-ts-${tag}`);
  const xdgStateHome = path.join(base, `xdg-state-ts-${tag}`);
  fs.mkdirSync(path.join(xdgConfigHome, "skills-manager"), { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });
  fs.writeFileSync(
    path.join(xdgConfigHome, "skills-manager", "config.json"),
    JSON.stringify({
      version: 1,
      roots: [{ name: "public", path: fixtureRoot, visibility: "public" }],
      agents: ["claude-code"],
    }),
  );

  // Subprocess: Bun resolves execFileSync binaries against the process's ORIGINAL
  // environ, so the shim must be first on PATH at process start (phase-3 precedent).
  const script = path.join(base, "ts-sync.ts");
  if (!fs.existsSync(script)) {
    const verbModule = path.join(repoRootDir(), "cli", "src", "upstream", "verb.ts");
    fs.writeFileSync(
      script,
      `import { runUpstream } from ${JSON.stringify(verbModule)};\n` +
        `const [home, xdgConfigHome, xdgStateHome] = process.argv.slice(2);\n` +
        `const out = await runUpstream(\n` +
        `  { home: home!, xdgConfigHome, xdgStateHome, machineName: "parity", clock: { now: () => "2026-07-15T00:00:00.000Z" } },\n` +
        `  { json: true, prune: false, yes: false, fix: false, args: ["sync"] },\n` +
        `);\n` +
        `process.stdout.write(JSON.stringify(out.json));\n`,
    );
  }
  const log = path.join(base, `skills-ts-${tag}.log`);
  execFileSync(process.execPath, [script, home, xdgConfigHome, xdgStateHome], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SKILLS_AGENTS: skillsAgents,
      SKILLS_BIN: "skills",
      UPSTREAM_COVERAGE_FILE: path.join(fixtureRoot, "upstream-coverage.json"),
      PARITY_UPSTREAM_JSON: upstreamJson,
      PARITY_SKILLS_LOG: log,
      PARITY_INSTALLED_JSON: writeInstalledJson(`ts-${tag}`, home),
    },
  });
  return { argv: readArgvLog(log), snapshot: snapshotHome(home) };
}

// ── comparison ───────────────────────────────────────────────────────────────

interface ArgvGroups {
  list: string[][];
  removes: string[][];
  update: string[][];
  adds: string[][];
}

/** Group recorded argv by subcommand, asserting the phase order
 *  (list → removes → update → adds) held in the raw sequence. */
function groupArgv(argv: string[][]): ArgvGroups {
  const groups: ArgvGroups = { list: [], removes: [], update: [], adds: [] };
  let phase = 0; // 0 list, 1 removes, 2 update, 3 adds
  const phaseOf: Record<string, number> = { list: 0, remove: 1, update: 2, add: 3 };
  for (const line of argv) {
    const sub = line[0]!;
    const p = phaseOf[sub];
    expect(p).toBeDefined();
    expect(p!).toBeGreaterThanOrEqual(phase);
    phase = p!;
    if (sub === "list") groups.list.push(line);
    else if (sub === "remove") groups.removes.push(line);
    else if (sub === "update") groups.update.push(line);
    else groups.adds.push(line);
  }
  return groups;
}

/** Removal order is a hash-iteration artifact: compare removals as sorted sets. */
function sortedLines(lines: string[][]): string[] {
  return lines.map((l) => l.join(" ")).sort();
}

/** Assert the TS run reproduces the recorded bash golden (argv groups + fs snapshot). */
function assertParity(golden: SyncGolden, ts: RunResult): { groups: ArgvGroups } {
  const goldenGroups = groupArgv(golden.argv);
  const tsGroups = groupArgv(ts.argv);
  expect(tsGroups.list).toEqual(goldenGroups.list);
  expect(sortedLines(tsGroups.removes)).toEqual(sortedLines(goldenGroups.removes));
  expect(tsGroups.update).toEqual(goldenGroups.update);
  expect(tsGroups.adds).toEqual(goldenGroups.adds); // exact order: desired-spec order
  expect(ts.snapshot).toEqual(golden.snapshot);
  return { groups: tsGroups };
}

// ── scenarios ────────────────────────────────────────────────────────────────

describe.skipIf(!enabled)("skm upstream sync destructive-edge parity (golden: install-repro-skills.sh)", () => {
  test("standard agents (no hermes): stale+excluded removed, preserves honored, extra add flags", () => {
    const golden = GOLDEN.std!;
    const { groups } = assertParity(golden, runTs("std", golden.agents));

    // (iv) preserveGlobalSkillNames: installed 'handmade' is stale but never removed.
    // (v) excludeGlobalSpecs: installed 'w2' IS removed (exclusion is not preservation);
    //     'elsewhere' (outside ~/.agents/skills) is invisible to the diff.
    expect(sortedLines(groups.removes)).toEqual([
      "remove -g stale-a -a codex claude-code -y",
      "remove -g w2 -a codex claude-code -y",
    ]);
    // (ii)+(iii) extra flags after -y; (v) w2 not added from the expanded wide/repo.
    expect(groups.adds.map((l) => l.join(" "))).toEqual([
      "add miss/repo -g -a codex claude-code -s missing-c -y",
      "add openclaw/openclaw -g -a codex claude-code -s github -y --dangerously-accept-openclaw-risks",
      "add aurokin/diffwarden -g -a codex claude-code -s diffwarden -y --full-depth",
      "add wide/repo -g -a codex claude-code -s w1 w3 -y",
      "add local/repo -g -a codex claude-code -s local-extra -y",
    ]);
  });

  test("with hermes: removals narrowed to non-hermes agents; hermes sweep only touches ours", () => {
    const golden = GOLDEN.hermes!;
    const ts = runTs("hermes", golden.agents);
    const { groups } = assertParity(golden, ts);

    // (i) stale removal narrowed with -a to NON-hermes agents…
    for (const r of groups.removes) {
      expect(r).toContain("codex");
      expect(r).not.toContain("hermes-agent");
    }
    // …while adds fan out to the full agent set including hermes.
    for (const a of groups.adds) expect(a).toContain("hermes-agent");

    // (i) the hermes sweep: OUR danglers gone, foreign dangler + live link + real dir
    // survive (assertParity already diffed snapshots; these assert the absolute edge).
    const hermes = ts.snapshot.filter((l) => l.startsWith(path.join(".hermes", "skills")));
    const names = hermes.map((l) => l.split(" ")[0]);
    expect(names).not.toContain(path.join(".hermes", "skills", "ours-dangling-abs"));
    expect(names).not.toContain(path.join(".hermes", "skills", "ours-dangling-rel"));
    expect(names).toContain(path.join(".hermes", "skills", "foreign-dangling"));
    expect(names).toContain(path.join(".hermes", "skills", "ours-valid"));
    expect(names).toContain(path.join(".hermes", "skills", "real-dir"));
  });

  test("hermes-only mode: stale removal skipped entirely; adds still run", () => {
    const golden = GOLDEN["hermes-only"]!;
    const { groups } = assertParity(golden, runTs("hermes-only", golden.agents));

    // (i) NEVER deletes when only hermes is enabled: zero `skills remove` calls.
    expect(groups.removes).toEqual([]);
    expect(groups.adds.length).toBeGreaterThan(0);
    for (const a of groups.adds) {
      expect(a.join(" ")).toContain("-a hermes-agent -s");
    }
  });

  test("no hermes in agents: the hermes dir is never touched at all", () => {
    const golden = GOLDEN["no-hermes"]!;
    const ts = runTs("no-hermes", golden.agents);
    assertParity(golden, ts);
    // All fixture entries survive on both sides.
    const prefix = `${path.join(".hermes", "skills")}${path.sep}`;
    const hermesEntries = ts.snapshot.filter((l) => l.startsWith(prefix)).length;
    expect(hermesEntries).toBe(6); // 4 links + real-dir + its SKILL.md
  });
});

// Guard-rail: a skipped parity suite must be visible, never green-by-omission.
test("sync parity toolchain availability (informational)", () => {
  if (!enabled) {
    console.warn(`upstream-sync parity suite skipped: bash=${hasBash} jq=${hasJq}`);
  }
  expect(true).toBe(true);
});
