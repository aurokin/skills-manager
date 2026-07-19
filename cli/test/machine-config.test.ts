import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertRootsExist,
  defaultConfig,
  loadMachineConfig,
  normalizeConfig,
  repoRoot,
} from "../src/machine-config";
import { defaultEnabledAgents, enabledAgents, loadRegistry } from "../src/registry";
import type { MachineConfig, Registry } from "../src/types";
import { makeSandbox, realRegistryPath, writeMachineConfig, type Sandbox } from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("repoRoot", () => {
  test("resolves to the repo containing the CLI (…/skills-manager)", () => {
    expect(path.basename(repoRoot())).toBe("skills-manager");
    // Registry lives under it, proving the resolution is right.
    expect(fs.existsSync(path.join(repoRoot(), "registry", "agents.json"))).toBe(true);
  });
});

describe("defaultConfig", () => {
  test("single public root at repo root, defaulted agents, empty allowlist", () => {
    const config = defaultConfig(reg());
    expect(config.roots).toHaveLength(1);
    expect(config.roots[0]!.name).toBe("public");
    expect(config.roots[0]!.visibility).toBe("public");
    expect(path.basename(config.roots[0]!.path)).toBe("skills-manager");
    // Raw absence is preserved (defaulting lives in enabledAgents, not the loader).
    expect(config.agents).toBeUndefined();
    expect(enabledAgents(config, reg())).toEqual(defaultEnabledAgents(reg()));
    expect(enabledAgents(config, reg())).not.toContain("hermes");
    expect(config.privateOriginAllowlist).toEqual([]);
  });
});

describe("loadMachineConfig", () => {
  test("missing file yields the default config", () => {
    sandbox = makeSandbox();
    const config = loadMachineConfig(sandbox.env, reg());
    expect(config.roots[0]!.name).toBe("public");
    expect(config.agents).toBeUndefined();
    expect(enabledAgents(config, reg())).toEqual(defaultEnabledAgents(reg()));
  });

  test("present file is normalized: tilde expanded, agents honored", () => {
    sandbox = makeSandbox();
    const written: MachineConfig = {
      version: 1,
      roots: [
        { name: "public", path: "~/code/skills-manager", visibility: "public" },
        { name: "private", path: "~/code/skills_private", visibility: "private" },
      ],
      agents: ["claude-code", "codex"],
    };
    writeMachineConfig(sandbox, written);

    const config = loadMachineConfig(sandbox.env, reg());
    expect(config.roots[0]!.path).toBe(path.join(sandbox.home, "code/skills-manager"));
    expect(config.roots[1]!.path).toBe(path.join(sandbox.home, "code/skills_private"));
    expect(config.roots[1]!.visibility).toBe("private");
    expect(config.agents).toEqual(["claude-code", "codex"]);
    // default filled in for an omitted key
    expect(config.privateOriginAllowlist).toEqual([]);
  });

  test("config without agents falls back to the default set", () => {
    sandbox = makeSandbox();
    writeMachineConfig(sandbox, {
      version: 1,
      roots: [{ name: "public", path: "~/x", visibility: "public" }],
    });
    const config = loadMachineConfig(sandbox.env, reg());
    expect(config.agents).toBeUndefined();
    expect(enabledAgents(config, reg())).toEqual(defaultEnabledAgents(reg()));
  });

  test("optInAgents adds to the default set without duplicating members", () => {
    sandbox = makeSandbox();
    writeMachineConfig(sandbox, {
      version: 1,
      roots: [{ name: "public", path: "~/x", visibility: "public" }],
      optInAgents: ["hermes", "claude-code"],
    });
    const config = loadMachineConfig(sandbox.env, reg());
    const enabled = enabledAgents(config, reg());
    expect(enabled).toEqual([...defaultEnabledAgents(reg()), "hermes"]);
  });

  test("agents + optInAgents together is a config error", () => {
    sandbox = makeSandbox();
    writeMachineConfig(sandbox, {
      version: 1,
      roots: [{ name: "public", path: "~/x", visibility: "public" }],
      agents: ["claude-code"],
      optInAgents: ["hermes"],
    });
    expect(() => loadMachineConfig(sandbox!.env, reg())).toThrow(/mutually exclusive/);
  });

  test("agent lists naming unknown agents are a config error", () => {
    sandbox = makeSandbox();
    writeMachineConfig(sandbox, {
      version: 1,
      roots: [{ name: "public", path: "~/x", visibility: "public" }],
      optInAgents: ["not-an-agent"],
    });
    expect(() => loadMachineConfig(sandbox!.env, reg())).toThrow(/unknown agent 'not-an-agent'/);
  });
});

describe("normalizeConfig", () => {
  test("throws when roots is missing", () => {
    sandbox = makeSandbox();
    const bad = { version: 1 } as unknown as MachineConfig;
    expect(() => normalizeConfig(sandbox!.env, bad, reg())).toThrow(/missing `roots`/);
  });
});

describe("assertRootsExist", () => {
  test("passes when every root exists on disk", () => {
    sandbox = makeSandbox();
    const rootPath = path.join(sandbox.base, "present");
    fs.mkdirSync(rootPath, { recursive: true });
    const config: MachineConfig = {
      version: 1,
      roots: [{ name: "present", path: rootPath, visibility: "public" }],
    };
    expect(() => assertRootsExist(config)).not.toThrow();
  });

  test("hard-aborts when a registered root is missing", () => {
    sandbox = makeSandbox();
    const config: MachineConfig = {
      version: 1,
      roots: [{ name: "gone", path: path.join(sandbox.base, "nope"), visibility: "private" }],
    };
    expect(() => assertRootsExist(config)).toThrow(/registered root 'gone' missing/);
  });
});
