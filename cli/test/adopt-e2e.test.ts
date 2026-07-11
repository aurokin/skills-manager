// AUR-616 `skm adopt custom-agents`: read the custom_agents v2 manifest from BOTH
// locations (XDG + legacy in-repo), take ownership of agent-def files that match
// skm's current render, report missing/mismatched as stale, skip ghost entries,
// hard-fail on v1, and leave the manifests untouched. Also covers old-state-version
// (v1/v2 → v3) upgrade on read through a real verb. Sandboxed; never touches $HOME.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runAdopt } from "../src/adopt";
import { renderAgentDefFile } from "../src/agentdef/artifact";
import { buildPlan } from "../src/plan";
import { loadContext } from "../src/context";
import { stateHome } from "../src/env";
import { loadState } from "../src/state";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeAgentDef, makeRoot, makeSandbox, writeMachineConfig } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

function homePath(...parts: string[]): string {
  return path.join(sb.home, ...parts);
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: ["custom-agents"], ...over };
}

/** Absolute path to the primary (XDG) manifest inside the sandbox. */
function xdgManifest(): string {
  return path.join(stateHome(sb.env), "custom_agents", ".shared-agents-manifest.json");
}
/** Absolute path to the legacy manifest under the default agents_home (~/.agents). */
function legacyManifest(): string {
  return homePath(".agents", ".shared-agents-manifest.json");
}
function writeManifest(file: string, generated: Record<string, { agent: string; path: string }[]>, version = 2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version, generated_files: generated, linked_targets: {} }, null, 2));
}
/** Write skm's exact current render of `src` for `dialect` to `target` (a match). */
function writeMatchingFile(target: string, src: string, dialect: "claude" | "codex"): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderAgentDefFile(src, dialect));
}

describe("adopt custom-agents (XDG manifest)", () => {
  test("adopts matching agent-def files into skm ownership without touching disk or manifest", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const claudeFile = homePath(".claude/agents/rev.md");
    const codexFile = homePath(".codex/agents/rev.toml");
    writeMatchingFile(claudeFile, src, "claude");
    writeMatchingFile(codexFile, src, "codex");
    const manifest = xdgManifest();
    writeManifest(manifest, {
      claude: [{ agent: "rev", path: claudeFile }],
      codex: [{ agent: "rev", path: codexFile }],
    });
    const before = fs.readFileSync(manifest, "utf8");

    const outcome = await runAdopt(sb.env, opts());
    expect(outcome.exitCode).toBe(0);
    const j = outcome.json as { summary: { adopted: number; stale: number; ghostSkipped: number } };
    expect(j.summary).toEqual({ adopted: 2, stale: 0, ghostSkipped: 0 });

    // Ownership recorded under the type-qualified key, two rendered-file placements.
    const state = loadState(sb.env);
    const art = state.artifacts["agent-def:rev"]!;
    expect(art.type).toBe("agent-def");
    expect(art.placements.map((p) => p.kind)).toEqual(["rendered-file", "rendered-file"]);
    expect(new Set(art.placements.map((p) => p.agent))).toEqual(new Set(["claude-code", "codex"]));

    // The manifest and the target files are left exactly as they were.
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
    expect(fs.readFileSync(claudeFile, "utf8")).toBe(renderAgentDefFile(src, "claude"));
  });

  test("adopted files become skm-managed: a subsequent plan noops, and dropping the def prunes them", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const claudeFile = homePath(".claude/agents/rev.md");
    writeMatchingFile(claudeFile, src, "claude");
    writeManifest(xdgManifest(), { claude: [{ agent: "rev", path: claudeFile }] });

    await runAdopt(sb.env, opts());

    // Owned + on-disk match → plan sees no work.
    let c = loadContext(sb.env);
    let plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);

    // Remove the definition → the adopted placement becomes a prune (we own it now).
    fs.rmSync(path.join(root.path, "agents", "rev"), { recursive: true });
    c = loadContext(sb.env);
    plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    expect(plan.actions.filter((a) => a.type === "prune").map((a) => a.placement.path)).toContain(claudeFile);
  });

  test("stale entries (missing + content-mismatch) are reported and never owned", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const claudeFile = homePath(".claude/agents/rev.md"); // never written → missing
    const codexFile = homePath(".codex/agents/rev.toml");
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, "hand written, not our render\n"); // content mismatch
    writeManifest(xdgManifest(), {
      claude: [{ agent: "rev", path: claudeFile }],
      codex: [{ agent: "rev", path: codexFile }],
    });

    const outcome = await runAdopt(sb.env, opts());
    const j = outcome.json as { stale: { reason: string }[]; summary: { adopted: number; stale: number } };
    expect(j.summary.adopted).toBe(0);
    expect(j.summary.stale).toBe(2);
    // Nothing owned; the mismatched foreign file is untouched.
    expect(loadState(sb.env).artifacts["agent-def:rev"]).toBeUndefined();
    expect(fs.readFileSync(codexFile, "utf8")).toBe("hand written, not our render\n");
    void src;
  });

  test("a matching-content file in the WRONG location is reported stale, never adopted (DEL-1)", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // skm's EXACT current render, but written somewhere that is NOT the definition's
    // computed destination (~/.claude/agents/rev.md). A stale/malformed manifest must
    // not let skm own an unrelated matching file a later apply --prune could delete.
    const wrong = homePath(".claude/agents/elsewhere/rev.md");
    writeMatchingFile(wrong, src, "claude");
    writeManifest(xdgManifest(), { claude: [{ agent: "rev", path: wrong }] });

    const outcome = await runAdopt(sb.env, opts());
    const j = outcome.json as { stale: { reason: string }[]; summary: { adopted: number; stale: number } };
    expect(j.summary.adopted).toBe(0);
    expect(j.summary.stale).toBe(1);
    expect(j.stale[0]!.reason).toContain("not this definition's placement");
    expect(loadState(sb.env).artifacts["agent-def:rev"]).toBeUndefined();
  });

  test("ghost entries (agent: '') are skipped, not adopted or staled", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    writeManifest(xdgManifest(), { claude: [{ agent: "", path: homePath(".claude/agents/orphan.md") }] });

    const outcome = await runAdopt(sb.env, opts());
    const j = outcome.json as { summary: { adopted: number; stale: number; ghostSkipped: number } };
    expect(j.summary).toEqual({ adopted: 0, stale: 0, ghostSkipped: 1 });
    expect(loadState(sb.env).artifacts).toEqual({});
  });

  test("a v1 manifest hard-errors telling the user to upgrade first", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    writeManifest(xdgManifest(), { claude: [] }, 1);

    await expect(runAdopt(sb.env, opts())).rejects.toThrow(/v1 \(unsupported\).*upgrade/s);
  });
});

