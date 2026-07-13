// AUR-646: composed-skill rendering, placement, and the plan/apply/status/doctor
// arms. Goldens are frozen from the TS renderer (byte-match, like agentdef-dialects);
// unit tests pin the tree-hash binding and each drift class.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { runApply } from "../src/apply";
import { loadComposedSkillFromDir } from "../src/composed/source";
import {
  composedTreeHash,
  renderComposedSkill,
  treeHashOfMemory,
  writeComposedTree,
} from "../src/composed/render";
import { loadContext } from "../src/context";
import { diagnose, runDoctor } from "../src/doctor";
import { buildPlan } from "../src/plan";
import { treeHashOf } from "../src/render";
import { loadRegistry } from "../src/registry";
import { loadState } from "../src/state";
import { computeDesiredPlacements } from "../src/placements";
import { explainSkill } from "../src/explain";
import { computeDrift } from "../src/status";
import type { DesiredComposedSkill, MachineConfig, Posture, Registry, VerbOptions } from "../src/types";
import { makeAgentScopes, makeComposed, makeRoot, makeSandbox, makeSkill, realRegistryPath, writeMachineConfig, type Sandbox } from "./util";

const registry = loadRegistry(realRegistryPath());
const fixturesDir = `${import.meta.dir}/goldens/fixtures`;
const goldensDir = `${import.meta.dir}/goldens/composed`;

/** Serialize a rendered tree to the golden's `===== rel =====\n<bytes>` form. */
function serializeTree(tree: Record<string, string>): string {
  return Object.keys(tree)
    .sort()
    .map((rel) => `===== ${rel} =====\n${tree[rel]}`)
    .join("\n");
}

