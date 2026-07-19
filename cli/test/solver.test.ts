import { describe, expect, test } from "bun:test";
import { loadRegistry } from "../src/registry";
import { bleedFor, solvePlacements } from "../src/solver";
import type { AgentScope, DesiredSkill, MachineConfig, Registry } from "../src/types";
import { realRegistryPath } from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

/** Build a DesiredSkill (the solver never touches the fs, so paths are inert). */
function desired(
  name: string,
  opts: { scoping?: AgentScope; overrides?: DesiredSkill["overrides"] } = {},
): DesiredSkill {
  return {
    name,
    source: { root: "public", visibility: "public", path: "/dummy" },
    scoping: opts.scoping,
    overrides: opts.overrides ?? {},
  };
}

const defaultConfig: MachineConfig = { version: 1, roots: [] };

describe("solvePlacements — unscoped", () => {
  test("places into shared + claude + antigravity, all symlinks, no hermes by default", () => {
    const r = solvePlacements(desired("alpha"), defaultConfig, reg());
    const dirs = r.placements.map((p) => p.dir).sort();
    // antigravity is default-enabled and does NOT read the shared dir, so it gets its
    // own-dir symlink alongside claude (which also skips shared).
    expect(dirs).toEqual(["antigravity", "claude", "shared"]);
    expect(r.placements.every((p) => p.kind === "symlink")).toBe(true);
    expect(r.unreachable).toEqual([]);
  });

  test("antigravity gets its own-dir symlink, keyed to its registry dir", () => {
    const r = solvePlacements(desired("alpha"), defaultConfig, reg());
    const ag = r.placements.find((p) => p.dir === "antigravity");
    expect(ag).toBeDefined();
    expect(ag!.agent).toBe("antigravity");
    expect(ag!.kind).toBe("symlink");
    expect(ag!.path).toBe("~/.gemini/config/skills/alpha");
  });

  test("no antigravity placement when antigravity is not enabled", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const r = solvePlacements(desired("alpha"), config, reg());
    expect(r.placements.some((p) => p.dir === "antigravity")).toBe(false);
  });

  test("hermes gets an add-only placement only when enabled", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "hermes"] };
    const r = solvePlacements(desired("alpha"), config, reg());
    const hermes = r.placements.find((p) => p.dir === "hermes");
    expect(hermes).toBeDefined();
    expect(hermes!.agent).toBe("hermes");
    expect(hermes!.addOnly).toBe(true);
  });

  test("a claude.yaml override renders the claude placement", () => {
    const r = solvePlacements(
      desired("alpha", { overrides: { claude: "/x/agents/claude.yaml" } }),
      defaultConfig,
      reg(),
    );
    const claude = r.placements.find((p) => p.dir === "claude");
    expect(claude!.kind).toBe("rendered");
  });
});

describe("solvePlacements — allow", () => {
  test("allow claude-code lands in the claude dir with opencode+cursor bleed", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["claude-code"] } }),
      defaultConfig,
      reg(),
    );
    expect(r.placements.map((p) => p.dir)).toEqual(["claude"]);
    const p = r.placements[0]!;
    expect(p.agent).toBe("claude-code");
    expect(p.kind).toBe("symlink");
    expect(p.bleed).toEqual(["cursor", "opencode"]);
    // Scoped skills never touch the shared dir.
    expect(r.placements.some((x) => x.dir === "shared")).toBe(false);
  });

  test("allow claude-code with a claude override renders", () => {
    const r = solvePlacements(
      desired("drive", {
        scoping: { allow: ["claude-code"] },
        overrides: { claude: "/x/agents/claude.yaml" },
      }),
      defaultConfig,
      reg(),
    );
    expect(r.placements[0]!.kind).toBe("rendered");
  });

  test("allow codex uses the deprecated codex dir and reports cursor bleed", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["codex"] } }),
      defaultConfig,
      reg(),
    );
    const p = r.placements[0]!;
    expect(p.dir).toBe("codex");
    expect(p.deprecated).toBe(true);
    expect(p.bleed).toEqual(["cursor"]);
  });

  test("allow antigravity lands in its own dir as a symlink, no shared", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["antigravity"] } }),
      defaultConfig,
      reg(),
    );
    expect(r.placements.map((p) => p.dir)).toEqual(["antigravity"]);
    const p = r.placements[0]!;
    expect(p.agent).toBe("antigravity");
    expect(p.kind).toBe("symlink");
    expect(r.placements.some((x) => x.dir === "shared")).toBe(false);
    expect(r.unreachable).toEqual([]);
  });

  test("allow aider is unreachable (no readable dir), no placements", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["aider"] } }),
      defaultConfig,
      reg(),
    );
    expect(r.placements).toEqual([]);
    expect(r.unreachable).toEqual(["aider"]);
  });
});

describe("solvePlacements — deny (hard guarantee incl. maybeReads)", () => {
  test("deny grok forbids grok's maybe-reads (shared + claude); claude-code unreachable", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["grok"] } }),
      defaultConfig,
      reg(),
    );
    const forbidden = new Set(["grok", "shared", "claude"]);
    for (const p of r.placements) expect(forbidden.has(p.dir)).toBe(false);
    expect(r.unreachable).toContain("claude-code");
  });

  test("deny antigravity forbids its maybe-read of the gemini dir; gemini-cli unreachable", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["antigravity"] } }),
      defaultConfig,
      reg(),
    );
    for (const p of r.placements) {
      expect(p.dir).not.toBe("gemini");
      expect(p.dir).not.toBe("antigravity");
    }
    expect(r.unreachable).toContain("gemini-cli");
  });

  test("a deny that empties an agent's only dir reports it unreachable", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["opencode"] } }),
      config,
      reg(),
    );
    // opencode reads the claude dir, so denying it forbids claude-code's only target.
    expect(r.placements).toEqual([]);
    expect(r.unreachable).toEqual(["claude-code"]);
  });
});

