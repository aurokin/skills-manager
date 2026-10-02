// Unit tests for the pure `skm upstream sync` pieces (ADR 0014 decision 4):
// desired-spec resolution, the remove-stale/add-missing plan (with the per-repo
// extra flags and Hermes narrowing), and the two broken-symlink sweeps.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UpstreamEnumerator } from "../src/deploy/resolve";
import {
  addBatchToSkillsArgs,
  buildRepoSkillSummary,
  buildSyncPlan,
  readGlobalSpecsFile,
  removalToSkillsArgs,
  resolveDesiredGlobalSpecs,
  sweepBrokenSymlinks,
  sweepHermesBrokenSymlinks,
} from "../src/upstream/sync";
import type { LocalSkillsConfig } from "../src/deploy/local-config";
import { classifyInstalledGlobalNames, runUpstream } from "../src/upstream/verb";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const emptyLocal: LocalSkillsConfig = {
  present: false,
  globalSpecs: [],
  excludeGlobalSpecs: [],
  preserveGlobalSkillNames: [],
  familySpecs: {},
  excludeFamilySpecs: {},
  customFamilies: {},
};

const noEnumerate: UpstreamEnumerator = (repo) => {
  throw new Error(`unexpected enumeration of ${repo}`);
};

describe("readGlobalSpecsFile / resolveDesiredGlobalSpecs", () => {
  test("invalid spec lines fail loudly with file:line", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "ok/spec@a\nnot a spec\n");
    expect(() => readGlobalSpecsFile(f)).toThrow(/Invalid skill spec in .*global-specs.txt:2/);
  });

  test("local globalSpecs append and excludeGlobalSpecs filter (whole-repo expansion)", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "keep/repo@keep\nwide/repo\n");
    const local: LocalSkillsConfig = {
      ...emptyLocal,
      present: true,
      globalSpecs: ["local/repo@extra"],
      excludeGlobalSpecs: ["wide/repo@w2"],
    };
    const enumerate: UpstreamEnumerator = (repo) => {
      if (repo === "wide/repo") return ["w1", "w2", "w3"];
      throw new Error(`unexpected ${repo}`);
    };
    const { desiredSpecs, resolvedExcludedSpecs } = resolveDesiredGlobalSpecs(f, local, enumerate);
    expect(desiredSpecs).toEqual(["keep/repo@keep", "wide/repo@w1", "wide/repo@w3", "local/repo@extra"]);
    expect(resolvedExcludedSpecs).toEqual(["wide/repo@w2"]);
  });

  test("a whole-repo exclude resolves to every expanded spec of that repo", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "wide/repo\nkeep/repo@keep\n");
    const local: LocalSkillsConfig = { ...emptyLocal, present: true, excludeGlobalSpecs: ["wide/repo"] };
    const enumerate: UpstreamEnumerator = () => ["w1", "w2"];
    const { desiredSpecs } = resolveDesiredGlobalSpecs(f, local, enumerate);
    expect(desiredSpecs).toEqual(["keep/repo@keep"]);
  });
});

describe("buildSyncPlan", () => {
  const desired = ["keep/repo@keep-b", "openclaw/openclaw@github", "aurokin/diffwarden@diffwarden"];

  test("stale names removed, preserved kept, missing batched with extra flags", () => {
    const plan = buildSyncPlan({
      desiredSpecs: desired,
      preservedNames: ["handmade"],
      installedNames: ["stale-a", "keep-b", "handmade"],
      removableNames: ["stale-a", "keep-b", "handmade"],
      nonHermesAgents: ["codex"],
    });
    expect(plan.removals).toEqual(["stale-a"]);
    expect(plan.preservedInstalled).toEqual(["handmade"]);
    expect(plan.skipStaleRemoval).toBe(false);
    expect(plan.addBatches).toEqual([
      { repo: "openclaw/openclaw", skills: ["github"], extraArgs: ["--dangerously-accept-openclaw-risks"] },
      { repo: "aurokin/diffwarden", skills: ["diffwarden"], extraArgs: ["--full-depth"] },
    ]);
  });

  test("hermes-only mode skips stale removal entirely", () => {
    const plan = buildSyncPlan({
      desiredSpecs: desired,
      preservedNames: [],
      installedNames: ["stale-a"],
      removableNames: ["stale-a"],
      nonHermesAgents: [],
    });
    expect(plan.skipStaleRemoval).toBe(true);
    expect(plan.removals).toEqual([]);
    // Adds are unaffected: Hermes installs are add-only, not add-never.
    expect(plan.addBatches.map((b) => b.repo)).toEqual([
      "keep/repo",
      "openclaw/openclaw",
      "aurokin/diffwarden",
    ]);
  });

  test("argv shapes match the bash invocations (extra flags after -y)", () => {
    expect(removalToSkillsArgs("stale-a", ["codex", "opencode"])).toEqual([
      "remove", "-g", "stale-a", "-a", "codex", "opencode", "-y",
    ]);
    expect(
      addBatchToSkillsArgs(
        { repo: "openclaw/openclaw", skills: ["github", "tmux"], extraArgs: ["--dangerously-accept-openclaw-risks"] },
        ["codex", "hermes-agent"],
      ),
    ).toEqual([
      "add", "openclaw/openclaw", "-g", "-a", "codex", "hermes-agent",
      "-s", "github", "tmux", "-y", "--dangerously-accept-openclaw-risks",
    ]);
  });
});

