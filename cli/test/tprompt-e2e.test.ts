// AUR-617: tprompt export channel (ADR 0008) for BOTH artifact types. Sandboxed
// end-to-end — resolve → plan → apply → status/doctor → prune — plus prompts-dir
// resolution from a fake config.toml, the flat-namespace collision matrix, footer
// rules, and probe-absent behavior. Never reads or writes the real machine or the
// real ~/.config/tprompt.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { CollisionError, ConfigError } from "../src/errors";
import { buildPlan, runPlan } from "../src/plan";
import { resolveDesiredState } from "../src/resolve";
import { loadRegistry } from "../src/registry";
import { loadMachineConfig } from "../src/machine-config";
import { computeDrift, runStatus } from "../src/status";
import { diagnose } from "../src/doctor";
import { loadState } from "../src/state";
import { renderTpromptPrompt } from "../src/tprompt/render";
import { resolveTpromptDirs } from "../src/tprompt/config";
import { registryPath } from "../src/context";
import type { VerbOptions } from "../src/types";
import {
  type Sandbox,
  makeAgentDef,
  makeRoot,
  makeSandbox,
  makeSkill,
  writeMachineConfig,
  writeTpromptConfig,
} from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox({ tprompt: true });
});
afterEach(() => {
  sb.cleanup();
});

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function withoutProbe(): void {
  sb.env = { ...sb.env, tpromptProbe: () => false };
}
function promptsDirOf(): string {
  return resolveTpromptDirs(sb.env).promptsDir;
}
function ctx() {
  return loadContext(sb.env);
}
function plan() {
  const c = ctx();
  return buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
}

// ── rendering + custom prompts_dir ─────────────────────────────────────────────

describe("rendering into config.toml prompts_dir", () => {
  test("skill and agent-def render prompt files with stamped tags; footer only for agent-defs", async () => {
    const root = makeRoot(sb, "public");
    const skillSrc = makeSkill(root.path, "greet", {
      frontmatter: { tprompt: { tags: ["hello"], key: "g" } },
      body: "Say hi to the user.",
    });
    const defSrc = makeAgentDef(root.path, "reviewer", {
      agentYaml: { description: "Reviews plans.", export: "agent", tprompt: { tags: ["review"] } },
      instructions: "Review the plan carefully.\n",
    });
    const customDir = path.join(sb.base, "custom-prompts");
    writeTpromptConfig(sb, { promptsDir: customDir });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const outcome = await runApply(sb.env, opts());
    expect(outcome.exitCode).toBe(0);

    const skillFile = path.join(customDir, "greet-ca.md");
    const defFile = path.join(customDir, "reviewer-ca.md");
    expect(fs.readFileSync(skillFile, "utf8")).toBe(renderTpromptPrompt("skill", skillSrc));
    expect(fs.readFileSync(defFile, "utf8")).toBe(renderTpromptPrompt("agent-def", defSrc));

    const skillText = fs.readFileSync(skillFile, "utf8");
    // Frontmatter: default title, default description, stamped tags, declared key.
    expect(skillText).toContain("title: Greet");
    expect(skillText).toContain("description: greet skill");
    expect(skillText).toContain("- hello");
    expect(skillText).toContain("- skm");
    expect(skillText).toContain("- skill");
    expect(skillText).toContain("key: g");
    expect(skillText).toContain("Say hi to the user.");
    // Skill prompts NEVER get the subagent footer.
    expect(skillText).not.toContain("Do not use subagents");

    const defText = fs.readFileSync(defFile, "utf8");
    expect(defText).toContain("title: Reviewer");
    expect(defText).toContain("- review");
    expect(defText).toContain("- agent-def");
    // Agent-def prompts DO get the footer, appended after the body.
    expect(defText.trimEnd().endsWith("Do not use subagents for this specific request.")).toBe(true);

    // Both are owned tprompt-channel placements under type-qualified keys.
    const state = loadState(sb.env);
    const skillPl = state.artifacts["skill:greet"]!.placements.find((p) => p.agent === "tprompt");
    const defPl = state.artifacts["agent-def:reviewer"]!.placements.find((p) => p.agent === "tprompt");
    expect(skillPl?.kind).toBe("rendered-file");
    expect(defPl?.kind).toBe("rendered-file");

    // Re-apply is idempotent.
    const again = await runApply(sb.env, opts());
    const j = again.json as { applied: Record<string, number> };
    expect(j.applied.create ?? 0).toBe(0);
    expect(j.applied.update ?? 0).toBe(0);
  });

  test("footer: false suppresses the agent-def footer", async () => {
    const root = makeRoot(sb, "public");
    const defSrc = makeAgentDef(root.path, "quiet", {
      agentYaml: { export: "agent", tprompt: { footer: false } },
      instructions: "Do the quiet thing.\n",
    });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    const text = fs.readFileSync(path.join(sb.base, "p", "quiet-ca.md"), "utf8");
    expect(text).not.toContain("Do not use subagents");
    expect(text).toBe(renderTpromptPrompt("agent-def", defSrc));
  });

  test("tprompt.filename overrides the stem", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: { filename: "salutation" } } });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    expect(exists(path.join(sb.base, "p", "salutation-ca.md"))).toBe(true);
    expect(exists(path.join(sb.base, "p", "greet-ca.md"))).toBe(false);
  });
});