describe("bleedFor", () => {
  test("claude dir bleeds to opencode and cursor (hard reads only, not grok's maybe)", () => {
    const placement = { agent: "claude-code", dir: "claude", path: "/x", kind: "symlink" as const };
    expect(bleedFor(reg(), placement, ["claude-code"])).toEqual(["cursor", "opencode"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase-1 variant support: allow ∩ enabled, data-driven unscoped own-dir
// placement, and the registry-derived render channel (fixture registries).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal fixture registry: claude-code plus a claude-dialect config-home variant. */
function variantRegistry(): Registry {
  return {
    version: 1,
    directories: {
      shared: { path: "~/.agents/skills" },
      claude: { path: "~/.claude/skills" },
      variant: { path: "~/.variant/skills" },
      hermes: { path: "~/.hermes/skills" },
    },
    agents: {
      "claude-code": {
        skillsSupport: "supported",
        reads: ["claude"],
        maybeReads: [],
        ownDir: "claude",
        dialect: "claude",
        symlinks: "followed",
        firstParty: true,
        unscopedOwnDir: true,
        evidence: "fixture",
      },
      "super-claude": {
        skillsSupport: "supported",
        reads: ["variant"],
        maybeReads: [],
        ownDir: "variant",
        dialect: "claude",
        symlinks: "followed",
        firstParty: true,
        optIn: true,
        unscopedOwnDir: true,
        evidence: "fixture",
      },
      hermes: {
        skillsSupport: "supported",
        reads: ["hermes"],
        maybeReads: [],
        ownDir: "hermes",
        dialect: "spec",
        symlinks: "followed",
        addOnly: true,
        optIn: true,
        unscopedOwnDir: true,
        evidence: "fixture",
      },
    },
  };
}

describe("allow ∩ enabled (disabled agents are skipped, not placed)", () => {
  test("an allow-listed disabled agent is skipped with a reason, not placed or unreachable", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["claude-code", "super-claude"] } }),
      config,
      variantRegistry(),
    );
    expect(r.placements.map((p) => p.dir)).toEqual(["claude"]);
    expect(r.unreachable).toEqual([]);
    expect(r.disabledSkipped).toEqual(["super-claude"]);
  });

  test("an enabled allow-listed variant is placed in its own dir", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "super-claude"] };
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["super-claude"] } }),
      config,
      variantRegistry(),
    );
    expect(r.placements.map((p) => p.dir)).toEqual(["variant"]);
    expect(r.disabledSkipped).toBeUndefined();
  });

  test("gated allow mode also intersects with enablement", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const registry = variantRegistry();
    registry.agents["claude-code"]!.skillInvocation = {
      userInvocation: "slash",
      gate: "frontmatter",
      evidence: "fixture",
      probedVersion: "1.0.0",
      probedOn: "2026-07-01",
    };
    registry.agents["super-claude"]!.skillInvocation = registry.agents["claude-code"]!.skillInvocation;
    const skill: DesiredSkill = { ...desired("gated-one", { scoping: { allow: ["claude-code", "super-claude"] } }), gated: true };
    const r = solvePlacements(skill, config, registry);
    expect(r.placements.map((p) => p.dir)).toEqual(["claude"]);
    expect(r.disabledSkipped).toEqual(["super-claude"]);
  });

  test("deny mode keeps intersecting silently (no disabledSkipped rows)", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["claude-code"] } }),
      config,
      variantRegistry(),
    );
    expect(r.placements).toEqual([]);
    expect(r.disabledSkipped).toBeUndefined();
  });
});

describe("solveUnscoped — data-driven own-dir placements", () => {
  test("every enabled unscopedOwnDir agent gets an own-dir placement; disabled ones do not", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "super-claude"] };
    const r = solvePlacements(desired("alpha"), config, variantRegistry());
    expect(r.placements.map((p) => p.dir)).toEqual(["shared", "claude", "variant"]);
  });

  test("a disabled claude-code no longer receives unscoped placements", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["super-claude"] };
    const r = solvePlacements(desired("alpha"), config, variantRegistry());
    expect(r.placements.map((p) => p.dir)).toEqual(["shared", "variant"]);
  });

  test("a claude override renders in EVERY enabled claude-dialect firstParty dir", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "super-claude"] };
    const r = solvePlacements(
      desired("alpha", { overrides: { claude: "/x/agents/claude.yaml" } }),
      config,
      variantRegistry(),
    );
    const kinds = Object.fromEntries(r.placements.map((p) => [p.dir, p.kind]));
    expect(kinds).toEqual({ shared: "symlink", claude: "rendered", variant: "rendered" });
  });

  test("add-only flows from the agent's registry flag", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "hermes"] };
    const r = solvePlacements(desired("alpha"), config, variantRegistry());
    const hermes = r.placements.find((p) => p.dir === "hermes");
    expect(hermes!.addOnly).toBe(true);
    expect(r.placements.find((p) => p.dir === "claude")!.addOnly).toBeUndefined();
  });

  test("unscoped placements stay bleed-exempt (no bleed fields at all)", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "super-claude", "hermes"] };
    const r = solvePlacements(desired("alpha"), config, variantRegistry());
    expect(r.placements.every((p) => p.bleed === undefined)).toBe(true);
  });

  test("real registry: unchanged default placement set (behavior guard)", () => {
    const r = solvePlacements(desired("alpha"), defaultConfig, reg());
    expect(r.placements.map((p) => p.dir).sort()).toEqual(["antigravity", "claude", "shared"]);
    expect(r.placements.every((p) => p.bleed === undefined)).toBe(true);
  });
});
