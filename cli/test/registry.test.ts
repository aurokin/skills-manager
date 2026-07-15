import { describe, expect, test } from "bun:test";
import {
  defaultEnabledAgents,
  dirPath,
  enabledAgents,
  loadRegistry,
  readersOf,
  validateRegistry,
} from "../src/registry";
import type { AgentCapability, MachineConfig, Registry } from "../src/types";
import { makeSandbox, realRegistryPath } from "./util";

/** The real, authoritative registry (read-only load). */
function realRegistry(): Registry {
  return loadRegistry(realRegistryPath());
}

/** A minimal valid registry for negative-case surgery. */
function baseRegistry(): Registry {
  const agent = (over: Partial<AgentCapability>): AgentCapability => ({
    skillsSupport: "supported",
    reads: [],
    maybeReads: [],
    ownDir: "shared",
    dialect: "spec",
    symlinks: "followed",
    evidence: "test",
    ...over,
  });
  return {
    version: 1,
    directories: {
      shared: { path: "~/.agents/skills" },
      claude: { path: "~/.claude/skills" },
    },
    agents: {
      alpha: agent({ reads: ["shared"], ownDir: "shared" }),
      claudey: agent({ reads: ["claude"], ownDir: "claude" }),
    },
  };
}

describe("loadRegistry + validateRegistry", () => {
  test("the real registry loads and validates", () => {
    const reg = realRegistry();
    expect(reg.version).toBe(1);
    expect(Object.keys(reg.agents).length).toBeGreaterThan(5);
  });

  test("a hand-built valid registry passes", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  test("rejects reads referencing an unknown directory", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.reads = ["nope"];
    expect(() => validateRegistry(reg)).toThrow(/unknown directory 'nope'/);
  });

  test("rejects maybeReads referencing an unknown directory", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.maybeReads = ["ghost"];
    expect(() => validateRegistry(reg)).toThrow(/maybeReads unknown directory 'ghost'/);
  });

  test("rejects an ownDir not in directories", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.ownDir = "missing";
    expect(() => validateRegistry(reg)).toThrow(/ownDir 'missing'/);
  });

  test("rejects a supported agent with no ownDir", () => {
    const reg = baseRegistry();
    delete reg.agents.alpha!.ownDir;
    expect(() => validateRegistry(reg)).toThrow(/has no ownDir/);
  });
});