describe("adopt custom-agents (legacy + both locations)", () => {
  test("reads the legacy in-repo manifest (~/.agents) with the same treatment", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const claudeFile = homePath(".claude/agents/rev.md");
    writeMatchingFile(claudeFile, src, "claude");
    writeManifest(legacyManifest(), { claude: [{ agent: "rev", path: claudeFile }] });

    const outcome = await runAdopt(sb.env, opts());
    const j = outcome.json as { summary: { adopted: number } };
    expect(j.summary.adopted).toBe(1);
    expect(loadState(sb.env).artifacts["agent-def:rev"]!.placements).toHaveLength(1);
  });

  test("--agents-home overrides where the legacy manifest is read from", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const claudeFile = homePath(".claude/agents/rev.md");
    writeMatchingFile(claudeFile, src, "claude");
    const customHome = path.join(sb.base, "custom-agents-checkout");
    writeManifest(path.join(customHome, ".shared-agents-manifest.json"), {
      claude: [{ agent: "rev", path: claudeFile }],
    });

    const outcome = await runAdopt(sb.env, opts({ agentsHome: customHome }));
    expect((outcome.json as { summary: { adopted: number } }).summary.adopted).toBe(1);
  });

  test("an entry present in BOTH manifests is adopted once (deduped placement)", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const claudeFile = homePath(".claude/agents/rev.md");
    writeMatchingFile(claudeFile, src, "claude");
    const entry = { claude: [{ agent: "rev", path: claudeFile }] };
    writeManifest(xdgManifest(), entry);
    writeManifest(legacyManifest(), entry);

    await runAdopt(sb.env, opts());
    expect(loadState(sb.env).artifacts["agent-def:rev"]!.placements).toHaveLength(1);
  });

  test("no manifest anywhere → clean no-op summary", async () => {
    const root = makeRoot(sb, "public");
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    const outcome = await runAdopt(sb.env, opts());
    expect((outcome.json as { summary: { adopted: number; stale: number } }).summary).toEqual({
      adopted: 0,
      stale: 0,
      ghostSkipped: 0,
    });
  });
});

// ── old-state-version upgrade (v1 & v2 → v4) on read, through a real verb ──────

describe("state version upgrade on read", () => {
  function writeStateFile(version: number, artifacts: unknown): void {
    const file = path.join(stateHome(sb.env), "skills-manager", "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version, machine: "sandbox", artifacts }));
  }

  test("a v2 (bare-key, untyped) state file upgrades to v4 type-qualified keys in memory", () => {
    writeStateFile(2, {
      alpha: {
        source: { root: "public", visibility: "public" },
        placements: [{ agent: "shared", path: homePath(".agents/skills/alpha"), kind: "symlink" }],
      },
    });
    const state = loadState(sb.env);
    expect(state.version).toBe(4);
    expect(Object.keys(state.artifacts)).toEqual(["skill:alpha"]);
    expect(state.artifacts["skill:alpha"]!.type).toBe("skill");
    expect(state.artifacts["skill:alpha"]!.name).toBe("alpha");
  });

  test("a v1 state file upgrades on read without hard-failing", () => {
    writeStateFile(1, {
      beta: {
        source: { root: "public", visibility: "public" },
        placements: [{ agent: "shared", path: homePath(".agents/skills/beta"), kind: "symlink" }],
      },
    });
    const state = loadState(sb.env);
    expect(state.version).toBe(4);
    expect(state.artifacts["skill:beta"]!.type).toBe("skill");
  });

  test("adopt migrates a pre-v3 state file forward when it writes new ownership", async () => {
    const root = makeRoot(sb, "public");
    const src = makeAgentDef(root.path, "rev", { agentYaml: { export: "agent" } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    // Seed a v2 state carrying an existing skill; adoption must preserve it.
    writeStateFile(2, {
      alpha: {
        source: { root: "public", visibility: "public" },
        placements: [{ agent: "shared", path: homePath(".agents/skills/alpha"), kind: "symlink" }],
      },
    });
    const claudeFile = homePath(".claude/agents/rev.md");
    writeMatchingFile(claudeFile, src, "claude");
    writeManifest(xdgManifest(), { claude: [{ agent: "rev", path: claudeFile }] });

    await runAdopt(sb.env, opts());
    const state = loadState(sb.env);
    expect(state.version).toBe(4);
    expect(Object.keys(state.artifacts).sort()).toEqual(["agent-def:rev", "skill:alpha"]);
  });
});