// ── fallback prompts-dir ───────────────────────────────────────────────────────

describe("prompts-dir fallback", () => {
  test("no config.toml → XDG default <configHome>/tprompt/prompts", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const fallback = path.join(sb.env.xdgConfigHome!, "tprompt", "prompts");
    expect(promptsDirOf()).toBe(fallback);

    await runApply(sb.env, opts());
    expect(exists(path.join(fallback, "greet-ca.md"))).toBe(true);
  });
});

// ── collision matrix ───────────────────────────────────────────────────────────

describe("collision matrix", () => {
  test("skm-vs-skm same stem → hard-fail before any mutation", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "alpha", { frontmatter: { tprompt: { filename: "dup" } } });
    makeSkill(root.path, "beta", { frontmatter: { tprompt: { filename: "dup" } } });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const registry = loadRegistry(registryPath());
    const config = loadMachineConfig(sb.env, registry);
    expect(() => resolveDesiredState(sb.env, config, registry)).toThrow(CollisionError);
  });

  test("foreign file at the target stem → reported + skipped; other placements proceed", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    makeSkill(root.path, "keep", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // A hand-dropped foreign prompt already owns the greet-ca stem.
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "greet-ca.md"), "foreign prompt content");

    const pl = plan();
    const greetTarget = path.join(p, "greet-ca.md");
    expect(pl.foreign.some((f) => path.resolve(f.path) === path.resolve(greetTarget))).toBe(true);
    // No create action for greet; keep still planned.
    expect(pl.actions.some((a) => a.skill === "greet" && a.placement.channel === "tprompt")).toBe(false);
    expect(pl.actions.some((a) => a.skill === "keep" && a.placement.channel === "tprompt")).toBe(true);

    await runApply(sb.env, opts());
    // Foreign file untouched; keep written.
    expect(fs.readFileSync(greetTarget, "utf8")).toBe("foreign prompt content");
    expect(exists(path.join(p, "keep-ca.md"))).toBe(true);
  });

  test("cross-dir collision via additional_prompts_dirs → reported + skipped", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const primary = path.join(sb.base, "primary");
    const extra = path.join(sb.base, "extra");
    writeTpromptConfig(sb, { promptsDir: primary, additionalDirs: [extra] });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // Foreign prompt with the same flat stem lives in an additional dir (directories
    // do not namespace — tprompt DECISIONS.md), so placing greet-ca in `primary`
    // would create a duplicate stem → skip.
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, "greet-ca.md"), "foreign in additional dir");

    const pl = plan();
    expect(pl.foreign.some((f) => f.detail.includes("greet-ca"))).toBe(true);
    expect(pl.actions.some((a) => a.skill === "greet" && a.placement.channel === "tprompt")).toBe(false);
    // Nothing was written into the primary dir for greet.
    expect(exists(path.join(primary, "greet-ca.md"))).toBe(false);
  });
});

// ── target-path handling: per-file diff vs cross-path collision ─────────────────