describe("agent-definition field validation", () => {
  test("the real registry's agentDef fields validate", () => {
    const reg = realRegistry();
    expect(reg.agents["claude-code"]!.agentDefDir).toBe("~/.claude/agents");
    expect(reg.agents.codex!.agentDefDialect).toBe("codex");
    expect(reg.agents.pi!.agentDefSupport).toBe("none");
    expect(reg.agents.grok!.agentDefSupport).toBe("unknown");
    // antigravity is supported but served via gemini-cli's render — no own dir/dialect.
    expect(reg.agents.antigravity!.agentDefSupport).toBe("supported");
    expect(reg.agents.antigravity!.agentDefVia).toBe("gemini-cli");
    expect(reg.agents.antigravity!.agentDefDir).toBeUndefined();
    expect(reg.agents.antigravity!.agentDefDialect).toBeUndefined();
  });

  /** baseRegistry with `claudey` turned into a real agent-def renderer (a valid via target). */
  function regWithRenderer(): Registry {
    const reg = baseRegistry();
    reg.agents.claudey!.agentDefSupport = "supported";
    reg.agents.claudey!.agentDefDir = "~/.claudey/agents";
    reg.agents.claudey!.agentDefDialect = "claude";
    reg.agents.claudey!.agentDefEvidence = "renderer";
    return reg;
  }

  test("a served-via (agentDefVia) supported agent needs no dir/dialect", () => {
    const reg = regWithRenderer();
    reg.agents.alpha!.agentDefSupport = "supported";
    reg.agents.alpha!.agentDefVia = "claudey";
    reg.agents.alpha!.agentDefEvidence = "served by claudey";
    expect(() => validateRegistry(reg)).not.toThrow();
  });

  test("a served-via supported agent must not also declare its own dir", () => {
    const reg = regWithRenderer();
    reg.agents.alpha!.agentDefSupport = "supported";
    reg.agents.alpha!.agentDefVia = "claudey";
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefEvidence = "served by claudey";
    expect(() => validateRegistry(reg)).toThrow(/must not declare agentDefDir/);
  });

  test("agentDefVia requires an explicit supported status", () => {
    const reg = regWithRenderer();
    // agentDefSupport omitted while agentDefVia is set → incoherent, must be rejected.
    reg.agents.alpha!.agentDefVia = "claudey";
    reg.agents.alpha!.agentDefEvidence = "served by claudey";
    expect(() => validateRegistry(reg)).toThrow(/agentDefSupport is not 'supported'/);
  });

  test("agentDefVia must reference a real agent-def renderer", () => {
    const reg = baseRegistry(); // claudey is NOT a renderer here
    reg.agents.alpha!.agentDefSupport = "supported";
    reg.agents.alpha!.agentDefVia = "claudey";
    reg.agents.alpha!.agentDefEvidence = "served by claudey";
    expect(() => validateRegistry(reg)).toThrow(/must reference an agent with its own agent-definition render channel/);
  });

  test("none support must not declare agentDefVia", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefSupport = "none";
    reg.agents.alpha!.agentDefVia = "claudey";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/must not declare agentDefDir, agentDefDialect, or agentDefVia/);
  });

  test("a supported agentDef requires agentDefDir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefSupport = "supported";
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDir/);
  });

  test("a supported agentDef requires agentDefDialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDialect/);
  });

  test("a declared dir/dialect requires evidence", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "claude";
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
  });

  test("none support must not declare a dir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefSupport = "none";
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/must not declare agentDefDir/);
  });

  test("rejects an invalid dialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "toml" as never;
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/invalid agentDefDialect/);
  });

  test("rejects a non-string or empty agentDefDir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = 42 as never;
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/agentDefDir must be a non-empty string/);
    reg.agents.alpha!.agentDefDir = "  ";
    expect(() => validateRegistry(reg)).toThrow(/agentDefDir must be a non-empty string/);
  });

  test("rejects a non-string or empty agentDefEvidence", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = true as never;
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
    reg.agents.alpha!.agentDefEvidence = "";
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
  });

  test("an agent with no agentDef fields is fine", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  test("rejects a stray agentDefEvidence with no support/dir/dialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefEvidence = "orphan citation";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDir/);
  });
});

