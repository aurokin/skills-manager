// Review-model assembly (ADR 0013) against a fully fabricated SkmEnv: fake
// HOME, fabricated roots + deploy dirs + state + catalogs. The model is the
// tested surface; stability here is what lets the HTML stay a dumb renderer.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { buildReviewModel } from "../src/review/model";
import type { VerbOptions } from "../src/types";
import { stringify } from "yaml";
import { type Sandbox, makeAgentDef, makeComposed, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

function providerText(name: string, cli: string): string {
  return `---\n${stringify({ name, cli, models: { m1: { default: true } } })}---\n\n# ${name}\n\nAnti-recursion: {{provider_clis}}.\n`;
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox({ machineName: "fixture-machine" });
});
afterEach(() => {
  sb.cleanup();
});

const APPLY_OPTS: VerbOptions = { json: true, prune: false, yes: true, fix: false, args: [] };

function writeCatalog(rootPath: string): void {
  const catalogDir = path.join(rootPath, "catalog");
  fs.mkdirSync(path.join(catalogDir, "families"), { recursive: true });
  fs.writeFileSync(
    path.join(catalogDir, "global-specs.txt"),
    "acme/upstream-skills@upstream-skill\nacme/whole-repo\n# comment\n\n",
  );
  fs.writeFileSync(path.join(catalogDir, "families.tsv"), "demo\tDemo family\n");
  fs.writeFileSync(
    path.join(catalogDir, "families", "demo.txt"),
    "acme/upstream-skills@family-skill\n",
  );
}