describe("target-path is the per-file diff's job, not a stem collision", () => {
  test("an unowned byte-matching file AT the target is adopted, not reported as a collision", async () => {
    const root = makeRoot(sb, "public");
    const skillDir = makeSkill(root.path, "greet", { frontmatter: { tprompt: {} }, body: "hi" });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // A hand-dropped, unowned file that already byte-matches skm's render sits at
    // the target. It must reach diffTpromptFile's adopt branch (the target path is
    // exempt from the foreign-stem scan), not be reported as a stem collision.
    const target = path.join(p, "greet-ca.md");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(target, renderTpromptPrompt("skill", skillDir));

    const pl = plan();
    expect(pl.foreign.some((f) => path.resolve(f.path) === path.resolve(target))).toBe(false);
    expect(pl.actions.some((a) => a.type === "adopt" && a.skill === "greet" && a.placement.channel === "tprompt")).toBe(true);
  });

  test("an unowned NON-matching file AT the target is refused by the per-file diff as foreign", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const target = path.join(p, "greet-ca.md");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(target, "foreign prompt content");

    const pl = plan();
    // diffTpromptFile owns this refusal (not the collision guard): the target has a
    // non-matching unowned file → foreign "unmanaged file at tprompt target".
    const f = pl.foreign.find((x) => path.resolve(x.path) === path.resolve(target));
    expect(f?.detail).toBe("unmanaged file at tprompt target");
    expect(pl.actions.some((a) => a.skill === "greet" && a.placement.channel === "tprompt")).toBe(false);
  });

  test("prompts_dir moved with the old dir still additional: the stale owned export collides + skips", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const oldDir = path.join(sb.base, "old");
    const newDir = path.join(sb.base, "new");
    writeTpromptConfig(sb, { promptsDir: oldDir });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // First apply owns oldDir/greet-ca.md.
    await runApply(sb.env, opts());
    const stale = path.join(oldDir, "greet-ca.md");
    expect(exists(stale)).toBe(true);

    // Move prompts_dir → new, but keep old in the flat namespace as an additional dir.
    // The new placement would create a duplicate greet-ca stem tprompt hard-errors on,
    // so it must be reported (with a --prune hint for the stale owned export) + skipped.
    writeTpromptConfig(sb, { promptsDir: newDir, additionalDirs: [oldDir] });

    const pl = plan();
    const target = path.join(newDir, "greet-ca.md");
    const f = pl.foreign.find((x) => path.resolve(x.path) === path.resolve(target));
    expect(f).toBeDefined();
    expect(f!.detail).toContain("greet-ca");
    expect(f!.detail).toContain("--prune");
    // No create for greet in the new dir → no duplicate stem written.
    expect(pl.actions.some((a) => a.type === "create" && a.skill === "greet" && a.placement.channel === "tprompt")).toBe(false);
    expect(exists(target)).toBe(false);
  });
});

// ── probe absent ───────────────────────────────────────────────────────────────

describe("probe absent (tprompt not on PATH)", () => {
  test("plan reports channel unavailable and creates no tprompt placements", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    withoutProbe();

    const pl = plan();
    expect(pl.channels?.tprompt.available).toBe(false);
    expect(pl.actions.some((a) => a.placement.channel === "tprompt")).toBe(false);

    // status --json also surfaces the channel as unavailable (not a silent skip).
    const st = await runStatus(sb.env, opts());
    const stJson = st.json as { channels: { tprompt: { available: boolean } } };
    expect(stJson.channels.tprompt.available).toBe(false);
  });

  test("existing owned prompt is NOT pruned when the channel goes unavailable", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // First apply with the channel available → prompt created + owned.
    await runApply(sb.env, opts());
    const target = path.join(p, "greet-ca.md");
    expect(exists(target)).toBe(true);

    // Channel now unavailable: plan must not prune, and apply --prune must leave it.
    withoutProbe();
    const pl = plan();
    expect(pl.actions.some((a) => a.type === "prune" && a.placement.agent === "tprompt")).toBe(false);
    await runApply(sb.env, opts({ prune: true }));
    expect(exists(target)).toBe(true);
    expect(loadState(sb.env).artifacts["skill:greet"]!.placements.some((x) => x.agent === "tprompt")).toBe(true);
  });
});