function loadFixture(name: string): DesiredComposedSkill {
  return loadComposedSkillFromDir(
    `${fixturesDir}/${name}`,
    "orchestrate",
    { root: "private", visibility: "private", path: `${fixturesDir}/${name}` },
    registry,
  ).skill;
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden byte-match
// ─────────────────────────────────────────────────────────────────────────────

describe("golden byte-match", () => {
  // composed-kitchen-sink (posture yolo, no posture blocks → one golden per consumer):
  // self-exclusion skip, self-was-rank-1 note, displayed fallback chain,
  // provider-only-as-fallback reference, gate/appendix present+absent, per-consumer
  // descriptions, {{provider_clis}} in the template and inside shipped references.
  for (const consumer of ["claude-code", "codex"]) {
    test(`composed-kitchen-sink/${consumer}`, () => {
      const tree = renderComposedSkill(loadFixture("composed-kitchen-sink"), consumer, registry);
      const golden = fs.readFileSync(`${goldensDir}/composed-kitchen-sink/${consumer}.golden`, "utf8");
      expect(serializeTree(tree)).toBe(golden);
    });
  }

  // composed-posture: posture axis (sandboxed | yolo) over template, provider bodies,
  // and the consumer gate. codex has NO consumer file → both sections empty.
  for (const consumer of ["claude-code", "codex"]) {
    for (const posture of ["sandboxed", "yolo"] as Posture[]) {
      test(`composed-posture/${consumer}.${posture}`, () => {
        const skill = loadFixture("composed-posture");
        skill.posture = posture;
        const tree = renderComposedSkill(skill, consumer, registry);
        const golden = fs.readFileSync(`${goldensDir}/composed-posture/${consumer}.${posture}.golden`, "utf8");
        expect(serializeTree(tree)).toBe(golden);
      });
    }
  }

  // ADR 0012: moving a provider from providers/ to the root pool must not change a
  // single rendered byte — the property the orchestrate migration relies on.
  test("pool-resolved fixture renders byte-identically to its local-provider original", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skm-pool-golden-"));
    try {
      const src = `${fixturesDir}/composed-kitchen-sink`;
      const skillDir = path.join(tmp, "composed", "composed-kitchen-sink");
      fs.cpSync(src, skillDir, { recursive: true });
      // Move ONE provider (grok) into the pool; the rest stay local.
      const poolDir = path.join(tmp, "composed", "_providers");
      fs.mkdirSync(poolDir, { recursive: true });
      fs.renameSync(path.join(skillDir, "providers", "grok.md"), path.join(poolDir, "grok.md"));

      const original = loadFixture("composed-kitchen-sink");
      const pooled = loadComposedSkillFromDir(
        skillDir,
        "orchestrate",
        { root: "private", visibility: "private", path: skillDir },
        registry,
      ).skill;
      for (const consumer of Object.keys(original.consumers)) {
        expect(composedTreeHash(pooled, consumer, registry)).toBe(
          composedTreeHash(original, consumer, registry),
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no unfiltered @posture/@end/@section marker survives into any rendered output", () => {
    const outputs: string[] = [];
    for (const fixture of ["composed-kitchen-sink", "composed-posture"]) {
      for (const posture of ["sandboxed", "yolo"] as Posture[]) {
        const skill = loadFixture(fixture);
        skill.posture = posture;
        for (const consumer of Object.keys(skill.consumers)) {
          for (const body of Object.values(renderComposedSkill(skill, consumer, registry))) outputs.push(body);
        }
      }
    }
    for (const out of outputs) {
      expect(out).not.toContain("@posture");
      expect(out).not.toContain("@end");
      expect(out).not.toContain("@section");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Renderer semantics (self-exclusion, self-note, references, provider_clis)
// ─────────────────────────────────────────────────────────────────────────────

describe("renderComposedSkill semantics", () => {
  test("never ships references/<self>.md; ships every referenced provider (incl. fallback-only)", () => {
    const skill = loadFixture("composed-kitchen-sink");
    const codex = renderComposedSkill(skill, "codex", registry); // self = codex
    expect(codex["references/codex.md"]).toBeUndefined();
    // grok appears only as a fallback for codex, yet its reference ships.
    expect(codex["references/grok.md"]).toBeDefined();
    expect(codex["references/claude.md"]).toBeDefined();

    const cc = renderComposedSkill(skill, "claude-code", registry); // self = claude
    expect(cc["references/claude.md"]).toBeUndefined();
    expect(Object.keys(cc).sort()).toEqual(["SKILL.md", "references/codex.md", "references/grok.md"]);
  });

  test("{{provider_clis}} expands to ALL declared providers' CLIs, sorted, in refs", () => {
    const cc = renderComposedSkill(loadFixture("composed-kitchen-sink"), "claude-code", registry);
    // claude is self (no reference), yet its CLI is still listed for anti-recursion.
    expect(cc["references/grok.md"]).toContain("never spawn claude, codex, grok.");
  });

  test("pipes and newlines in authored values are escaped in table cells", () => {
    const skill = loadFixture("composed-kitchen-sink");
    const dim = skill.dimensions.find((d) => d.candidates.some((c) => c.provider !== "claude"))!;
    dim.when = "read | write tasks";
    dim.title = "line one\nline two";
    const tree = renderComposedSkill(skill, "claude-code", registry);
    const row = tree["SKILL.md"]!.split("\n").find((l) => l.includes("read \\| write tasks"));
    expect(row).toBeDefined();
    expect(row!).toContain("line one line two");
    // The row still has exactly 5 cells: 6 unescaped pipe delimiters.
    expect(row!.split(/(?<!\\)\|/).length - 2).toBe(5);
  });

  test("a dimension with an empty chain is dropped silently (no row, no reference)", () => {
    const cc = renderComposedSkill(loadFixture("composed-kitchen-sink"), "claude-code", registry);
    // judgment routes only to claude (self) for claude-code → dropped.
    expect(cc["SKILL.md"]).not.toContain("Taste-sensitive judgment");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree-hash binding: in-memory hash === treeHashOf(written dir)
// ─────────────────────────────────────────────────────────────────────────────

describe("tree-hash binding", () => {
  test("composedTreeHash equals treeHashOf over the written directory", () => {
    const skill = loadFixture("composed-kitchen-sink");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composed-tree-"));
    try {
      for (const consumer of ["claude-code", "codex"]) {
        const target = path.join(dir, consumer);
        const tree = renderComposedSkill(skill, consumer, registry);
        writeComposedTree(tree, target);
        expect(treeHashOfMemory(tree)).toBe(treeHashOf(target)!);
        expect(composedTreeHash(skill, consumer, registry)).toBe(treeHashOf(target)!);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a posture flip changes the tree hash", () => {
    const skill = loadFixture("composed-posture");
    skill.posture = "sandboxed";
    const sandboxed = composedTreeHash(skill, "claude-code", registry);
    skill.posture = "yolo";
    const yolo = composedTreeHash(skill, "claude-code", registry);
    expect(sandboxed).not.toBe(yolo);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan / apply / status / doctor arms (sandbox + real registry)
// ─────────────────────────────────────────────────────────────────────────────

/** A provider file (frontmatter registry + body with a {{provider_clis}} slot). */
function providerText(name: string, cli: string, models: Record<string, { default?: boolean }>): string {
  return `---\n${stringify({ name, cli, models })}---\n\n# ${name}\n\nAnti-recursion: {{provider_clis}}.\n`;
}

/** makeComposed opts for a valid orchestrate skill (consumers claude-code + codex). */
function composedOpts(): NonNullable<Parameters<typeof makeComposed>[2]> {
  return {
    skillYaml: {
      posture: "yolo",
      consumers: {
        "claude-code": { description: "Delegate to codex/grok; keep taste yourself." },
        codex: { description: "Delegate to claude/grok; keep mechanical work yourself." },
      },
      dimensions: [
        { key: "implementation", candidates: [{ provider: "codex", model: "gpt-5.5" }, { provider: "grok", model: "grok-4.5" }] },
        { key: "judgment", candidates: [{ provider: "claude", model: "opus" }] },
      ],
    },
    template: "# Orchestrate {{consumer}}\n\n{{routing_table}}\n\nCLIs: {{provider_clis}}\n",
    providers: {
      claude: providerText("claude", "claude", { opus: { default: true } }),
      codex: providerText("codex", "codex", { "gpt-5.5": { default: true } }),
      grok: providerText("grok", "grok", { "grok-4.5": { default: true } }),
    },
  };
}

const config = (roots: MachineConfig["roots"]): MachineConfig => ({
  version: 1,
  roots,
  agents: ["claude-code", "codex"],
});

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

/** Write a composed skill + machine config into a fresh sandbox; return the context builder. */
function setup(visibility: "public" | "private" = "public") {
  sandbox = makeSandbox();
  const root = makeRoot(sandbox, "root", visibility);
  makeComposed(root.path, "orchestrate", composedOpts());
  writeMachineConfig(sandbox, config([root]));
  return { root };
}

function claudeTree(): string {
  return path.join(sandbox!.home, ".claude/skills/orchestrate");
}
function codexTree(): string {
  return path.join(sandbox!.home, ".codex/skills/orchestrate");
}

describe("plan/apply — composed fan-out", () => {
  test("fresh apply creates one rendered tree per consumer under its ownDir", async () => {
    setup();
    const outcome = await runApply(sandbox!.env, opts());
    expect(outcome.exitCode).toBe(0);

    for (const dir of [claudeTree(), codexTree()]) {
      expect(fs.lstatSync(dir).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    }
    // codex is self for the codex consumer → its own reference never ships.
    expect(fs.existsSync(path.join(codexTree(), "references/codex.md"))).toBe(false);
    expect(fs.existsSync(path.join(codexTree(), "references/grok.md"))).toBe(true);

    const state = loadState(sandbox!.env);
    const art = state.artifacts["composed-skill:orchestrate"]!;
    expect(art.type).toBe("composed-skill");
    expect(art.placements.map((p) => p.agent).sort()).toEqual(["claude-code", "codex"]);
    // hash === tree by construction (both the full-tree hash).
    for (const p of art.placements) {
      expect(p.kind).toBe("rendered");
      expect(p.hash).toBe(p.tree!);
      expect(p.hash).toBe(treeHashOf(path.join(sandbox!.home, `.${p.agent === "claude-code" ? "claude" : "codex"}/skills/orchestrate`))!);
    }
  });

  test("a second apply is a noop (both trees already owned + current)", async () => {
    setup();
    await runApply(sandbox!.env, opts());
    const ctx = loadContext(sandbox!.env);
    const plan = buildPlan(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    expect(plan.actions.every((a) => a.type === "noop")).toBe(true);
  });

  test("declared consumers are intersected with the machine's enabled agents", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "root", "public");
    makeComposed(root.path, "orchestrate", composedOpts());
    // Machine enables codex only — claude-code is declared by the skill but must
    // not receive a placement, like every other placement type.
    writeMachineConfig(sandbox, { version: 1, roots: [root], agents: ["codex"] });

    const ctx = loadContext(sandbox!.env);
    const solved = computeDesiredPlacements(sandbox!.env, ctx.config, ctx.registry, ctx.desired);
    const composedPlacements = solved.placements.filter((dp) => dp.placement.artifactType === "composed-skill");
    expect(composedPlacements.map((dp) => dp.placement.agent)).toEqual(["codex"]);

    const outcome = await runApply(sandbox!.env, opts());
    expect(outcome.exitCode).toBe(0);
    expect(fs.existsSync(codexTree())).toBe(true);
    expect(fs.existsSync(claudeTree())).toBe(false);
  });
});

describe("placement metadata", () => {
  test("bleed uses the readers-INCLUDING-maybeReads variant (grok reads the claude dir)", () => {
    setup();
    const ctx = loadContext(sandbox!.env);
    const solved = computeDesiredPlacements(sandbox!.env, ctx.config, ctx.registry, ctx.desired);
    const claude = solved.placements.find(
      (dp) => dp.placement.artifactType === "composed-skill" && dp.placement.agent === "claude-code",
    )!;
    // grok only maybe-reads the claude dir; bleedFor would exclude it, so its presence
    // proves the maybeReads variant is used. The consumer itself is never in its bleed.
    expect(claude.placement.bleed).toContain("grok");
    expect(claude.placement.bleed).not.toContain("claude-code");
  });

  test("explain resolves a composed skill to its per-consumer placements", () => {
    setup();
    const ctx = loadContext(sandbox!.env);
    const e = explainSkill(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state, "orchestrate");
    expect(e.artifactType).toBe("composed-skill");
    expect(e.placements.map((p) => p.agent).sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("diffComposed drift classes", () => {
  test("a reference-body edit (unchanged SKILL.md) → plan update + status stale", async () => {
    const { root } = setup();
    await runApply(sandbox!.env, opts());

    // Edit a provider body in the SOURCE → the rendered reference changes, SKILL.md
    // does not; the full-tree hash still diverges.
    const grokSrc = path.join(root.path, "composed/orchestrate/providers/grok.md");
    fs.appendFileSync(grokSrc, "\nExtra guidance appended.\n");

    const ctx = loadContext(sandbox!.env);
    const plan = buildPlan(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const updates = plan.actions.filter((a) => a.type === "update" && a.placement.artifactType === "composed-skill");
    expect(updates.map((a) => a.placement.agent).sort()).toEqual(["claude-code", "codex"]);

    const drift = computeDrift(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const stale = drift.filter((d) => d.artifactType === "composed-skill" && d.drift === "stale");
    expect(stale.length).toBe(2);
  });

  test("a hand-edit on the deployed tree → plan warning + NO action", async () => {
    setup();
    await runApply(sandbox!.env, opts());
    fs.appendFileSync(path.join(claudeTree(), "SKILL.md"), "\nhand edit\n");

    const ctx = loadContext(sandbox!.env);
    const plan = buildPlan(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    // No create/update/adopt targets the hand-edited claude tree.
    const acted = plan.actions.filter(
      (a) => a.type !== "noop" && path.resolve(a.placement.path) === path.resolve(claudeTree()),
    );
    expect(acted).toEqual([]);
    const warn = plan.warnings.find((w) => w.kind === "modified" && w.message.includes(claudeTree()));
    expect(warn?.message).toContain("remove it and re-apply");
  });

  test("an unowned on-disk tree matching the expected render → adopt", async () => {
    setup();
    const ctx = loadContext(sandbox!.env);
    const composed = ctx.desired.composedSkills[0]!;
    // Pre-materialize the claude tree to exactly what skm would render (mid-apply-crash
    // recovery), but record nothing in state.
    writeComposedTree(renderComposedSkill(composed, "claude-code", registry), claudeTree());

    const plan = buildPlan(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const claudeAction = plan.actions.find(
      (a) => a.placement.artifactType === "composed-skill" && a.placement.agent === "claude-code",
    );
    expect(claudeAction?.type).toBe("adopt");

    await runApply(sandbox!.env, opts());
    const state = loadState(sandbox!.env);
    const rec = state.artifacts["composed-skill:orchestrate"]!.placements.find((p) => p.agent === "claude-code");
    expect(rec?.tree).toBe(treeHashOf(claudeTree())!);
  });
});

describe("prune + classifyRemoval on a composed tree", () => {
  test("removing the source prunes both trees (unmodified → safe removal)", async () => {
    const { root } = setup();
    await runApply(sandbox!.env, opts());
    expect(fs.existsSync(claudeTree())).toBe(true);

    // Drop the composed skill from desired (delete its source dir).
    fs.rmSync(path.join(root.path, "composed/orchestrate"), { recursive: true, force: true });

    const outcome = await runApply(sandbox!.env, opts({ prune: true }));
    expect(outcome.exitCode).toBe(0);
    expect(fs.existsSync(claudeTree())).toBe(false);
    expect(fs.existsSync(codexTree())).toBe(false);
    expect(loadState(sandbox!.env).artifacts["composed-skill:orchestrate"]).toBeUndefined();
  });
});

describe("cross-artifact ownership handoff", () => {
  test("replacing a native skill with a same-named composed skill is refused with a two-step remedy", async () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "root", "public");
    // Native skill 'orchestrate' scoped to claude-code (public catalog scoping) →
    // lands only at ~/.claude/skills/orchestrate.
    makeSkill(root.path, "orchestrate");
    makeAgentScopes(root.path, { orchestrate: { agents: { allow: ["claude-code"] } } });
    writeMachineConfig(sandbox, config([root]));
    await runApply(sandbox!.env, opts());
    expect(loadState(sandbox!.env).artifacts["skill:orchestrate"]).toBeDefined();

    // Replace the native source with a composed skill of the same name in one change.
    fs.rmSync(path.join(root.path, "skills/orchestrate"), { recursive: true });
    makeAgentScopes(root.path, {});
    makeComposed(root.path, "orchestrate", composedOpts());

    const ctx = loadContext(sandbox!.env);
    const plan = buildPlan(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const handoff = plan.warnings.filter((w) => w.kind === "ownership-handoff");
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.message).toContain("skill:orchestrate");
    expect(handoff[0]!.message).toContain("composed-skill:orchestrate");
    expect(handoff[0]!.message).toContain("two applies");
    // The claude-code placement is refused (no create writes over the owned symlink);
    // the codex placement has no prior owner and proceeds.
    const creates = plan.actions.filter((a) => a.type === "create");
    expect(creates.map((a) => a.placement.agent)).toEqual(["codex"]);
    // The old placement is not pruned either (its path is still desired) — no
    // destruction, no zombie write; state converges via the two-step remedy.
    expect(plan.actions.filter((a) => a.type === "prune")).toHaveLength(0);
  });
});

describe("doctor arms", () => {
  test("a hand-edited composed tree is reported non-fixable and applyFixes skips it", async () => {
    setup();
    await runApply(sandbox!.env, opts());
    const editedFile = path.join(claudeTree(), "references/grok.md");
    fs.appendFileSync(editedFile, "\nhand edit\n");
    const editedBytes = fs.readFileSync(editedFile, "utf8");

    const ctx = loadContext(sandbox!.env);
    const findings = diagnose(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const finding = findings.find((f) => f.skill === "orchestrate" && f.message.includes("composed skill hand-edited"));
    expect(finding?.fixable).toBe(false);

    // doctor --fix must NOT re-render (that would corrupt via the native renderer):
    // the hand-edited bytes survive and the finding persists (exit PENDING).
    const outcome = await runDoctor(sandbox!.env, opts({ fix: true }));
    expect(fs.readFileSync(editedFile, "utf8")).toBe(editedBytes);
    expect(outcome.exitCode).toBe(2);
  });

  test("a deleted composed tree is reported missing, non-fixable", async () => {
    setup();
    await runApply(sandbox!.env, opts());
    fs.rmSync(claudeTree(), { recursive: true });

    const ctx = loadContext(sandbox!.env);
    const findings = diagnose(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const finding = findings.find((f) => f.skill === "orchestrate" && f.message.includes("owned composed tree missing"));
    expect(finding?.category).toBe("broken-link");
    expect(finding?.fixable).toBe(false);
  });

  test("a composed tree replaced by a file is reported, non-fixable", async () => {
    setup();
    await runApply(sandbox!.env, opts());
    fs.rmSync(codexTree(), { recursive: true });
    fs.writeFileSync(codexTree(), "not a tree\n");

    const ctx = loadContext(sandbox!.env);
    const findings = diagnose(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const finding = findings.find((f) => f.skill === "orchestrate" && f.message.includes("owned composed tree replaced by file"));
    expect(finding?.category).toBe("broken-link");
    expect(finding?.fixable).toBe(false);
  });

  test("4b: an unmanaged copy of a private composed consumer tree is a private-leak finding", () => {
    setup("private");
    const ctx = loadContext(sandbox!.env);
    const composed = ctx.desired.composedSkills[0]!;
    // Manual copy of the claude-code consumer's rendered SKILL.md into a scanned agent
    // dir (shared), owned by no one.
    const leak = path.join(sandbox!.home, ".agents/skills/orch-leak");
    fs.mkdirSync(leak, { recursive: true });
    fs.writeFileSync(path.join(leak, "SKILL.md"), renderComposedSkill(composed, "claude-code", registry)["SKILL.md"]!);

    const findings = diagnose(sandbox!.env, ctx.config, ctx.registry, ctx.desired, ctx.state);
    const leakFinding = findings.find((f) => f.category === "private-leak" && f.path.includes("orch-leak"));
    expect(leakFinding?.skill).toBe("orchestrate");
    expect(leakFinding?.fixable).toBe(false);
  });
});
