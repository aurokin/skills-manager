// AUR-645: composed skills through the resolver — scan, later-root-wins, the
// output-namespace collision guards, and hashDesiredState selection identity.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { CollisionError } from "../src/errors";
import { loadRegistry } from "../src/registry";
import { hashDesiredState, resolveDesiredState } from "../src/resolve";
import type { DesiredComposedSkill, MachineConfig, Registry } from "../src/types";
import { makeAgentDef, makeComposed, makeProviderPool, makeRoot, makeSandbox, makeSkill, realRegistryPath, type Sandbox } from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function providerText(name: string, cli: string, models: Record<string, { default?: boolean }>): string {
  return `---\n${stringify({ name, cli, models })}---\n\nProvider ${name}. {{provider_clis}}\n`;
}

/** makeComposed opts for a valid orchestrate-style composed skill. */
function validComposed(): NonNullable<Parameters<typeof makeComposed>[2]> {
  return {
    skillYaml: {
      posture: "yolo",
      consumers: {
        "claude-code": { description: "Delegate to codex/grok." },
        codex: { description: "Delegate to claude/grok." },
      },
      dimensions: [
        {
          key: "implementation",
          candidates: [
            { provider: "codex", model: "gpt-5.5" },
            { provider: "grok", model: "grok-4.5" },
          ],
        },
        { key: "judgment", candidates: [{ provider: "claude", model: "opus" }] },
      ],
    },
    providers: {
      claude: providerText("claude", "claude", { opus: { default: true } }),
      codex: providerText("codex", "codex", { "gpt-5.5": { default: true } }),
      grok: providerText("grok", "grok", { "grok-4.5": { default: true } }),
    },
  };
}

const config = (...roots: MachineConfig["roots"]): MachineConfig => ({
  version: 1,
  roots,
  agents: ["claude-code", "codex"],
});

describe("resolveDesiredState — composed scan", () => {
  test("scans composed/<name>/ and returns the parsed carrier", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeComposed(root.path, "orchestrate", validComposed());
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    expect(desired.composedSkills.map((c) => c.name)).toEqual(["orchestrate"]);
    expect(desired.composedSkills[0]!.posture).toBe("yolo");
    expect(Object.keys(desired.composedSkills[0]!.providers).sort()).toEqual(["claude", "codex", "grok"]);
  });

  test("a dir without skill.yaml is skipped silently", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeComposed(root.path, "real", validComposed());
    fs.mkdirSync(path.join(root.path, "composed", "not-composed"), { recursive: true });
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    expect(desired.composedSkills.map((c) => c.name)).toEqual(["real"]);
  });

  test("later root wins a composed name collision (warning)", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    const priv = makeRoot(sandbox, "private", "private");
    makeComposed(pub.path, "orchestrate", validComposed());
    makeComposed(priv.path, "orchestrate", validComposed());
    const desired = resolveDesiredState(sandbox.env, config(pub, priv), reg());
    const winner = desired.composedSkills.find((c) => c.name === "orchestrate")!;
    expect(winner.source.root).toBe("private");
    const collision = desired.warnings.find((w) => w.kind === "collision" && w.skill === "orchestrate");
    expect(collision?.message).toContain("'private' wins");
  });

  test("an unused provider file surfaces a warning through resolve", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    const opts = validComposed();
    opts.providers = { ...opts.providers, pi: providerText("pi", "pi", { "pi-1": {} }) };
    makeComposed(root.path, "orchestrate", opts);
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    const warn = desired.warnings.find((w) => w.kind === "unused-provider");
    expect(warn?.message).toContain("providers/pi.md");
  });
});

describe("shared provider pool (ADR 0012)", () => {
  test("a composed skill resolves a dimension provider from the root pool", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    const opts = validComposed();
    const { claude, ...local } = opts.providers!;
    opts.providers = local;
    makeComposed(root.path, "orchestrate", opts);
    makeProviderPool(root.path, { claude: claude! });
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    expect(Object.keys(desired.composedSkills[0]!.providers).sort()).toEqual(["claude", "codex", "grok"]);
    expect(desired.warnings).toEqual([]);
  });

  test("_providers is never loaded as a composed skill, even with a stray skill.yaml", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeComposed(root.path, "orchestrate", validComposed());
    const poolDir = makeProviderPool(root.path, {});
    fs.writeFileSync(path.join(poolDir, "skill.yaml"), "name: _providers\n");
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    expect(desired.composedSkills.map((c) => c.name)).toEqual(["orchestrate"]);
  });

  test("a pool provider referenced by no composed skill in the root warns (advice)", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeComposed(root.path, "orchestrate", validComposed());
    makeProviderPool(root.path, { pi: providerText("pi", "pi", { "pi-1": {} }) });
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    const warn = desired.warnings.find((w) => w.kind === "unused-pool-provider");
    expect(warn?.message).toContain("_providers/pi.md");
    // Advice only: the skill still resolves.
    expect(desired.composedSkills.map((c) => c.name)).toEqual(["orchestrate"]);
  });

  test("pools are per-root: another root's skill does not consume this root's pool", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    const priv = makeRoot(sandbox, "private", "private");
    makeComposed(priv.path, "orchestrate", validComposed());
    // pub has a pool but no composed skills → its claude pool file is unreferenced.
    makeProviderPool(pub.path, { claude: providerText("claude", "claude", { opus: {} }) });
    const desired = resolveDesiredState(sandbox.env, config(pub, priv), reg());
    const warn = desired.warnings.find((w) => w.kind === "unused-pool-provider");
    expect(warn?.message).toContain("root 'public'");
    expect(warn?.message).toContain("_providers/claude.md");
  });
});