// ── deletion gate + drift ──────────────────────────────────────────────────────

describe("owned-prompt safety", () => {
  test("a hand-edited prompt is protected by the rendered-file deletion gate", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());

    const target = path.join(p, "greet-ca.md");
    fs.writeFileSync(target, "hand edited by the user\n");

    // status reports it modified; doctor flags a hash mismatch.
    const c = ctx();
    const drift = computeDrift(sb.env, c.config, c.registry, c.desired, c.state);
    expect(drift.some((d) => d.drift === "modified" && path.resolve(d.path) === path.resolve(target))).toBe(true);
    const findings = diagnose(sb.env, c.config, c.registry, c.desired, c.state);
    expect(findings.some((f) => f.message.includes("hand-edited"))).toBe(true);

    // apply refuses to overwrite the hand-edited file.
    await runApply(sb.env, opts());
    expect(fs.readFileSync(target, "utf8")).toBe("hand edited by the user\n");
  });

  test("prompt is pruned when the tprompt block is removed", async () => {
    const root = makeRoot(sb, "public");
    const skillDir = makeSkill(root.path, "greet", { frontmatter: { tprompt: {} }, body: "hi" });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, opts());
    const target = path.join(p, "greet-ca.md");
    expect(exists(target)).toBe(true);

    // Remove the tprompt block from the SKILL.md.
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greet skill\n---\n\nhi\n");

    const pl = plan();
    expect(pl.actions.some((a) => a.type === "prune" && a.placement.agent === "tprompt")).toBe(true);
    await runApply(sb.env, opts({ prune: true }));
    expect(exists(target)).toBe(false);
    expect(loadState(sb.env).artifacts["skill:greet"]?.placements.some((x) => x.agent === "tprompt") ?? false).toBe(false);
  });
});

// ── malformed config.toml ───────────────────────────────────────────────────────

describe("malformed config.toml", () => {
  test("an existing-but-unparseable config is a hard error, not a silent default fallback", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const customDir = path.join(sb.base, "custom-prompts");
    writeTpromptConfig(sb, { promptsDir: customDir });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // First apply owns customDir/greet-ca.md.
    await runApply(sb.env, opts());
    const target = path.join(customDir, "greet-ca.md");
    expect(exists(target)).toBe(true);

    // User drops the quotes → invalid TOML (like tp-malformed-config-fallback).
    const configFile = path.join(sb.env.xdgConfigHome!, "tprompt", "config.toml");
    fs.writeFileSync(configFile, `prompts_dir = ${customDir}\n`);

    // resolveTpromptDirs, plan, and apply --prune all hard-error instead of
    // resolving to the XDG default and pruning the owned export.
    expect(() => resolveTpromptDirs(sb.env)).toThrow(ConfigError);
    expect(() => plan()).toThrow(ConfigError);
    await expect(runApply(sb.env, opts({ prune: true }))).rejects.toThrow(ConfigError);

    // The owned prompt was never relocated or deleted.
    expect(exists(target)).toBe(true);
  });
});

// ── namespace scan fidelity (matches tprompt store.go discovery) ─────────────────

describe("namespace scan fidelity", () => {
  test("a foreign SYMLINKED .md sharing the stem in an additional dir is detected + skipped", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    makeSkill(root.path, "keep", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    const extra = path.join(sb.base, "extra");
    writeTpromptConfig(sb, { promptsDir: p, additionalDirs: [extra] });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // tprompt loads symlinked `.md` files (WalkDir: !d.IsDir() && Ext == ".md"),
    // so a symlink owning the greet-ca stem in another namespace dir is a real
    // cross-path collision the guard must see (the target itself is the per-file
    // diff's job, so the symlink lives in an additional dir, not at the target).
    fs.mkdirSync(extra, { recursive: true });
    const shared = path.join(sb.base, "shared-foo.md");
    fs.writeFileSync(shared, "shared foreign prompt");
    fs.symlinkSync(shared, path.join(extra, "greet-ca.md"));

    const pl = plan();
    expect(pl.foreign.some((f) => f.detail.includes("greet-ca"))).toBe(true);
    expect(pl.actions.some((a) => a.skill === "greet" && a.placement.channel === "tprompt")).toBe(false);
    // Unrelated placements still proceed.
    expect(pl.actions.some((a) => a.skill === "keep" && a.placement.channel === "tprompt")).toBe(true);
  });

  test("a HIDDEN dir/file sharing the stem is ignored → placement proceeds", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "greet", { frontmatter: { tprompt: {} } });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    // tprompt's discovery skips any dotted path (shouldSkipPath/isHidden → SkipDir),
    // so neither of these is in its namespace and greet-ca is NOT a collision.
    fs.mkdirSync(path.join(p, ".trash"), { recursive: true });
    fs.writeFileSync(path.join(p, ".trash", "greet-ca.md"), "deleted export");
    fs.writeFileSync(path.join(p, ".greet-ca.md"), "hidden backup");

    const pl = plan();
    expect(pl.foreign.some((f) => f.detail.includes("greet-ca"))).toBe(false);
    expect(pl.actions.some((a) => a.skill === "greet" && a.placement.channel === "tprompt")).toBe(true);

    await runApply(sb.env, opts());
    expect(exists(path.join(p, "greet-ca.md"))).toBe(true);
  });
});

