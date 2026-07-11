import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { statePath } from "../src/env";
import {
  emptyState,
  findOwner,
  loadState,
  recordArtifact,
  removePlacement,
  saveState,
} from "../src/state";
import type { StatePlacement } from "../src/types";
import { makeSandbox, type Sandbox } from "./util";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

function placement(agent: string, p: string): StatePlacement {
  return { agent, path: p, kind: "symlink" };
}

describe("emptyState", () => {
  test("has the current state version, the given machine, and no artifacts", () => {
    const s = emptyState("koopa");
    expect(s).toEqual({ version: 3, machine: "koopa", artifacts: {} });
  });
});

describe("loadState", () => {
  test("returns an empty state (named after env.machine) when the file is absent", () => {
    sandbox = makeSandbox({ machineName: "koopa" });
    expect(loadState(sandbox.env)).toEqual(emptyState("koopa"));
  });

  test("round-trips through saveState", () => {
    sandbox = makeSandbox();
    const s = emptyState("m1");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("claude-code", "/abs/.claude/skills/alpha"),
    ]);
    saveState(sandbox.env, s);
    expect(loadState(sandbox.env)).toEqual(s);
  });

  test("forward-migrates a v2 (bare-key) state file to v3 type-qualified keys", () => {
    sandbox = makeSandbox();
    const file = statePath(sandbox.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        machine: "m",
        artifacts: {
          alpha: { source: { root: "public", visibility: "public" }, placements: [placement("shared", "/a/.agents/skills/alpha")] },
        },
      }),
    );
    const loaded = loadState(sandbox.env);
    expect(loaded.version).toBe(3);
    expect(loaded.artifacts["skill:alpha"]).toEqual({
      type: "skill",
      name: "alpha",
      source: { root: "public", visibility: "public" },
      placements: [placement("shared", "/a/.agents/skills/alpha")],
    });
    expect(loaded.artifacts.alpha).toBeUndefined();
  });

  test("hard-fails on a newer-than-supported state version", () => {
    sandbox = makeSandbox();
    const file = statePath(sandbox.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 4, machine: "m", artifacts: {} }));
    expect(() => loadState(sandbox!.env)).toThrow(/newer than this skm supports/);
  });

  test("throws a clear error on invalid JSON", () => {
    sandbox = makeSandbox();
    const file = statePath(sandbox.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json ");
    expect(() => loadState(sandbox!.env)).toThrow(/corrupt state file.*invalid JSON/);
  });

  test("throws a clear error when 'artifacts' is not an object", () => {
    sandbox = makeSandbox();
    const file = statePath(sandbox.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, machine: "m", artifacts: [] }));
    expect(() => loadState(sandbox!.env)).toThrow(/'artifacts' must be an object/);
  });

  test("throws when 'version' is missing", () => {
    sandbox = makeSandbox();
    const file = statePath(sandbox.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ machine: "m", artifacts: {} }));
    expect(() => loadState(sandbox!.env)).toThrow(/numeric 'version'/);
  });
});

describe("saveState (atomic)", () => {
  test("writes the target file and leaves no .tmp sibling behind", () => {
    sandbox = makeSandbox();
    saveState(sandbox.env, emptyState("m"));
    const file = statePath(sandbox.env);
    expect(fs.existsSync(file)).toBe(true);
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings.filter((n: string) => n.includes(".tmp"))).toEqual([]);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("creates the state directory if it does not exist", () => {
    sandbox = makeSandbox();
    expect(fs.existsSync(path.dirname(statePath(sandbox.env)))).toBe(false);
    saveState(sandbox.env, emptyState("m"));
    expect(fs.existsSync(statePath(sandbox.env))).toBe(true);
  });
});

describe("recordArtifact", () => {
  test("upserts a skill's source and full placement set with type + name", () => {
    const s = emptyState("m");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("shared", "/a/.agents/skills/alpha"),
    ]);
    expect(s.artifacts["skill:alpha"]).toEqual({
      type: "skill",
      name: "alpha",
      source: { root: "public", visibility: "public" },
      placements: [placement("shared", "/a/.agents/skills/alpha")],
    });
    // second call replaces placements wholesale
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, []);
    expect(s.artifacts["skill:alpha"]!.placements).toEqual([]);
  });

  test("records an agent-def artifact under the agent-def namespace", () => {
    const s = emptyState("m");
    recordArtifact(s, "agent-def:review", { root: "public", visibility: "public" }, []);
    expect(s.artifacts["agent-def:review"]!.type).toBe("agent-def");
    expect(s.artifacts["agent-def:review"]!.name).toBe("review");
  });
});

describe("removePlacement", () => {
  test("drops one placement by path and keeps the rest", () => {
    const s = emptyState("m");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("shared", "/a/.agents/skills/alpha"),
      placement("claude-code", "/a/.claude/skills/alpha"),
    ]);
    removePlacement(s, "skill:alpha", "/a/.agents/skills/alpha");
    expect(s.artifacts["skill:alpha"]!.placements).toEqual([
      placement("claude-code", "/a/.claude/skills/alpha"),
    ]);
  });

  test("deletes the artifact when its last placement is removed", () => {
    const s = emptyState("m");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("shared", "/a/.agents/skills/alpha"),
    ]);
    removePlacement(s, "skill:alpha", "/a/.agents/skills/alpha");
    expect(s.artifacts["skill:alpha"]).toBeUndefined();
  });

  test("matches paths regardless of non-canonical form", () => {
    const s = emptyState("m");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("shared", "/a/.agents/skills/alpha"),
    ]);
    removePlacement(s, "skill:alpha", "/a/./.agents/skills/../skills/alpha");
    expect(s.artifacts["skill:alpha"]).toBeUndefined();
  });

  test("is a no-op for an unknown skill", () => {
    const s = emptyState("m");
    expect(() => removePlacement(s, "skill:ghost", "/x")).not.toThrow();
  });
});

describe("findOwner", () => {
  test("returns the owning key and placement for a recorded path", () => {
    const s = emptyState("m");
    recordArtifact(s, "skill:alpha", { root: "public", visibility: "public" }, [
      placement("claude-code", "/a/.claude/skills/alpha"),
    ]);
    expect(findOwner(s, "/a/.claude/skills/alpha")).toEqual({
      skill: "skill:alpha",
      placement: placement("claude-code", "/a/.claude/skills/alpha"),
    });
  });

  test("returns undefined for an unowned path", () => {
    const s = emptyState("m");
    expect(findOwner(s, "/nope")).toBeUndefined();
  });
});