describe("output-namespace collision guards", () => {
  test("composed-vs-native name collision hard-fails", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeSkill(root.path, "orchestrate");
    makeComposed(root.path, "orchestrate", validComposed());
    expect(() => resolveDesiredState(sandbox!.env, config(root), reg())).toThrow(CollisionError);
  });

  test("composed-vs-derived name collision hard-fails", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeAgentDef(root.path, "orchestrate", { agentYaml: { export: "skill" } });
    makeComposed(root.path, "orchestrate", validComposed());
    expect(() => resolveDesiredState(sandbox!.env, config(root), reg())).toThrow(
      /composed skill 'orchestrate' collides with derived skill/,
    );
  });

  test("a composed skill with a unique name resolves cleanly beside skills + defs", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeSkill(root.path, "some-skill");
    makeAgentDef(root.path, "reviewer", { agentYaml: { export: "agent" } });
    makeComposed(root.path, "orchestrate", validComposed());
    const desired = resolveDesiredState(sandbox.env, config(root), reg());
    expect(desired.skills.map((s) => s.name)).toEqual(["some-skill"]);
    expect(desired.composedSkills.map((c) => c.name)).toEqual(["orchestrate"]);
  });
});

describe("hashDesiredState — composed selection identity", () => {
  function carrier(mut: (c: DesiredComposedSkill) => void = () => {}): DesiredComposedSkill {
    const c: DesiredComposedSkill = {
      name: "orchestrate",
      source: { root: "public", visibility: "public", path: "/x/composed/orchestrate" },
      posture: "yolo",
      template: "Body\n\n{{routing_table}}\n",
      consumers: {
        "claude-code": { description: "d1" },
        codex: { description: "d2" },
      },
      dimensions: [{ key: "implementation", candidates: [{ provider: "codex", model: "gpt-5.5" }] }],
      providers: { codex: { name: "codex", cli: "codex", models: { "gpt-5.5": { default: true } }, body: "b" } },
      consumerFiles: {},
    };
    mut(c);
    return c;
  }

  test("flipping posture changes the hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    const flipped = hashDesiredState([], [], [carrier((c) => (c.posture = "sandboxed"))]);
    expect(flipped).not.toBe(base);
  });

  test("adding a consumer changes the hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    const added = hashDesiredState(
      [],
      [],
      [carrier((c) => (c.consumers.grok = { description: "d3" }))],
    );
    expect(added).not.toBe(base);
  });

  test("removing a consumer changes the hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    const removed = hashDesiredState([], [], [carrier((c) => delete c.consumers.codex)]);
    expect(removed).not.toBe(base);
  });

  test("changing a consumer description changes the hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    const changed = hashDesiredState([], [], [carrier((c) => (c.consumers.codex!.description = "different"))]);
    expect(changed).not.toBe(base);
  });

  test("a selfProvider acknowledgment change changes the hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    const acked = hashDesiredState([], [], [carrier((c) => (c.consumers.codex!.selfProvider = "none"))]);
    expect(acked).not.toBe(base);
  });

  test("provider/dimension CONTENT edits do NOT change the selection hash", () => {
    const base = hashDesiredState([], [], [carrier()]);
    // add a whole dimension + mutate provider body: content, not selection identity.
    const edited = hashDesiredState(
      [],
      [],
      [
        carrier((c) => {
          c.dimensions.push({ key: "judgment", candidates: [{ provider: "codex", model: "gpt-5.5" }] });
          c.providers.codex!.body = "totally different body";
        }),
      ],
    );
    expect(edited).toBe(base);
  });

  test("a composed edit does not disturb skill hash entries beyond the top-level hash", () => {
    // Same skills, composed present vs absent: composed changes the overall hash but
    // the skills payload is unchanged, so a skills-only hash is stable.
    const skills = [
      {
        name: "s",
        source: { root: "public" as const, visibility: "public" as const, path: "/x/skills/s" },
        overrides: {},
      },
    ];
    const skillsOnly = hashDesiredState(skills);
    const withComposedA = hashDesiredState(skills, [], [carrier()]);
    const withComposedB = hashDesiredState(skills, [], [carrier((c) => (c.posture = "sandboxed"))]);
    expect(withComposedA).not.toBe(skillsOnly);
    expect(withComposedA).not.toBe(withComposedB);
    // skills-only hash is unaffected by which composed skills exist.
    expect(hashDesiredState(skills)).toBe(skillsOnly);
  });
});