// ── agent-def export-mode gate ───────────────────────────────────────────────────

describe("agent-def tprompt eligibility", () => {
  test("a non-`agent` export-mode agent-def with a tprompt block emits NO prompt", async () => {
    const root = makeRoot(sb, "public");
    makeAgentDef(root.path, "asskill", {
      agentYaml: { export: "skill", tprompt: { tags: ["tagx"] } },
      instructions: "Body.\n",
    });
    makeAgentDef(root.path, "asnone", {
      agentYaml: { export: "none", tprompt: { tags: ["tagy"] } },
      instructions: "Body.\n",
    });
    const p = path.join(sb.base, "p");
    writeTpromptConfig(sb, { promptsDir: p });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });

    const outcome = await runApply(sb.env, opts());
    expect(outcome.exitCode).toBe(0);
    // Neither export mode reaches the tprompt channel (ADR 0008 §4).
    expect(exists(path.join(p, "asskill-ca.md"))).toBe(false);
    expect(exists(path.join(p, "asnone-ca.md"))).toBe(false);
  });
});

// ── tilde-expanded prompts dirs ──────────────────────────────────────────────────

describe("prompts-dir home expansion", () => {
  test("`~`-prefixed prompts_dir and additional_prompts_dirs expand against home", () => {
    writeTpromptConfig(sb, { promptsDir: "~/lib", additionalDirs: ["~/extra"] });
    const dirs = resolveTpromptDirs(sb.env);
    expect(dirs.promptsDir).toBe(path.join(sb.env.home, "lib"));
    expect(dirs.additionalDirs).toEqual([path.join(sb.env.home, "extra")]);
  });
});

// ── skm-vs-skm stem collision (probe-independent, cross artifact type) ───────────

describe("skm-vs-skm stem collision guard", () => {
  function resolve() {
    const registry = loadRegistry(registryPath());
    const config = loadMachineConfig(sb.env, registry);
    return () => resolveDesiredState(sb.env, config, registry);
  }

  test("hard-fails even when the tprompt probe is absent", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "alpha", { frontmatter: { tprompt: { filename: "dup" } } });
    makeSkill(root.path, "beta", { frontmatter: { tprompt: { filename: "dup" } } });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    withoutProbe();
    expect(resolve()).toThrow(CollisionError);
  });

  test("hard-fails on a skill vs agent-def stem clash", () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "alpha", { frontmatter: { tprompt: { filename: "dup" } } });
    makeAgentDef(root.path, "beta", {
      agentYaml: { export: "agent", tprompt: { filename: "dup" } },
      instructions: "Body.\n",
    });
    writeTpromptConfig(sb, { promptsDir: path.join(sb.base, "p") });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    expect(resolve()).toThrow(CollisionError);
  });
});

// ── invalid block ──────────────────────────────────────────────────────────────

test("an invalid skill tprompt block is rejected with a clear error", () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "greet", { frontmatter: { tprompt: { bogus: 1 } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(sb.env, registry);
  expect(() => resolveDesiredState(sb.env, config, registry)).toThrow(/Unknown tprompt keys/);
});