describe("skillInvocation field validation", () => {
  test("the real registry's skillInvocation fields validate", () => {
    const reg = realRegistry();
    expect(reg.agents["claude-code"]!.skillInvocation!.gate).toBe("frontmatter");
    expect(reg.agents.codex!.skillInvocation!.gate).toBe("companion:agents/openai.yaml");
    expect(reg.agents.codex!.skillInvocation!.userInvocation).toBe("mention");
    expect(reg.agents.opencode!.skillInvocation!.gate).toBe("none");
    // antigravity: no skill-gating field exists in SKILL.md (probe agy v1.1.2) → no-gate.
    expect(reg.agents.antigravity!.skillInvocation!.gate).toBe("none");
    expect(reg.agents.antigravity!.skillInvocation!.userInvocation).toBe("none");
    expect(reg.agents.antigravity!.skillInvocation!.probedVersion).toBe("1.1.2");
    expect(reg.agents.aider!.skillInvocation).toBeUndefined();
  });

  test("an agent with no skillInvocation block is fine", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  test("rejects an invalid userInvocation value", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "telepathy" as never,
      gate: "frontmatter",
      evidence: "test",
      probedVersion: "1.0.0",
      probedOn: "2026-07-11",
    };
    expect(() => validateRegistry(reg)).toThrow(/invalid skillInvocation.userInvocation/);
  });

  test("rejects an invalid gate value", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "companion:agents/other.yaml" as never,
      evidence: "test",
      probedVersion: "1.0.0",
      probedOn: "2026-07-11",
    };
    expect(() => validateRegistry(reg)).toThrow(/invalid skillInvocation.gate/);
  });

  test("rejects a missing or empty evidence", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "frontmatter",
      evidence: "  ",
      probedVersion: "1.0.0",
      probedOn: "2026-07-11",
    };
    expect(() => validateRegistry(reg)).toThrow(/skillInvocation requires evidence/);
  });

  test("a probed entry requires probedVersion", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "frontmatter",
      evidence: "test",
      probedOn: "2026-07-11",
    };
    expect(() => validateRegistry(reg)).toThrow(/requires probedVersion/);
  });

  test("a probed entry requires probedOn as YYYY-MM-DD", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "frontmatter",
      evidence: "test",
      probedVersion: "1.0.0",
      probedOn: "July 11, 2026",
    };
    expect(() => validateRegistry(reg)).toThrow(/probedOn as a real YYYY-MM-DD date/);
  });

  test("rejects a well-formed but impossible calendar date", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "frontmatter",
      evidence: "test",
      probedVersion: "1.0.0",
      probedOn: "2026-02-30",
    };
    expect(() => validateRegistry(reg)).toThrow(/probedOn as a real YYYY-MM-DD date/);
  });

  test("a fully unknown entry must not declare probe fields", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "unknown",
      gate: "unknown",
      evidence: "not probed",
      probedVersion: "1.0.0",
    };
    expect(() => validateRegistry(reg)).toThrow(/must not declare probedVersion or probedOn/);
  });

  test("a fully unknown entry with evidence only is fine", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "unknown",
      gate: "unknown",
      evidence: "not probed",
    };
    expect(() => validateRegistry(reg)).not.toThrow();
  });

  test("a gate-only unknown still requires probe fields (userInvocation was probed)", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.skillInvocation = {
      userInvocation: "slash",
      gate: "unknown",
      evidence: "test",
    };
    expect(() => validateRegistry(reg)).toThrow(/requires probedVersion/);
  });
});

describe("readersOf", () => {
  const reg = realRegistry();

  test("shared dir is read by codex and droid but not claude-code", () => {
    const readers = readersOf(reg, "shared");
    expect(readers).toContain("codex");
    expect(readers).toContain("droid");
    expect(readers).not.toContain("claude-code");
  });

  test("claude dir bleeds to opencode and cursor", () => {
    const readers = readersOf(reg, "claude");
    expect(readers).toContain("claude-code");
    expect(readers).toContain("opencode");
    expect(readers).toContain("cursor");
  });

  test("includeMaybe pulls in grok's unconfirmed shared read", () => {
    expect(readersOf(reg, "shared")).not.toContain("grok");
    expect(readersOf(reg, "shared", { includeMaybe: true })).toContain("grok");
  });
});

describe("enabledAgents / defaultEnabledAgents", () => {
  const reg = realRegistry();

  test("default set excludes hermes (opt-in) and aider (unsupported)", () => {
    const def = defaultEnabledAgents(reg);
    expect(def).toContain("claude-code");
    expect(def).toContain("codex");
    expect(def).not.toContain("hermes");
    expect(def).not.toContain("aider");
  });

  test("explicit config.agents is honored verbatim", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["codex", "hermes"] };
    expect(enabledAgents(config, reg)).toEqual(["codex", "hermes"]);
  });

  test("absent config.agents falls back to the default set", () => {
    const config: MachineConfig = { version: 1, roots: [] };
    expect(enabledAgents(config, reg)).toEqual(defaultEnabledAgents(reg));
  });
});

describe("dirPath", () => {
  test("expands ~ against the injected home", () => {
    const sandbox = makeSandbox();
    try {
      const reg = realRegistry();
      expect(dirPath(sandbox.env, reg, "claude")).toBe(`${sandbox.home}/.claude/skills`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("throws on an unknown directory id", () => {
    const sandbox = makeSandbox();
    try {
      expect(() => dirPath(sandbox.env, realRegistry(), "nope")).toThrow(/unknown directory/);
    } finally {
      sandbox.cleanup();
    }
  });
});