describe("installed global discovery", () => {
  test("local symlinks reported by the skills CLI never enter stale removal", () => {
    const home = path.join(base, "home");
    const globalDir = path.join(home, ".agents", "skills");
    const source = path.join(base, "local-source");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(source);
    fs.mkdirSync(path.join(globalDir, "upstream-real"));
    fs.symlinkSync(source, path.join(globalDir, "local-live"));
    fs.symlinkSync(path.join(base, "gone"), path.join(globalDir, "local-dangling"));

    const installed = classifyInstalledGlobalNames(
      { home, machineName: "test", clock: { now: () => "2026-07-10T00:00:00.000Z" } },
      [
        { name: "upstream-real", path: path.join(globalDir, "upstream-real") },
        { name: "local-live", path: path.join(globalDir, "local-live") },
        { name: "local-dangling", path: path.join(globalDir, "local-dangling") },
        { name: "elsewhere", path: path.join(home, ".claude", "skills", "elsewhere") },
      ],
    );

    expect(installed).toEqual({
      presentNames: ["upstream-real", "local-live", "local-dangling"],
      removableNames: ["upstream-real"],
    });
    const plan = buildSyncPlan({
      desiredSpecs: ["local/repo@local-live"],
      preservedNames: [],
      installedNames: installed.presentNames,
      removableNames: installed.removableNames,
      nonHermesAgents: ["codex"],
    });
    expect(plan).toMatchObject({ removals: ["upstream-real"], addBatches: [] });
  });
});