describe("review model", () => {
  test("assembles units, drift join, inventory, and docs from engine state", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "plain body" });
    makeSkill(root.path, "gated-skill", {
      frontmatter: { "disable-model-invocation": true },
      body: "gated body",
    });
    writeCatalog(root.path);
    makeComposed(root.path, "orchestrate", {
      skillYaml: {
        posture: "yolo",
        consumers: {
          "claude-code": { description: "Delegate to codex." },
          codex: { description: "Delegate to claude." },
        },
        dimensions: [
          { key: "judgment", candidates: [{ provider: "claude", model: "m1" }, { provider: "codex", model: "m1" }] },
        ],
      },
      template: "# Orchestrate {{consumer}}\n\n{{routing_table}}\n",
      providers: {
        claude: providerText("claude", "claude"),
        codex: providerText("codex", "codex"),
      },
    });
    writeMachineConfig(sb, {
      version: 1,
      roots: [root],
      agents: ["claude-code", "codex"],
    });

    await runApply(sb.env, APPLY_OPTS);

    // Fabricate an upstream install in the shared dir: catalog-expected label.
    const shared = path.join(sb.home, ".agents", "skills");
    fs.mkdirSync(path.join(shared, "upstream-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(shared, "upstream-skill", "SKILL.md"),
      "---\nname: upstream-skill\ndescription: up\n---\n\nbody\n",
    );

    const model = buildReviewModel(sb.env, loadContext(sb.env));

    expect(model.reviewModelVersion).toBe(1);
    expect(model.machine).toBe("fixture-machine");

    const plain = model.units.find((u) => u.name === "plain-skill");
    expect(plain?.group).toBe("Public skills");
    expect(plain?.badges).toContain("symlinked");
    expect(plain?.variants[0]?.files.some((f) => f.path === "SKILL.md")).toBe(true);
    // Placement applied cleanly → drift join says clean.
    expect(plain?.variants[0]?.deployed?.status).toBe("clean");

    const gated = model.units.find((u) => u.name === "gated-skill");
    expect(gated?.badges).toContain("gated");
    // Gated: per-agent rendered variants beyond source.
    expect((gated?.variants.length ?? 0)).toBeGreaterThan(1);

    // Inventory: shared dir present, upstream entry attributed as expectation.
    const sharedDir = model.inventory.find((d) => d.path.endsWith(".agents/skills"));
    expect(sharedDir).toBeDefined();
    const upstream = sharedDir?.entries.find((e) => e.name === "upstream-skill");
    expect(upstream?.kind).toBe("upstream");
    expect(upstream?.label).toContain("catalog-expected · acme/upstream-skills");
    // Docs registered and deduped by real path.
    expect(upstream?.doc).toBeDefined();
    expect(model.docs[upstream!.doc!]?.skill).toContain("body");

    const ours = sharedDir?.entries.find((e) => e.name === "plain-skill");
    expect(ours?.kind).toBe("public");

    // Composed unit: both postures compiled per consumer, self-exclusion intact.
    const composed = model.units.find((u) => u.name === "orchestrate");
    expect(composed?.matrix?.consumers.map((c) => c.key)).toEqual(["claude-code", "codex"]);
    expect(Object.keys(composed?.matrix?.cells ?? {}).sort()).toEqual([
      "claude-code|sandboxed",
      "claude-code|yolo",
      "codex|sandboxed",
      "codex|yolo",
    ]);
    const cell = composed?.matrix?.cells["claude-code|yolo"];
    expect(cell?.files.some((f) => f.path === "SKILL.md")).toBe(true);
    // claude-code's cell must not ship the claude self-reference.
    expect(cell?.files.some((f) => f.path === "references/claude.md")).toBe(false);
    expect(cell?.files.some((f) => f.path === "references/codex.md")).toBe(true);
    // Deployed chip present for the applied consumer placements.
    expect(composed?.matrix?.consumers[0]?.deployed?.status).toBe("clean");
  });

  test("drift join reports modified placements instead of clean", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "gated-skill", {
      frontmatter: { "disable-model-invocation": true },
      body: "gated body",
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    // Hand-edit the rendered tree → status must class it modified.
    const rendered = path.join(sb.home, ".claude", "skills", "gated-skill", "SKILL.md");
    fs.appendFileSync(rendered, "\ntampered\n");

    const model = buildReviewModel(sb.env, loadContext(sb.env));
    const gated = model.units.find((u) => u.name === "gated-skill");
    const deployed = gated?.variants.find((v) => v.key === "claude-code")?.deployed;
    expect(deployed?.status).toBe("modified");
  });

  test("missing placements surface as drift instead of vanishing", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "gated-skill", {
      frontmatter: { "disable-model-invocation": true },
      body: "gated body",
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sb.env, APPLY_OPTS);

    // Delete one agent's rendered tree entirely: the placement must still be
    // joined and reported missing, and the source variant must not read clean.
    fs.rmSync(path.join(sb.home, ".claude", "skills", "gated-skill"), { recursive: true });

    const model = buildReviewModel(sb.env, loadContext(sb.env));
    const gated = model.units.find((u) => u.name === "gated-skill");
    expect(gated?.placements.some((d) => d.status === "missing")).toBe(true);
    expect(gated?.variants[0]?.deployed?.status).toBe("missing");
    // The surviving agent's variant is still present and clean.
    const codex = gated?.variants.find((v) => v.key === "codex");
    expect(codex?.deployed?.status).toBe("clean");
  });

  test("export:skill defs join placements under the derived name; export:agent files hit inventory", async () => {
    const root = makeRoot(sb, "public");
    // The name-mismatch case the placement join must survive: def dir
    // helper-agent, derived skill review-helper (recorded under the latter).
    makeAgentDef(root.path, "helper-agent", {
      agentYaml: {
        export: "skill",
        skill: { name: "review-helper", title: "Review Helper", description: "Use when reviewing." },
      },
      instructions: "Review the patch.\n",
    });
    makeAgentDef(root.path, "plain-agent", {});
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
    await runApply(sb.env, APPLY_OPTS);

    const model = buildReviewModel(sb.env, loadContext(sb.env));

    const derived = model.units.find((u) => u.id === "agent-helper-agent");
    expect(derived?.placements.length ?? 0).toBeGreaterThan(0);
    expect(derived?.placements.every((d) => d.status === "clean")).toBe(true);
    // Rendered trees are directories: their content must load into variants.
    const deployVariant = derived?.variants.find((v) => v.key !== "source");
    expect(deployVariant?.files.some((f) => f.path === "SKILL.md" && f.content.includes("Review Helper"))).toBe(true);

    // export:agent renders plain files — inventory must attribute them.
    const agentsDir = model.inventory.find((d) => d.path.endsWith(".claude/agents"));
    const renderedFile = agentsDir?.entries.find((e) => e.name === "plain-agent.md");
    expect(renderedFile?.kind).toBe("rendered");
    expect(renderedFile?.label).toBe("skm-rendered file");
  });

  test("source trees with symlinked and broken directories do not break the walk", async () => {
    const root = makeRoot(sb, "public");
    const dir = makeSkill(root.path, "plain-skill", { body: "plain body" });
    const outside = path.join(sb.home, "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "inner.md"), "linked content\n");
    fs.symlinkSync(outside, path.join(dir, "linked"));
    fs.symlinkSync(path.join(sb.home, "does-not-exist"), path.join(dir, "dangling"));
    // Symlink cycle back to the skill root: the walk must terminate.
    fs.symlinkSync(dir, path.join(dir, "loop"));
    // Binary and oversized files must become markers, not raw payload.
    fs.writeFileSync(path.join(dir, "asset.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    fs.writeFileSync(path.join(dir, "huge.md"), `start ${"x".repeat(90_000)}`);
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const model = buildReviewModel(sb.env, loadContext(sb.env));
    const files = model.units.find((u) => u.name === "plain-skill")?.variants[0]?.files ?? [];
    expect(files.some((f) => f.path === "linked/inner.md")).toBe(true);
    expect(files.some((f) => f.path.startsWith("dangling"))).toBe(false);
    expect(files.filter((f) => f.path === "SKILL.md")).toHaveLength(1);
    expect(files.some((f) => f.path.startsWith("loop/"))).toBe(false);
    expect(files.find((f) => f.path === "asset.bin")?.content).toContain("[binary file");
    const huge = files.find((f) => f.path === "huge.md");
    expect(huge?.content).toContain("[truncated: 90006 bytes total]");
    expect((huge?.content.length ?? 0)).toBeLessThan(90_000);

    // registerDoc must survive the same tree: the inventoried skill keeps its
    // doc despite the dangling link and cycle inside it.
    const shared = model.inventory.find((d) => d.path.endsWith(".agents/skills"));
    const entry = shared?.entries.find((e) => e.name === "plain-skill");
    expect(entry?.doc).toBeDefined();
    expect(model.docs[entry!.doc!]?.skill).toContain("plain body");
  });

  test("model is stable across runs (modulo clock)", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill");
    writeCatalog(root.path);
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const a = buildReviewModel(sb.env, loadContext(sb.env));
    const b = buildReviewModel(sb.env, loadContext(sb.env));
    expect(JSON.stringify({ ...a, built: "" })).toBe(JSON.stringify({ ...b, built: "" }));
  });
});