describe("stale removal with a detected agent outside -a", () => {
  // Fake `skills` emulating real CLI 1.5.22 on a host with a detected universal agent
  // outside `-a` (e.g. cursor): a narrowed global remove unlinks the targeted agents but
  // keeps the canonical dir (and its lock entry); an all-agent remove deletes the name
  // everywhere, Hermes included; `update` re-places every surviving canonical skill.
  // Paths are baked in: Bun children inherit the ORIGINAL environ, not process.env edits.
  const shimScript = (home: string, log: string): string => `#!/usr/bin/env bash
SHIM_HOME=${JSON.stringify(home)}
SHIM_LOG=${JSON.stringify(log)}
printf '%s\\n' "$*" >> "$SHIM_LOG"
case "$1" in
  list) printf '[{"name":"stale","path":"%s"}]' "$SHIM_HOME/.agents/skills/stale" ;;
  remove)
    rm -rf "$SHIM_HOME/.claude/skills/$3"
    if [ "$4" != "-a" ]; then rm -rf "$SHIM_HOME/.agents/skills/$3" "$SHIM_HOME/.hermes/skills/$3"; fi ;;
  update)
    if [ -d "$SHIM_HOME/.agents/skills/stale" ]; then ln -s ../../.agents/skills/stale "$SHIM_HOME/.claude/skills/stale"; fi ;;
esac
`;

  async function sync(home: string): Promise<{ argv: string[]; removed: unknown }> {
    const root = path.join(base, "root");
    fs.mkdirSync(path.join(root, "catalog", "families"), { recursive: true });
    fs.writeFileSync(path.join(root, "catalog", "global-specs.txt"), "");
    const xdgConfigHome = path.join(base, "xdg-config");
    fs.mkdirSync(path.join(xdgConfigHome, "skills-manager"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgConfigHome, "skills-manager", "config.json"),
      JSON.stringify({
        version: 1,
        roots: [{ name: "public", path: root, visibility: "public" }],
        agents: ["claude-code"],
      }),
    );
    const shim = path.join(base, "skills");
    const log = path.join(base, "skills.log");
    fs.writeFileSync(shim, shimScript(home, log), { mode: 0o755 });

    const vars: Record<string, string | undefined> = {
      SKILLS_BIN: shim,
      SKILLS_AGENTS: "claude-code",
      SKILLS_AUDIT_REPO_COVERAGE: "0",
      HERMES_HOME: undefined,
    };
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const assign = (values: Record<string, string | undefined>): void => {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    assign(vars);
    try {
      const out = await runUpstream(
        { home, xdgConfigHome, machineName: "test", clock: { now: () => "2026-07-10T00:00:00.000Z" } },
        { json: true, prune: false, yes: false, fix: false, args: ["sync"] },
      );
      const argv = fs.readFileSync(log, "utf8").trim().split("\n");
      return { argv, removed: (out.json as { removed: unknown }).removed };
    } finally {
      assign(saved);
    }
  }

  function makeHome(): string {
    const home = path.join(base, "home");
    fs.mkdirSync(path.join(home, ".agents", "skills", "stale"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync("../../.agents/skills/stale", path.join(home, ".claude", "skills", "stale"));
    return home;
  }

  test("a lingering canonical dir gets an all-agent removal, so update cannot re-place it", async () => {
    const home = makeHome();
    const { argv, removed } = await sync(home);

    expect(argv).toEqual(["list -g --json", "remove -g stale -a claude-code -y", "remove -g stale -y", "update"]);
    expect(removed).toEqual(["stale"]);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "stale"))).toBe(false);
    expect(fs.lstatSync(path.join(home, ".claude", "skills", "stale"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("when Hermes holds the name, removal stays narrowed and Hermes is untouched", async () => {
    const home = makeHome();
    const hermesEntry = path.join(home, ".hermes", "skills", "stale");
    fs.mkdirSync(hermesEntry, { recursive: true });
    fs.writeFileSync(path.join(hermesEntry, "SKILL.md"), "hermes-owned\n");

    const { argv } = await sync(home);

    expect(argv).toEqual(["list -g --json", "remove -g stale -a claude-code -y", "update"]);
    expect(fs.readFileSync(path.join(hermesEntry, "SKILL.md"), "utf8")).toBe("hermes-owned\n");
  });
});

describe("sweeps", () => {
  test("owned-dir sweep removes only dangling symlinks", () => {
    const dir = path.join(base, "owned");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "real-dir"));
    fs.writeFileSync(path.join(dir, "target-file"), "x");
    fs.symlinkSync(path.join(dir, "target-file"), path.join(dir, "live-link"));
    fs.symlinkSync(path.join(dir, "nonexistent"), path.join(dir, "dead-link"));
    expect(sweepBrokenSymlinks(dir)).toEqual(["dead-link"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["live-link", "real-dir", "target-file"]);
  });

  test("hermes sweep removes only OUR dangling links; foreign/real/live untouched", () => {
    const home = path.join(base, "home");
    const hermes = path.join(home, ".hermes", "skills");
    const agentsSkills = path.join(home, ".agents", "skills");
    fs.mkdirSync(hermes, { recursive: true });
    fs.mkdirSync(path.join(agentsSkills, "alive"), { recursive: true });

    fs.symlinkSync(path.join(agentsSkills, "gone"), path.join(hermes, "ours-dangling-abs"));
    fs.symlinkSync("../../.agents/skills/gone2", path.join(hermes, "ours-dangling-rel"));
    fs.symlinkSync("/nowhere/foreign-target", path.join(hermes, "foreign-dangling"));
    fs.symlinkSync(path.join(agentsSkills, "alive"), path.join(hermes, "ours-valid"));
    fs.mkdirSync(path.join(hermes, "real-dir"));

    const removed = sweepHermesBrokenSymlinks(hermes, [
      `${path.join(base, "repo", "skills")}/`,
      `${agentsSkills}/`,
      "../../.agents/skills/",
    ]);
    expect(removed).toEqual(["ours-dangling-abs", "ours-dangling-rel"]);
    expect(fs.readdirSync(hermes).sort()).toEqual(["foreign-dangling", "ours-valid", "real-dir"]);
  });

  test("missing dirs are a no-op", () => {
    expect(sweepBrokenSymlinks(path.join(base, "nope"))).toEqual([]);
    expect(sweepHermesBrokenSymlinks(path.join(base, "nope"), ["/x/"])).toEqual([]);
  });
});

describe("buildRepoSkillSummary", () => {
  test("marks full coverage only when declared equals the upstream enumeration", () => {
    const enumerate: UpstreamEnumerator = (repo) =>
      repo === "full/repo" ? ["a", "b"] : ["x", "y", "z"];
    const summary = buildRepoSkillSummary(["full/repo@b", "full/repo@a", "part/repo@x"], enumerate);
    expect(summary).toEqual([
      { repo: "full/repo", skills: ["a", "b"], fullCoverage: true },
      { repo: "part/repo", skills: ["x"], fullCoverage: false },
    ]);
  });

  test("propagates enumeration failure (summary resolves before any mutation)", () => {
    expect(() => buildRepoSkillSummary(["x/y@a"], noEnumerate)).toThrow(/unexpected enumeration/);
  });
});
